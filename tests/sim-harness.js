/**
 * Headless simulation harness for tests.
 *
 * Builds a Game with no render loop and no input listeners, steps it with
 * the fixed simulation dt and fingerprints the world state. Two runs with
 * the same seed, teams and inputs must produce identical fingerprints at
 * every checkpoint — that's the property multiplayer lockstep and replays
 * depend on.
 */

import { Game } from '../js/engine/Game.js';
import { FIXED_DT } from '../js/engine/GameConstants.js';

/** FNV-1a over the exact bit patterns of a list of numbers. */
export function hashNumbers(nums) {
    const f64 = new Float64Array(1);
    const u32 = new Uint32Array(f64.buffer);
    let h = 0x811C9DC5;
    for (const n of nums) {
        f64[0] = typeof n === 'number' ? n : (n ? 1 : 0);
        for (let i = 0; i < 2; i++) {
            let w = u32[i];
            for (let b = 0; b < 4; b++) {
                h ^= w & 0xFF;
                h = Math.imul(h, 0x01000193) >>> 0;
                w >>>= 8;
            }
        }
    }
    return h.toString(16).padStart(8, '0');
}

/** Everything that matters for the outcome of a match, as numbers. */
export function snapshotNumbers(game) {
    const out = [game.frame, game.turnManager.turnCounter, game.currentTeamIndex,
        game.currentKoalaIndex, game.wind, game.waterLevel, game.turnManager.roundNumber];
    for (const team of game.teams) {
        for (const k of team.koalas) {
            out.push(k.x, k.y, k.vx, k.vy, k.health, k.isAlive, k.aimAngle);
        }
        for (const id in team.weapons) {
            const a = team.weapons[id].ammo;
            out.push(a === Infinity ? -1 : a);
        }
    }
    for (const p of game.projectiles) out.push(p.x, p.y, p.vx, p.vy, p.stationary);
    for (const c of game.lootManager.crates) out.push(c.x, c.y);
    for (const d of game.oilDrums) out.push(d.x, d.y, d.hp);
    for (const f of game.firePatches) out.push(f.x, f.y);
    return out;
}

/** Cheap terrain fingerprint: every 7th collision-mask alpha byte. */
export function terrainHash(game) {
    const data = game.terrain.imageData.data;
    let h = 0x811C9DC5;
    for (let i = 3; i < data.length; i += 4 * 7) {
        h ^= data[i];
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

export function fingerprint(game) {
    return hashNumbers(snapshotNumbers(game)) + ':' + terrainHash(game);
}

/**
 * Create and start a headless game. `options` are normal Game options
 * (seed, teamsConfig, scheme, replay ...); headless + isPractice are forced.
 */
export async function createHeadlessGame(options) {
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 540;
    const game = new Game(canvas, { ...options, isPractice: true, headless: true });
    await game.start();
    return game;
}

/**
 * Step a game until it ends or maxFrames pass, fingerprinting every
 * `every` frames. `onFrame(game)` (optional) runs before each step — tests
 * use it to inject scripted input.
 */
export function runGame(game, { maxFrames = 60 * 60 * 4, every = 300, onFrame = null } = {}) {
    const checkpoints = [];
    for (let i = 0; i < maxFrames && !game.isGameOver; i++) {
        onFrame?.(game);
        game.update(FIXED_DT);
        if (game.frame % every === 0) checkpoints.push(fingerprint(game));
    }
    checkpoints.push(fingerprint(game));
    return {
        checkpoints,
        frames: game.frame,
        turns: game.turnManager.turnCounter,
        over: game.isGameOver
    };
}
