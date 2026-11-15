/**
 * Online lockstep tests.
 *
 * Several complete clients (each its own Game + LockstepSession) run in
 * this one tab, joined by a fake network that delays and jitters every
 * message the way a real star-topology match would (guests only ever talk
 * to the host). Each client plays its own turns through
 * InputManager.dispatch, exactly like a human at a keyboard.
 *
 *  1. A 3-player match with a spectator stays identical on every client,
 *     turn after turn, with no repairs needed.
 *  2. A spectator who joins mid-match rebuilds it from the host's command
 *     log (replaying it at full speed) and is in step from then on.
 *  3. A client whose world is deliberately corrupted is detected at the
 *     next turn start and repaired from the host's snapshot.
 *  4. A player who vanishes on their own turn is forfeited by the host and
 *     the match carries on for everyone else.
 *  5. A client that falls out of step IN TIME (it believes the turn already
 *     ended, so it stops producing frames while the host waits for them) is
 *     pulled back by the host's stall beacon instead of freezing the match.
 */

import { Game } from '../js/engine/Game.js';
import { FIXED_DT } from '../js/engine/GameConstants.js';
import { LockstepSession } from '../js/network/LockstepSession.js';
import { defaultScheme } from '../js/utils/GameScheme.js';
import { fingerprint } from './sim-harness.js';

export function mulberry(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function matchScheme() {
    const s = defaultScheme();
    s.turnTime = 15;
    s.retreatTime = 2;
    s.crateDropChance = 0.6;
    s.mineCount = 8;
    s.oilDrumCount = 6;
    s.suddenDeathTime = 90;
    return s;
}

/**
 * The fake network: ordered, reliable links with a per-message delay (in
 * simulation ticks) between each guest and the host.
 */
export class FakeNet {
    constructor(seed, { minDelay = 2, maxDelay = 9 } = {}) {
        this.rand = mulberry(seed);
        this.minDelay = minDelay;
        this.maxDelay = maxDelay;
        this.tick = 0;
        this.clients = new Map(); // peerId -> client
        this.links = new Map();   // 'from>to' -> { queue, lastDue }
        this.host = null;
        this.sent = 0;
    }

    post(from, to, msg) {
        const key = `${from}>${to}`;
        let link = this.links.get(key);
        if (!link) this.links.set(key, link = { queue: [], lastDue: 0 });
        // Jittered delay, but never overtaking the message before it
        const delay = this.minDelay + Math.floor(this.rand() * (this.maxDelay - this.minDelay + 1));
        const due = Math.max(link.lastDue, this.tick + delay);
        link.lastDue = due;
        // A real channel serialises: the receiver never shares objects
        link.queue.push({ due, to, from, msg: JSON.parse(JSON.stringify(msg)) });
        this.sent++;
    }

    deliver() {
        for (const link of this.links.values()) {
            while (link.queue.length && link.queue[0].due <= this.tick) {
                const { to, from, msg } = link.queue.shift();
                const client = this.clients.get(to);
                if (!client || client.gone) continue;
                // Guests see everything as "from the host" (fromPeer null)
                client.session?.handleMessage(msg, client.isHost ? from : null);
            }
        }
    }

    transportFor(client) {
        const net = this;
        return {
            isHost: client.isHost,
            mySlot: client.slot,
            isSpectator: client.spectator,
            send(msg) {
                if (client.gone) return;
                if (client.isHost) {
                    for (const other of net.clients.values()) {
                        if (other !== client && !other.gone) net.post(client.id, other.id, msg);
                    }
                } else {
                    net.post(client.id, net.host.id, msg);
                }
            },
            sendTo(peer, msg) {
                if (!client.gone) net.post(client.id, peer, msg);
            },
            broadcastExcept(peer, msg) {
                for (const other of net.clients.values()) {
                    if (other !== client && other.id !== peer && !other.gone) net.post(client.id, other.id, msg);
                }
            }
        };
    }
}

/** Create one client: a headless online Game with its lockstep session. */
export async function addClient(net, gameState, { id, slot, isHost = false, spectator = false, resume = null, scriptSeed = 1 }) {
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 540;

    const client = { id, slot, isHost, spectator, gone: false, acc: 0, turns: new Map(), session: null };
    if (isHost) net.host = client;
    net.clients.set(id, client);

    const game = new Game(canvas, { headless: true, isPractice: false, initialState: gameState, scheme: gameState.scheme });
    const session = new LockstepSession(game, net.transportFor(client), {
        players: gameState.players, tag: gameState.seed, resume
    });
    game.net = session;
    client.game = game;
    client.session = session;

    // Fingerprint the world at the start of every turn, independently of
    // the session's own checksum
    const onTurnStart = session.onTurnStart.bind(session);
    session.onTurnStart = (turn) => {
        client.turns.set(turn, fingerprint(game));
        onTurnStart(turn);
    };

    client.script = spectator ? null : makePlayer(scriptSeed);
    await game.start();
    return client;
}

/**
 * A scripted player: on its own turn it walks a little, aims near an
 * enemy, charges and fires — all through dispatch(), all with its own PRNG.
 */
function makePlayer(seed) {
    const rnd = mulberry(seed);
    let plan = [];
    let plannedTurn = -1;

    return (game) => {
        const net = game.net;
        if (!game.isMyTurn() || !net.acceptsLocalInput()) return;
        const im = game.inputManager;

        const turn = game.turnManager.turnCounter;
        if (turn !== plannedTurn && game.phase === 'aiming') {
            plannedTurn = turn;
            const me = game.getCurrentKoala();
            const team = game.getCurrentTeam();
            const enemies = game.teams.filter(t => t.alliance !== team.alliance)
                .flatMap(t => t.koalas.filter(k => k.isAlive));
            const target = enemies.sort((a, b) => Math.abs(a.x - me.x) - Math.abs(b.x - me.x))[0];
            const at = game.frame;
            const walk = Math.floor(rnd() * 50);
            const dir = rnd() < 0.5 ? 'left' : 'right';
            const charge = 15 + Math.floor(rnd() * 45);
            const tx = (target ? target.x : me.x + 200) + (rnd() - 0.5) * 140;
            const ty = (target ? target.y : me.y) - 120 - rnd() * 220;
            const weapon = ['bazooka', 'grenade', 'cluster', 'bazooka', 'shotgun'][Math.floor(rnd() * 5)];
            plan = [
                [at + 3, { t: 'sel', id: weapon }],
                [at + 5, { t: 'press', a: dir }],
                [at + 5 + walk, { t: 'release', a: dir }],
                [at + 8 + walk, { t: 'press', a: 'jump' }],
                [at + 9 + walk, { t: 'release', a: 'jump' }],
                [at + 60 + walk, { t: 'pmove', x: tx, y: ty }],
                [at + 61 + walk, { t: 'pmove', x: tx + 3.25, y: ty - 2.5 }],
                [at + 64 + walk, { t: 'press', a: 'timer' + (1 + Math.floor(rnd() * 5)) }],
                [at + 65 + walk, { t: 'press', a: 'fire' }],
                [at + 65 + walk + charge, { t: 'release', a: 'fire' }],
                [at + 75 + walk + charge, { t: 'pdown', x: tx, y: ty }],
                [at + 76 + walk + charge, { t: 'pup' }],
                // Walk during the retreat too
                [at + 90 + walk + charge, { t: 'press', a: dir === 'left' ? 'right' : 'left' }],
                [at + 150 + walk + charge, { t: 'release', a: dir === 'left' ? 'right' : 'left' }]
            ];
        }
        while (plan.length && plan[0][0] <= game.frame) {
            im.dispatch(plan.shift()[1]);
        }
    };
}

/** Advance the whole fake world by one tick. */
export function tickAll(net, hitchRand) {
    net.tick++;
    net.deliver();
    for (const client of net.clients.values()) {
        if (client.gone) continue;
        client.script?.(client.game);
        // Clients don't run in step with each other: now and then one
        // hitches (drops a few frames of time, then gets it back)
        const r = hitchRand();
        const dt = r < 0.03 ? 0 : r > 0.97 ? FIXED_DT * 2 : FIXED_DT;
        client.acc = client.session.pump(client.acc + dt);
    }
}

export function newMatch(seed, playerCount = 3) {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const scheme = matchScheme();
    return {
        seed,
        scheme,
        players: Array.from({ length: playerCount }, (_, i) => ({
            slot: i, name: `P${i + 1}`, color: colors[i], style: null
        }))
    };
}

/** Compare the per-turn fingerprints of every client against the host. */
function compareTurns(net, { from = 1 } = {}) {
    const host = net.host;
    let compared = 0;
    for (const client of net.clients.values()) {
        if (client === host || client.gone) continue;
        for (const [turn, fp] of client.turns) {
            if (turn < from || !host.turns.has(turn)) continue;
            compared++;
            if (host.turns.get(turn) !== fp) {
                return { ok: false, compared, where: `${client.id} differs from host at turn ${turn}` };
            }
        }
    }
    return { ok: true, compared };
}

function totals(net) {
    let desyncs = 0, repaired = 0;
    for (const c of net.clients.values()) {
        desyncs += c.session.stats.desyncs;
        repaired += c.session.stats.repaired;
    }
    return { desyncs, repaired };
}

function destroyAll(net) {
    for (const c of net.clients.values()) c.game.destroy();
}

async function threePlayersStayIdentical() {
    const net = new FakeNet(11);
    const state = newMatch(90210);
    await addClient(net, state, { id: 'host', slot: 0, isHost: true, scriptSeed: 5 });
    await addClient(net, state, { id: 'g1', slot: 1, scriptSeed: 6 });
    await addClient(net, state, { id: 'g2', slot: 2, scriptSeed: 7 });
    await addClient(net, state, { id: 'spec', slot: 100, spectator: true });

    const hitch = mulberry(3);
    const TICKS = 60 * 60 * 3;
    for (let i = 0; i < TICKS && !net.host.game.isGameOver; i++) tickAll(net, hitch);
    // Let the last frames reach everybody
    for (let i = 0; i < 120; i++) tickAll(net, hitch);

    const cmp = compareTurns(net);
    const { desyncs } = totals(net);
    const turns = net.host.game.turnManager.turnCounter;
    const lag = Math.max(...[...net.clients.values()].map(c => net.host.game.frame - c.game.frame));
    const commands = net.host.session.log.length;
    destroyAll(net);

    const pass = cmp.ok && desyncs === 0 && turns >= 6 && cmp.compared >= 12 && commands > 50;
    return {
        pass,
        detail: cmp.ok
            ? `${turns} turns, ${cmp.compared} turn checks identical on 4 clients, ${desyncs} desyncs, ${commands} commands, ${net.sent} messages, max lag ${lag} frames`
            : cmp.where
    };
}

async function lateSpectatorCatchesUp() {
    const net = new FakeNet(21);
    const state = newMatch(4711, 2);
    const host = await addClient(net, state, { id: 'host', slot: 0, isHost: true, scriptSeed: 15 });
    await addClient(net, state, { id: 'g1', slot: 1, scriptSeed: 16 });

    const hitch = mulberry(4);
    for (let i = 0; i < 60 * 22; i++) tickAll(net, hitch);
    if (host.game.isGameOver) return { pass: false, detail: 'match ended before the spectator could join' };

    // Arrives 22 seconds in: gets the match setup + the log so far
    const joinTurn = host.game.turnManager.turnCounter;
    const resume = JSON.parse(JSON.stringify(host.session.resumeData()));
    const loggedCommands = resume.log.length;
    const late = await addClient(net, state, { id: 'late', slot: 100, spectator: true, resume });

    for (let i = 0; i < 60 * 80 && !host.game.isGameOver; i++) tickAll(net, hitch);
    for (let i = 0; i < 120; i++) tickAll(net, hitch);

    const cmp = compareTurns(net, { from: joinTurn + 1 });
    const { desyncs } = totals(net);
    const behind = host.game.frame - late.game.frame;
    const lateTurns = [...late.turns.keys()].filter(t => t > joinTurn).length;
    destroyAll(net);

    const pass = cmp.ok && desyncs === 0 && lateTurns >= 2 && behind < 60;
    return {
        pass,
        detail: cmp.ok
            ? `joined at turn ${joinTurn} with ${loggedCommands} logged commands, replayed ${resume.confirmed} frames, then matched the host for ${lateTurns} turns (${behind} frames behind at the end, ${desyncs} desyncs)`
            : cmp.where
    };
}

async function corruptedClientIsRepaired() {
    const net = new FakeNet(31);
    const state = newMatch(1337, 2);
    const host = await addClient(net, state, { id: 'host', slot: 0, isHost: true, scriptSeed: 25 });
    const guest = await addClient(net, state, { id: 'g1', slot: 1, scriptSeed: 26 });

    const hitch = mulberry(5);
    for (let i = 0; i < 60 * 25; i++) tickAll(net, hitch);

    // Sabotage the guest: a koala in the wrong place with the wrong health,
    // a drifted RNG and a hole in the ground the host doesn't have
    const victim = guest.game.teams[0].koalas[0];
    victim.x += 37;
    victim.health -= 13;
    guest.game.seededRandom();
    guest.game.terrain.createCrater(victim.x, victim.y + 30, 40);
    const brokenAt = guest.game.turnManager.turnCounter;

    for (let i = 0; i < 60 * 90 && !host.game.isGameOver; i++) tickAll(net, hitch);
    for (let i = 0; i < 120; i++) tickAll(net, hitch);

    const repaired = guest.session.stats.repaired;
    // The turn right after the sabotage is where it gets caught; from the
    // one after that the guest must match the host again
    const cmp = compareTurns(net, { from: brokenAt + 2 });
    const turnsAfter = [...guest.turns.keys()].filter(t => t >= brokenAt + 2).length;
    const terrainEqual = guest.game.terrain.encodeMask().join() === host.game.terrain.encodeMask().join()
        || host.game.frame !== guest.game.frame; // only comparable on the same frame
    destroyAll(net);

    const pass = cmp.ok && repaired >= 1 && repaired <= 2 && turnsAfter >= 2 && terrainEqual;
    return {
        pass,
        detail: cmp.ok
            ? `sabotaged at turn ${brokenAt}; ${repaired} repair(s); identical to the host for the next ${turnsAfter} turns`
            : `${cmp.where} (${repaired} repairs)`
    };
}

async function vanishedPlayerIsForfeited() {
    const net = new FakeNet(41);
    const state = newMatch(2468, 3);
    const host = await addClient(net, state, { id: 'host', slot: 0, isHost: true, scriptSeed: 35 });
    const g1 = await addClient(net, state, { id: 'g1', slot: 1, scriptSeed: 36 });
    const g2 = await addClient(net, state, { id: 'g2', slot: 2, scriptSeed: 37 });

    const hitch = mulberry(6);
    // Run until it is g1's turn and they are a second into it
    let guard = 0;
    while (guard++ < 60 * 120) {
        tickAll(net, hitch);
        const g = g1.game;
        if (g.isMyTurn() && g.phase === 'aiming' && g.turnManager.turnTimer < g.turnManager.turnTime - 1) break;
    }

    // g1's tab dies mid-turn
    g1.gone = true;
    for (let i = 0; i < 200; i++) tickAll(net, hitch);
    const stuckFrame = host.game.frame;
    for (let i = 0; i < 120; i++) tickAll(net, hitch);
    const stalled = host.game.frame === stuckFrame;

    // The host gives up on them
    host.session.setAbsent(1, true);
    host.session.inject({ t: 'forfeit', team: 1, gone: true });

    const turnAtForfeit = host.game.turnManager.turnCounter;
    for (let i = 0; i < 60 * 60 && !host.game.isGameOver; i++) tickAll(net, hitch);
    for (let i = 0; i < 120; i++) tickAll(net, hitch);

    const cmp = compareTurns(net);
    const dead = !host.game.teams[1].isAlive() && !g2.game.teams[1].isAlive();
    const moved = host.game.turnManager.turnCounter - turnAtForfeit;
    const { desyncs } = totals(net);
    destroyAll(net);

    const pass = cmp.ok && stalled && dead && moved >= 2 && desyncs === 0;
    return {
        pass,
        detail: cmp.ok
            ? `match waited while the player was gone (${stalled ? 'yes' : 'NO'}), squad forfeited on both remaining clients (${dead ? 'yes' : 'NO'}), ${moved} more turns played, ${desyncs} desyncs`
            : cmp.where
    };
}

async function outOfStepClientIsPulledBack() {
    const net = new FakeNet(51);
    const state = newMatch(8642, 2);
    const host = await addClient(net, state, { id: 'host', slot: 0, isHost: true, scriptSeed: 45 });
    const guest = await addClient(net, state, { id: 'g1', slot: 1, scriptSeed: 46 });

    const hitch = mulberry(7);
    // Run until the guest is a moment into its own turn
    let guard = 0;
    while (guard++ < 60 * 120) {
        tickAll(net, hitch);
        const g = guest.game;
        if (g.isMyTurn() && g.phase === 'aiming' && g.turnManager.turnTimer < g.turnManager.turnTime - 1) break;
    }
    const brokenAt = guest.game.turnManager.turnCounter;

    // Only the guest's simulation ends the turn here. It hands over to the
    // host and waits for the host's turn check; the host, still mid-turn,
    // waits for the guest's frames. Without the beacon: a deadlock.
    guest.script = null;
    guest.game.endTurn();

    // The beacon runs on wall-clock time (a few seconds of silence)
    const t0 = performance.now();
    let deadlocked = false;
    while (performance.now() - t0 < 9000 && guest.session.stats.repaired === 0) {
        for (let i = 0; i < 30; i++) tickAll(net, hitch);
        if (host.game.turnManager.turnCounter === brokenAt && guest.session.awaiting !== null) deadlocked = true;
        await new Promise(r => setTimeout(r, 40));
    }
    const rescued = guest.session.stats.repaired > 0;
    guest.script = makePlayer(47);

    for (let i = 0; i < 60 * 60 && !host.game.isGameOver; i++) tickAll(net, hitch);
    for (let i = 0; i < 120; i++) tickAll(net, hitch);

    const cmp = compareTurns(net, { from: brokenAt + 1 });
    const turnsAfter = host.game.turnManager.turnCounter - brokenAt;
    destroyAll(net);

    const pass = cmp.ok && deadlocked && rescued && turnsAfter >= 2;
    return {
        pass,
        detail: cmp.ok
            ? `guest ended turn ${brokenAt} on its own (deadlock seen: ${deadlocked ? 'yes' : 'NO'}), host beacon pulled it back (${rescued ? 'yes' : 'NO'}), ${turnsAfter} more turns in step`
            : cmp.where
    };
}

export const LOCKSTEP_TESTS = [
    ['Online: 3 players + spectator stay identical (3 min, jittery network)', threePlayersStayIdentical],
    ['Online: spectator joining mid-match catches up from the log', lateSpectatorCatchesUp],
    ['Online: a corrupted client is detected and repaired from the host', corruptedClientIsRepaired],
    ['Online: a vanished player is forfeited and the match goes on', vanishedPlayerIsForfeited],
    ['Online: a client out of step in time is pulled back by the host', outOfStepClientIsPulledBack]
];
