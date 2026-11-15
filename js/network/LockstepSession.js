/**
 * LockstepSession - deterministic lockstep for online matches.
 *
 * THE MODEL
 * ---------
 * Every client runs the complete simulation itself. Nothing about the world
 * (positions, damage, craters, crates, turn changes) is ever sent over the
 * wire. The only thing that travels is the INPUT of whoever's turn it is:
 * the same small commands InputManager.dispatch() already produces for
 * replays ("press fire", "pointer at x,y", "select grenade"), each stamped
 * with the simulation frame it happened on.
 *
 * The simulation is deterministic (fixed 60 Hz step, seeded RNG streams,
 * collision mask edited with plain arithmetic), so feeding every client the
 * same commands on the same frames produces the same match everywhere — the
 * property the replay system and tests/determinism.test.js already rely on.
 * This is how Worms Armageddon and Hedgewars stay in sync, and it replaces
 * the old model where each client simulated on its own clock and the host
 * patched health/terrain/turn state after the fact.
 *
 * WHO STEPS WHEN
 * --------------
 *  - The DRIVER is the client whose squad has the turn. It steps in real
 *    time, with zero input delay, and streams "frames [a, b) are final, and
 *    these commands happened in them".
 *  - Everyone else only steps frames the driver has confirmed, so they
 *    trail by the network latency and can never run ahead or guess.
 *  - A turn change is itself part of the simulation: it happens on the same
 *    frame for everybody. The next driver takes over the moment it has
 *    played the previous driver's last frame.
 *
 * SAFETY NET
 * ----------
 * At the start of every turn each client fingerprints its world and the
 * host broadcasts its own fingerprint + snapshot. A guest waits for that
 * message before stepping into the new turn (it is already waiting for the
 * next driver anyway). If the fingerprints differ, the guest adopts the
 * host's snapshot right there, on the exact frame it was taken — a drift
 * (different browser engines can round a sine differently) is healed in one
 * turn instead of growing for the rest of the match.
 *
 * JOINING LATE
 * ------------
 * The host keeps the whole command log. A reconnecting player or a
 * spectator arriving mid-match rebuilds the world from the seed, replays
 * the log at full speed, then keeps following the live stream.
 *
 * TRANSPORT
 * ---------
 * Anything with { isHost, mySlot, isSpectator, send(msg), sendTo(peer, msg),
 * broadcastExcept(peer, msg) } — NetworkManager in the real game, a
 * loopback pipe in tests. Every message is { type: 'ls', k: <kind>, m:
 * <match tag>, ... }; the tag keeps a stray message from the previous match
 * out of a rematch.
 */

import { FIXED_DT } from '../engine/GameConstants.js';
import { log } from '../utils/Logger.js';
import { captureTurnState, hashTurnState, applyTurnState, diffTurnStates } from './StateSync.js';

const HOST_SLOT = 0;

// The driver confirms frames in batches this big (2 frames = 30 messages/s)
const SEND_EVERY = 2;
// Followers this far behind stop pacing themselves and catch up flat out
const CATCHUP_FRAMES = 90;
// Followers a little behind (a network hiccup) run slightly fast until level
const SMOOTH_FRAMES = 8;
// Wall-clock budget per tick while catching up (ms)
const CATCHUP_BUDGET_MS = 11;
// How long a guest waits for the host's terrain mask before moving on (ms)
const TERRAIN_WAIT_MS = 8000;
// Host: with no frames for this long from a driver who is still connected,
// publish our state so a client that has drifted out of step can rejoin it
const STALL_BEACON_MS = 3000;

// Compact command encoding: [frame, code, ...args] (same shape as replays)
const ENCODE = {
    press: (c) => ['p', c.a],
    release: (c) => ['r', c.a],
    pmove: (c) => ['m', c.x, c.y],
    pdown: (c) => ['d', c.x, c.y],
    pup: () => ['u'],
    rdown: () => ['R'],
    sel: (c) => ['s', c.id],
    // Out-of-band match command (forfeit); see inject()
    net: (c) => ['n', c.id, c.cmd]
};
const DECODE = {
    p: (e) => ({ t: 'press', a: e[2] }),
    r: (e) => ({ t: 'release', a: e[2] }),
    m: (e) => ({ t: 'pmove', x: e[2], y: e[3] }),
    d: (e) => ({ t: 'pdown', x: e[2], y: e[3] }),
    u: () => ({ t: 'pup' }),
    R: () => ({ t: 'rdown' }),
    s: (e) => ({ t: 'sel', id: e[2] }),
    n: (e) => ({ t: 'net', id: e[2], cmd: e[3] })
};

/** Audio stand-in while fast-forwarding: every call is a silent no-op. */
const SILENT_AUDIO = new Proxy({}, {
    get: () => () => null,
    set: () => true
});

export class LockstepSession {
    /**
     * @param {Game} game
     * @param {Object} transport - see the file header
     * @param {Object} options
     * @param {Array} options.players - gameState.players: teams[i] belongs to players[i].slot
     * @param {number} options.tag - identifies the match (its seed)
     * @param {Object} [options.resume] - { log, confirmed, sync } when joining a running match
     */
    constructor(game, transport, { players, tag = 0, resume = null } = {}) {
        this.game = game;
        this.transport = transport;
        this.players = players || [];
        this.tag = tag;

        this.isHost = !!transport.isHost;
        this.mySlot = transport.mySlot;
        this.isSpectator = !!transport.isSpectator;

        // Canonical command log, ascending by frame. The host's copy is what
        // late joiners replay; everyone else only reads it forward.
        this.log = [];
        this.readIndex = 0;

        // Frames [0, confirmed) are final and may be stepped by anyone
        this.confirmed = 0;

        // Driver side: first frame not yet announced, and the commands in it
        this.outFrom = 0;
        this.outCmds = [];

        // Turn checksums. turnPending: a turn started inside the frame being
        // stepped; it is fingerprinted once that frame is complete.
        this.turnPending = null;
        this.awaiting = null;         // guest: turn we need the host's sync for
        this.localSync = null;        // our own snapshot of that turn
        this.hostSyncs = new Map();   // turn -> { turn, frame, hash, state }
        this.terrainWait = null;      // { turn, since } while fetching the host's mask
        this.resumeTurn = 0;          // turns before this are history: don't wait

        // Out-of-band commands waiting for a driver to put them in the stream
        this.pendingInject = new Map();
        this.appliedInject = new Set();
        this.injectSeq = 0;
        // Host: slots whose player is currently disconnected
        this.absent = new Set();

        this.fastForward = false;
        this.realAudio = null;
        this.destroyed = false;
        this.lastBeaconAt = 0;

        // Diagnostics (shown by the in-game net indicator)
        this.stats = { desyncs: 0, repaired: 0, lastFrameAt: 0, stalledFor: 0 };

        // UI hooks
        this.onDesync = null;      // ({ turn, sections })
        this.onCatchUp = null;     // (progress 0..1 | null when done)
        this.onBroken = null;      // () the stream is unusable: rejoin

        if (resume) {
            this.log = resume.log || [];
            this.confirmed = resume.confirmed || 0;
            this.outFrom = this.confirmed;
            if (resume.sync) {
                this.hostSyncs.set(resume.sync.turn, resume.sync);
                this.resumeTurn = resume.sync.turn;
            }
            this.catchUpTotal = this.confirmed;
        }
    }

    // ==================== SENDING ====================

    /** To the host (guest) or to every guest (host). */
    send(k, body) {
        this.transport.send({ type: 'ls', k, m: this.tag, ...body });
    }

    /** Host: to one guest. */
    sendTo(peer, k, body) {
        this.transport.sendTo(peer, { type: 'ls', k, m: this.tag, ...body });
    }

    // ==================== WHO IS WHO ====================

    /** Slot of the player whose client produces the frames right now. */
    driverSlot() {
        const g = this.game;
        const team = g.teams[g.currentTeamIndex];
        const owner = this.players[g.currentTeamIndex]?.slot;
        // A squad whose player left for good is played out by the host
        if (!team || team.forfeited || owner === undefined) return HOST_SLOT;
        return owner;
    }

    isDriver() {
        return !this.isSpectator && this.driverSlot() === this.mySlot;
    }

    isMyTeam(teamIndex) {
        return !this.isSpectator && this.players[teamIndex]?.slot === this.mySlot;
    }

    /** True once we have played every frame anyone has confirmed. */
    isLive() {
        return this.game.frame >= this.confirmed;
    }

    /**
     * May the local player's input enter the simulation right now? Only the
     * driver's does, and only once it is up to date and past the turn check.
     */
    acceptsLocalInput() {
        return !this.destroyed && this.isLive() && this.isDriver() &&
            this.awaiting === null && this.turnPending === null && !this.game.isGameOver;
    }

    // ==================== LOCAL INPUT (driver) ====================

    /**
     * Called by InputManager.dispatch for a command it is about to apply.
     * Stamps it with the frame it takes effect on and queues it for sending.
     */
    recordLocal(cmd) {
        const enc = ENCODE[cmd.t];
        if (!enc) return;
        const frame = this.game.frame;
        const entry = [frame, ...enc(cmd)];

        // Pointer moves only matter by their last value before a frame
        const last = this.outCmds[this.outCmds.length - 1];
        if (entry[1] === 'm' && last && last[0] === frame && last[1] === 'm') {
            this.outCmds[this.outCmds.length - 1] = entry;
            this.log[this.log.length - 1] = entry;
            return;
        }
        this.outCmds.push(entry);
        this.log.push(entry);
        // Our own commands are applied at dispatch time, never re-read
        this.readIndex = this.log.length;
    }

    /** Announce the frames we have stepped as driver since the last send. */
    flush() {
        const b = this.game.frame;
        if (b <= this.outFrom && this.outCmds.length === 0) return;

        // Commands stamped with frame b belong to the next batch
        let split = this.outCmds.length;
        while (split > 0 && this.outCmds[split - 1][0] >= b) split--;
        const cmds = this.outCmds.slice(0, split);
        this.outCmds = this.outCmds.slice(split);

        if (b === this.outFrom && cmds.length === 0) return;
        this.send('f', { a: this.outFrom, b, c: cmds });
        this.outFrom = b;
    }

    // ==================== STEPPING ====================

    /**
     * Advance the simulation. Called from the game loop with the real time
     * that has built up; returns the time left over.
     */
    pump(accumulator) {
        const g = this.game;
        if (this.destroyed || g.isGameOver) return 0;

        const backlog = this.confirmed - g.frame;
        this.setFastForward(backlog > CATCHUP_FRAMES);

        let budget;
        let deadline = 0;
        if (this.fastForward) {
            budget = Infinity;
            deadline = performance.now() + CATCHUP_BUDGET_MS;
            accumulator = 0;
        } else {
            budget = Math.floor(accumulator / FIXED_DT);
            accumulator -= budget * FIXED_DT;
            // A little behind after a hiccup: run slightly fast until level
            if (backlog > SMOOTH_FRAMES && budget > 0) budget++;
        }

        let stepped = 0;
        let starved = false;
        while (budget > 0 && !g.isGameOver && !g.simFrozen()) {
            if (this.blockedOnSync()) { starved = true; break; }

            if (g.frame < this.confirmed) {
                // Follow: replay the confirmed frame with its commands
                this.applyLogUpTo(g.frame);
                g.update(FIXED_DT);
            } else if (this.canDrive()) {
                // Drive: our input for this frame was applied as it arrived
                this.authorPendingInjects();
                g.update(FIXED_DT);
                this.confirmed = g.frame;
            } else {
                starved = true;
                break;
            }

            budget--;
            stepped++;
            this.afterFrame();
            if (deadline && (stepped & 15) === 0 && performance.now() > deadline) break;
        }

        // Everything we stepped as driver goes out — at once when the turn
        // just passed to someone else, so they can take over without a wait
        if (this.outFrom < g.frame || this.outCmds.length) {
            if (!this.canDrive() || g.frame - this.outFrom >= SEND_EVERY || g.isGameOver) this.flush();
        }

        const now = performance.now();
        if (stepped > 0) {
            this.stats.lastFrameAt = now;
            this.stats.stalledFor = 0;
        } else if (starved) {
            if (!this.stats.lastFrameAt) this.stats.lastFrameAt = now;
            this.stats.stalledFor = now - this.stats.lastFrameAt;
            this.maybeSendBeacon(now);
        }

        if (this.fastForward) {
            this.onCatchUp?.(this.catchUpTotal ? Math.min(1, g.frame / this.catchUpTotal) : 0);
        }

        // While waiting for frames keep at most a few steps of time in the
        // bank: enough to smooth over jitter, not enough to lurch forward
        if (starved) accumulator = Math.min(accumulator, FIXED_DT * 4);
        return accumulator;
    }

    /**
     * Host: nobody has produced a frame for a while although the driver is
     * connected. In a healthy match that just means a slow or backgrounded
     * player — but it is also what a client that has fallen out of step
     * looks like (it believes the turn already changed and is waiting for
     * us, while we wait for it). Publishing our state lets it rejoin us.
     */
    maybeSendBeacon(now) {
        if (!this.isHost || this.stats.stalledFor < STALL_BEACON_MS) return;
        if (now - this.lastBeaconAt < STALL_BEACON_MS) return;
        if (!this.isLive() || this.absent.has(this.driverSlot())) return;
        this.lastBeaconAt = now;

        const state = captureTurnState(this.game);
        this.send('bc', {
            turn: this.game.turnManager.turnCounter,
            frame: this.game.frame,
            hash: hashTurnState(state),
            state
        });
    }

    /** Guest: the host says where the match stands while it waits for frames. */
    onBeacon(msg) {
        if (this.isHost) return;
        // Only a client that is itself stuck takes this: one that is busy
        // producing or playing frames is simply ahead of the message
        const stuck = this.awaiting !== null || this.stats.stalledFor > 1000;
        if (!stuck) return;

        const g = this.game;
        if (g.frame === msg.frame && hashTurnState(captureTurnState(g)) === msg.hash) return;

        console.warn(`[lockstep] out of step with the host (frame ${g.frame} vs ${msg.frame}) — rejoining its state`);
        this.stats.desyncs++;
        this.stats.repaired++;
        const sections = diffTurnStates(captureTurnState(g), msg.state);
        this.adoptHostState(msg);

        // The host has seen nothing past this frame: forget what we had
        while (this.log.length && this.log[this.log.length - 1][0] >= msg.frame) this.log.pop();
        this.readIndex = this.log.length;
        this.confirmed = msg.frame;
        this.outFrom = msg.frame;
        this.outCmds = [];
        this.turnPending = null;
        this.terrainWait = null;
        this.awaiting = null;
        this.localSync = null;
        this.onDesync?.({ turn: msg.turn, sections });

        if (sections.includes('terrain')) {
            // Hold at this frame until the host's mask is in
            this.awaiting = msg.turn;
            this.terrainWait = { turn: msg.turn, since: performance.now() };
            this.send('tr', { turn: msg.turn });
        }
    }

    /**
     * Take over the host's snapshot, including its position in time: if we
     * reached this point on a different frame, the commands logged from the
     * host's frame on are (re)played against the host's world.
     */
    adoptHostState(sync) {
        applyTurnState(this.game, sync.state);
        let i = 0;
        while (i < this.log.length && this.log[i][0] < sync.frame) i++;
        this.readIndex = i;
    }

    /** We are the driver and nothing stops us from producing the next frame. */
    canDrive() {
        if (this.game.frame < this.confirmed) return false;
        if (this.isDriver()) return true;
        // The host stands in for a driver who is gone, but only to deliver
        // the forfeit that hands their turn on
        return this.isHost && this.pendingInject.size > 0 && this.absent.has(this.driverSlot());
    }

    /** Feed the simulation every logged command up to and including `frame`. */
    applyLogUpTo(frame) {
        const logEntries = this.log;
        while (this.readIndex < logEntries.length && logEntries[this.readIndex][0] <= frame) {
            const e = logEntries[this.readIndex++];
            const dec = DECODE[e[1]];
            if (!dec) continue;
            const cmd = dec(e);
            if (cmd.t === 'net') this.applyNetCommand(cmd);
            else this.game.inputManager.applyCommand(cmd);
        }
    }

    /** Bookkeeping after each completed simulation frame. */
    afterFrame() {
        if (this.turnPending === null) return;
        const turn = this.turnPending;
        this.turnPending = null;

        const state = captureTurnState(this.game);
        const sync = { turn, frame: this.game.frame, hash: hashTurnState(state), state };

        if (this.isHost) {
            // The host is the reference: publish, never wait
            this.hostSyncs.set(turn, sync);
            this.hostSyncs.delete(turn - 3);
            this.send('ts', { turn, frame: sync.frame, hash: sync.hash, state });
        } else if (turn >= this.resumeTurn) {
            this.localSync = sync;
            this.awaiting = turn;
        }
    }

    /** Called by TurnManager.startTurn (inside a simulation frame). */
    onTurnStart(turn) {
        this.turnPending = turn;
    }

    /**
     * Guest: at a turn start, hold until the host's fingerprint for that
     * turn is in, compare, and repair if needed. Returns true while held.
     */
    blockedOnSync() {
        if (this.awaiting === null) return false;

        if (this.terrainWait) {
            if (performance.now() - this.terrainWait.since < TERRAIN_WAIT_MS) return true;
            console.warn('[lockstep] host terrain never arrived — continuing without it');
            this.terrainWait = null;
            this.finishSync();
            return false;
        }

        const host = this.hostSyncs.get(this.awaiting);
        if (!host) return true;

        const mine = this.localSync;
        if (host.hash === mine.hash) {
            this.finishSync();
            return false;
        }

        // Out of sync with the host. Adopt its world, on this exact frame.
        const sections = diffTurnStates(mine.state, host.state);
        this.stats.desyncs++;
        console.warn(`[lockstep] turn ${host.turn}: state differs from host in [${sections.join(', ')}] — repairing`);
        this.send('ds', { turn: host.turn, sections });

        this.adoptHostState(host);
        this.stats.repaired++;
        this.onDesync?.({ turn: host.turn, sections });

        if (sections.includes('terrain')) {
            this.terrainWait = { turn: host.turn, since: performance.now() };
            this.send('tr', { turn: host.turn });
            return true;
        }
        this.finishSync();
        return false;
    }

    finishSync() {
        this.hostSyncs.delete(this.awaiting);
        this.awaiting = null;
        this.localSync = null;
    }

    setFastForward(on) {
        if (on === this.fastForward) return;
        this.fastForward = on;
        const g = this.game;
        if (on) {
            this.realAudio = g.audioManager;
            g.audioManager = SILENT_AUDIO;
            if (!this.catchUpTotal) this.catchUpTotal = this.confirmed;
        } else {
            g.audioManager = this.realAudio;
            this.realAudio = null;
            this.catchUpTotal = 0;
            g.particles.length = 0;
            g.audioManager.voicePack = g.getCurrentTeam()?.style?.voice;
            this.onCatchUp?.(null);
        }
    }

    // ==================== OUT-OF-BAND COMMANDS ====================

    /**
     * Put a match command into the simulation that is NOT the current
     * player's input — today that is only a forfeit (a player left, or an
     * eliminated player's squad is being retired). The command is handed to
     * every client; whoever drives next writes it into the stream, so it
     * still lands on one agreed frame.
     */
    inject(cmd) {
        if (!this.isHost) return;
        const id = `i${++this.injectSeq}`;
        this.pendingInject.set(id, cmd);
        this.send('inj', { id, cmd });
    }

    authorPendingInjects() {
        if (this.pendingInject.size === 0) return;
        for (const [id, cmd] of this.pendingInject) {
            const wrapped = { t: 'net', id, cmd };
            this.recordLocal(wrapped);
            this.applyNetCommand(wrapped);
        }
    }

    applyNetCommand({ id, cmd }) {
        this.pendingInject.delete(id);
        if (this.appliedInject.has(id)) return;
        this.appliedInject.add(id);

        if (cmd?.t === 'forfeit') {
            const g = this.game;
            const team = g.teams[cmd.team];
            if (!team) return;
            g.forfeitTeam(cmd.team);
            // gone: the player is not coming back — the host plays out
            // whatever is left of this squad's turn (see driverSlot)
            if (cmd.gone) team.forfeited = true;
            const alive = g.teams.filter(t => t.isAlive());
            if (g.countAliveAlliances(alive) <= 1) g.endGame(alive[0] || null);
        }
    }

    /** Host: a player's connection dropped / came back. */
    setAbsent(slot, absent) {
        if (absent) this.absent.add(slot);
        else this.absent.delete(slot);
    }

    // ==================== MESSAGES ====================

    handleMessage(msg, fromPeer = null) {
        if (this.destroyed || !msg || msg.m !== this.tag) return;
        switch (msg.k) {
            case 'f': this.onFrames(msg, fromPeer); break;
            case 'ts':
                if (!this.isHost) {
                    this.hostSyncs.set(msg.turn, msg);
                    // Turns we are already past will never be checked again
                    const current = this.game.turnManager.turnCounter;
                    for (const turn of this.hostSyncs.keys()) {
                        if (turn < current) this.hostSyncs.delete(turn);
                    }
                }
                break;
            case 'bc': this.onBeacon(msg); break;
            case 'rs': if (!this.isHost) this.onBroken?.(); break;
            case 'tr': this.onTerrainRequest(msg, fromPeer); break;
            case 'tt': this.onTerrain(msg); break;
            case 'inj':
                if (!this.isHost && !this.appliedInject.has(msg.id)) this.pendingInject.set(msg.id, msg.cmd);
                break;
            case 'ds':
                if (this.isHost) {
                    this.stats.desyncs++;
                    console.warn(`[lockstep] a guest repaired a desync at turn ${msg.turn}: [${(msg.sections || []).join(', ')}]`);
                }
                break;
        }
    }

    onFrames(msg, fromPeer) {
        if (!Array.isArray(msg.c) || !(msg.b >= msg.a)) return;

        if (msg.a !== this.confirmed) {
            if (msg.b <= this.confirmed) return; // duplicate of frames we have
            console.error(`[lockstep] frame gap: have ${this.confirmed}, got [${msg.a}, ${msg.b})`);
            // The sender's stream no longer lines up with the match: it has
            // to rebuild from the host's log
            if (this.isHost && fromPeer) this.sendTo(fromPeer, 'rs', {});
            else this.onBroken?.();
            return;
        }

        for (const e of msg.c) this.log.push(e);
        this.confirmed = msg.b;
        this.outFrom = msg.b;

        // Star topology: the host passes a guest's frames on to the others
        if (this.isHost && fromPeer) this.transport.broadcastExcept(fromPeer, msg);
    }

    onTerrainRequest(msg, fromPeer) {
        if (!this.isHost || !fromPeer) return;
        const sync = this.hostSyncs.get(msg.turn);
        const terrain = this.game.terrain;
        this.sendTo(fromPeer, 'tt', {
            turn: msg.turn,
            runs: terrain.encodeMask(),
            // Count edits from where that turn started: any edit made since
            // is replayed by the guest anyway (carving a hole twice is
            // harmless)
            hashes: sync ? sync.state.terrain : [terrain.baseHash, terrain.opHash, terrain.opCount]
        });
    }

    onTerrain(msg) {
        if (!this.terrainWait || msg.turn !== this.terrainWait.turn) return;
        log.debug('[lockstep] applying host terrain mask');
        this.game.terrain.applyMask(msg.runs, msg.hashes);
        this.terrainWait = null;
        this.finishSync();
    }

    /** One-line status for the in-game network indicator. */
    status() {
        if (this.fastForward) return 'catching up';
        if (this.terrainWait) return 'syncing map';
        if (this.stats.stalledFor > 1500 && !this.game.isPaused) return 'waiting';
        return 'ok';
    }

    /** Host: everything a late joiner needs to rebuild the match so far. */
    resumeData() {
        // Announce what we have stepped first, so the joiner's copy ends
        // exactly where the next batch it receives begins
        this.flush();
        const confirmed = this.confirmed;

        // Commands stamped with the frame after that are still to come
        let end = this.log.length;
        while (end > 0 && this.log[end - 1][0] >= confirmed) end--;

        let sync = null;
        for (const s of this.hostSyncs.values()) {
            if (!sync || s.turn > sync.turn) sync = s;
        }
        return { log: this.log.slice(0, end), confirmed, sync };
    }

    destroy() {
        this.setFastForward(false);
        this.destroyed = true;
    }
}
