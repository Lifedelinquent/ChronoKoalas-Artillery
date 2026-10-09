/**
 * InstantReplay - WA-style "replay the shot" after a turn that killed a koala.
 *
 * This is a visual recording, not a re-simulation: from the moment a shot
 * is fired until the turn ends, every frame snapshots what the renderer
 * draws (koalas, projectiles, particles, hazards, camera) and every terrain
 * edit. If a koala died during that window, the next turn is held back
 * while the recording plays through the normal Renderer — pointed at a
 * "ghost" view of the recorded state — with slow motion around explosions.
 *
 * Local games only (single player / hotseat): pausing one multiplayer
 * client for a few seconds would leave it behind the others.
 */

import { Terrain } from '../engine/Terrain.js';
import { getSettings } from '../utils/Settings.js';

const MAX_FRAMES = 60 * 20;     // keep at most the last 20 s of a turn
const MIN_FRAMES = 30;          // too short to be worth replaying
const SLOWMO_RATE = 0.35;       // playback speed around explosions
const SLOWMO_WINDOW = 18;       // frames either side of a blast

const copy = (o) => Object.assign({}, o);

export class InstantReplay {
    constructor(game) {
        this.game = game;
        this.recording = false;
        this.playing = false;
        this.frames = [];
        this.pendingOps = [];
        this.baseCanvas = null;
        this.turn = -1;
        this.aliveAtStart = null;

        game.terrain.onModify = (op) => {
            if (this.recording) this.pendingOps.push(op);
        };
    }

    static isEnabledFor(game) {
        return !game.options.headless && (game.isPractice || !game.networkManager) &&
            getSettings().instantReplay !== false;
    }

    isPlaying() {
        return this.playing;
    }

    /** Called from fireWeapon / fireTargettedWeapon. */
    onShotFired() {
        const g = this.game;
        const weapon = g.weaponManager.currentWeapon;
        if (weapon?.utility || this.playing) return;
        // Second shotgun shell etc. keep the same recording going
        if (this.recording && this.turn === g.turnManager.turnCounter) return;

        const src = g.terrain.canvas;
        if (!this.baseCanvas) {
            this.baseCanvas = document.createElement('canvas');
            this.baseCanvas.width = src.width;
            this.baseCanvas.height = src.height;
        }
        const ctx = this.baseCanvas.getContext('2d');
        ctx.clearRect(0, 0, src.width, src.height);
        ctx.drawImage(src, 0, 0);

        this.frames = [];
        this.pendingOps = [];
        this.turn = g.turnManager.turnCounter;
        this.aliveAtStart = g.teams.flatMap(t => t.koalas.filter(k => k.isAlive));
        this.recording = true;
    }

    /** End of every Game.update while recording. */
    captureFrame() {
        if (!this.recording) return;
        const g = this.game;

        // A recording that ran into the next turn without a kill is stale
        if (g.turnManager.turnCounter !== this.turn) {
            this.recording = false;
            this.frames = [];
            return;
        }

        const koalas = [];
        const koalaIndex = new Map();
        for (const team of g.teams) {
            for (const k of team.koalas) {
                koalaIndex.set(k, koalas.length);
                koalas.push(copy(k));
            }
        }

        let rope = null;
        if (g.ropeState) {
            rope = {
                ...g.ropeState,
                hook: copy(g.ropeState.hook),
                pivots: g.ropeState.pivots ? g.ropeState.pivots.map(copy) : null,
                koalaIdx: koalaIndex.get(g.ropeState.koala)
            };
        }

        const cam = g.camera;
        this.frames.push({
            koalas,
            current: koalaIndex.get(g.getCurrentKoala()) ?? -1,
            projectiles: g.projectiles.map(copy),
            particles: g.particles.map(copy),
            firePatches: g.firePatches.map(copy),
            oilDrums: g.oilDrums.map(copy),
            graves: g.graves.map(copy),
            crates: g.lootManager.crates.map(copy),
            rope,
            camera: {
                x: cam.x, y: cam.y, zoom: cam.zoom,
                shake: cam.shake ? copy(cam.shake) : null
            },
            waterLevel: g.waterLevel,
            wind: g.wind,
            weapon: g.weaponManager.currentWeapon,
            ops: this.pendingOps
        });
        this.pendingOps = [];

        // Ring buffer: fold the oldest frame's terrain edits into the base
        if (this.frames.length > MAX_FRAMES) {
            const old = this.frames.shift();
            this.applyOps(this.baseTerrainView(), old.ops);
        }
    }

    /** Should the turn that just finished be replayed? */
    shouldPlay() {
        if (!this.recording || this.playing) return false;
        if (this.frames.length < MIN_FRAMES) return false;
        return this.aliveAtStart.some(k => !k.isAlive);
    }

    /** Stop recording (turn over) without playing. */
    discard() {
        this.recording = false;
        this.frames = [];
    }

    // -------------------------------------------------------------- playback

    baseTerrainView() {
        return this.makeTerrainView(this.baseCanvas);
    }

    /** A Terrain-shaped object over `canvas` that draws edits but has no mask. */
    makeTerrainView(canvas) {
        const view = Object.create(Terrain.prototype);
        view.canvas = canvas;
        view.ctx = canvas.getContext('2d');
        view.width = canvas.width;
        view.height = canvas.height;
        view.theme = this.game.terrain.theme;
        view.updateCollisionMask = () => {};
        view.checkCollision = () => false;
        return view;
    }

    applyOps(view, ops) {
        for (const op of ops) {
            if (op.type === 'crater') {
                Terrain.prototype.createCrater.call(view, op.x, op.y, op.r, false);
            } else if (op.type === 'girder') {
                Terrain.prototype.addGirder.call(view, op.x, op.y, op.w, op.h);
            }
        }
    }

    /**
     * Play the recording, then call onDone. The game loop routes frames to
     * tick() while playing, so the simulation is frozen meanwhile.
     */
    play(onDone) {
        this.recording = false;
        this.playing = true;
        this.onDone = onDone;
        this.cursor = 0;

        // Playback terrain starts from the base snapshot
        const playCanvas = document.createElement('canvas');
        playCanvas.width = this.baseCanvas.width;
        playCanvas.height = this.baseCanvas.height;
        playCanvas.getContext('2d').drawImage(this.baseCanvas, 0, 0);
        this.view = this.makeTerrainView(playCanvas);
        this.appliedUpTo = -1;

        // Frames near a blast play in slow motion
        const boom = this.frames.map(f => f.ops.some(op => op.type === 'crater' && op.r >= 24));
        this.slow = this.frames.map((_, i) => {
            for (let j = Math.max(0, i - SLOWMO_WINDOW); j <= Math.min(boom.length - 1, i + SLOWMO_WINDOW); j++) {
                if (boom[j]) return true;
            }
            return false;
        });

        // Any key or click skips
        this.skipHandler = (e) => {
            if (e.type === 'keydown' && ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
            this.finish();
        };
        // Deferred so the click that ended the turn doesn't skip instantly
        setTimeout(() => {
            if (!this.playing) return;
            window.addEventListener('keydown', this.skipHandler, true);
            window.addEventListener('pointerdown', this.skipHandler, true);
        }, 150);

        this.game.audioManager.playClick();
    }

    /** Advance playback by a wall-clock dt and draw. */
    tick(dt) {
        if (!this.playing) return;
        const i = Math.floor(this.cursor);
        const rate = this.slow[i] ? SLOWMO_RATE : 1;
        this.cursor += dt * 60 * rate;

        if (this.cursor >= this.frames.length) {
            this.finish();
            return;
        }
        this.render(Math.floor(this.cursor));
    }

    render(index) {
        const g = this.game;
        const frame = this.frames[index];

        // Bring the playback terrain up to this frame (with blast audio)
        for (let i = this.appliedUpTo + 1; i <= index; i++) {
            const ops = this.frames[i].ops;
            this.applyOps(this.view, ops);
            for (const op of ops) {
                if (op.type === 'crater' && op.r >= 30) {
                    g.audioManager.playExplosion(op.r >= 90 ? 'large' : 'medium');
                }
            }
        }
        this.appliedUpTo = Math.max(this.appliedUpTo, index);

        // Ghost game: the real Game underneath, with the recorded state on top
        const teams = g.teams.map(t => ({ ...t, koalas: [] }));
        let n = 0;
        g.teams.forEach((t, ti) => {
            for (let k = 0; k < t.koalas.length; k++) teams[ti].koalas.push(frame.koalas[n++]);
        });
        const current = frame.koalas[frame.current] || null;
        const ghost = Object.create(g);
        Object.assign(ghost, {
            teams,
            projectiles: frame.projectiles,
            particles: frame.particles,
            firePatches: frame.firePatches,
            oilDrums: frame.oilDrums,
            graves: frame.graves,
            camera: frame.camera,
            waterLevel: frame.waterLevel,
            wind: frame.wind,
            terrain: this.view,
            homingTarget: null,
            weaponManager: { currentWeapon: frame.weapon, timer: g.weaponManager.timer },
            lootManager: {
                render: (ctx) => {
                    for (const c of frame.crates) g.lootManager.renderCrate(ctx, c);
                }
            },
            ropeState: frame.rope ? { ...frame.rope, koala: frame.koalas[frame.rope.koalaIdx] } : null,
            getCurrentKoala: () => current
        });
        Object.defineProperty(ghost, 'phase', { value: 'replay' });
        Object.defineProperty(ghost, 'countdownTimer', { value: 0 });

        const renderer = g.renderer;
        renderer.game = ghost;
        try {
            renderer.render();
        } finally {
            renderer.game = g;
        }
        this.drawOverlay(index);
    }

    drawOverlay(index) {
        const ctx = this.game.ctx;
        const { width, height } = this.game.canvas;
        ctx.save();

        // Letterbox bars
        const bar = Math.round(height * 0.07);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.fillRect(0, 0, width, bar);
        ctx.fillRect(0, height - bar, width, bar);

        // Blinking REPLAY tag
        const blink = Math.floor(performance.now() / 500) % 2 === 0;
        ctx.font = '700 26px Bangers, Outfit, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ff3b30';
        if (blink) {
            ctx.beginPath();
            ctx.arc(28, bar / 2, 8, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.fillStyle = '#fff';
        ctx.fillText(this.slow[index] ? 'REPLAY  ·  SLOW-MO' : 'REPLAY', 46, bar / 2 + 1);

        ctx.font = '600 14px Outfit, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fillText('Click or press any key to skip', width - 20, height - bar / 2);

        // Progress line
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(0, height - bar, width, 3);
        ctx.fillStyle = '#ff3b30';
        ctx.fillRect(0, height - bar, width * (index / Math.max(1, this.frames.length - 1)), 3);
        ctx.restore();
    }

    finish() {
        if (!this.playing) return;
        this.playing = false;
        this.frames = [];
        this.view = null;
        window.removeEventListener('keydown', this.skipHandler, true);
        window.removeEventListener('pointerdown', this.skipHandler, true);
        const done = this.onDone;
        this.onDone = null;
        done?.();
    }

    destroy() {
        if (this.playing) {
            window.removeEventListener('keydown', this.skipHandler, true);
            window.removeEventListener('pointerdown', this.skipHandler, true);
        }
        this.playing = false;
        this.recording = false;
        this.frames = [];
        this.game.terrain.onModify = null;
    }
}
