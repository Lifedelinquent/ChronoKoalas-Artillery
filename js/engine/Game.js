/**
 * Game Engine - Core game loop and state management
 */

import { Terrain } from './Terrain.js';
import { Physics } from './Physics.js';
import { Renderer } from './Renderer.js';
import { WeaponManager } from '../weapons/WeaponManager.js';
import { InputManager } from './InputManager.js';
import { EventEmitter } from '../utils/EventEmitter.js';
import { globalAudioManager } from './AudioManager.js';
import { LootManager } from './LootManager.js';
import { SpatialGrid } from './SpatialGrid.js';
import { DOMCache } from '../utils/DOMCache.js';
import { TurnManager } from './TurnManager.js';
import { WeatherSystem } from './WeatherSystem.js';
import { sanitizeScheme } from '../utils/GameScheme.js';
import { TEAM_COLOR_LABELS } from '../utils/TeamColors.js';
import {
    LIVE_TURN_PHASES, DAMAGE_RADIUS_SCALE, DAMAGE_CORE_FRACTION, ROPE_HAND_OFFSET, ROPE_MIN_LENGTH, FIXED_DT
} from './GameConstants.js';
import { ReplayRecorder, ReplayPlayer } from '../replay/Replay.js';
import { InstantReplay } from '../replay/InstantReplay.js';
import { MatchStats } from './MatchStats.js';
import { log } from '../utils/Logger.js';
import { SpawnSystem } from './game/SpawnSystem.js';
import { ProjectileSystem } from './game/ProjectileSystem.js';
import { Effects } from './game/Effects.js';
import { DeathSystem } from './game/DeathSystem.js';
import { HazardSystem } from './game/HazardSystem.js';
import { RopeSystem } from './game/RopeSystem.js';
import { ToolWeapons } from './game/ToolWeapons.js';
import { Firing } from './game/Firing.js';
import { CameraSystem } from './game/CameraSystem.js';
import { HUD } from './game/HUD.js';
import { NetSync } from './game/NetSync.js';

export class Game extends EventEmitter {
    // Gameplay constants (defined in GameConstants.js, mirrored here for
    // existing Game.X call sites)
    static LIVE_TURN_PHASES = LIVE_TURN_PHASES;
    static DAMAGE_RADIUS_SCALE = DAMAGE_RADIUS_SCALE;
    static DAMAGE_CORE_FRACTION = DAMAGE_CORE_FRACTION;
    static ROPE_HAND_OFFSET = ROPE_HAND_OFFSET;
    static ROPE_MIN_LENGTH = ROPE_MIN_LENGTH;

    constructor(canvas, options = {}) {
        super();

        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.options = options;

        // Match-rule scheme (health, timers, ammo, hazards, crates, sudden
        // death). Guests receive the host's scheme inside initialState.
        // MUST be set before WeaponManager is constructed — createWeapons()
        // reads scheme ammo/delay overrides off this.game.scheme.
        this.scheme = sanitizeScheme(options.scheme || options.initialState?.scheme);

        // Game dimensions
        this.worldWidth = 2400;
        this.worldHeight = 1200;

        // Current water-surface Y. Constant during normal play; sudden death
        // raises it (decreasing Y) each turn. Single source of truth for
        // drowning (Physics), rendering (Renderer) and turn-settle checks.
        this.waterLevel = this.worldHeight - 60;

        // Resize canvas
        this.handleResize();

        // Core systems
        this.terrain = new Terrain(this.worldWidth, this.worldHeight);
        this.physics = new Physics(this);
        this.renderer = new Renderer(this);
        this.weaponManager = new WeaponManager(this);
        this.inputManager = new InputManager(this);
        this.audioManager = globalAudioManager;

        // Spatial partitioning for efficient collision detection
        // Cell size of 100px works well for our entity sizes
        this.spatialGrid = new SpatialGrid(this.worldWidth, this.worldHeight, 100);

        // Game state
        this.teams = [];
        this.projectiles = [];
        // Active ninja-rope session (null when nobody is roping). See
        // startRope/updateRope — the rope is not a projectile.
        this.ropeState = null;
        this.particles = [];
        this.maxParticles = 200; // Performance: limit particle count

        // Object pooling for projectiles (performance optimization)
        this.projectilePool = [];
        this.particlePool = [];
        this.maxPoolSize = 50;

        this.wind = 0; // -1 to 1

        this.isPaused = false;
        this.isGameOver = false;

        // Initialize turn manager which holds turn state
        this.turnManager = new TurnManager(this);

        // Delayed action queue (replaces setTimeout for better performance)
        this.delayedActions = [];
        this.damagePhaseDelay = 0;
        this.damagePhaseCallback = null;

        // Multi-shot weapon tracking (shotgun)
        this.shotgunShotsRemaining = 0;

        // Homing missile target marker, placed by clicking before firing
        // (WA-style: cleared at the start of every turn)
        this.homingTarget = null;

        // Burning patches of ground (petrol bomb / napalm strike)
        this.firePatches = [];

        // Explosive oil drums scattered on the map (WA-style hazards).
        // Landmines are stationary Projectiles and live in this.projectiles.
        this.oilDrums = [];

        // Gravestones left where koalas self-destructed (y = base of stone)
        this.graves = [];

        // Death-cam: while a koala works through its self-destruct the camera
        // cuts to it, then lingers briefly on the blast. Turn/retreat timers
        // hold for the duration so the death is actually seen instead of
        // playing off-screen behind the shooter.
        this.deathCamX = 0;
        this.deathCamY = 0;
        this.deathCamTimer = 0;

        // Kamikaze dash state (null when inactive)
        this.kamikazeState = null;

        // Camera
        this.camera = {
            x: 0,
            y: 0,
            zoom: 1.1, // Default zoom at 110% to fill screen
            targetX: 0,
            targetY: 0
        };

        // Animation
        this.lastTime = 0;
        this.animationId = null;

        this.networkManager = options.networkManager;
        this.isPractice = options.isPractice || false;

        // Replays (local games only): watching one feeds recorded input back
        // in (ReplayPlayer); playing a local match records it (ReplayRecorder).
        // Both are (re)built in start() so a rematch records afresh.
        this.isReplay = !!options.replay;
        this.replayPlayer = null;
        this.replayRecorder = null;
        this.instantReplay = null;

        // Wall-clock speed multiplier for the render loop (replay fast-forward).
        // The simulation itself always steps at FIXED_DT.
        this.timeScale = 1;

        // DOM Cache - eliminates querySelector bottleneck
        this.dom = new DOMCache();
        this.dom.init(); // Cache all DOM references once

        // Loot crate system (replaces old powerups)
        this.lootManager = new LootManager(this);

        // CPU brain for single player — created in createTeams when any
        // team config is flagged isCPU (local games only, never networked)
        this.aiController = null;

        // Atmospheric weather particles (cosmetic, theme-driven, local-only)
        this.weather = new WeatherSystem(this);
    }

    /**
     * Start the game
     */
    async start() {
        // Initialize audio (requires user interaction)
        this.audioManager.init();
        this.audioManager.resetTheme?.('battle');

        // Apply the match scheme: timers, sudden death and crate behavior.
        // (Weapon ammo/delays are applied inside createWeapons; health, wind,
        // hazards and damage are read live from this.scheme where they act.)
        const scheme = this.scheme;
        this.turnManager.defaultTurnTime = scheme.turnTime;
        this.turnManager.retreatTime = scheme.retreatTime;
        this.turnManager.suddenDeathTime = scheme.suddenDeathTime === -1 ? Infinity : scheme.suddenDeathTime;
        this.turnManager.suddenDeathHealthCap = scheme.suddenDeathHealthCap;
        this.turnManager.suddenDeathDecay = scheme.suddenDeathDecay;
        this.turnManager.waterRisePerTurn = scheme.waterRisePerTurn;
        this.lootManager.crateDropChance = scheme.crateDropChance;
        this.lootManager.maxCratesOnMap = scheme.maxCratesOnMap;

        // Reset per-match turn / sudden-death state so a rematch starts fresh
        this.turnManager.suddenDeathActive = false;
        this.turnManager.roundNumber = 1;
        this.turnManager.lastTeamIndex = -1;
        this.turnManager.turnTime = this.turnManager.defaultTurnTime;
        this.turnManager.elapsedGameTime = 0;
        this.turnManager.turnCounter = 0;
        this.turnManager.passiveWait = 0;
        this.turnManager.localFallback = false;
        this.waterLevel = this.worldHeight - 60;

        // Get game seed for multiplayer sync (or generate random for practice)
        // (?? not ||: a seed of 0 must not silently become a local random one)
        const initialState = this.options.initialState;
        // options.seed: fixed seed for single-player missions (reproducible maps)
        this.gameSeed = initialState?.seed ?? this.options.seed ?? Math.floor(Math.random() * 1000000);
        log.debug('🎲 Game seed:', this.gameSeed);

        // Create seeded random function for consistent results
        this.seededRandom = this.createSeededRandom(this.gameSeed);

        // Side streams, derived from the same seed but never sharing draws
        // with the shared stream above (see the RNG invariants in
        // NetSync/ProjectileSystem). hostRandom: rolls only the authority
        // makes (loot crates, oil-drum fuses). aiRandom: CPU decisions.
        // Seeding them (instead of Math.random) keeps local games fully
        // reproducible, which replays and the determinism test rely on.
        this.hostRandom = this.createSeededRandom((this.gameSeed ^ 0x5BD1E995) >>> 0);
        this.aiRandom = this.createSeededRandom((this.gameSeed ^ 0x27D4EB2D) >>> 0);

        // Simulation clock: fixed steps taken and seconds simulated
        this.frame = 0;
        this.simTime = 0;

        // WA-style instant replay of killing shots (local games only)
        this.instantReplay?.destroy();
        this.instantReplay = InstantReplay.isEnabledFor(this) ? new InstantReplay(this) : null;

        if (this.isReplay) {
            this.replayPlayer = new ReplayPlayer(this, this.options.replay);
        } else if (this.isPractice && this.options.recordReplay !== false) {
            this.replayRecorder = new ReplayRecorder(this, this.options.replayMeta);
        }

        // Reset camera to default zoom and position
        this.camera.zoom = 1.1; // 110% to fill screen
        this.camera.userZoom = 1.1;
        this.cameraManualTurn = -1;
        this.camera.x = 0;
        this.camera.y = 0;
        this.camera.targetX = 0;
        this.camera.targetY = 0;

        // Generate or load terrain
        if (this.options.customMap) {
            // Load custom map from editor
            await this.loadCustomMap(this.options.customMap);
        } else {
            // Pass seeded random to terrain for multiplayer sync
            this.terrain.setSeededRandom(this.seededRandom);
            // Generate terrain procedurally
            this.terrain.generate();
        }

        // Looping map ambience matching the terrain theme (cosmetic,
        // local-only; no-op for custom maps where theme is null)
        this.audioManager.playAmbient(this.terrain.theme?.id);

        // Fresh statistics for this match (createTeams wires the hooks)
        this.stats = new MatchStats(this);

        // Create teams
        this.createTeams();

        // Scatter WA-style hazards (landmines + oil drums) once the koalas
        // are placed. Seeded, so every client builds the same minefield.
        this.spawnMapHazards();

        // Randomize wind (using seeded random for sync)
        this.randomizeWind();

        // Start match with a 3-second countdown
        this.phase = 'countdown';
        this.countdownTimer = 3.5; // (3, 2, 1, GO!)

        // Start game loop (headless games are stepped by their owner)
        this.lastTime = performance.now();
        if (!this.options.headless) {
            this.gameLoop();
        }

        // Start background timer for when tab is inactive (multiplayer sync)
        if (this.networkManager && !this.isPractice) {
            this.startBackgroundTimer();
        }

        log.debug('🎮 Game started!');
    }

    // Proxy properties to TurnManager
    get currentTeamIndex() { return this.turnManager.currentTeamIndex; }
    set currentTeamIndex(v) { this.turnManager.currentTeamIndex = v; }
    get currentKoalaIndex() { return this.turnManager.currentKoalaIndex; }
    set currentKoalaIndex(v) { this.turnManager.currentKoalaIndex = v; }
    get turnTime() { return this.turnManager.turnTime; }
    set turnTime(v) { this.turnManager.turnTime = v; }
    get turnTimer() { return this.turnManager.turnTimer; }
    set turnTimer(v) { this.turnManager.turnTimer = v; }
    get phase() { return this.turnManager.phase; }
    set phase(v) { this.turnManager.phase = v; }
    get countdownTimer() { return this.turnManager.countdownTimer; }
    set countdownTimer(v) { this.turnManager.countdownTimer = v; }
    get retreatTime() { return this.turnManager.retreatTime; }
    set retreatTime(v) { this.turnManager.retreatTime = v; }
    get retreatTimer() { return this.turnManager.retreatTimer; }
    set retreatTimer(v) { this.turnManager.retreatTimer = v; }
    get projectileGraceTimer() { return this.turnManager.projectileGraceTimer; }
    set projectileGraceTimer(v) { this.turnManager.projectileGraceTimer = v; }

    /**
     * Create a seeded random number generator for multiplayer sync
     */
    createSeededRandom(seed) {
        // mulberry32: fast, well-distributed PRNG with a full 32-bit state.
        // Deterministic for a given seed so all multiplayer clients agree,
        // and far less biased than the old Math.sin() approach.
        let s = (Math.floor(seed) || 1) >>> 0;
        return () => {
            s = (s + 0x6D2B79F5) >>> 0;
            let t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /**
     * Derive an independent RNG from the shared seeded stream. The one draw
     * happens at a SYMMETRIC point (weapon fire / projectile creation, which
     * both clients replay identically), so impact-time effects can roll dice
     * without touching the shared stream. Before this, an impact that only
     * happened on one client — e.g. a cluster bomb that lands in water here
     * but on the crater lip there — consumed a different number of shared
     * rolls and silently desynced every later wind/spread/dud draw.
     */
    makeSubRandom(rand = this.seededRandom) {
        if (!rand) return Math.random;
        const seed = Math.floor(rand() * 0xFFFFFFFF);
        return this.createSeededRandom(seed);
    }

    /**
     * Per-projectile effect RNG, seeded when the projectile was created (a
     * symmetric event). Used for impact-spawned effects: cluster fragments
     * and fire patches.
     */
    getProjectileEffectRand(projectile) {
        if (!projectile._effectRand) {
            projectile._effectRand = projectile.effectSeed !== undefined
                ? this.createSeededRandom(projectile.effectSeed)
                : (this.seededRandom || Math.random);
        }
        return projectile._effectRand;
    }

    /**
     * Load a custom map from map editor data
     */
    loadCustomMap(mapData) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                // Clear the terrain canvas
                this.terrain.ctx.clearRect(0, 0, this.terrain.width, this.terrain.height);

                // Draw the custom terrain
                this.terrain.ctx.drawImage(img, 0, 0);

                // Update collision mask from the visual terrain
                this.terrain.updateCollisionMask();

                // Safety net: a custom map saved as a fully-opaque image (before
                // the editor auto-converted imports) has no air to play in.
                // Convert it to a playable mask on the fly.
                const converted = this.terrain.ensurePlayableTerrain();

                // Store custom background color
                if (mapData.backgroundColor) {
                    this.customBackgroundColor = mapData.backgroundColor;
                }

                // Store map bounds (for teleport/spawn validation)
                // Use provided bounds or fall back to calculating them.
                // If we just converted an opaque map, its saved bounds describe
                // the old (solid) terrain, so recompute them from the new mask.
                if (mapData.mapBounds && !converted) {
                    this.mapBounds = mapData.mapBounds;
                    log.debug(`📐 Using exported map bounds: Top=${this.mapBounds.topY}, Bottom=${this.mapBounds.bottomY}`);
                } else {
                    if (converted) {
                        log.debug('🩹 Converted fully-opaque map to a playable terrain mask');
                    }
                    // Fallback: calculate bounds from terrain (for older maps)
                    this.mapBounds = {
                        topY: this.terrain.getMapTopBoundary(),
                        bottomY: this.worldHeight - 100,
                        waterLevel: this.worldHeight - 60
                    };
                    log.debug(`📐 Calculated map bounds: Top=${this.mapBounds.topY}`);
                }

                log.debug('🗺️ Custom map loaded:', mapData.name);
                resolve();
            };
            img.onerror = () => {
                console.error('Failed to load custom map image');
                // Fall back to generated terrain
                this.terrain.generate();
                this.mapBounds = { topY: 0, bottomY: this.worldHeight, waterLevel: this.worldHeight - 60 };
                resolve();
            };
            img.src = mapData.terrain;
        });
    }

    /**
     * Rebuild the spatial grid with all entities
     */
    rebuildSpatialGrid() {
        const entities = [];

        // Add all koalas
        for (const team of this.teams) {
            for (const koala of team.koalas) {
                // Include ALL koalas (alive and dead) so dead bodies can be
                // flung by explosions — but exploded koalas are gone (only
                // their gravestone remains)
                if (koala.vanished) continue;
                entities.push(koala);
            }
        }

        // Add all projectiles
        for (const proj of this.projectiles) {
            entities.push(proj);
        }

        // Add loot crates
        for (const crate of this.lootManager.crates) {
            entities.push(crate);
        }

        this.spatialGrid.rebuild(entities);
    }

    /**
     * Main game loop
     */
    gameLoop(currentTime = 0) {
        if (this.isGameOver && !this.victoryDance) return;

        // On first frame, currentTime is 0 (default) which would cause negative dt
        // Skip update on first frame to let requestAnimationFrame provide real time
        let deltaTime = 0;
        if (currentTime > 0 && this.lastTime > 0) {
            deltaTime = (currentTime - this.lastTime) / 1000;
        }
        this.lastTime = currentTime;

        // Fixed timestep definitions
        if (this.fixedAccumulator === undefined) this.fixedAccumulator = 0;
        // Cap max catch-up time to 1.0s (60 frames) to preserve determinism during heavy lag spikes
        if (deltaTime > 1.0) deltaTime = 1.0;
        this.fixedAccumulator += deltaTime * this.timeScale;
        // Cap catch-up so a fast-forwarded replay can't stall the tab
        this.fixedAccumulator = Math.min(this.fixedAccumulator, FIXED_DT * 60 * this.timeScale);

        // Game over: only the victory dance animates until the results show
        if (this.victoryDance) {
            this.updateVictoryDance(Math.min(deltaTime, 0.05));
            this.render();
            this.animationId = requestAnimationFrame((t) => this.gameLoop(t));
            return;
        }

        // Instant replay: the simulation is frozen while the last turn
        // plays back (InstantReplay draws its own frames)
        if (this.instantReplay?.isPlaying()) {
            this.fixedAccumulator = 0;
            this.instantReplay.tick(deltaTime);
            this.animationId = requestAnimationFrame((t) => this.gameLoop(t));
            return;
        }

        // Performance debugging
        if (window.debugPerformance) {
            const frameStart = performance.now();
            let updateTime = 0, renderTime = 0;

            if (!this.isPaused) {
                const t0 = performance.now();
                while (this.fixedAccumulator >= FIXED_DT && !this.simFrozen()) {
                    this.update(FIXED_DT);
                    this.fixedAccumulator -= FIXED_DT;
                }
                updateTime = performance.now() - t0;
            }

            const t1 = performance.now();
            this.render();
            renderTime = performance.now() - t1;

            const frameTime = performance.now() - frameStart;

            // Track frame times
            this.frameTimes = this.frameTimes || [];
            this.frameTimes.push(frameTime);
            if (this.frameTimes.length > 60) this.frameTimes.shift();

            // Log if frame took too long (>10ms for detailed, >50ms for basic)
            const threshold = window.debugPerformanceDetail ? 10 : 50;
            if (frameTime > threshold) {
                console.warn(`⚠️ LAG: ${frameTime.toFixed(1)}ms (Update: ${updateTime.toFixed(1)}ms, Render: ${renderTime.toFixed(1)}ms) | Phase: ${this.phase} | Projectiles: ${this.projectiles.length}`);
            }

            // Log average every 60 frames
            if (this.frameTimes.length === 60 && this.frameTimes.length % 60 === 0) {
                const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
                const max = Math.max(...this.frameTimes);
                log.debug(`📊 Avg: ${avg.toFixed(2)}ms (${(1000 / avg).toFixed(0)} FPS) | Max: ${max.toFixed(1)}ms`);
            }
        } else {
            // Normal loop (no debugging overhead)
            if (!this.isPaused) {
                while (this.fixedAccumulator >= FIXED_DT && !this.simFrozen()) {
                    this.update(FIXED_DT);
                    this.fixedAccumulator -= FIXED_DT;
                }
            }
            this.render();
        }

        this.animationId = requestAnimationFrame((t) => this.gameLoop(t));
    }

    /**
     * True while something outside the simulation (an instant replay) holds
     * it still. Steps must not run then, or the turn would move on unseen.
     */
    simFrozen() {
        return !!this.instantReplay?.isPlaying();
    }

    /**
     * Run `fn` (the next turn / game over) — after the instant replay of the
     * turn that just ended, if that turn killed someone.
     */
    runAfterInstantReplay(fn) {
        if (this.instantReplay?.shouldPlay()) {
            this.instantReplay.play(fn);
        } else {
            this.instantReplay?.discard();
            fn();
        }
    }

    /**
     * Start background update timer (for when tab is inactive)
     * requestAnimationFrame pauses when tab is not visible, but we need
     * to keep processing network updates and game state
     */
    startBackgroundTimer() {
        // Listen for visibility changes
        if (!this.visibilityHandler) {
            this.visibilityHandler = () => {
                if (document.hidden) {
                    // Tab became hidden - start fallback timer
                    log.debug('🔄 Tab hidden - starting background timer');
                    this.startFallbackTimer();
                } else {
                    // Tab became visible - stop fallback timer
                    log.debug('🔄 Tab visible - stopping background timer');
                    this.stopFallbackTimer();
                    // Sync time to prevent huge deltaTime
                    this.lastTime = performance.now();
                }
            };
            document.addEventListener('visibilitychange', this.visibilityHandler);
        }

        // Started in a background tab (a guest whose host hit Start while
        // they were tabbed away): no visibilitychange will come, so begin
        // ticking right away
        if (document.hidden) {
            this.startFallbackTimer();
        }
    }

    /**
     * Start the fallback setInterval timer for background updates
     */
    startFallbackTimer() {
        if (this.fallbackTimerId) return; // Already running

        this.fallbackTimerId = setInterval(() => {
            if (this.isGameOver) {
                this.stopFallbackTimer();
                return;
            }

            const now = performance.now();
            let deltaTime = (now - this.lastTime) / 1000;
            this.lastTime = now;

            if (this.fixedAccumulator === undefined) this.fixedAccumulator = 0;
            if (deltaTime > 1.0) deltaTime = 1.0;
            this.fixedAccumulator += deltaTime;

            if (!this.isPaused) {
                while (this.fixedAccumulator >= FIXED_DT && !this.simFrozen()) {
                    this.update(FIXED_DT);
                    this.fixedAccumulator -= FIXED_DT;
                }
            }
            // Skip rendering when tab is hidden (saves resources)
        }, 50); // 20 updates per second when hidden
    }

    /**
     * Stop the fallback timer
     */
    stopFallbackTimer() {
        if (this.fallbackTimerId) {
            clearInterval(this.fallbackTimerId);
            this.fallbackTimerId = null;
        }
    }

    /**
     * Update game state
     */
    update(dt) {
        // Cap delta time to prevent physics issues (also clamp negative values)
        dt = Math.max(0, Math.min(dt, 0.05));

        // Replay playback feeds the recorded input commands for this frame
        // before simulating it (exactly where they happened when recorded).
        // A recording that stops before the match ended (it can't, normally)
        // halts there instead of running on with nobody at the controls.
        if (this.replayPlayer) {
            if (this.frame >= (this.options.replay.frames ?? Infinity) && !this.isGameOver) {
                if (!this.replayEnded) {
                    this.replayEnded = true;
                    this.isPaused = true;
                    this.emit('replayEnded');
                }
                return;
            }
            this.replayPlayer.beforeFrame(this.frame);
        }
        this.frame++;
        this.simTime += dt;

        // Accumulate elapsed match time (drives the sudden-death trigger). Excludes
        // the opening countdown so the clock starts when play actually begins.
        if (this.phase !== 'countdown' && !this.isGameOver) {
            this.turnManager.elapsedGameTime += dt;
        }

        // If the koala whose turn it is has died mid-turn — usually by walking,
        // jumping or drilling into the water — don't let the timer keep ticking on
        // a corpse the player can still nudge around. Hand the turn over right
        // away. This runs deterministically on every client (same model as the
        // turn-timer expiry in TurnManager), so no extra network message is needed.
        if (!this.isGameOver && Game.LIVE_TURN_PHASES.includes(this.phase)) {
            const activeKoala = this.getCurrentKoala();
            if (activeKoala && !activeKoala.isAlive) {
                this.endTurn();
                return;
            }
        }

        // Detailed profiling when debugging
        const profile = window.debugPerformance && window.debugPerformanceDetail;
        let t0, t1;

        switch (this.phase) {
            case 'countdown':
                this.countdownTimer -= dt;
                if (this.countdownTimer <= 0) {
                    this.startTurn();
                }
                break;
            case 'aiming':
                this.updateTurnTimer(dt);
                this.updateAiming(dt);
                break;
            case 'firing':
                this.updateTurnTimer(dt);
                this.updateFiring(dt);
                break;
            case 'armed':
                // Aim is locked in; player can still fine-tune aim before firing
                this.updateTurnTimer(dt);
                this.updateAiming(dt);
                break;
            case 'blowtorch':
                this.updateTurnTimer(dt);
                this.updateBlowtorch(dt);
                break;
            case 'rope':
                // Ninja rope: hook flight or swinging. The turn clock keeps
                // ticking — roping eats your turn time like walking does.
                this.updateTurnTimer(dt);
                this.updateRope(dt);
                break;
            case 'drill':
                this.updateDrill(dt);
                break;
            case 'retreat':
                this.updateRetreat(dt);
                break;
            case 'damage':
                // Damage phase is handled by processDamage timeout.
                // A passive multiplayer client parks here until the turn
                // owner's 'turnStart' arrives — the watchdog un-sticks us if
                // that message never comes.
                this.turnManager.updatePassiveWatchdog(dt);
                break;
        }

        // Kamikaze dash moves the koala through terrain until it detonates
        if (this.kamikazeState) {
            this.updateKamikaze(dt);
        }

        // Burning ground keeps cooking across phases (and turns)
        this.updateFirePatches(dt);

        // Oil drums: burn-down fuses and falling when ground is destroyed
        this.updateOilDrums(dt);

        // WA-style deaths: koalas at 0 HP panic briefly, then self-destruct
        this.updateDeathSequences(dt);

        // Gravestones fall when the ground under them is blown away
        this.updateGraves(dt);

        // Always update projectiles/traps (mines need to work even during aiming)
        if (profile) t0 = performance.now();
        this.updateProjectiles(dt);
        if (profile) { t1 = performance.now(); if (t1 - t0 > 2) log.debug(`  📦 Projectiles: ${(t1 - t0).toFixed(1)}ms`); }

        // Update physics for all entities
        if (profile) t0 = performance.now();
        this.physics.update(dt);
        if (profile) { t1 = performance.now(); if (t1 - t0 > 2) log.debug(`  ⚙️ Physics: ${(t1 - t0).toFixed(1)}ms`); }

        // Update spatial grid after physics (entities may have moved)
        if (profile) t0 = performance.now();
        this.rebuildSpatialGrid();
        if (profile) { t1 = performance.now(); if (t1 - t0 > 2) log.debug(`  🗺️ SpatialGrid: ${(t1 - t0).toFixed(1)}ms`); }

        // Update particles
        if (profile) t0 = performance.now();
        this.updateParticles(dt);
        if (profile) { t1 = performance.now(); if (t1 - t0 > 2) log.debug(`  ✨ Particles: ${(t1 - t0).toFixed(1)}ms`); }

        // Ambient weather (cosmetic, wind-driven)
        this.weather.update(dt);

        // Update loot crates
        if (profile) t0 = performance.now();
        this.lootManager.update(dt);
        if (profile) { t1 = performance.now(); if (t1 - t0 > 2) log.debug(`  📦 Loot: ${(t1 - t0).toFixed(1)}ms`); }

        // Update koala animations (backflip etc) and state
        this.updateKoalaAnimations(dt);

        // Update individual koalas (timers, etc)
        this.teams.forEach(team => {
            team.koalas.forEach(koala => {
                if (koala.isAlive) koala.update(dt);
            });
        });

        // Process delayed actions (replaces setTimeout - no more timer fired lag!)
        this.updateDelayedActions(dt);

        // Death-cam linger countdown
        if (this.deathCamTimer > 0) this.deathCamTimer -= dt;

        // CPU turns: the AI drives the current koala through the same APIs
        // the player would (runs across phases so it can walk during retreat).
        // AI pauses along with player input while a death plays out.
        if (this.aiController && !this.deathHoldActive()) {
            this.aiController.update(dt);
        }

        // Update UI states based on input
        this.inputManager.update(dt);

        // Smooth camera movement
        this.updateCamera(dt);

        // Instant replay records what this frame looked like
        this.instantReplay?.captureFrame();
    }

    /**
     * Update during aiming phase
     */
    updateAiming(dt) {
        const koala = this.getCurrentKoala();
        if (!koala) return;

        // Handle input for movement and aiming
        this.inputManager.updateAiming(koala, dt);
    }

    updateKoalaAnimations(dt) {
        for (const team of this.teams) {
            for (const koala of team.koalas) {
                if (!koala.isAlive) continue;

                // Animate backflip rotation - one clean somersault, then hold
                // upright through the rest of the descent (no more wild 4+ spins
                // that snap back to upright on landing).
                if (koala.isBackflipping && !koala.onGround) {
                    koala.backflipRotation = Math.min(
                        koala.backflipRotation + 9 * dt, // rad/s
                        Math.PI * 2                       // cap at one full flip
                    );
                }

                // Animate melee swing
                if (koala.isSwinging) {
                    koala.swingProgress += 6 * dt; // Animation speed
                    if (koala.swingProgress >= 1) {
                        koala.isSwinging = false;
                        koala.swingProgress = 0;
                    }
                }
            }
        }
    }

    /**
     * Schedule a delayed action (replaces setTimeout for game loop integration)
     */
    scheduleDelayedAction(delay, callback) {
        this.delayedActions.push({
            delay: delay / 1000, // Convert ms to seconds
            callback: callback
        });
    }

    /**
     * Update delayed actions (processes in main loop with deltaTime)
     */
    updateDelayedActions(dt) {
        for (let i = this.delayedActions.length - 1; i >= 0; i--) {
            const action = this.delayedActions[i];
            action.delay -= dt;

            if (action.delay <= 0) {
                action.callback();
                this.delayedActions.splice(i, 1);
            }
        }
    }

    /**
     * Update during firing phase
     */
    updateFiring(dt) {
        // Power bar charging
        if (this.inputManager.isCharging) {
            this.weaponManager.updatePower(dt);
        }
    }

    /**
     * Update turn timer countdown
     */
    updateTurnTimer(dt) {
        const prevTimer = this.turnTimer;
        this.turnManager.updateTurnTimer(dt);

        // Timer warning sound (last 5 seconds, once per second)
        if (this.turnTimer <= 5 && this.turnTimer > 0 && !this.isPractice) {
            const prevSec = Math.ceil(prevTimer);
            const currSec = Math.ceil(this.turnTimer);
            if (prevSec !== currSec) {
                this.audioManager.playTimerTick();
            }
        }
    }

    /**
     * Clean up any in-progress input state (charging, blowtorch) when a turn
     * is force-ended, so the power bar doesn't stay stuck on screen
     */
    cleanupTurnInputState() {
        // Cancel power charging / locked aim
        this.inputManager.isCharging = false;
        this.inputManager.lockedPower = null;
        this.weaponManager.isCharging = false;
        this.weaponManager.power = 0;

        // Clear blowtorch state
        const koala = this.getCurrentKoala();
        if (koala) {
            koala.blowtorchActive = false;
            koala.blowtorchDigging = false;
        }

        // Let go of the ninja rope (turn ended mid-swing)
        if (this.ropeState) {
            this.clearRope();
        }

        // Hide power bar
        if (this.dom.elements.powerBarContainer) {
            this.dom.elements.powerBarContainer.classList.add('hidden');
            this.dom.elements.powerBarContainer.classList.remove('locked');
        }
        if (this.dom.elements.powerFill) {
            this.dom.elements.powerFill.style.width = '0%';
        }
    }

    /**
     * Start retreat phase after firing
     */
    startRetreat() {
        this.turnManager.startRetreat();
        this.shotgunShotsRemaining = 0; // Clear multi-shot state

        // Show retreat indicator
        const turnIndicator = this.dom.elements.turnIndicator;
        if (turnIndicator) {
            turnIndicator.innerHTML = '<span class="retreat-label">RETREAT!</span>';
        }
    }

    /**
     * Update during retreat phase
     */
    updateRetreat(dt) {
        this.turnManager.updateRetreat(dt);

        // Allow walking during retreat
        const koala = this.getCurrentKoala();
        if (koala) {
            this.inputManager.updateAiming(koala, dt);
        }

        // Check if retreat ended
        if (this.phase !== 'retreat') {
            // Restore turn indicator (will be updated properly on next turn)
            const turnIndicator = this.dom.elements.turnIndicator;
            if (turnIndicator) {
                turnIndicator.innerHTML = '<span id="current-team">...</span>\'s Turn';
            }
        }
    }

    // Turn flow proxy methods
    processDamage() { this.turnManager.processDamage(); }
    applyFallDamage() { this.turnManager.applyFallDamage(); }
    startTurn() { this.turnManager.startTurn(); }
    selectNextKoala() { this.turnManager.selectNextKoala(); }
    nextTeam() { this.turnManager.nextTeam(); }
    endTurn() { this.turnManager.endTurn(); }
    nextTurn() { this.turnManager.nextTurn(); }

    /**
     * Damage multiplier: scheme-wide setting × the current team's crate buffs
     */
    getDamageMultiplier() {
        const buffMult = this.getCurrentTeam()?.buffs?.doubleDamage ? 2 : 1;
        return buffMult * this.scheme.damageMultiplier;
    }

    /**
     * Scheme weapon delays: a weapon with delay N unlocks on round N+1
     * (WA-style). roundNumber is deterministic on both clients, so this
     * agrees across the network.
     */
    isWeaponAvailable(weapon) {
        if (!weapon) return false;
        const delay = weapon.delay || 0;
        return delay <= 0 || this.turnManager.roundNumber > delay;
    }

    /**
     * Rounds left before a delayed weapon unlocks (0 when usable).
     */
    weaponDelayRemaining(weapon) {
        if (!weapon || this.isWeaponAvailable(weapon)) return 0;
        return weapon.delay - this.turnManager.roundNumber + 1;
    }

    /**
     * Randomize wind (uses seeded random for multiplayer sync)
     */
    randomizeWind() {
        // Use seeded random for multiplayer sync, or regular random for practice.
        // Always draw the roll (even at 0 wind strength) so the shared RNG
        // stream advances identically no matter the scheme.
        const rand = this.seededRandom ? this.seededRandom() : Math.random();
        this.wind = (rand - 0.5) * 2 * this.scheme.windStrength; // -1..1 at 100%
        this.updateWindDisplay();
    }

    /**
     * Find nearest koala within range (optimized with spatial grid)
     */
    findNearbyKoala(x, y, radius) {
        if (!this.spatialGrid) {
            // Fallback to old method if no spatial grid
            let nearest = null;
            let minDist = radius;
            for (const team of this.teams) {
                for (const koala of team.koalas) {
                    if (!koala.isAlive) continue;
                    const dist = Math.hypot(koala.x - x, koala.y - y);
                    if (dist < minDist) {
                        minDist = dist;
                        nearest = koala;
                    }
                }
            }
            return nearest;
        }

        // Use spatial grid for O(1) lookup instead of O(n) iteration
        const nearby = this.spatialGrid.getNearby(x, y, radius);

        let nearest = null;
        let minDist = radius;

        for (let i = 0; i < nearby.length; i++) {
            const entity = nearby[i];
            // Only check koalas (not other entities)
            if (entity.isAlive && entity.health !== undefined) {
                const dist = Math.hypot(entity.x - x, entity.y - y);
                if (dist < minDist) {
                    minDist = dist;
                    nearest = entity;
                }
            }
        }

        return nearest;
    }

    /**
     * Get current koala
     */
    getCurrentKoala() {
        const team = this.teams[this.currentTeamIndex];
        return team ? team.koalas[this.currentKoalaIndex] : null;
    }

    /**
     * Get current team
     */
    getCurrentTeam() {
        return this.teams[this.currentTeamIndex];
    }

    /**
     * End the game. In multiplayer the client that decided the result tells
     * the peer — game over used to be decided independently on each client
     * from locally-drifted health/positions, so one side could see a win
     * while the other kept playing.
     */
    endGame(winningTeam, options = {}) {
        if (this.isGameOver) return;
        this.isGameOver = true;
        this.phase = 'gameOver';

        if (this.networkManager && !this.isPractice && !options.fromRemote) {
            this.networkManager.send({
                type: 'gameOver',
                winnerTeamIndex: winningTeam ? this.teams.indexOf(winningTeam) : -1
            });
        }

        // Play end game sound (the winners cheer in their own voice pack)
        if (winningTeam) {
            this.audioManager.voicePack = winningTeam.style?.voice;
            this.audioManager.playVictory();
        } else {
            this.audioManager.playDefeat();
        }

        // Winner display: a lone squad wins under its own name; allied squads
        // (same colour) win together as "<Colour> Team".
        let winnerDisplay = null;
        if (winningTeam) {
            const allies = this.teams.filter(t => t.alliance === winningTeam.alliance);
            winnerDisplay = allies.length > 1
                ? {
                    name: `${TEAM_COLOR_LABELS[winningTeam.alliance] || winningTeam.alliance} Team (${allies.map(t => t.name).join(' & ')})`,
                    color: winningTeam.color,
                    alliance: winningTeam.alliance
                }
                : { name: winningTeam.name, color: winningTeam.color, alliance: winningTeam.alliance };
        }

        const result = {
            winner: winnerDisplay,
            stats: this.calculateStats()
        };

        // WA-style victory dance: the winners celebrate for a few seconds
        // before the results screen (skipped headless or in a hidden tab,
        // where nothing would draw it)
        if (winningTeam && !this.options.headless && !document.hidden) {
            this.victoryDance = { alliance: winningTeam.alliance, time: 0, duration: 3.2, result };
            // Safety net in case the render loop stalls (tab hidden mid-dance)
            this.victoryDanceTimeout = setTimeout(() => this.finishVictoryDance(), 4500);
            return;
        }
        this.emit('gameOver', result);
    }

    /** Per-frame victory dance: confetti, camera on the winners. */
    updateVictoryDance(dt) {
        const dance = this.victoryDance;
        dance.time += dt;

        const winners = this.teams
            .filter(t => t.alliance === dance.alliance)
            .flatMap(t => t.koalas.filter(k => k.isAlive));
        if (winners.length > 0) {
            const cx = winners.reduce((s, k) => s + k.x, 0) / winners.length;
            const cy = winners.reduce((s, k) => s + k.y, 0) / winners.length;
            this.centerCameraOn(cx, cy - 30);
            this.camera.x += (this.camera.targetX - this.camera.x) * Math.min(1, 4 * dt);
            this.camera.y += (this.camera.targetY - this.camera.y) * Math.min(1, 4 * dt);

            if (Math.random() < 0.6) {
                const k = winners[Math.floor(Math.random() * winners.length)];
                this.addParticle({
                    type: 'spark',
                    x: k.x + (Math.random() - 0.5) * 60,
                    y: k.y - 70 - Math.random() * 40,
                    vx: (Math.random() - 0.5) * 120,
                    vy: -60 - Math.random() * 80,
                    color: ['#f1c40f', '#e74c3c', '#2ecc71', '#3498db', '#ffffff'][Math.floor(Math.random() * 5)],
                    size: 2 + Math.random() * 3,
                    lifetime: 1.4,
                    time: 0
                });
            }
        }
        this.updateParticles(dt);
        this.weather.update(dt);

        if (dance.time >= dance.duration) this.finishVictoryDance();
    }

    finishVictoryDance() {
        const dance = this.victoryDance;
        if (!dance) return;
        clearTimeout(this.victoryDanceTimeout);
        this.victoryDance = null;
        this.emit('gameOver', dance.result);
    }

    /**
     * Number of distinct alliances still standing. The match is over when
     * this drops to 1 (or 0 — mutual destruction).
     */
    countAliveAlliances(aliveTeams = this.teams.filter(t => t.isAlive())) {
        return new Set(aliveTeams.map(t => t.alliance || t.color)).size;
    }

    /**
     * Alliance colour of the local player's squad (null in practice)
     */
    getMyAlliance() {
        if (this.isPractice || !this.networkManager) return null;
        for (let i = 0; i < this.teams.length; i++) {
            if (this.networkManager.isMyTeam(i)) {
                return this.teams[i].alliance;
            }
        }
        return null;
    }

    /**
     * Kill an entire team (player left and never came back, or surrendered).
     * Deterministic, so every client can apply it from the same message.
     */
    forfeitTeam(teamIndex) {
        const team = this.teams[teamIndex];
        if (!team) return;
        log.debug(`🏳️ ${team.name} forfeits`);
        for (const koala of team.koalas) {
            if (koala.isAlive) {
                koala.health = 0;
                koala.die();
                this.createDeathEffect(koala);
            }
        }
        this.updateTeamHealth();
    }

    /**
     * Calculate end-game stats
     */
    calculateStats() {
        let totalDamage = 0;
        let totalKills = 0;

        for (const team of this.teams) {
            for (const koala of team.koalas) {
                totalDamage += koala.damageDealt || 0;
                if (!koala.isAlive) totalKills++;
            }
        }

        return { totalDamage, totalKills, ...(this.stats ? this.stats.summary() : {}) };
    }

    /**
     * Render the game
     */
    render() {
        this.renderer.render();
    }

    /**
     * Handle window resize
     */
    handleResize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    /**
     * Reset game for rematch
     * Re-runs the same initialization path as start() so custom maps,
     * countdown, loot state etc. all behave like a fresh game.
     */
    reset() {
        log.debug('Resetting game...');

        // Stop current game loop
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }

        // Clear all transient state
        clearTimeout(this.victoryDanceTimeout);
        this.victoryDance = null;
        this.teams = [];
        this.projectiles = [];
        this.projectilePool = [];
        this.particles = [];
        this.delayedActions = []; // Stale callbacks from the old game must not fire
        this.followingProjectile = null;
        this.currentTeamIndex = 0;
        this.currentKoalaIndex = 0;
        this.isGameOver = false;
        this.isPaused = false;
        this.phase = 'waiting';
        this.turnTimer = this.turnTime;
        this.shotgunShotsRemaining = 0;
        this.firePatches = [];
        this.oilDrums = [];
        this.graves = [];
        this.deathCamTimer = 0;
        this.kamikazeState = null;
        this.ropeState = null;
        this.ropeAmmoTurn = undefined;
        this.lootManager.reset();
        this.spatialGrid.clear();

        // Reset weapon manager and input state
        this.weaponManager.reset();
        this.inputManager.isCharging = false;
        this.cleanupTurnInputState();

        // start() regenerates terrain (or reloads the custom map), creates
        // teams, randomizes wind, runs the countdown and restarts the loop
        this.start();

        log.debug('Game reset complete!');
    }

    /**
     * Destroy game instance
     */
    destroy() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }

        this.isGameOver = true; // Stops any in-flight gameLoop callback

        // Stop music - each Game owns an AudioManager, so a leftover instance
        // would keep playing on top of the next game's music
        this.audioManager.stopMusic();

        // Stop background timer
        this.stopFallbackTimer();

        // Remove visibility handler
        if (this.visibilityHandler) {
            document.removeEventListener('visibilitychange', this.visibilityHandler);
            this.visibilityHandler = null;
        }

        this.inputManager.destroy();
        this.instantReplay?.destroy();
        clearTimeout(this.victoryDanceTimeout);
        this.victoryDance = null;
    }
}

// Subsystems live in js/engine/game/ as plain method bags; installing them
// on the prototype keeps every call site (game.fireWeapon, game.updateRope,
// renderer/AI/network access to game state) exactly as it was.
Object.assign(Game.prototype,
    SpawnSystem,
    ProjectileSystem,
    Effects,
    DeathSystem,
    HazardSystem,
    RopeSystem,
    ToolWeapons,
    Firing,
    CameraSystem,
    HUD,
    NetSync
);
