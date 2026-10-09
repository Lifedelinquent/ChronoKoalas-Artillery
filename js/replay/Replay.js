/**
 * Replays - record a local match as (seed + setup + input commands) and
 * play it back by re-running the simulation.
 *
 * Why this works: a local game is fully deterministic. The map, wind,
 * weapon spread, crates and CPU decisions all come from RNG streams seeded
 * by the match seed (Game.start), the world steps at a fixed dt, and every
 * human input reaches the simulation through InputManager.dispatch() as a
 * small command. So a replay only stores the setup and the commands with
 * the frame they arrived on; playback feeds each command back in right
 * before that frame and the match unfolds exactly as it did.
 *
 * Multiplayer matches are not recorded: remote players' actions arrive as
 * network messages that also patch state directly (explosion sync, turn
 * starts), which a local re-simulation can't reproduce.
 */

import { log } from '../utils/Logger.js';

export const REPLAY_FORMAT = 'koala-replay';
export const REPLAY_VERSION = 1;

// Compact command encoding: [frame, code, ...args]
const ENCODE = {
    press: (c) => ['p', c.a],
    release: (c) => ['r', c.a],
    pmove: (c) => ['m', c.x, c.y],
    pdown: (c) => ['d', c.x, c.y],
    pup: () => ['u'],
    rdown: () => ['R'],
    sel: (c) => ['s', c.id]
};
const DECODE = {
    p: (e) => ({ t: 'press', a: e[2] }),
    r: (e) => ({ t: 'release', a: e[2] }),
    m: (e) => ({ t: 'pmove', x: e[2], y: e[3] }),
    d: (e) => ({ t: 'pdown', x: e[2], y: e[3] }),
    u: () => ({ t: 'pup' }),
    R: () => ({ t: 'rdown' }),
    s: (e) => ({ t: 'sel', id: e[2] })
};

/**
 * Records the commands of a running local game.
 */
export class ReplayRecorder {
    constructor(game, meta = {}) {
        this.game = game;
        this.meta = meta;
        this.events = [];
    }

    record(cmd) {
        const enc = ENCODE[cmd.t];
        if (!enc) return;
        const frame = this.game.frame || 0;
        const entry = [frame, ...enc(cmd)];

        // Pointer moves only matter by their LAST value before a frame
        // (InputManager.updateAimFromPointer is threshold-free), so a burst
        // of mousemoves between two frames collapses into one entry
        const last = this.events[this.events.length - 1];
        if (entry[1] === 'm' && last && last[0] === frame && last[1] === 'm') {
            this.events[this.events.length - 1] = entry;
            return;
        }
        this.events.push(entry);
    }

    /** The finished replay object (call after the game ended or any time). */
    build(result = null) {
        const g = this.game;
        return {
            format: REPLAY_FORMAT,
            version: REPLAY_VERSION,
            id: `replay_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
            createdAt: new Date().toISOString(),
            title: this.meta.title || 'Match',
            mode: this.meta.mode || 'hotseat',
            seed: g.gameSeed,
            scheme: g.scheme,
            teamsConfig: g.options.teamsConfig || null,
            teamStyles: g.options.teamStyles || null,
            customMap: g.options.customMap || null,
            frames: g.frame,
            teams: g.teams.map(t => ({ name: t.name, color: t.color })),
            result: result ? {
                winner: result.winner ? { name: result.winner.name, color: result.winner.color } : null
            } : null,
            events: this.events
        };
    }
}

/**
 * Feeds a replay's commands into a game created from the replay's setup.
 * Game.update() calls beforeFrame(frame) at the start of every step.
 */
export class ReplayPlayer {
    constructor(game, replay) {
        this.game = game;
        this.replay = replay;
        this.events = replay.events || [];
        this.index = 0;
    }

    beforeFrame(frame) {
        const events = this.events;
        while (this.index < events.length && events[this.index][0] <= frame) {
            const e = events[this.index++];
            const dec = DECODE[e[1]];
            if (dec) this.game.inputManager.applyCommand(dec(e));
        }
    }

    get progress() {
        const total = this.replay.frames || 1;
        return Math.min(1, (this.game.frame || 0) / total);
    }
}

/** Validate an imported replay file. Returns an error string or null. */
export function validateReplay(data) {
    if (!data || data.format !== REPLAY_FORMAT) return 'Not a Koala Artillery replay file.';
    if (data.version > REPLAY_VERSION) return 'This replay was made by a newer version of the game.';
    if (!Array.isArray(data.events) || typeof data.seed !== 'number') return 'Replay file is damaged.';
    return null;
}

/**
 * IndexedDB storage for saved replays. Separate database from the maps so
 * neither schema has to migrate for the other.
 */
export class ReplayStore {
    static DB_NAME = 'koala_artillery_replays';
    static STORE = 'replays';
    static MAX_SAVED = 30;   // oldest auto-saved replays are pruned past this
    static _db = null;

    static _open() {
        if (this._db) return Promise.resolve(this._db);
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.DB_NAME, 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.STORE)) {
                    db.createObjectStore(this.STORE, { keyPath: 'id' });
                }
            };
            req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    static async _tx(mode, fn) {
        const db = await this._open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE, mode);
            const result = fn(tx.objectStore(this.STORE));
            tx.oncomplete = () => resolve(result?.result ?? result);
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    static async save(replay) {
        try {
            await this._tx('readwrite', store => store.put(replay));
            await this.prune();
            log.debug('🎬 Replay saved:', replay.id);
        } catch (e) {
            console.warn('Failed to save replay:', e);
        }
    }

    /** Newest first. Each entry is the full replay object. */
    static async list() {
        try {
            const all = await this._tx('readonly', store => store.getAll());
            return (all || []).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        } catch (e) {
            console.warn('Failed to list replays:', e);
            return [];
        }
    }

    static async remove(id) {
        try {
            await this._tx('readwrite', store => store.delete(id));
        } catch (e) {
            console.warn('Failed to delete replay:', e);
        }
    }

    static async prune() {
        const all = await this.list();
        const unpinned = all.filter(r => !r.pinned);
        for (const r of unpinned.slice(this.MAX_SAVED)) {
            await this.remove(r.id);
        }
    }

    /** Download a replay as a .koalareplay file. */
    static download(replay) {
        const blob = new Blob([JSON.stringify(replay)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const date = (replay.createdAt || '').slice(0, 10);
        a.download = `${(replay.title || 'replay').replace(/[^a-z0-9]+/gi, '_')}_${date}.koalareplay`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }
}
