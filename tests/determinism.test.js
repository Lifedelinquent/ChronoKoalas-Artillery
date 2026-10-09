/**
 * Determinism tests.
 *
 *  1. Same seed + same setup → the identical match, checkpoint for
 *     checkpoint (CPU vs CPU vs CPU with crates, mines, drums and wind).
 *  2. A different seed → a different match (guards against the test
 *     trivially passing because nothing happens).
 *  3. Replay round-trip: a scripted "human" plays against the CPU through
 *     InputManager.dispatch while the match is recorded; replaying the
 *     recording must reproduce every checkpoint.
 */

import { createHeadlessGame, runGame } from './sim-harness.js';
import { defaultScheme } from '../js/utils/GameScheme.js';

const FRAMES = 60 * 60 * 3; // three minutes of game time

function busyScheme() {
    const s = defaultScheme();
    s.turnTime = 20;
    s.crateDropChance = 0.6;
    s.mineCount = 8;
    s.oilDrumCount = 6;
    s.windStrength = 1;
    s.suddenDeathTime = 120;
    return s;
}

function cpuTeams() {
    return [
        { name: 'Alpha', color: 'red', isCPU: true, difficulty: 3, koalaCount: 3 },
        { name: 'Bravo', color: 'blue', isCPU: true, difficulty: 4, koalaCount: 3 },
        { name: 'Charlie', color: 'green', isCPU: true, difficulty: 5, koalaCount: 3 }
    ];
}

function firstMismatch(a, b) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i] !== b[i]) return i;
    }
    return -1;
}

async function sameSeedSameMatch() {
    const opts = { seed: 424242, teamsConfig: cpuTeams(), scheme: busyScheme(), recordReplay: false };
    const runA = runGame(await createHeadlessGame(opts), { maxFrames: FRAMES });
    const runB = runGame(await createHeadlessGame(opts), { maxFrames: FRAMES });
    const at = firstMismatch(runA.checkpoints, runB.checkpoints);
    return {
        pass: at === -1 && runA.turns > 3,
        detail: at === -1
            ? `${runA.checkpoints.length} checkpoints identical over ${runA.frames} frames, ${runA.turns} turns${runA.over ? ' (match finished)' : ''}`
            : `diverged at checkpoint ${at}: ${runA.checkpoints[at]} vs ${runB.checkpoints[at]}`
    };
}

async function differentSeedDifferentMatch() {
    const base = { teamsConfig: cpuTeams(), scheme: busyScheme(), recordReplay: false };
    const runA = runGame(await createHeadlessGame({ ...base, seed: 1111 }), { maxFrames: 60 * 30 });
    const runB = runGame(await createHeadlessGame({ ...base, seed: 2222 }), { maxFrames: 60 * 30 });
    const differ = runA.checkpoints.at(-1) !== runB.checkpoints.at(-1);
    return { pass: differ, detail: differ ? 'seeds 1111 and 2222 produce different matches' : 'two seeds produced the same match!' };
}

/**
 * A deterministic stand-in for a human player: walks a bit, points at the
 * nearest enemy with some wobble, holds fire for a while, then confirms.
 * Uses its own PRNG — it must never draw from the game's streams.
 */
function makeScriptedHuman(seed) {
    let s = seed >>> 0;
    const rnd = () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let plan = [];
    let plannedTurn = -1;

    return (game) => {
        const im = game.inputManager;
        const team = game.getCurrentTeam();
        if (!team || team.isCPU) return;

        const turn = game.turnManager.turnCounter;
        if (turn !== plannedTurn && game.phase === 'aiming') {
            plannedTurn = turn;
            const me = game.getCurrentKoala();
            const enemies = game.teams.filter(t => t !== team).flatMap(t => t.koalas.filter(k => k.isAlive));
            const target = enemies.sort((a, b) => Math.abs(a.x - me.x) - Math.abs(b.x - me.x))[0];
            const at = game.frame;
            const walk = Math.floor(rnd() * 40);
            const dir = rnd() < 0.5 ? 'left' : 'right';
            const charge = 20 + Math.floor(rnd() * 40);
            const tx = (target ? target.x : me.x + 200) + (rnd() - 0.5) * 120;
            const ty = (target ? target.y : me.y) - 150 - rnd() * 200;
            const weapon = ['bazooka', 'grenade', 'bazooka', 'cluster'][Math.floor(rnd() * 4)];
            plan = [
                [at + 2, { t: 'sel', id: weapon }],
                [at + 4, { t: 'press', a: dir }],
                [at + 4 + walk, { t: 'release', a: dir }],
                [at + 10 + walk, { t: 'pmove', x: tx, y: ty }],
                [at + 11 + walk, { t: 'pmove', x: tx + 3, y: ty - 2 }],
                [at + 14 + walk, { t: 'press', a: 'timer' + (1 + Math.floor(rnd() * 5)) }],
                [at + 15 + walk, { t: 'press', a: 'fire' }],
                [at + 15 + walk + charge, { t: 'release', a: 'fire' }],
                [at + 25 + walk + charge, { t: 'pdown', x: tx, y: ty }],
                [at + 26 + walk + charge, { t: 'pup' }]
            ];
        }
        while (plan.length && plan[0][0] <= game.frame) {
            im.dispatch(plan.shift()[1]);
        }
    };
}

async function replayRoundTrip() {
    const teamsConfig = [
        { name: 'Humans', color: 'red', isCPU: false, koalaCount: 3 },
        { name: 'Bots', color: 'blue', isCPU: true, difficulty: 3, koalaCount: 3 }
    ];
    const opts = { seed: 777, teamsConfig, scheme: busyScheme() };

    const live = await createHeadlessGame(opts);
    const liveRun = runGame(live, { maxFrames: FRAMES, onFrame: makeScriptedHuman(99) });
    const replay = live.replayRecorder.build();

    const watched = await createHeadlessGame({ ...opts, seed: replay.seed, replay });
    const replayRun = runGame(watched, { maxFrames: liveRun.frames });

    const at = firstMismatch(liveRun.checkpoints, replayRun.checkpoints);
    const commands = replay.events.length;
    return {
        pass: at === -1 && commands > 20,
        detail: at === -1
            ? `${commands} recorded commands reproduced ${liveRun.checkpoints.length} checkpoints over ${liveRun.frames} frames (${JSON.stringify(replay).length} bytes)`
            : `replay diverged at checkpoint ${at} (${commands} commands)`
    };
}

export const TESTS = [
    ['Same seed → identical match (CPU x3, 3 min)', sameSeedSameMatch],
    ['Different seed → different match', differentSeedDifferentMatch],
    ['Recorded match replays identically', replayRoundTrip]
];
