/**
 * Game Engine - Core game loop and state management
 */

import { Terrain } from './Terrain.js';
import { Physics } from './Physics.js';
import { Renderer } from './Renderer.js';
import { Koala } from '../entities/Koala.js';
import { Team } from '../entities/Team.js';
import { WeaponManager } from '../weapons/WeaponManager.js';
import { Projectile } from '../weapons/Projectile.js';
import { InputManager } from './InputManager.js';
import { EventEmitter } from '../utils/EventEmitter.js';
import { AudioManager, globalAudioManager } from './AudioManager.js';
import { LootManager } from './LootManager.js';
import { SpatialGrid } from './SpatialGrid.js';
import { DOMCache } from '../utils/DOMCache.js';
import { TurnManager } from './TurnManager.js';
import { WeatherSystem } from './WeatherSystem.js';
import { sanitizeScheme } from '../utils/GameScheme.js';
import { TEAM_COLORS, TEAM_COLOR_LABELS } from '../utils/TeamColors.js';

export class Game extends EventEmitter {
    // Phases during which the active player is in control of their koala. If that
    // koala dies during one of these (e.g. drowns), the turn is handed over.
    static LIVE_TURN_PHASES = ['aiming', 'armed', 'firing', 'blowtorch', 'drill', 'rope'];

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

        // Burning patches of ground (petrol bomb / napalm strike)
        this.firePatches = [];

        // Explosive oil drums scattered on the map (WA-style hazards).
        // Landmines are stationary Projectiles and live in this.projectiles.
        this.oilDrums = [];

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

        // DOM Cache - eliminates querySelector bottleneck
        this.dom = new DOMCache();
        this.dom.init(); // Cache all DOM references once

        // Loot crate system (replaces old powerups)
        this.lootManager = new LootManager(this);

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
        this.gameSeed = initialState?.seed ?? Math.floor(Math.random() * 1000000);
        console.log('🎲 Game seed:', this.gameSeed);

        // Create seeded random function for consistent results
        this.seededRandom = this.createSeededRandom(this.gameSeed);

        // Reset camera to default zoom and position
        this.camera.zoom = 1.1; // 110% to fill screen
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

        // Start game loop
        this.lastTime = performance.now();
        this.gameLoop();

        // Start background timer for when tab is inactive (multiplayer sync)
        if (this.networkManager && !this.isPractice) {
            this.startBackgroundTimer();
        }

        console.log('🎮 Game started!');
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
                    console.log(`📐 Using exported map bounds: Top=${this.mapBounds.topY}, Bottom=${this.mapBounds.bottomY}`);
                } else {
                    if (converted) {
                        console.log('🩹 Converted fully-opaque map to a playable terrain mask');
                    }
                    // Fallback: calculate bounds from terrain (for older maps)
                    this.mapBounds = {
                        topY: this.terrain.getMapTopBoundary(),
                        bottomY: this.worldHeight - 100,
                        waterLevel: this.worldHeight - 60
                    };
                    console.log(`📐 Calculated map bounds: Top=${this.mapBounds.topY}`);
                }

                console.log('🗺️ Custom map loaded:', mapData.name);
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
     * Create teams and place koalas
     * Spawning priority:
     * 1. Try to spawn at custom marker positions
     * 2. If marker position is invalid, find nearest valid spawn point from marker
     * 3. If no markers exist, use random spawning from valid spawn points
     */
    createTeams() {
        const koalaCount = this.scheme.koalasPerTeam;

        // Multiplayer: one squad per player, in gameState.players order (so
        // teams[i] is driven by players[i] on every client). A player's
        // colour is their alliance — same colour means allied squads.
        // Practice keeps the classic red-vs-blue setup.
        const players = this.options.initialState?.players;
        let teamConfigs;
        if (Array.isArray(players) && players.length >= 2) {
            teamConfigs = players.map(p => ({
                name: p.name || `${TEAM_COLOR_LABELS[p.color] || p.color} Team`,
                color: TEAM_COLORS[p.color] || p.color,
                alliance: p.color,
                koalaCount
            }));
        } else {
            teamConfigs = [
                { name: 'Red Team', color: '#e74c3c', alliance: 'red', koalaCount },
                { name: 'Blue Team', color: '#3498db', alliance: 'blue', koalaCount }
            ];
        }

        // STEP 1: Pre-scan the entire map for valid spawn points
        // This must happen AFTER the map is loaded (which it is, since start() awaits loadCustomMap)
        console.log('🗺️ Scanning map for valid spawn points...');
        this.validSpawnPoints = this.terrain.getAllSpawnPoints(this.getSpawnScanBounds());
        console.log(`✅ Found ${this.validSpawnPoints.length} valid spawn points on map`);

        // Track all spawned positions to avoid overlap
        const spawnedPositions = [];
        const minSpawnDistance = this.options.customMap ? 80 : 150;

        // Get custom spawn markers from the map editor (if any)
        const customSpawns = this.options.customMap?.spawns || null;
        const hasCustomSpawns = customSpawns &&
            ((customSpawns.team1 && customSpawns.team1.length > 0) ||
                (customSpawns.team2 && customSpawns.team2.length > 0));

        console.log('🎯 Custom spawn markers:', hasCustomSpawns ? JSON.stringify(customSpawns) : 'None');

        // Bias teams toward separate slices of the map for fairer starts.
        // Use the actual horizontal extent of standable terrain (custom maps may
        // not fill the world width), split it into one band per team, and deal
        // the bands out in seeded-shuffled order so all multiplayer clients
        // agree. Only affects the random (markerless) spawn path — explicit
        // markers always win.
        const rand = () => this.seededRandom ? this.seededRandom() : Math.random();
        let extentMinX = 0, extentMaxX = this.worldWidth;
        if (this.validSpawnPoints.length > 0) {
            let minX = Infinity, maxX = -Infinity;
            for (const p of this.validSpawnPoints) {
                if (p.x < minX) minX = p.x;
                if (p.x > maxX) maxX = p.x;
            }
            extentMinX = minX;
            extentMaxX = maxX;
        }
        const bandCount = teamConfigs.length;
        const bandWidth = (extentMaxX - extentMinX) / bandCount;
        const bandOrder = [...Array(bandCount).keys()];
        for (let i = bandOrder.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [bandOrder[i], bandOrder[j]] = [bandOrder[j], bandOrder[i]];
        }
        const teamBands = bandOrder.map(k => ({
            minX: extentMinX + k * bandWidth,
            maxX: extentMinX + (k + 1) * bandWidth
        }));
        console.log('⚔️ Team spawn bands →', teamConfigs.map((c, i) =>
            `${c.name}: ${Math.round(teamBands[i].minX)}-${Math.round(teamBands[i].maxX)}`).join(', '));

        teamConfigs.forEach((config, teamIndex) => {
            const team = new Team(config.name, config.color, config.alliance);
            // Custom-map spawn markers only define two groups; teams beyond
            // the second fall back to random band spawning (empty marker list)
            const teamKey = teamIndex === 0 ? 'team1' : (teamIndex === 1 ? 'team2' : null);

            // Get spawn markers for this team (if any)
            const teamMarkers = (teamKey && customSpawns?.[teamKey]) || [];
            console.log(`📍 ${config.name}: ${teamMarkers.length} spawn marker(s)`);

            // Place koalas on terrain
            for (let i = 0; i < config.koalaCount; i++) {
                let pos = null;

                // PRIORITY 1: Try spawn marker (if available)
                if (teamMarkers.length > 0) {
                    // Cycle through markers if fewer than koalas
                    const markerIndex = i % teamMarkers.length;
                    const marker = teamMarkers[markerIndex];

                    pos = this.resolveSpawnPosition(marker, spawnedPositions, i >= teamMarkers.length);
                    console.log(`🐨 ${config.name} Koala ${i + 1}: Using marker #${markerIndex + 1} → (${pos.x}, ${pos.y})`);
                }
                // PRIORITY 2: No markers - use random valid spawn
                else {
                    pos = this.findRandomSpawnPosition(spawnedPositions, minSpawnDistance, {
                        band: teamBands[teamIndex]
                    });
                    console.log(`🐨 ${config.name} Koala ${i + 1}: Random spawn → (${pos?.x}, ${pos?.y})`);
                }

                if (pos) {
                    // Snap the koala onto the first solid ground BELOW the spawn
                    // point so it never free-falls through lower levels on a
                    // multi-level map. If the only ground below is underwater (or
                    // there's none at all), the marker is over a gap/water — fall
                    // back to the nearest scanned valid spawn point instead.
                    const waterLevel = this.mapBounds?.waterLevel ?? (this.worldHeight - 60);
                    let groundY = this.terrain.getGroundBelow(pos.x, pos.y);

                    if (groundY >= waterLevel) {
                        const nearest = this.findNearestValidSpawn(pos.x, pos.y, spawnedPositions);
                        if (nearest) {
                            console.log(`   ⚠️ Spawn over gap/water at (${pos.x}, ${pos.y}), relocating to (${nearest.x}, ${nearest.y})`);
                            pos.x = nearest.x;
                            pos.y = nearest.y;
                            groundY = this.terrain.getGroundBelow(pos.x, pos.y);
                        }
                    }

                    if (groundY < waterLevel) {
                        console.log(`   ✨ Snapping Koala to ground: ${pos.y} -> ${groundY - 15}`);
                        pos.y = groundY - 15; // Place feet on ground (-15 is half height)
                    }

                    spawnedPositions.push(pos);
                    const koala = new Koala(pos.x, pos.y, team);
                    koala.name = this.getKoalaName(teamIndex, i);

                    // Scheme-defined starting health
                    koala.maxHealth = this.scheme.startingHealth;
                    koala.health = this.scheme.startingHealth;

                    // Ensure physics state is grounded immediately
                    koala.onGround = true;
                    koala.vy = 0;

                    team.addKoala(koala);
                }
            }

            // Give each team their own set of weapons
            team.weapons = this.weaponManager.createWeapons();
            this.teams.push(team);
        });

        // Register all koalas in spatial grid
        this.rebuildSpatialGrid();

        this.buildTeamHealthUI();
        this.updateTeamHealth();
    }

    /**
     * Build one HUD health bar per team. The markup used to be two static
     * red/blue rows in index.html; with up to 4 squads the rows are generated
     * here and coloured from the team.
     */
    buildTeamHealthUI() {
        const container = document.getElementById('team-health');
        this.teamHpEls = [];
        if (!container) return;

        container.innerHTML = '';
        for (const team of this.teams) {
            const row = document.createElement('div');
            row.className = 'team-hp';

            const name = document.createElement('span');
            name.className = 'team-name';
            name.textContent = team.name;
            name.style.color = team.color;
            name.title = team.name;

            const bar = document.createElement('div');
            bar.className = 'hp-bar';
            const fill = document.createElement('div');
            fill.className = 'hp-fill';
            fill.style.background = team.color;
            bar.appendChild(fill);

            const value = document.createElement('span');
            value.className = 'hp-value';
            value.textContent = team.getTotalHealth();

            row.appendChild(name);
            row.appendChild(bar);
            row.appendChild(value);
            container.appendChild(row);

            this.teamHpEls.push({ row, fill, value });
        }
    }

    /**
     * Rebuild the spatial grid with all entities
     */
    rebuildSpatialGrid() {
        const entities = [];

        // Add all koalas
        for (const team of this.teams) {
            for (const koala of team.koalas) {
                // Include ALL koalas (alive and dead) so dead bodies can be flung by explosions
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
     * Build the bounds passed to the terrain spawn scan so it respects the
     * real map area (no dead zone above imported maps, no underwater surfaces).
     *
     * A top-margin exclusion zone (10% of playable height) prevents characters
     * from spawning on thin terrain edges or slivers near the very top of the
     * map, which is a common issue with user-created maps.
     */
    getSpawnScanBounds() {
        const rawTopY = this.mapBounds?.topY || 0;
        const waterLevel = this.mapBounds?.waterLevel ?? (this.worldHeight - 60);

        // Push the spawn ceiling down by 10% of the playable map height so
        // characters never appear right at the top edge of the terrain.
        const playableHeight = waterLevel - rawTopY;
        const topMargin = Math.max(60, Math.floor(playableHeight * 0.10));
        const adjustedTopY = rawTopY + topMargin;

        console.log(`📏 Spawn scan: topY=${rawTopY} + margin=${topMargin} → effective=${adjustedTopY}, waterLevel=${waterLevel}`);

        return {
            topY: adjustedTopY,
            waterLevel,
        };
    }

    /**
     * Resolve a spawn marker to a valid spawn position
     * @param {Object} marker - The marker position {x, y} from the editor
     * @param {Array} existingPositions - Already spawned positions to avoid
     * @param {boolean} addJitter - Whether to add random offset (for shared markers)
     * @returns {Object} Final spawn position {x, y}
     */
    resolveSpawnPosition(marker, existingPositions, addJitter = false) {
        let x = marker.x;
        let y = marker.y;

        // Helper: use seeded random if available (multiplayer sync)
        const rand = () => this.seededRandom ? this.seededRandom() : Math.random();

        // Reject markers above the spawn exclusion ceiling (top of map)
        const spawnBounds = this.getSpawnScanBounds();
        if (y < spawnBounds.topY) {
            console.log(`   ⚠️ Marker (${x}, ${y}) is above spawn ceiling (${spawnBounds.topY}), relocating...`);
            const nearest = this.findNearestValidSpawn(x, y, existingPositions);
            if (nearest) {
                console.log(`   ✅ Relocated to (${nearest.x}, ${nearest.y})`);
                return nearest;
            }
        }

        // Check if marker position has valid ground nearby
        const isValidSpawn = this.isValidSpawnPoint(x, y);

        if (isValidSpawn) {
            // Marker is in a valid spot - use it directly
            // (or apply small jitter if reusing same marker)
            if (addJitter) {
                x += (rand() - 0.5) * 50;
            }
            return { x, y };
        }

        // Marker is NOT in a valid spot - find nearest valid spawn point
        console.log(`   ⚠️ Marker (${x}, ${y}) is not a valid spawn, finding nearest...`);
        const nearest = this.findNearestValidSpawn(x, y, existingPositions);

        if (nearest) {
            console.log(`   ✅ Found nearest valid spawn at (${nearest.x}, ${nearest.y})`);
            return nearest;
        }

        // Absolute fallback: spawn at marker anyway and let physics handle it
        console.log(`   ❌ No valid spawn found, using marker position anyway`);
        return { x: marker.x, y: marker.y };
    }

    /**
     * Check if a position is a valid spawn point
     * For user-placed markers, we're more permissive - just ensure we're not inside solid terrain
     * The koala will fall to the ground naturally via physics
     */
    isValidSpawnPoint(x, y) {
        // Must not be inside solid terrain
        if (this.terrain.checkCollision(x, y)) {
            return false;
        }

        // Also check a small area around the point for the koala's body
        // Koala is roughly 24px wide, 30px tall
        const bodyCheckPoints = [
            { dx: 0, dy: -10 },   // Head area
            { dx: -10, dy: 0 },   // Left side
            { dx: 10, dy: 0 },    // Right side
        ];

        for (const point of bodyCheckPoints) {
            if (this.terrain.checkCollision(x + point.dx, y + point.dy)) {
                return false; // Part of body would be in terrain
            }
        }

        // Valid - the koala will fall naturally if there's no ground immediately below
        // This is intentional to allow spawning on floating platforms, in open air, etc.
        return true;
    }

    /**
     * Find the nearest valid spawn point to a target position
     */
    findNearestValidSpawn(targetX, targetY, existingPositions = []) {
        if (!this.validSpawnPoints || this.validSpawnPoints.length === 0) {
            return null;
        }

        let nearestPoint = null;
        let nearestDist = Infinity;

        for (const point of this.validSpawnPoints) {
            const dist = Math.hypot(point.x - targetX, point.y - targetY);

            // Check if this point is already used (too close to existing spawns)
            let tooClose = false;
            for (const pos of existingPositions) {
                if (Math.hypot(point.x - pos.x, point.y - pos.y) < 50) {
                    tooClose = true;
                    break;
                }
            }

            if (!tooClose && dist < nearestDist) {
                nearestDist = dist;
                nearestPoint = point;
            }
        }

        return nearestPoint ? { ...nearestPoint } : null;
    }

    /**
     * Find a random safe spawn position anywhere on the map.
     * Uses a pre-calculated list of every valid standing surface to ensure
     * that characters can spawn in caves, on islands, and in the top half of the map.
     */
    findRandomSpawnPosition(existingPositions, minDistance, options = {}) {
        // Helper: use seeded random if available (multiplayer sync)
        const rand = () => this.seededRandom ? this.seededRandom() : Math.random();

        // 1. Get ALL potentially valid spawn points from the terrain engine
        // This scans the entire map once per game start
        if (!this.validSpawnPoints || this.validSpawnPoints.length === 0) {
            this.validSpawnPoints = this.terrain.getAllSpawnPoints(this.getSpawnScanBounds());
        }

        // If the map is completely empty or the scan failed, use a safety fallback
        if (!this.validSpawnPoints || this.validSpawnPoints.length === 0) {
            console.warn('⚠️ No spawn points found via scan, using safety fallback');
            return { x: 100 + rand() * (this.worldWidth - 200), y: 100 };
        }

        // 2. Use all valid points found in the scan
        const safePoints = this.validSpawnPoints;

        // 3. Shuffle the points for random selection (using seeded random for sync).
        // Fisher-Yates produces an unbiased, deterministic permutation — unlike
        // Array.sort with a random comparator, which is biased and unstable.
        const shuffledPoints = [...(safePoints.length > 0 ? safePoints : this.validSpawnPoints)];
        for (let i = shuffledPoints.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [shuffledPoints[i], shuffledPoints[j]] = [shuffledPoints[j], shuffledPoints[i]];
        }

        // 3b. Bias toward the team's slice of the map: put in-band points
        // first (still randomly ordered within the band), with the rest kept
        // as fallback so we never fail to place a koala on cramped maps.
        let orderedPoints = shuffledPoints;
        if (options.band) {
            const near = [], far = [];
            for (const p of shuffledPoints) {
                const inBand = p.x >= options.band.minX && p.x <= options.band.maxX;
                (inBand ? near : far).push(p);
            }
            orderedPoints = near.concat(far);
        }

        // 4. Try to find a point that satisfies distance and Line-of-Sight requirements
        for (const point of orderedPoints) {
            let invalidSpot = false;
            for (const pos of existingPositions) {
                const dist = Math.hypot(point.x - pos.x, point.y - pos.y);

                // Check minimum distance
                if (dist < minDistance) {
                    invalidSpot = true;
                    break;
                }

                // Check Line-of-Sight (separation by terrain)
                // If they are relatively close, they should be separated by a wall
                if (dist < 450) {
                    const hasLOS = this.terrain.lineOfSight(point.x, point.y - 15, pos.x, pos.y - 15);
                    if (hasLOS) {
                        invalidSpot = true;
                        break;
                    }
                }
            }

            if (!invalidSpot) {
                return { ...point };
            }
        }

        // 5. Relax requirements if no perfect spot found (ignore Line of Sight)
        console.log('Relaxing spawn requirements (ignoring Line-of-Sight)...');
        for (const point of orderedPoints) {
            let tooClose = false;
            for (const pos of existingPositions) {
                if (Math.hypot(point.x - pos.x, point.y - pos.y) < 100) {
                    tooClose = true;
                    break;
                }
            }
            if (!tooClose) return { ...point };
        }

        // 6. Hard fallback: Just pick any valid point from the list (using seeded random)
        const randomIndex = Math.floor(rand() * orderedPoints.length);
        const randomPoint = orderedPoints[randomIndex];
        return { ...randomPoint };
    }

    /**
     * Find a safe spawn position near the ideal X
     */
    findSafeSpawnPosition(idealX) {
        // Search pattern: check ideal X, then expanding outwards
        const searchStep = 10;
        const maxOffset = 300; // Search up to 300px away

        for (let offset = 0; offset <= maxOffset; offset += searchStep) {
            // Check both directions (except for offset 0)
            const directions = offset === 0 ? [1] : [1, -1];

            for (const dir of directions) {
                const x = idealX + (offset * dir);

                // Keep within world bounds with padding
                if (x < 50 || x > this.worldWidth - 50) continue;

                // Find ground level
                const groundY = this.terrain.getGroundY(x);

                // Avoid spawning in water
                if (groundY >= this.worldHeight - 60) continue;

                // Check for clearance around the spawn point
                // Koala is roughly 24px wide, 30px tall
                if (this.checkSpawnClearance(x, groundY)) {
                    return { x, y: groundY - 20 };
                }
            }
        }

        // Fallback if no safe spot found (spawn high in air)
        console.warn('Could not find safe spawn for X:', idealX);
        return { x: idealX, y: 0 };
    }

    /**
     * Check if area above ground is clear for spawning
     */
    checkSpawnClearance(x, groundY) {
        const halfWidth = 18; // Slightly wider for safety
        const height = 60; // Check higher for comfortable standing

        // Check immediate body clearance (the space the koala will occupy)
        for (let checkX = x - halfWidth; checkX <= x + halfWidth; checkX += halfWidth / 2) {
            for (let checkY = groundY - 5; checkY >= groundY - height; checkY -= 8) {
                if (this.terrain.checkCollision(checkX, checkY)) {
                    return false; // Hit something (enclosed/cramped)
                }
            }
        }

        // NOTE: Removed "True Sky" check that required clear air all the way to Y=0
        // That was preventing spawns under floating islands and multi-layered terrain
        // We only need enough clearance for the koala to stand, not open sky above

        return true;
    }

    /**
     * Get a fun koala name
     */
    getKoalaName(teamIndex, index) {
        // One pool per team slot. Names must stay unique across ALL teams:
        // network sync messages identify koalas by name (findKoalaByName).
        const names = [
            ['DelinquentKoala', 'Sleepy Steve', 'Chompy Charlie'],
            ['ChronoKoala', 'Koala Kate', 'Dropbear Dan'],
            ['Gumleaf Gus', 'Wombat Wally', 'Eucalyptus Ed'],
            ['Bushfire Betty', 'Outback Ozzy', 'Didgeri Dee']
        ];
        return names[teamIndex]?.[index] || `Koala ${teamIndex + 1}-${index + 1}`;
    }

    /**
     * Main game loop
     */
    gameLoop(currentTime = 0) {
        if (this.isGameOver) return;

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
        this.fixedAccumulator += deltaTime;
        const FIXED_DT = 1 / 60; // 60 FPS fixed physics step

        // Performance debugging
        if (window.debugPerformance) {
            const frameStart = performance.now();
            let updateTime = 0, renderTime = 0;

            if (!this.isPaused) {
                const t0 = performance.now();
                while (this.fixedAccumulator >= FIXED_DT) {
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
                console.log(`📊 Avg: ${avg.toFixed(2)}ms (${(1000 / avg).toFixed(0)} FPS) | Max: ${max.toFixed(1)}ms`);
            }
        } else {
            // Normal loop (no debugging overhead)
            if (!this.isPaused) {
                while (this.fixedAccumulator >= FIXED_DT) {
                    this.update(FIXED_DT);
                    this.fixedAccumulator -= FIXED_DT;
                }
            }
            this.render();
        }

        this.animationId = requestAnimationFrame((t) => this.gameLoop(t));
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
                    console.log('🔄 Tab hidden - starting background timer');
                    this.startFallbackTimer();
                } else {
                    // Tab became visible - stop fallback timer
                    console.log('🔄 Tab visible - stopping background timer');
                    this.stopFallbackTimer();
                    // Sync time to prevent huge deltaTime
                    this.lastTime = performance.now();
                }
            };
            document.addEventListener('visibilitychange', this.visibilityHandler);
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
            const FIXED_DT = 1 / 60;

            if (!this.isPaused) {
                while (this.fixedAccumulator >= FIXED_DT) {
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

        // Always update projectiles/traps (mines need to work even during aiming)
        if (profile) t0 = performance.now();
        this.updateProjectiles(dt);
        if (profile) { t1 = performance.now(); if (t1 - t0 > 2) console.log(`  📦 Projectiles: ${(t1 - t0).toFixed(1)}ms`); }

        // Update physics for all entities
        if (profile) t0 = performance.now();
        this.physics.update(dt);
        if (profile) { t1 = performance.now(); if (t1 - t0 > 2) console.log(`  ⚙️ Physics: ${(t1 - t0).toFixed(1)}ms`); }

        // Update spatial grid after physics (entities may have moved)
        if (profile) t0 = performance.now();
        this.rebuildSpatialGrid();
        if (profile) { t1 = performance.now(); if (t1 - t0 > 2) console.log(`  🗺️ SpatialGrid: ${(t1 - t0).toFixed(1)}ms`); }

        // Update particles
        if (profile) t0 = performance.now();
        this.updateParticles(dt);
        if (profile) { t1 = performance.now(); if (t1 - t0 > 2) console.log(`  ✨ Particles: ${(t1 - t0).toFixed(1)}ms`); }

        // Ambient weather (cosmetic, wind-driven)
        this.weather.update(dt);

        // Update loot crates
        if (profile) t0 = performance.now();
        this.lootManager.update(dt);
        if (profile) { t1 = performance.now(); if (t1 - t0 > 2) console.log(`  📦 Loot: ${(t1 - t0).toFixed(1)}ms`); }

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

        // Update UI states based on input
        this.inputManager.update(dt);

        // Smooth camera movement
        this.updateCamera(dt);
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
     * Handle melee swing (Baseball Bat)
     */
    handleMeleeSwing(shooter, weapon, angle) {
        // Trigger animation state
        shooter.isSwinging = true;
        shooter.swingProgress = 0;

        // Visual flash at hit area
        const hitX = shooter.x + Math.cos(angle) * weapon.range;
        const hitY = (shooter.y - 10) + Math.sin(angle) * weapon.range;

        const isAuthoritativeClient = this.isPractice || !this.networkManager || this.networkManager.isHost;
        const explosionResults = [];

        // Check for targets (koalas)
        for (const team of this.teams) {
            for (const target of team.koalas) {
                if (!target.isAlive || target === shooter) continue;

                const dist = Math.hypot(target.x - hitX, target.y - hitY);
                if (dist < weapon.range + 10) {
                    if (isAuthoritativeClient) {
                        // HIT! (double damage crate buff applies to melee too)
                        const damage = weapon.damage * this.getDamageMultiplier();
                        if (damage > 0) {
                            target.takeDamage(damage);
                            this.createFloatingText(target.x, target.y - 40, `-${damage}`, '#ff5544');
                            shooter.damageDealt = (shooter.damageDealt || 0) + damage;
                        }

                        // Knockback direction depends on the weapon:
                        // Fire Punch launches skyward, Dragon Ball sends them
                        // flat, Prod is a pure WA-style nudge (no lift, no
                        // tumble — just enough to walk someone off a ledge),
                        // everything else follows the swing angle
                        let kbX, kbY;
                        if (weapon.verticalKnockback) {
                            kbX = Math.cos(angle) * 0.35 * weapon.knockback;
                            kbY = -weapon.knockback;
                        } else if (weapon.flatKnockback) {
                            kbX = (Math.cos(angle) >= 0 ? 1 : -1) * weapon.knockback;
                            kbY = -0.3 * weapon.knockback;
                        } else if (weapon.pushKnockback) {
                            kbX = (Math.cos(angle) >= 0 ? 1 : -1) * weapon.knockback;
                            kbY = 0;
                        } else {
                            kbX = Math.cos(angle) * weapon.knockback;
                            kbY = Math.sin(angle) * weapon.knockback;
                        }
                        target.applyKnockback(kbX, kbY, { tumble: !weapon.pushKnockback });

                        explosionResults.push({
                            koalaName: target.name,
                            damage,
                            newHealth: target.health,
                            x: target.x,
                            y: target.y,
                            vx: target.vx,
                            vy: target.vy
                        });
                    }

                    this.audioManager.playDamage();
                    // Particle effects for hit
                    this.createExplosionParticles(target.x, target.y, 10, '#fff');
                    console.log('Melee hit on', target.name, 'knockback:', weapon.knockback);
                }
            }
        }

        // Whacking an oil drum sets it off. Authoritative client applies the
        // damage; the resulting detonation reaches the guest via the synced
        // drum id in explosionSync.
        if (isAuthoritativeClient) {
            this.damageOilDrums(hitX, hitY, weapon.range + 10, weapon.damage || 30);
        }

        // Send sync to ensure players match health and positions
        if (this.networkManager && !this.isPractice && this.networkManager.isHost && explosionResults.length > 0) {
            this.networkManager.send({
                type: 'explosionSync',
                explosionX: 0,
                explosionY: 0,
                explosionRadius: 0, // 0 means no terrain destruction
                results: explosionResults
            });
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
     * Activate blowtorch - dig through terrain while following mouse
     */
    activateBlowtorch(koala, weapon) {
        this.phase = 'blowtorch';

        // Store blowtorch state on the koala
        koala.blowtorchActive = true;
        koala.blowtorchMeter = 100; // Start with full meter
        koala.blowtorchMaxMeter = 100;
        koala.blowtorchSpeed = weapon.speed;
        koala.blowtorchDigRadius = weapon.digRadius;
        koala.blowtorchDrainRate = 33; // Meter per second when digging (~3 seconds total)
        koala.blowtorchDigging = false; // Not digging until mouse pressed
        // Passive-client carve anchor (see updateBlowtorch) — reset each use
        koala._btCarveX = koala.x;
        koala._btCarveY = koala.y;

        // Show power bar as blowtorch meter at 100%
        if (this.dom.elements.powerBarContainer) {
            this.dom.elements.powerBarContainer.classList.remove('hidden');
        }
        if (this.dom.elements.powerFill) {
            this.dom.elements.powerFill.style.width = '100%'; // Start at full
        }

        console.log('Blowtorch activated for', koala.name);
    }

    /**
     * Update blowtorch - meter-based digging system
     */
    updateBlowtorch(dt) {
        const koala = this.getCurrentKoala();
        if (!koala || !koala.blowtorchActive) {
            this.endBlowtorch();
            return;
        }

        const myTurn = this.isMyTurn();

        // PASSIVE CLIENT: we don't own this koala. Its position arrives via
        // remote 'move' messages and the active player is the sole authority on
        // when the blowtorch ends (we leave it on the 'turnEnd' message in
        // handleRemoteTurnEnd). Carve terrain along the path the koala actually
        // travels so both clients dig identical tunnels — driving movement from
        // OUR local mouse here would dig in a totally different direction.
        if (!myTurn && !this.isPractice) {
            const isDigging = koala.blowtorchDigging;
            if (koala._btCarveX === undefined) {
                koala._btCarveX = koala.x;
                koala._btCarveY = koala.y;
            }
            if (isDigging) {
                const moved = Math.hypot(koala.x - koala._btCarveX, koala.y - koala._btCarveY);
                if (moved >= 4) {
                    koala._btCarveX = koala.x;
                    koala._btCarveY = koala.y;
                    this.terrain.createCrater(koala.x, koala.y, koala.blowtorchDigRadius);
                }
            } else {
                // Keep the carve anchor on the koala while idle so we don't
                // carve a long gash the instant digging resumes.
                koala._btCarveX = koala.x;
                koala._btCarveY = koala.y;
            }
            return;
        }

        // ACTIVE CLIENT (or practice): mouse-driven digging.
        const isDigging = myTurn ? this.inputManager.mouse.down : koala.blowtorchDigging;
        koala.blowtorchDigging = isDigging;

        // Only deplete meter when actively digging
        if (isDigging) {
            koala.blowtorchMeter -= koala.blowtorchDrainRate * dt;

            // Update power bar to show remaining meter
            if (this.dom.elements.powerFill) {
                const percentage = Math.max(0, (koala.blowtorchMeter / koala.blowtorchMaxMeter) * 100);
                this.dom.elements.powerFill.style.width = percentage + '%';
            }

            if (koala.blowtorchMeter <= 0) {
                // Meter depleted - end turn
                koala.blowtorchMeter = 0;
                this.endBlowtorch();
                return;
            }
        }

        // Initialize dig accumulator if needed
        if (koala.blowtorchDigAccum === undefined) {
            koala.blowtorchDigAccum = 0;
        }

        // Allow movement during blowtorch phase
        this.inputManager.updateAiming(koala, dt);

        // Only dig when mouse is held
        if (isDigging) {
            // Get mouse position for direction
            const mouse = this.inputManager.mouse;
            const dx = mouse.x - koala.x;
            const dy = mouse.y - (koala.y - 10);
            const dist = Math.hypot(dx, dy);

            if (dist > 5) {
                const dirX = dx / dist;
                const dirY = dy / dist;

                // Move koala toward mouse
                const moveSpeed = koala.blowtorchSpeed * dt;
                const oldX = koala.x;
                const oldY = koala.y;
                koala.x += dirX * moveSpeed;
                koala.y += dirY * moveSpeed;

                // Update facing direction
                koala.facingLeft = dx < 0;

                // Accumulate distance traveled for digging
                const distMoved = Math.hypot(koala.x - oldX, koala.y - oldY);
                koala.blowtorchDigAccum += distMoved;

                // Dig terrain every 4 pixels traveled
                if (koala.blowtorchDigAccum >= 4) {
                    koala.blowtorchDigAccum = 0;
                    this.terrain.createCrater(koala.x, koala.y, koala.blowtorchDigRadius);

                    // Play fire sound occasionally
                    if (Math.random() > 0.9) {
                        this.audioManager.playFire('blowtorch');
                    }
                }

                // Create flame particles
                const particleCount = 3;
                for (let i = 0; i < particleCount; i++) {
                    const spread = (Math.random() - 0.5) * 20;
                    this.addParticle({
                        type: 'spark',
                        x: koala.x + dirX * 15,
                        y: koala.y + dirY * 15,
                        vx: dirX * 50 + spread,
                        vy: dirY * 50 + spread,
                        color: Math.random() > 0.5 ? '#ff6600' : '#ffcc00',
                        size: 2 + Math.random() * 2,
                        lifetime: 0.5,
                        time: 0
                    });
                }

                // Keep koala in bounds
                koala.x = Math.max(20, Math.min(this.worldWidth - 20, koala.x));
                koala.y = Math.max(20, Math.min(this.worldHeight - 20, koala.y));
            }
        }
    }

    /**
     * End blowtorch mode and clean up
     */
    endBlowtorch() {
        const koala = this.getCurrentKoala();
        if (koala) {
            koala.blowtorchActive = false;
            koala.blowtorchDigging = false;
        }

        // Hide power bar
        if (this.dom.elements.powerBarContainer) {
            this.dom.elements.powerBarContainer.classList.add('hidden');
        }
        if (this.dom.elements.powerFill) {
            this.dom.elements.powerFill.style.width = '0%';
        }

        // NETWORK SYNC: Send turn end/retreat to remote player
        if (this.networkManager && !this.isPractice && this.isMyTurn()) {
            this.sendTurnEnd();
        }

        this.startRetreat();
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

    /**
     * Remove a projectile and mark it as destroyed (for camera tracking)
     * Returns it to the pool for reuse
     */
    removeProjectile(index) {
        const proj = this.projectiles[index];
        if (proj) {
            proj.destroyed = true;
            // Stop camera tracking before the object is recycled,
            // otherwise a pooled reuse could re-attach the camera
            if (this.followingProjectile === proj) {
                this.followingProjectile = null;
            }
            // Return to pool for reuse
            this.returnProjectileToPool(proj);
        }
        this.projectiles.splice(index, 1);
    }

    /**
     * Get a projectile from the pool or create a new one
     */
    getProjectileFromPool() {
        if (this.projectilePool.length > 0) {
            return this.projectilePool.pop();
        }
        // Pool is empty, will need to create new one
        return null;
    }

    /**
     * Return a projectile to the pool for reuse
     */
    returnProjectileToPool(projectile) {
        // Don't exceed pool size
        if (this.projectilePool.length >= this.maxPoolSize) {
            return;
        }

        // Reset projectile properties for reuse
        projectile.destroyed = false;
        projectile.stationary = false;
        projectile.timerStarted = false;
        projectile.timeOnGround = 0;
        projectile.bounceCount = 0;
        projectile.isTriggered = false;
        projectile.triggerTimer = 0;
        projectile.shooter = null;

        this.projectilePool.push(projectile);
    }

    /**
     * True if any projectile is still "live" and should hold up the turn from
     * ending: still moving, counting down an active timer, or a triggered mine.
     * Inert map hazards (resting landmines, duds) are stationary with no timer
     * and must NOT count — they live in this.projectiles permanently, so
     * treating them as active would loop the retreat phase forever.
     */
    hasBlockingProjectiles() {
        for (let i = 0; i < this.projectiles.length; i++) {
            const p = this.projectiles[i];
            if (!p.stationary || (p.timer !== null && p.timerStarted) || p.isTriggered) {
                return true;
            }
        }
        return false;
    }

    /**
     * Update projectiles
     */
    updateProjectiles(dt) {
        // Handle turn phase transition
        if (this.phase === 'projectile') {
            // Decrement grace timer
            if (this.projectileGraceTimer > 0) {
                this.projectileGraceTimer -= dt;
                // Don't check for phase transition during grace period
            } else {
                if (!this.hasBlockingProjectiles()) {
                    console.log(`🔄 Phase transition check: shotgunShotsRemaining=${this.shotgunShotsRemaining}, projectiles=${this.projectiles.length}`);

                    // Special handling for shotgun multi-shot
                    if (this.shotgunShotsRemaining > 0) {
                        console.log(`🔫 Shotgun ready for shot ${2 - this.shotgunShotsRemaining + 1}`);
                        this.phase = 'aiming'; // Return to aiming for next shot
                        return;
                    }

                    // Reset shotgun counter when turn ends
                    this.shotgunShotsRemaining = 0;
                    console.log('🏃 Starting retreat');
                    this.startRetreat();
                    return;
                }
            }
        }

        if (this.projectiles.length === 0) return;

        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const proj = this.projectiles[i];

            // Store previous position BEFORE physics updates
            const prevX = proj.x;
            const prevY = proj.y;

            // Homing missiles steer toward their locked target after a boost phase
            if (proj.homingTarget && !proj.stationary) {
                proj.homingDelay -= dt;
                if (proj.homingDelay <= 0 && proj.homingFuel > 0) {
                    proj.homingFuel -= dt;
                    const hx = proj.homingTarget.x - proj.x;
                    const hy = proj.homingTarget.y - proj.y;
                    const hd = Math.hypot(hx, hy) || 1;
                    if (hd < 30) {
                        // Reached the marker - cut the engine and fly through,
                        // otherwise an in-air target makes it hover forever
                        proj.homingFuel = 0;
                    } else {
                        const cruiseSpeed = 750;
                        const blend = Math.min(1, 6 * dt);
                        proj.vx += ((hx / hd) * cruiseSpeed - proj.vx) * blend;
                        proj.vy += ((hy / hd) * cruiseSpeed - proj.vy) * blend;
                    }
                }
            }

            // Sheep: walks along the ground and hops over obstacles
            if (proj.isWalker) {
                this.updateWalker(proj, dt);
            }

            // Apply physics to move the projectile FIRST
            if (!proj.stationary) {
                this.physics.updateProjectile(proj, dt);

                // Smoke trail for rockets and airstrike missiles
                if ((proj.type === 'bazooka' || proj.type === 'airstrike' || proj.type === 'homing' || proj.type === 'meteor') &&
                    this.particles.length < this.maxParticles - 10) {
                    proj.trailAccum = (proj.trailAccum || 0) + dt;
                    if (proj.trailAccum > 0.03) {
                        proj.trailAccum = 0;
                        this.addParticle({
                            type: 'smoke',
                            x: proj.x - Math.cos(proj.rotation) * 14,
                            y: proj.y - Math.sin(proj.rotation) * 14,
                            vx: (Math.random() - 0.5) * 20,
                            vy: (Math.random() - 0.5) * 20,
                            lifetime: 0.6,
                            time: 0,
                            color: '#bbb',
                            size: 3 + Math.random() * 2
                        });
                    }
                }
            }

            // Check pellet max range (shotgun pellets disappear after distance)
            if (proj.isPellet && proj.maxRange) {
                const distTraveled = Math.hypot(proj.x - proj.startX, proj.y - proj.startY);
                if (distTraveled >= proj.maxRange) {
                    this.removeProjectile(i);
                    continue;
                }
            }

            // Update timer and check for timer-based explosion
            const shouldExplode = proj.update(dt, this.wind);

            // Check mine proximity (duds stay inert once activated)
            if (proj.triggeredByProximity && proj.stationary && !proj.isTriggered && !proj.dudActivated) {
                const target = this.findNearbyKoala(proj.x, proj.y, 65);
                if (target) {
                    proj.isTriggered = true;
                    this.audioManager.playTimerTick(); // Beep!
                    console.log('Mine triggered by', target.name);
                }
            }

            if (shouldExplode) {
                // Check if it's a dud (returns 'dud' string)
                if (shouldExplode === 'dud') {
                    // Create dud smoke effect
                    for (let i = 0; i < 15; i++) {
                        this.addParticle({
                            type: 'smoke',
                            x: proj.x,
                            y: proj.y - 10,
                            vx: (Math.random() - 0.5) * 50,
                            vy: -Math.random() * 100 - 50,
                            lifetime: 1.5,
                            time: 0,
                            color: '#666',
                            size: 4
                        });
                    }
                    console.log('💨 Mine was a DUD!');
                    // Don't remove - dud stays on map
                } else {
                    // Normal explosion
                    this.handleProjectileImpact(proj);
                    this.removeProjectile(i);
                }
                continue;
            }

            // If stationary, check whether the ground beneath was blown away
            // (mines/dynamite resting on terrain should fall when it's destroyed)
            if (proj.stationary) {
                if (!this.terrain.checkCollision(proj.x, proj.y + 4) &&
                    !this.terrain.checkCollision(proj.x, proj.y + 8)) {
                    proj.stationary = false;
                }
                continue;
            }

            // Ray-casting Continuous Collision Detection (CCD) to prevent tunneling
            // We check both terrain AND koalas in the SAME progressive raycast to find the earliest hit
            const dx = proj.x - prevX;
            const dy = proj.y - prevY;
            const distance = Math.hypot(dx, dy);
            const steps = Math.max(1, Math.ceil(distance / 4)); // Check every 4 pixels for precision

            let hitResult = null; // { type: 'terrain'|'koala', x, y, koala? }

            for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                const checkX = prevX + dx * t;
                const checkY = prevY + dy * t;

                // 1. Check koalas first at this step (koalas block projectiles before the terrain behind them does)
                let hitKoala = null;
                for (const team of this.teams) {
                    for (const koala of team.koalas) {
                        // Skip the shooter
                        if (koala === proj.shooter) continue;

                        if (koala.isAlive) {
                            const dist = Math.hypot(checkX - koala.x, checkY - koala.y);
                            if (dist < 20) { // Collision radius
                                hitKoala = koala;
                                break;
                            }
                        }
                    }
                    if (hitKoala) break;
                }

                if (hitKoala) {
                    hitResult = { type: 'koala', x: checkX, y: checkY, koala: hitKoala };
                    break;
                }

                // 2. Check terrain next at this step
                if (this.terrain.checkCollision(checkX, checkY)) {
                    hitResult = { type: 'terrain', x: checkX, y: checkY };
                    break;
                }
            }

            // --- RESOLVE EARLIEST HIT ---
            if (hitResult) {
                // Set projectile position to exact impact point
                proj.x = hitResult.x;
                proj.y = hitResult.y;

                if (hitResult.type === 'koala') {
                    // Check if this weapon should explode on contact
                    if (proj.weapon.noContactExplosion) {
                        // Don't explode, just pass through/bounce
                        console.log(proj.weapon.name, 'hit koala but noContactExplosion is true');
                    } else {
                        // Normal explosion on contact
                        this.handleProjectileImpact(proj, hitResult.koala);
                        this.removeProjectile(i);
                    }
                    continue;
                }
                else if (hitResult.type === 'terrain') {
                    // Handle bouncing projectiles
                    if (proj.bounces) {
                        const speed = Math.hypot(proj.vx, proj.vy);
                        const normal = this.terrain.getSurfaceNormal(proj.x, proj.y);

                        if (speed > 40) {
                            // Still moves - bounce!
                            // Reflect velocity: v = v - 2(v.n)n
                            const dot = proj.vx * normal.x + proj.vy * normal.y;
                            proj.vx = (proj.vx - 2 * dot * normal.x) * proj.bounciness;
                            proj.vy = (proj.vy - 2 * dot * normal.y) * proj.bounciness;

                            // Push out along normal to prevent getting stuck
                            proj.x += normal.x * 4;
                            proj.y += normal.y * 4;

                            proj.bounceCount++;

                            // Start grenade timer on first terrain hit
                            if (proj.onTerrainHit) {
                                proj.onTerrainHit();
                            }

                            this.audioManager.playBounce();
                        } else {
                            // Moving slowly - settle and wait for timer
                            proj.vx = 0;
                            proj.vy = 0;
                            proj.stationary = true;

                            // Push slightly out based on normal
                            proj.x += normal.x * 2;
                            proj.y += normal.y * 2;

                            // Start timer if it hasn't been started
                            if (proj.onTerrainHit) {
                                proj.onTerrainHit();
                            }
                        }
                    } else if (proj.type === 'mine') {
                        // Mines stick to terrain
                        proj.vx = 0;
                        proj.vy = 0;
                        proj.stationary = true;

                        // Push slightly out based on normal to prevent falling through floor
                        const normal = this.terrain.getSurfaceNormal(proj.x, proj.y);
                        proj.x += normal.x * 2;
                        proj.y += normal.y * 2;

                        this.audioManager.playBounce(); // Sound effect for landing
                    } else if (proj.timer !== null && proj.timerStarted) {
                        // Has timer (dynamite, etc.) - stick to terrain and wait for timer
                        proj.vx = 0;
                        proj.vy = 0;
                        proj.stationary = true;
                        const normal = this.terrain.getSurfaceNormal(proj.x, proj.y);
                        proj.x += normal.x * 2;
                        proj.y += normal.y * 2;
                        // Timer already started, just wait
                    } else {
                        // Non-bouncing, non-timer weapons explode on impact
                        this.handleProjectileImpact(proj);
                        this.removeProjectile(i);
                    }
                    continue;
                }
            }

            // Splash and sink when hitting the water surface
            if (proj.y > this.waterLevel && proj.x > 0 && proj.x < this.worldWidth) {
                this.createSplash(proj.x, this.waterLevel);
                this.audioManager.playSplash();
                this.removeProjectile(i);
                continue;
            }

            // Check out of bounds (left, right, bottom, and FAR above screen)
            // Note: Using a large margin for top (-500) to allow high arcing shots
            if (proj.x < -100 || proj.x > this.worldWidth + 100 ||
                proj.y > this.worldHeight + 100 || proj.y < -500) {
                this.removeProjectile(i);
                continue;
            }
        }
    }

    /**
     * Update a walking projectile (sheep): trots along the ground in its
     * throw direction, hops over walls, never settles down for long.
     */
    updateWalker(proj, dt) {
        // A walker never stays parked - terrain hits may have flagged it
        // stationary, but it gets right back up and keeps going
        if (proj.stationary) {
            proj.stationary = false;
            proj.vy = 0;
        }

        const grounded = this.terrain.checkCollision(proj.x, proj.y + 7);
        if (!grounded) return; // airborne: let gravity do its thing

        // Lift out if embedded in the ground
        let lift = 0;
        while (lift < 10 && this.terrain.checkCollision(proj.x, proj.y + 3)) {
            proj.y -= 1;
            lift++;
        }

        // Trot forward
        proj.vx = proj.walkDir * (proj.walkSpeed || 140);
        if (proj.vy > 0) proj.vy = 0;

        // Wall ahead? Hop. Hop didn't help (still blocked higher up)? Turn around.
        const aheadX = proj.x + proj.walkDir * 9;
        if (this.terrain.checkCollision(aheadX, proj.y - 2)) {
            if (this.terrain.checkCollision(aheadX, proj.y - 26)) {
                proj.walkDir *= -1;
            } else {
                proj.vy = -300;
            }
        }
    }

    /**
     * Handle projectile impact
     */
    handleProjectileImpact(projectile, directHitKoala = null) {
        const weapon = projectile.weapon;

        // Double damage crate buff (applies while the collecting team is shooting)
        const damageMultiplier = this.getDamageMultiplier();

        // Collect explosion results for network sync
        const explosionResults = [];

        // In multiplayer, the Host calculates authoritative damage/terrain
        // The Guest will receive synced data via explosionSync from the Host
        const isAuthoritativeClient = this.isPractice || !this.networkManager || this.networkManager.isHost;

        // Create explosion
        if (weapon.explosionRadius > 0) {
            // Play explosion sound based on size (thresholds match the
            // WA-proportioned radii: 100+ = dynamite class, <30 = gun chip)
            const size = weapon.explosionRadius >= 90 ? 'large' : weapon.explosionRadius < 30 ? 'small' : 'medium';
            this.audioManager.playExplosion(size);

            this.createExplosion(projectile.x, projectile.y, weapon.explosionRadius);

            // Screen shake scaled to explosion size (skip tiny pellet hits)
            if (weapon.explosionRadius >= 30) {
                this.addScreenShake(weapon.explosionRadius / 8, 0.35);
            }

            // Damage terrain - ONLY on authoritative client
            // Non-active player will receive terrain sync via explosionSync
            if (isAuthoritativeClient) {
                this.terrain.createCrater(projectile.x, projectile.y, weapon.explosionRadius);
            }

            // Damage koalas in radius - ONLY on authoritative client
            // Use spatial grid for efficient radius query
            if (isAuthoritativeClient) {
                const nearbyEntities = this.spatialGrid.queryRadius(
                    projectile.x, projectile.y, weapon.explosionRadius
                );

                for (const { entity, distance } of nearbyEntities) {
                    // Skip if not a koala (no isAlive property)
                    if (entity.isAlive === undefined) continue;

                    const koala = entity;

                    // Worms Armageddon-style knockback: launch speed is
                    // proportional to the damage this hit would deal (same
                    // distance falloff, double-damage buff included). Big
                    // weapons fling koalas across the map, grazes just nudge.
                    // Dead bodies use the same would-be damage so ragdolls
                    // still fly.
                    const falloff = 1 - distance / weapon.explosionRadius;
                    const launchDamage = weapon.damage * damageMultiplier * falloff;
                    const knockback = Math.min(launchDamage * 9, 900);

                    // Apply knockback with biased origin (shifted down 10px)
                    // This ensures characters fly "up and out" instead of sliding sideways
                    // IMPORTANT: Apply knockback to BOTH alive AND dead koalas (ragdoll effect)
                    const biasedExplosionY = projectile.y + 10;
                    const angle = Math.atan2(koala.y - biasedExplosionY, koala.x - projectile.x);
                    // applyKnockback adds the impulse, marks them airborne, and
                    // starts a tumble scaled to the launch speed (works on dead
                    // bodies too for ragdoll flinging).
                    koala.applyKnockback(Math.cos(angle) * knockback, Math.sin(angle) * knockback * 1.3);

                    // Only apply damage to alive koalas
                    if (koala.isAlive) {
                        const damage = Math.round(launchDamage);
                        koala.takeDamage(damage);

                        // Play damage sound
                        if (damage > 0) {
                            this.audioManager.playDamage();
                            // Floating damage number + stat attribution
                            this.createFloatingText(koala.x, koala.y - 40, `-${damage}`, '#ff5544');
                            if (projectile.shooter && projectile.shooter !== koala) {
                                projectile.shooter.damageDealt = (projectile.shooter.damageDealt || 0) + damage;
                            }
                        }

                        // Record for sync
                        explosionResults.push({
                            koalaName: koala.name,
                            damage,
                            newHealth: koala.health,
                            x: koala.x,
                            y: koala.y,
                            vx: koala.vx,
                            vy: koala.vy
                        });
                    }
                }

                // Blast damage to oil drums (detonations get synced by id)
                this.damageOilDrums(projectile.x, projectile.y,
                    weapon.explosionRadius, weapon.damage * damageMultiplier);
            }
        }

        // Direct hit bonus - ONLY on authoritative client
        // Use ?? so weapons with an explicit directDamage of 0 (bazooka etc.)
        // don't get a phantom double-damage bonus on direct hits
        const directDamage = Math.round((weapon.directDamage ?? weapon.damage) * damageMultiplier);
        if (directHitKoala && isAuthoritativeClient && directDamage > 0) {
            directHitKoala.takeDamage(directDamage);

            // Arrows and bullets shove the target along their flight path
            if (weapon.directKnockback) {
                const speed = Math.hypot(projectile.vx, projectile.vy) || 1;
                directHitKoala.applyKnockback(
                    (projectile.vx / speed) * weapon.directKnockback,
                    (projectile.vy / speed) * weapon.directKnockback - 100
                );
            }

            this.createFloatingText(directHitKoala.x, directHitKoala.y - 55, `-${directDamage}`, '#ff5544');
            if (projectile.shooter && projectile.shooter !== directHitKoala) {
                projectile.shooter.damageDealt = (projectile.shooter.damageDealt || 0) + directDamage;
            }

            // Add to sync results if not already there from AoE
            const existing = explosionResults.find(r => r.koalaName === directHitKoala.name);
            if (existing) {
                existing.newHealth = directHitKoala.health;
            } else {
                explosionResults.push({
                    koalaName: directHitKoala.name,
                    damage: directDamage,
                    newHealth: directHitKoala.health,
                    x: directHitKoala.x,
                    y: directHitKoala.y,
                    vx: directHitKoala.vx,
                    vy: directHitKoala.vy
                });
            }
        }

        // Create particles
        this.createExplosionParticles(projectile.x, projectile.y, weapon.explosionRadius);

        // Cluster weapons split into fragments (both clients simulate these
        // with the shared seeded RNG, damage stays host-authoritative)
        if (weapon.clusters) {
            this.spawnClusterFragments(projectile, weapon);
        }

        // Petrol bomb / napalm missiles seed burning ground (rolled from the
        // projectile's own effect RNG — impacts aren't symmetric events)
        if (weapon.spawnsFire) {
            this.spawnFirePatches(projectile.x, projectile.y, weapon.fireCount || 5,
                this.getProjectileEffectRand(projectile));
        }

        // NETWORK SYNC: ALWAYS send explosion results to opponent for terrain sync
        // Host sends explosion results to Guest to maintain authority
        if (this.networkManager && !this.isPractice && this.networkManager.isHost) {
            this.networkManager.send({
                type: 'explosionSync',
                explosionX: projectile.x,
                explosionY: projectile.y,
                explosionRadius: weapon.explosionRadius,
                results: explosionResults
            });
        }
    }

    /**
     * Create explosion visual
     */
    createExplosion(x, y, radius) {
        this.particles.push({
            type: 'explosion',
            x, y, radius,
            maxRadius: radius,
            alpha: 1,
            lifetime: 0.5,
            time: 0
        });
    }

    /**
     * Create explosion particles
     */
    createExplosionParticles(x, y, radius, color = null) {
        const count = Math.floor(radius / 2);
        // Limit particle count for performance
        const particlesToAdd = Math.min(count, this.maxParticles - this.particles.length);
        for (let i = 0; i < particlesToAdd; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 50 + Math.random() * 150;
            this.addParticle({
                type: 'debris',
                x, y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 50,
                size: 2 + Math.random() * 4,
                color: color || (Math.random() > 0.5 ? '#654321' : '#8B4513'),
                lifetime: 1 + Math.random(),
                time: 0
            });
        }
    }

    /**
     * Soul-departing sparkle burst when a koala dies
     */
    createDeathEffect(koala) {
        for (let i = 0; i < 12; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 30 + Math.random() * 60;
            this.addParticle({
                type: 'spark',
                x: koala.x,
                y: koala.y - 10,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 80, // Drift upward
                color: Math.random() > 0.5 ? '#ffd700' : '#ffffff',
                size: 2 + Math.random() * 3,
                lifetime: 1 + Math.random() * 0.5,
                time: 0
            });
        }
    }

    /**
     * Water splash effect (entity or projectile falls into water)
     */
    createSplash(x, waterY) {
        for (let i = 0; i < 14; i++) {
            this.addParticle({
                type: 'splash',
                x: x + (Math.random() - 0.5) * 20,
                y: waterY,
                vx: (Math.random() - 0.5) * 160,
                vy: -120 - Math.random() * 220,
                size: 2 + Math.random() * 3,
                lifetime: 0.8 + Math.random() * 0.4,
                time: 0
            });
        }
    }

    /**
     * Trigger a camera shake (intensity in world px, duration in seconds)
     */
    addScreenShake(intensity, duration = 0.3) {
        // Keep the stronger shake if one is already running
        if (this.camera.shake && this.camera.shake.time > 0 &&
            this.camera.shake.intensity > intensity) {
            return;
        }
        this.camera.shake = { intensity, duration, time: duration };
    }

    /**
     * Add a particle with limit enforcement
     */
    addParticle(particleData) {
        // Remove oldest particles if at limit
        while (this.particles.length >= this.maxParticles) {
            const removed = this.particles.shift();
            if (this.particlePool.length < this.maxPoolSize) {
                this.particlePool.push(removed);
            }
        }

        let p;
        if (this.particlePool.length > 0) {
            p = this.particlePool.pop();
            // Clear all old properties to prevent ghost behaviors (e.g. retained velocities)
            for (const key in p) delete p[key];
            // Copy all new properties to recycled object
            Object.assign(p, particleData);
        } else {
            p = { ...particleData };
        }

        this.particles.push(p);
    }

    /**
     * Create floating text (for damage numbers, healing, etc.)
     */
    /**
     * Flash a big "SUDDEN DEATH" banner over the battlefield. Built and animated
     * entirely in JS (Web Animations API) so it needs no extra HTML/CSS, and
     * auto-removes itself so rematches don't stack banners.
     */
    announceSuddenDeath() {
        const screen = document.getElementById('game-screen');
        if (!screen) return;

        const banner = document.createElement('div');
        banner.textContent = '💀 SUDDEN DEATH 💀';
        banner.style.cssText = [
            'position:absolute',
            'top:38%',
            'left:50%',
            'transform:translate(-50%,-50%)',
            'font-size:64px',
            'font-weight:900',
            'color:#ff3b30',
            'text-shadow:0 0 20px rgba(255,0,0,0.8),0 4px 8px rgba(0,0,0,0.6)',
            'letter-spacing:4px',
            'white-space:nowrap',
            'pointer-events:none',
            'z-index:50'
        ].join(';');
        screen.appendChild(banner);

        banner.animate([
            { opacity: 0, transform: 'translate(-50%,-50%) scale(0.6)' },
            { opacity: 1, transform: 'translate(-50%,-50%) scale(1.15)', offset: 0.2 },
            { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.8 },
            { opacity: 0, transform: 'translate(-50%,-50%) scale(1)' }
        ], { duration: 3000, easing: 'ease-out' });

        setTimeout(() => banner.remove(), 3000);
    }

    createFloatingText(x, y, text, color = '#fff') {
        this.addParticle({
            type: 'floatingText',
            x, y,
            vx: 0,
            vy: -50, // Float upward
            text,
            color,
            lifetime: 1.5,
            time: 0,
            size: 16,
            alpha: 1
        });
    }

    /**
     * Update particles
     */
    updateParticles(dt) {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.time += dt;

            if (p.time >= p.lifetime) {
                const removed = this.particles.splice(i, 1)[0];
                if (this.particlePool.length < this.maxPoolSize) {
                    this.particlePool.push(removed);
                }
                continue;
            }

            if (p.type === 'debris') {
                p.vy += 400 * dt; // gravity
                p.x += p.vx * dt;
                p.y += p.vy * dt;
            } else if (p.type === 'explosion') {
                p.alpha = 1 - (p.time / p.lifetime);
            } else if (p.type === 'floatingText') {
                p.y += p.vy * dt;
                p.vy *= 0.98; // Slow down
            } else if (p.type === 'spark') {
                p.vx *= 0.95;
                p.vy *= 0.95;
                p.vy += 100 * dt; // Light gravity
                p.x += p.vx * dt;
                p.y += p.vy * dt;
            } else if (p.type === 'smoke') {
                p.vx *= 0.97;
                p.vy -= 30 * dt; // Drift upward
                p.x += p.vx * dt;
                p.y += p.vy * dt;
            } else if (p.type === 'splash') {
                p.vy += 500 * dt; // Heavy gravity - water falls back down
                p.x += p.vx * dt;
                p.y += p.vy * dt;
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
     * Fire current weapon
     */
    fireWeapon(angle, power) {
        const koala = this.getCurrentKoala();
        const weapon = this.weaponManager.currentWeapon;

        if (!koala || !weapon) {
            console.error('Cannot fire: no koala or weapon selected');
            return;
        }

        // Check ammo
        if (weapon.ammo <= 0) {
            console.log('Out of ammo for', weapon.name);
            this.audioManager.playClick(); // Play click sound to indicate empty
            return;
        }

        // Scheme unlock delay. Only enforced for the local player — a remote
        // fire already happened on the acting client, and refusing the replay
        // here would desync the match (mirrors the ammo-drift guard).
        if (!this.isWeaponAvailable(weapon) && (this.isPractice || this.isMyTurn())) {
            console.log(`${weapon.name} locked for ${this.weaponDelayRemaining(weapon)} more round(s)`);
            this.audioManager.playClick();
            return;
        }

        console.log('Firing weapon:', weapon.name, 'angle:', angle, 'power:', power);

        // Play fire sound
        this.audioManager.playFire(weapon.id);

        // Handle Melee (Bat)
        if (weapon.type === 'melee') {
            this.handleMeleeSwing(koala, weapon, angle);

            // Melee weapons don't create projectiles
            // But they do end the turn phase
            this.phase = 'projectile';

            // Set a timer to end the "projectile" phase after the swing animation
            // (turn-counter guard: never fire into a turn that started since)
            const swingTurn = this.turnManager.turnCounter;
            this.scheduleDelayedAction(500, () => {
                if (this.turnManager.turnCounter === swingTurn && this.projectiles.length === 0) {
                    this.startRetreat();
                }
            });

            // Decrement ammo
            if (weapon.ammo !== Infinity) {
                weapon.ammo--;
                this.updateWeaponUI();
            }

            // NETWORK SYNC: Send swing to opponent
            if (this.networkManager && !this.isPractice && this.isMyTurn()) {
                this.networkManager.sendFire(weapon.id, angle, power, koala.x, koala.y, this.currentTeamIndex, this.currentKoalaIndex);
            }
            return;
        }

        // Handle Blowtorch
        if (weapon.type === 'blowtorch') {
            this.activateBlowtorch(koala, weapon);

            // Decrement ammo
            if (weapon.ammo !== Infinity) {
                weapon.ammo--;
                this.updateWeaponUI();
            }

            // NETWORK SYNC: Send blowtorch activation to opponent
            if (this.networkManager && !this.isPractice && this.isMyTurn()) {
                this.networkManager.sendFire(weapon.id, angle, power, koala.x, koala.y, this.currentTeamIndex, this.currentKoalaIndex);
            }
            return;
        }

        // Handle Pneumatic Drill (dig straight down)
        if (weapon.type === 'drill') {
            this.activateDrill(koala, weapon);

            if (weapon.ammo !== Infinity) {
                weapon.ammo--;
                this.updateWeaponUI();
            }

            if (this.networkManager && !this.isPractice && this.isMyTurn()) {
                this.networkManager.sendFire(weapon.id, angle, power, koala.x, koala.y, this.currentTeamIndex, this.currentKoalaIndex);
            }
            return;
        }

        // Handle Kamikaze (dash through terrain, then detonate)
        if (weapon.type === 'kamikaze') {
            this.startKamikaze(koala, weapon, angle);

            if (weapon.ammo !== Infinity) {
                weapon.ammo--;
                this.updateWeaponUI();
            }

            if (this.networkManager && !this.isPractice && this.isMyTurn()) {
                this.networkManager.sendFire(weapon.id, angle, power, koala.x, koala.y, this.currentTeamIndex, this.currentKoalaIndex);
            }
            return;
        }

        // Handle Parachute (deploys for the rest of the turn, doesn't end it)
        if (weapon.type === 'parachute') {
            if (koala.parachuteActive) return; // already deployed
            koala.parachuteActive = true;
            this.createFloatingText(koala.x, koala.y - 40, 'Parachute ready!', '#7ec8ff');

            if (weapon.ammo !== Infinity) {
                weapon.ammo--;
                this.updateWeaponUI();
            }

            if (this.networkManager && !this.isPractice && this.isMyTurn()) {
                this.networkManager.sendFire(weapon.id, angle, power, koala.x, koala.y, this.currentTeamIndex, this.currentKoalaIndex);
            }
            return;
        }

        // Handle Ninja Rope (WA-style swinging — see updateRope). Firing the
        // hook never ends the turn; ammo is consumed once per turn, so
        // re-shots while swinging/falling in the same turn are free. This
        // branch replays identically on remote clients via sendFire.
        if (weapon.type === 'rope') {
            // Artillery mode forbids all movement, rope included (same check
            // on every client, so a blocked fire is never sent or replayed)
            if (this.scheme?.artilleryMode) {
                this.audioManager.playClick();
                return;
            }

            // Re-fire while already roped: let go first, then shoot again
            if (this.ropeState) this.clearRope();

            const firstRopeThisTurn = this.ropeAmmoTurn !== this.turnManager.turnCounter;
            if (firstRopeThisTurn && weapon.ammo !== Infinity) {
                weapon.ammo--;
                this.updateWeaponUI();
            }
            this.ropeAmmoTurn = this.turnManager.turnCounter;

            this.startRope(koala, weapon, angle);

            if (this.networkManager && !this.isPractice && this.isMyTurn()) {
                this.networkManager.sendFire(weapon.id, angle, power, koala.x, koala.y, this.currentTeamIndex, this.currentKoalaIndex);
            }
            return;
        }

        // Handle Skip Go (forfeit the turn)
        if (weapon.type === 'skip') {
            console.log('⏭️ Turn skipped');
            if (this.networkManager && !this.isPractice && this.isMyTurn()) {
                this.networkManager.sendFire(weapon.id, angle, power, koala.x, koala.y, this.currentTeamIndex, this.currentKoalaIndex);
            }
            this.phase = 'damage';
            const skipTurn = this.turnManager.turnCounter;
            this.scheduleDelayedAction(300, () => {
                if (this.turnManager.turnCounter === skipTurn) this.processDamage();
            });
            return;
        }

        // Handle Surrender (white flag). With more than two sides the match
        // keeps going: the surrendering squad dies and play moves on; the
        // normal alliance win check in processDamage ends the game when only
        // one colour is left. (Replayed on every client, so it's symmetric.)
        if (weapon.type === 'surrender') {
            console.log('🏳️ Surrender!');
            if (this.networkManager && !this.isPractice && this.isMyTurn()) {
                this.networkManager.sendFire(weapon.id, angle, power, koala.x, koala.y, this.currentTeamIndex, this.currentKoalaIndex);
            }
            this.forfeitTeam(this.currentTeamIndex);
            this.phase = 'damage';
            const surrenderTurn = this.turnManager.turnCounter;
            this.scheduleDelayedAction(600, () => {
                if (this.turnManager.turnCounter === surrenderTurn) this.processDamage();
            });
            return;
        }

        // Handle Armageddon (meteors rain across the whole map)
        if (weapon.type === 'armageddon') {
            if (weapon.ammo !== Infinity) {
                weapon.ammo--;
                this.updateWeaponUI();
            }

            if (this.networkManager && !this.isPractice && this.isMyTurn()) {
                this.networkManager.sendFire(weapon.id, angle, power, koala.x, koala.y, this.currentTeamIndex, this.currentKoalaIndex);
            }

            this.executeArmageddon(weapon);
            return;
        }

        // Handle burst guns (handgun, uzi, minigun)
        if (weapon.type === 'gunburst') {
            this.fireBurstGun(koala, weapon, angle);

            if (weapon.ammo !== Infinity) {
                weapon.ammo--;
                this.updateWeaponUI();
            }

            if (this.networkManager && !this.isPractice && this.isMyTurn()) {
                this.networkManager.sendFire(weapon.id, angle, power, koala.x, koala.y, this.currentTeamIndex, this.currentKoalaIndex);
            }
            return;
        }

        // Handle Shotgun (scatter pellets with 2 shots per turn)
        if (weapon.type === 'shotgun') {
            // Initialize shots remaining on first shot
            if (this.shotgunShotsRemaining === 0) {
                this.shotgunShotsRemaining = weapon.shotsPerTurn || 2;
            }

            this.phase = 'projectile';
            this.projectileGraceTimer = 0.1; // Grace period
            this.shotgunShotsRemaining--;

            // Spawn offset from koala
            const spawnOffset = 30;
            const spawnX = koala.x + Math.cos(angle) * spawnOffset;
            const spawnY = (koala.y - 10) + Math.sin(angle) * spawnOffset;

            // Create multiple pellets with spread
            const pelletCount = weapon.pelletCount || 6;
            const spreadAngle = weapon.spreadAngle || 0.25;

            for (let i = 0; i < pelletCount; i++) {
                // Calculate spread offset for this pellet
                const spreadOffset = (i - (pelletCount - 1) / 2) * (spreadAngle / (pelletCount - 1));
                const pelletAngle = angle + spreadOffset;

                const projectile = this.weaponManager.createProjectile(spawnX, spawnY, pelletAngle, 1.0);
                if (projectile) {
                    projectile.shooter = koala;
                    projectile.isPellet = true;
                    projectile.maxRange = weapon.maxRange || 200;
                    projectile.startX = spawnX;
                    projectile.startY = spawnY;
                    this.projectiles.push(projectile);
                }
            }

            console.log(`🔫 Shotgun blast! ${pelletCount} pellets, ${this.shotgunShotsRemaining} shots remaining`);

            // (fire sound already played at the top of fireWeapon)

            // Network sync
            if (this.networkManager && !this.isPractice && this.isMyTurn()) {
                this.networkManager.sendFire(weapon.id, angle, power, koala.x, koala.y, this.currentTeamIndex, this.currentKoalaIndex);
            }

            return;
        }

        // Reset shotgun counter when firing any other weapon
        console.log(`🔄 Non-shotgun weapon fired, resetting shotgunShotsRemaining from ${this.shotgunShotsRemaining} to 0`);
        this.shotgunShotsRemaining = 0;

        this.phase = 'projectile';
        this.projectileGraceTimer = 0.1; // 100ms grace period before phase transition check

        // Decrement ammo
        if (weapon.ammo !== Infinity) {
            weapon.ammo--;
            this.updateWeaponUI();
        }

        // Spawn projectile away from koala in the firing direction
        // This prevents the projectile from immediately hitting the shooter
        const spawnOffset = 30; // pixels away from koala
        const spawnX = koala.x + Math.cos(angle) * spawnOffset;
        const spawnY = (koala.y - 10) + Math.sin(angle) * spawnOffset;

        // Create projectile using WeaponManager
        const projectile = this.weaponManager.createProjectile(spawnX, spawnY, angle, power);

        if (!projectile) {
            console.error('Failed to create projectile');
            this.phase = 'aiming';
            return;
        }

        // Track the shooter so we don't damage them with their own projectile
        projectile.shooter = koala;

        // Sheep walks in the direction it was thrown
        if (weapon.isWalker) {
            projectile.walkDir = Math.cos(angle) >= 0 ? 1 : -1;
            projectile.walkSpeed = weapon.walkSpeed || 140;
        }

        this.projectiles.push(projectile);
        console.log('Projectile created at:', spawnX.toFixed(0), spawnY.toFixed(0), 'shooter:', koala.name);

        // Special handling for dynamite - start retreat immediately
        if (weapon.type === 'dynamite') {
            console.log('💣 Dynamite placed! Starting retreat...');
            this.startRetreat();
        } else {
            // Follow projectile with camera for normal weapons
            this.followProjectile(projectile);
        }

        // Send to network (only if this is our turn)
        if (this.networkManager && !this.isPractice && this.isMyTurn()) {
            this.networkManager.sendFire(weapon.id, angle, power, koala.x, koala.y, this.currentTeamIndex, this.currentKoalaIndex);
        }
    }

    /**
     * Fire a targetted weapon (airstrike, teleport)
     */
    fireTargettedWeapon(weapon, targetX, targetY) {
        const koala = this.getCurrentKoala();
        if (!koala) return;

        // Check ammo
        if (weapon.ammo <= 0) {
            console.log('Out of ammo for', weapon.name);
            this.audioManager.playClick();
            return;
        }

        // Scheme unlock delay (local player only — see fireWeapon)
        if (!this.isWeaponAvailable(weapon) && (this.isPractice || this.isMyTurn())) {
            console.log(`${weapon.name} locked for ${this.weaponDelayRemaining(weapon)} more round(s)`);
            this.audioManager.playClick();
            return;
        }

        console.log('Firing targetted weapon:', weapon.name, 'at', targetX, targetY);

        // Execute the weapon; some (teleport, girder) can fail validation,
        // in which case no ammo is spent and no sound plays
        let success = true;
        switch (weapon.type) {
            case 'teleport':
                success = this.executeTeleport(koala, targetX, targetY) !== false;
                break;
            case 'airstrike':
                this.executeAirstrike(targetX, targetY, weapon);
                break;
            case 'homing':
                this.executeHomingMissile(koala, weapon, targetX, targetY);
                break;
            case 'girder':
                success = this.placeGirder(targetX, targetY);
                break;
            default:
                console.warn('Unknown targetted weapon:', weapon.type);
                return;
        }

        if (!success) {
            this.audioManager.playClick();
            return;
        }

        // Play fire sound
        this.audioManager.playFire(weapon.id);

        // Decrement ammo
        if (weapon.ammo !== Infinity) {
            weapon.ammo--;
            console.log('Ammo remaining:', weapon.ammo);
            this.updateWeaponUI();
        }

        // Send to network (only if this is our turn)
        if (this.networkManager && !this.isPractice && this.isMyTurn()) {
            this.networkManager.sendTargetWeapon(weapon.id, targetX, targetY, this.currentTeamIndex, this.currentKoalaIndex);
        }
    }

    /**
     * Execute teleport - move koala to target location (Worms Armageddon style)
     * The koala drops from the sky above the target ground position.
     */
    executeTeleport(koala, targetX, targetY) {
        // Validate the target location
        const validation = this.terrain.isValidTeleportTarget(targetX);

        if (!validation.valid) {
            console.log(`Cannot teleport: ${validation.reason}`);
            // No ammo is spent on an invalid target
            return false;
        }

        // Respect where the player is pointing. On multi-level maps there can be
        // several ground surfaces at this X (e.g. a high platform and the floor
        // below it). Pick the surface NEAREST to the crosshair Y so the koala
        // lands on the level the player aimed at, instead of always snapping to
        // the topmost surface and sliding down to a lower one.
        const surfaces = this.terrain.getVisualGroundY(targetX);
        let groundY = validation.groundY;
        if (surfaces.length > 0) {
            groundY = surfaces.reduce(
                (best, s) => (Math.abs(s - targetY) < Math.abs(best - targetY) ? s : best),
                surfaces[0]
            );
        }

        // Find the "sky" position above the ground at this X
        // This gives us the drop point - just like in Worms Armageddon
        let dropY = this.terrain.getSkyAboveGround(targetX, groundY);

        // Ensure we have at least 50 pixels of clearance above ground for the fall animation
        if (dropY > groundY - 50) {
            dropY = Math.max(5, groundY - 80);
        }

        // Use stored map bounds to prevent teleporting above the actual map area
        // (handles imported maps with empty space at top)
        const mapTop = this.mapBounds?.topY || this.terrain.getMapTopBoundary();

        // Clamp drop position to be within the actual map area
        // Don't let them spawn in the empty zone above the imported map
        dropY = Math.max(mapTop > 0 ? mapTop - 20 : 5, dropY);

        // Safety clamp: stay within world boundaries (minimum Y=5)
        dropY = Math.max(5, Math.min(this.worldHeight - 100, dropY));

        // Helper function: Check if a bounding box area is MOSTLY clear
        // This prevents false positives from small empty pixels inside terrain
        const isAreaClear = (x, y, width = 20, height = 30) => {
            let solidCount = 0;
            let totalChecks = 0;

            // Check a grid of points within the bounding box
            for (let checkX = x - width / 2; checkX <= x + width / 2; checkX += 5) {
                for (let checkY = y; checkY <= y + height; checkY += 5) {
                    totalChecks++;
                    if (this.terrain.checkCollision(checkX, checkY)) {
                        solidCount++;
                    }
                }
            }

            // Area is clear if less than 20% of points are solid
            // (allows for some noise but catches actual terrain)
            return solidCount < totalChecks * 0.2;
        };

        // CRITICAL: Verify the drop position is actually in open air
        // Use bounding box check to handle small empty pixels in terrain

        // Define the maximum scan depth - go to just above water level
        const waterLevel = this.worldHeight - 80;

        if (!isAreaClear(targetX, dropY)) {
            let foundClear = false;

            // Scan downward from current position all the way to water level
            for (let y = dropY; y < waterLevel; y += 3) {
                if (isAreaClear(targetX, y)) {
                    dropY = y;
                    foundClear = true;
                    break;
                }
            }

            // If still no clear space found, try scanning from the very top
            if (!foundClear) {
                for (let y = 10; y < waterLevel; y += 3) {
                    if (isAreaClear(targetX, y)) {
                        dropY = y;
                        foundClear = true;
                        break;
                    }
                }
            }

            // If STILL nothing found, log an error - teleport location is completely blocked
            if (!foundClear) {
                console.error(`[Teleport] ERROR: No clear space found anywhere at X=${targetX}!`);
                dropY = waterLevel - 100;
            }
        }

        // Create teleport visual effect at old position
        this.createTeleportEffect(koala.x, koala.y);

        // Move koala to drop position (they will fall to the ground)
        koala.x = targetX;
        koala.y = dropY;
        koala.vx = 0;
        koala.vy = 0;
        koala.onGround = false;

        // Reset spawn timer so they can fall immediately (no anti-gravity on teleport)
        koala.spawnTimer = 0;

        // Create teleport visual effect at new position
        this.createTeleportEffect(targetX, dropY);

        // Move camera to new position
        this.centerCameraOn(targetX, dropY);

        // End turn after teleport (turn-counter guard: a stale callback must
        // not end a NEW turn that started in the meantime)
        this.phase = 'damage';
        const teleportTurn = this.turnManager.turnCounter;
        this.scheduleDelayedAction(500, () => {
            if (this.turnManager.turnCounter === teleportTurn) this.processDamage();
        });
    }

    /**
     * Launch a homing missile from the koala toward a clicked target
     */
    executeHomingMissile(koala, weapon, targetX, targetY) {
        this.phase = 'projectile';
        this.projectileGraceTimer = 0.2;

        // Launch upward-ish toward the target side, then steer in
        const launchAngle = targetX >= koala.x ? -Math.PI / 3 : -Math.PI * 2 / 3;
        const spawnX = koala.x + Math.cos(launchAngle) * 30;
        const spawnY = (koala.y - 10) + Math.sin(launchAngle) * 30;

        const proj = this.weaponManager.createProjectileFor(weapon, spawnX, spawnY, launchAngle, 1.0);
        if (!proj) return;

        proj.shooter = koala;
        proj.homingTarget = { x: targetX, y: targetY };
        proj.homingDelay = 0.35; // straight boost before lock-on
        proj.homingFuel = 5;     // seconds of steering before it goes ballistic
        this.projectiles.push(proj);
        this.followProjectile(proj);
    }

    /**
     * Place a steel girder at the target position. Doesn't end the turn.
     * Returns false (no ammo spent) if a koala is in the way.
     */
    placeGirder(targetX, targetY) {
        const width = 90;
        const height = 12;

        // Refuse placement on top of any koala - they'd get stuck inside
        for (const team of this.teams) {
            for (const koala of team.koalas) {
                if (!koala.isAlive) continue;
                if (Math.abs(koala.x - targetX) < width / 2 + 15 &&
                    Math.abs(koala.y - targetY) < 40) {
                    console.log('Cannot place girder on a koala');
                    return false;
                }
            }
        }

        this.terrain.addGirder(targetX, targetY, width, height);

        // Placement puff
        for (let i = 0; i < 6; i++) {
            this.addParticle({
                type: 'smoke',
                x: targetX + (Math.random() - 0.5) * width,
                y: targetY,
                vx: (Math.random() - 0.5) * 40,
                vy: -20 - Math.random() * 30,
                lifetime: 0.6, time: 0, color: '#aaa', size: 4
            });
        }
        return true;
    }

    /**
     * Execute airstrike - missiles fall from sky.
     * Variants: napalm (missiles seed fire) and mine strike (drops live mines).
     */
    executeAirstrike(targetX, targetY, weapon) {
        const missileCount = weapon.missiles || 5;
        const spread = 150; // Total spread width
        const spacing = spread / (missileCount - 1);
        const startX = targetX - spread / 2;

        this.phase = 'projectile';

        // Mine strike: parachute live mines instead of missiles
        if (weapon.dropsMines) {
            // Sub-RNG snapshot: dud rolls happen on the drop schedule, which
            // an isGameOver bail-out could cut short on one client only
            const rand = this.makeSubRandom();
            const spawnMine = (index) => {
                if (this.isGameOver) return;
                const mineX = startX + (index * spacing);
                const proj = this.weaponManager.createProjectileFor(weapon, mineX, 50, Math.PI / 2, 0.2);
                if (proj) {
                    proj.type = 'mine';
                    proj.vx = 0;
                    proj.vy = 200;
                    proj.gravityMultiplier = 0.5;
                    // WA-style: strike drops drift with the wind on the way
                    // down, so you target upwind of where you want them
                    proj.affectedByWind = true;
                    proj.triggeredByProximity = true;
                    proj.triggerDelay = 3;
                    proj.timer = 3;
                    proj.timerStarted = false;
                    proj.isDud = rand() < 0.15;
                    this.projectiles.push(proj);
                }
                this.audioManager.playMissileDrop();
                if (this.phase !== 'projectile') this.phase = 'projectile';
            };

            spawnMine(0);
            for (let i = 1; i < missileCount; i++) {
                this.scheduleDelayedAction(i * 200, () => spawnMine(i));
            }
            this.centerCameraOn(targetX, targetY);
            return;
        }

        // Sub-RNG for per-missile effect seeds (napalm missiles spawn fire at
        // impact, which must not draw from the shared stream — see makeSubRandom)
        const strikeRand = this.makeSubRandom();

        // Helper to spawn a single missile
        const spawnMissile = (index) => {
            const missileX = startX + (index * spacing);
            const missileY = 50; // Start from top of world

            // Create a proper Projectile instance (using pool if available)
            let proj = this.getProjectileFromPool();

            if (proj) {
                // Reuse pooled projectile
                proj.x = missileX;
                proj.y = missileY;
                proj.vx = 0;
                proj.vy = 300; // Fall downward
                proj.type = 'airstrike';
                proj.weapon = weapon;
                proj.gravityMultiplier = 0.5;
                // WA-style: missiles are blown off course by the wind
                proj.affectedByWind = true;
                proj.bounces = false;
                proj.timer = null;
                proj.timerStarted = false;
                proj.timeOnGround = 0;
                proj.bounceCount = 0;
                proj.triggeredByProximity = false;
                proj.isTriggered = false;
                proj.triggerTimer = 0;
                proj.stationary = false;
                proj.destroyed = false;
                proj.shooter = null;
                proj.rotation = Math.PI / 2; // Point downward
            } else {
                // Pool empty, create new
                proj = new Projectile({
                    x: missileX,
                    y: missileY,
                    vx: 0,
                    vy: 300, // Fall downward
                    type: 'airstrike',
                    weapon: weapon,
                    gravityMultiplier: 0.5,
                    affectedByWind: true, // WA-style: wind blows missiles off course
                    bounces: false
                });
                // Override rotation to point downward
                proj.rotation = Math.PI / 2;
            }

            // Per-missile effect seed for impact-time fire scatter (napalm)
            proj.effectSeed = Math.floor(strikeRand() * 0xFFFFFFFF);
            proj._effectRand = null;

            this.projectiles.push(proj);

            // Play a sound for each missile
            this.audioManager.playMissileDrop();
        };

        // Create first missile immediately so phase doesn't revert
        spawnMissile(0);

        // Schedule remaining missiles
        for (let i = 1; i < missileCount; i++) {
            // Stagger the missiles slightly using delayed action
            this.scheduleDelayedAction(i * 200, () => {
                // Only spawn if game is still active
                if (!this.isGameOver) {
                    spawnMissile(i);
                    // Ensure phase stays as projectile while missiles are still falling
                    if (this.phase !== 'projectile') {
                        this.phase = 'projectile';
                    }
                }
            });
        }

        // Move camera to target area (center on impact point)
        this.centerCameraOn(targetX, targetY);
    }

    /**
     * Create teleport visual effect
     */
    createTeleportEffect(x, y) {
        for (let i = 0; i < 10; i++) {
            this.addParticle({
                type: 'smoke',
                x: x,
                y: y,
                vx: (Math.random() - 0.5) * 100,
                vy: (Math.random() - 0.5) * 100,
                lifetime: 1,
                time: 0,
                color: '#3498db',
                size: 5 + Math.random() * 5
            });
        }
    }

    // ==================== NINJA ROPE (Worms Armageddon style) ====================
    //
    // The rope is not a projectile: firing it enters the 'rope' phase and all
    // motion runs through updateRope. A straight-flying hook attaches to
    // terrain; the koala then swings as a pendulum around the anchor.
    // Left/right pump the swing, up/down climb the rope, the rope wraps and
    // unwraps around terrain corners, Enter lets go, and Space/click re-fires
    // toward the crosshair mid-air. Roping never ends the turn.
    //
    // Multiplayer: the turn owner simulates the swing and streams positions
    // via the existing 'move' channel. Hook flight is simulated on every
    // client (deterministic: fixed 1/60 steps over synced terrain), and rope
    // wrapping is recomputed on each client from whatever koala position it
    // has — worst case the drawn rope bends a pixel differently, the koala
    // position itself never diverges.

    // The rope is held slightly above the koala's center (its "hands")
    static ROPE_HAND_OFFSET = 8;
    static ROPE_MIN_LENGTH = 22;

    /**
     * Fire the rope hook from a koala (called from fireWeapon on every client)
     */
    startRope(koala, weapon, angle) {
        const handY = koala.y - Game.ROPE_HAND_OFFSET;
        this.ropeState = {
            mode: 'flying',
            koala,
            weapon,
            hook: { x: koala.x, y: handY },
            startX: koala.x,
            startY: handY,
            dirX: Math.cos(angle),
            dirY: Math.sin(angle),
            hookSpeed: weapon.hookSpeed || 1500,
            maxLength: weapon.maxLength || 420,
            swingAccel: weapon.swingAccel || 380,
            climbSpeed: weapon.climbSpeed || 150,
            // While attached: pivots[0] is the anchor, the last pivot is the
            // live swing center. `consumed` is the rope length eaten by the
            // wrap that created the pivot (returned when it unwraps).
            pivots: null,
            length: 0
        };
        this.phase = 'rope';
    }

    /**
     * Per-frame rope update (both hook flight and swinging). Runs on every
     * client; only the turn owner applies input and integrates the koala.
     */
    updateRope(dt) {
        const rs = this.ropeState;
        if (!rs) {
            this.phase = 'aiming';
            return;
        }
        const koala = rs.koala;
        if (!koala || !koala.isAlive) {
            this.clearRope();
            this.phase = 'aiming';
            return;
        }

        if (rs.mode === 'flying') {
            this.updateRopeFlight(rs, dt);
        } else {
            this.updateRopeSwing(rs, dt);
        }

        // Keep the action in frame on every client, like a followed projectile
        if (this.ropeState) {
            this.centerCameraOn(koala.x, koala.y);
        }
    }

    /**
     * Hook flight: straight line, no gravity/wind, raycast in small steps.
     * Attaches to the first terrain pixel, or fizzles at max rope length.
     */
    updateRopeFlight(rs, dt) {
        const move = rs.hookSpeed * dt;
        const steps = Math.max(1, Math.ceil(move / 4));

        for (let s = 1; s <= steps; s++) {
            const nx = rs.hook.x + rs.dirX * (move / steps);
            const ny = rs.hook.y + rs.dirY * (move / steps);

            if (this.terrain.checkCollision(nx, ny)) {
                rs.hook.x = nx;
                rs.hook.y = ny;
                this.attachRope(rs);
                return;
            }

            rs.hook.x = nx;
            rs.hook.y = ny;

            const flown = Math.hypot(rs.hook.x - rs.startX, rs.hook.y - rs.startY);
            if (flown >= rs.maxLength ||
                rs.hook.y > this.waterLevel ||
                rs.hook.x < -50 || rs.hook.x > this.worldWidth + 50) {
                // Out of rope — nothing to grab. Turn continues.
                console.log('🪢 Rope missed');
                this.audioManager.playClick();
                this.clearRope();
                this.phase = 'aiming';
                return;
            }
        }
    }

    /**
     * Hook found terrain: become a pendulum around it.
     */
    attachRope(rs) {
        const koala = rs.koala;
        rs.mode = 'attached';
        rs.pivots = [{ x: rs.hook.x, y: rs.hook.y, consumed: 0 }];

        const d = Math.hypot(koala.x - rs.hook.x, (koala.y - Game.ROPE_HAND_OFFSET) - rs.hook.y);
        rs.length = Math.max(Game.ROPE_MIN_LENGTH, Math.min(d, rs.maxLength));

        koala.onRope = true;
        koala.onGround = false;
        koala.isSliding = false;
        koala.isJumping = false;
        koala.isBackflipping = false;
        koala.parachuteActive = false; // rope overrides an open chute

        this.audioManager.playBounce();
        console.log(`🪢 Rope attached at ${rs.hook.x.toFixed(0)},${rs.hook.y.toFixed(0)} (length ${rs.length.toFixed(0)})`);
    }

    /**
     * Swinging on the rope. The turn owner integrates the pendulum + input;
     * remote clients only recompute wrap pivots around the streamed position.
     */
    updateRopeSwing(rs, dt) {
        const koala = rs.koala;

        if (this.isMyTurn()) {
            const keys = this.inputManager.keys;

            // Left/right: pump the swing
            let swing = 0;
            if (keys['KeyA'] || keys['ArrowLeft']) { swing = -1; koala.facingLeft = true; }
            if (keys['KeyD'] || keys['ArrowRight']) { swing = 1; koala.facingLeft = false; }
            koala.vx += swing * rs.swingAccel * dt;

            // Up/down: climb the rope. Total rope (wrapped + free) caps at maxLength.
            const used = rs.pivots.reduce((sum, p) => sum + p.consumed, 0);
            if (keys['KeyW'] || keys['ArrowUp']) {
                rs.length = Math.max(Game.ROPE_MIN_LENGTH, rs.length - rs.climbSpeed * dt);
            }
            if (keys['KeyS'] || keys['ArrowDown']) {
                rs.length = Math.min(Math.max(Game.ROPE_MIN_LENGTH, rs.maxLength - used), rs.length + rs.climbSpeed * dt);
            }

            // Pendulum integration: gravity, then constrain to the rope circle
            koala.vy += this.physics.gravity * dt;
            const prevX = koala.x, prevY = koala.y;
            koala.x += koala.vx * dt;
            koala.y += koala.vy * dt;

            const p = rs.pivots[rs.pivots.length - 1];
            const dx = koala.x - p.x;
            const dy = (koala.y - Game.ROPE_HAND_OFFSET) - p.y;
            const d = Math.hypot(dx, dy);
            if (d > rs.length && d > 0) {
                const nx = dx / d, ny = dy / d;
                koala.x = p.x + nx * rs.length;
                koala.y = p.y + ny * rs.length + Game.ROPE_HAND_OFFSET;
                // Kill outward radial velocity; keep the tangential component
                // (this is what makes the swing feel like WA — energy carries)
                const vr = koala.vx * nx + koala.vy * ny;
                if (vr > 0) {
                    koala.vx -= vr * nx;
                    koala.vy -= vr * ny;
                }
            }

            // Don't swing through walls: if the body ended up inside terrain,
            // step back and deaden the impact (a soft thud, not a bounce)
            if (this.ropeBodyCollides(koala)) {
                koala.x = prevX;
                koala.y = prevY;
                koala.vx *= -0.3;
                koala.vy *= -0.3;
            }

            // Swung into the drink: let go, normal physics handles the splash
            if (koala.y + koala.height / 2 > this.waterLevel) {
                this.releaseRope();
                return;
            }

            // Stream position over the wire like walking does (20/s)
            if (this.networkManager && !this.isPractice) {
                const now = performance.now();
                if (!this.lastRopeSync || now - this.lastRopeSync > 50) {
                    this.networkManager.sendMove(
                        koala.x, koala.y, koala.facingLeft, undefined,
                        this.currentTeamIndex, this.currentKoalaIndex
                    );
                    this.lastRopeSync = now;
                }
            }
        }

        this.updateRopeWrap(rs);
    }

    /**
     * Rope wrapping: if terrain blocks the line from the active pivot to the
     * koala, the rope bends at the last clear point (new pivot, rope gets
     * effectively shorter). When the line from the PREVIOUS pivot clears
     * again, the bend unwinds and the length comes back.
     */
    updateRopeWrap(rs) {
        const koala = rs.koala;
        const hx = koala.x;
        const hy = koala.y - Game.ROPE_HAND_OFFSET;

        // Unwrap any bends whose corner no longer blocks the line
        while (rs.pivots.length > 1) {
            const prev = rs.pivots[rs.pivots.length - 2];
            if (this.ropeRaycast(prev.x, prev.y, hx, hy)) break; // still blocked
            const removed = rs.pivots.pop();
            rs.length += removed.consumed;
        }

        // Wrap around any terrain that cuts the current segment (a single
        // frame can wrap around several corners of a jagged overhang)
        let guard = 0;
        while (guard++ < 8 && rs.pivots.length < 48) {
            const p = rs.pivots[rs.pivots.length - 1];
            const hit = this.ropeRaycast(p.x, p.y, hx, hy);
            if (!hit) break;
            const consumed = Math.hypot(hit.x - p.x, hit.y - p.y);
            if (consumed < 3) break; // degenerate corner right at the pivot
            rs.pivots.push({ x: hit.x, y: hit.y, consumed });
            rs.length = Math.max(8, rs.length - consumed);
        }
    }

    /**
     * March from (x1,y1) toward (x2,y2) in ~3px steps. Returns the last clear
     * point before the first terrain hit, or null if the line is clear. Skips
     * a few px at both ends (the pivot hugs a corner and the koala's body
     * overlaps the line) so touching endpoints don't read as blockage.
     */
    ropeRaycast(x1, y1, x2, y2) {
        const dx = x2 - x1, dy = y2 - y1;
        const dist = Math.hypot(dx, dy);
        if (dist < 10) return null;

        const steps = Math.ceil(dist / 3);
        let clearX = x1, clearY = y1;
        for (let s = 1; s < steps; s++) {
            const t = s / steps;
            const px = x1 + dx * t;
            const py = y1 + dy * t;
            const fromStart = dist * t;
            if (fromStart < 5 || dist - fromStart < 6) { clearX = px; clearY = py; continue; }
            if (this.terrain.checkCollision(px, py)) {
                return { x: clearX, y: clearY };
            }
            clearX = px;
            clearY = py;
        }
        return null;
    }

    /**
     * Quick body-vs-terrain check while swinging (center, head, feet)
     */
    ropeBodyCollides(koala) {
        const half = koala.height / 2 - 3;
        return this.terrain.checkCollision(koala.x, koala.y) ||
            this.terrain.checkCollision(koala.x, koala.y - half) ||
            this.terrain.checkCollision(koala.x, koala.y + half);
    }

    /**
     * Let go of the rope (Enter, water, or turn cleanup). The koala keeps its
     * swing velocity — release at the top of a pump to fling yourself. The
     * turn continues in the aiming phase.
     */
    releaseRope() {
        if (!this.ropeState) return;
        const koala = this.ropeState.koala;
        const wasMyAction = this.isMyTurn() && !this.isGameOver;

        this.clearRope();
        this.phase = 'aiming';

        if (wasMyAction && this.networkManager && !this.isPractice) {
            this.networkManager.send({
                type: 'ropeRelease',
                x: koala.x, y: koala.y,
                vx: koala.vx, vy: koala.vy,
                teamIndex: this.currentTeamIndex,
                koalaIndex: this.currentKoalaIndex
            });
        }
    }

    /**
     * Space/click while roped: let go and immediately shoot a new hook
     * toward the crosshair (free — rope ammo is once per turn).
     */
    ropeRefire() {
        const rs = this.ropeState;
        if (!rs) return;
        const koala = rs.koala;
        // fireWeapon's rope branch clears the old rope and replays remotely
        this.weaponManager.selectWeapon('rope');
        this.fireWeapon(koala.aimAngle, 1.0);
    }

    /**
     * Drop all rope state and hand the koala back to normal physics. Fall
     * damage counts from here (WA-style: swinging is safe, the drop is not).
     */
    clearRope() {
        const rs = this.ropeState;
        if (rs && rs.koala) {
            rs.koala.onRope = false;
            rs.koala.onGround = false;
            rs.koala.peakY = rs.koala.y;
        }
        this.ropeState = null;
    }

    /**
     * Remote turn owner let go of their rope
     */
    handleRemoteRopeRelease(data) {
        if (!this.adoptRemoteTurn(data, 'rope release')) return;
        const koala = this.getCurrentKoala();
        if (koala && data.x !== undefined) {
            koala.x = data.x;
            koala.y = data.y;
            koala.vx = data.vx || 0;
            koala.vy = data.vy || 0;
        }
        this.clearRope();
        this.phase = 'aiming';
    }

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
     * Fire a burst gun (handgun / uzi / minigun): a stream of pellets at the
     * locked-in angle, staggered over time via delayed actions.
     */
    fireBurstGun(koala, weapon, angle) {
        const burstCount = weapon.burstCount || 6;
        const interval = weapon.burstInterval || 0.1;

        this.phase = 'projectile';
        // Grace period covers the whole burst so the phase can't end between rounds
        this.projectileGraceTimer = burstCount * interval + 0.25;

        // Sub-RNG snapshot: the whole burst rolls from its own stream so an
        // early isGameOver bail-out on one client can't skew the shared stream
        const rand = this.makeSubRandom();
        const spawnOffset = 30;

        const fireOne = () => {
            if (this.isGameOver) return;
            const spread = (rand() - 0.5) * (weapon.burstSpread || 0);
            const shotAngle = angle + spread;
            const spawnX = koala.x + Math.cos(shotAngle) * spawnOffset;
            const spawnY = (koala.y - 10) + Math.sin(shotAngle) * spawnOffset;

            const projectile = this.weaponManager.createProjectileFor(weapon, spawnX, spawnY, shotAngle, 1.0);
            if (projectile) {
                projectile.shooter = koala;
                projectile.isPellet = true;
                projectile.maxRange = weapon.maxRange || 500;
                projectile.startX = spawnX;
                projectile.startY = spawnY;
                this.projectiles.push(projectile);
            }
            this.audioManager.playFire(weapon.id);

            // Muzzle flash
            this.addParticle({
                type: 'spark',
                x: spawnX, y: spawnY,
                vx: Math.cos(shotAngle) * 80, vy: Math.sin(shotAngle) * 80,
                color: '#ffdd66', size: 3, lifetime: 0.1, time: 0
            });

            // Keep the phase pinned while the burst is still going
            if (this.phase !== 'projectile') {
                this.phase = 'projectile';
            }
        };

        fireOne();
        for (let i = 1; i < burstCount; i++) {
            this.scheduleDelayedAction(i * interval * 1000, fireOne);
        }
    }

    /**
     * Activate the pneumatic drill - digs straight down for a fixed duration
     */
    activateDrill(koala, weapon) {
        this.phase = 'drill';
        koala.drillTimer = weapon.duration || 2.5;
        koala.drillSpeed = weapon.digSpeed || 75;
        koala.drillRadius = weapon.digRadius || 16;
        koala.drillAccum = 0;

        // Open a hole right beneath so the first frames don't fight collision
        this.terrain.createCrater(koala.x, koala.y + 10, koala.drillRadius);
        console.log('🪛 Drill activated for', koala.name);
    }

    /**
     * Update pneumatic drill - straight-down dig, then retreat
     */
    updateDrill(dt) {
        const koala = this.getCurrentKoala();
        if (!koala || koala.drillTimer === undefined || koala.drillTimer <= 0) {
            this.endDrill();
            return;
        }

        koala.drillTimer -= dt;
        const move = koala.drillSpeed * dt;
        koala.y += move;
        koala.drillAccum += move;

        // Carve every few pixels of descent
        if (koala.drillAccum >= 5) {
            koala.drillAccum = 0;
            this.terrain.createCrater(koala.x, koala.y + 8, koala.drillRadius);
            if (Math.random() > 0.85) {
                this.audioManager.playFire('blowtorch');
            }
        }

        // Dust particles
        this.addParticle({
            type: 'spark',
            x: koala.x + (Math.random() - 0.5) * 16,
            y: koala.y + 12,
            vx: (Math.random() - 0.5) * 120,
            vy: -Math.random() * 80,
            color: Math.random() > 0.5 ? '#a08060' : '#776655',
            size: 2 + Math.random() * 2,
            lifetime: 0.4,
            time: 0
        });

        // Don't drill into the water
        if (koala.y > this.waterLevel - 30) {
            koala.drillTimer = 0;
        }

        if (koala.drillTimer <= 0) {
            this.endDrill();
        }
    }

    /**
     * Finish drilling and hand the turn over
     */
    endDrill() {
        const koala = this.getCurrentKoala();
        if (koala) {
            koala.drillTimer = undefined;
            koala.vy = 0;
            koala.onGround = false; // let physics settle them into the shaft
        }

        // No turn-end message needed: the drill runs for a fixed duration at a
        // fixed speed with no player input, so both clients reach endDrill on
        // their own (the same deterministic handover used by a normal shot).
        this.startRetreat();
    }

    /**
     * Start a kamikaze dash: the koala flies along the aim direction, carving
     * through terrain and battering anyone in the way, then detonates.
     */
    startKamikaze(koala, weapon, angle) {
        this.phase = 'projectile';
        this.projectileGraceTimer = 0.2;
        this.kamikazeState = {
            koala,
            weapon,
            dirX: Math.cos(angle),
            dirY: Math.sin(angle),
            traveled: 0,
            carveAccum: 0,
            hitVictims: new Set()
        };
        koala.isBackflipping = false;
        console.log('✈️ KAMIKAZE!', koala.name);
    }

    /**
     * Update the kamikaze dash each frame
     */
    updateKamikaze(dt) {
        const state = this.kamikazeState;
        const koala = state.koala;
        const weapon = state.weapon;

        const move = (weapon.dashSpeed || 480) * dt;
        koala.x += state.dirX * move;
        koala.y += state.dirY * move;
        koala.vx = 0;
        koala.vy = 0;
        koala.onGround = false;
        state.traveled += move;
        state.carveAccum += move;

        // Carve a tunnel
        if (state.carveAccum >= 8) {
            state.carveAccum = 0;
            this.terrain.createCrater(koala.x, koala.y, 20);
        }

        // Flame trail
        this.addParticle({
            type: 'spark',
            x: koala.x - state.dirX * 14,
            y: koala.y - state.dirY * 14,
            vx: (Math.random() - 0.5) * 60,
            vy: (Math.random() - 0.5) * 60,
            color: Math.random() > 0.5 ? '#ff6600' : '#ffcc00',
            size: 3, lifetime: 0.3, time: 0
        });

        // Batter anyone touched along the way (once each)
        const isAuthoritativeClient = this.isPractice || !this.networkManager || this.networkManager.isHost;
        for (const team of this.teams) {
            for (const target of team.koalas) {
                if (!target.isAlive || target === koala || state.hitVictims.has(target)) continue;
                if (Math.hypot(target.x - koala.x, target.y - koala.y) < 28) {
                    state.hitVictims.add(target);
                    if (isAuthoritativeClient) {
                        const dmg = (weapon.dashDamage || 30) * this.getDamageMultiplier();
                        target.takeDamage(dmg);
                        target.applyKnockback(state.dirX * 400, -300);
                        this.createFloatingText(target.x, target.y - 40, `-${dmg}`, '#ff5544');
                        koala.damageDealt = (koala.damageDealt || 0) + dmg;
                    }
                    this.audioManager.playDamage();
                }
            }
        }

        // Detonate at max range, out of bounds, or in the drink
        const out = koala.x < 0 || koala.x > this.worldWidth || koala.y < -50 || koala.y > this.waterLevel;
        if (state.traveled >= (weapon.dashDistance || 380) || out) {
            this.kamikazeState = null;

            // The pilot doesn't come back
            koala.health = 0;

            // Final blast reuses the standard impact pipeline via a stub projectile
            const blast = this.weaponManager.getSubMunition('kamikazeBlast');
            this.handleProjectileImpact({ x: koala.x, y: koala.y, weapon: blast, shooter: koala });

            this.phase = 'damage';
            const kamikazeTurn = this.turnManager.turnCounter;
            this.scheduleDelayedAction(800, () => {
                if (this.turnManager.turnCounter === kamikazeTurn) this.processDamage();
            });
        }
    }

    /**
     * Armageddon: meteors rain across the entire map for a few seconds
     */
    executeArmageddon(weapon) {
        this.phase = 'projectile';
        this.projectileGraceTimer = 0.3;

        // Sub-RNG snapshot (see fireBurstGun): keeps the shared stream safe
        // from per-client differences in how many meteors actually spawn
        const rand = this.makeSubRandom();
        const meteorDef = this.weaponManager.getSubMunition('meteor');
        const count = weapon.meteorCount || 14;

        const spawnMeteor = () => {
            if (this.isGameOver) return;
            const x = rand() * this.worldWidth;
            const proj = this.weaponManager.createProjectileFor(meteorDef, x, 20, Math.PI / 2, 1.0);
            if (proj) {
                proj.vx = (rand() - 0.5) * 220;
                proj.vy = 300 + rand() * 150;
                this.projectiles.push(proj);
            }
            this.audioManager.playMissileDrop();
            if (this.phase !== 'projectile') {
                this.phase = 'projectile';
            }
        };

        spawnMeteor();
        for (let i = 1; i < count; i++) {
            this.scheduleDelayedAction(i * 280, spawnMeteor);
        }

        this.addScreenShake(6, 0.6);
        console.log('☄️ ARMAGEDDON!');
    }

    /**
     * Spawn cluster fragments after a cluster weapon's main explosion
     */
    spawnClusterFragments(projectile, weapon) {
        // Impact-time event: roll from the projectile's own effect RNG, never
        // the shared stream (this impact may not happen on the other client)
        const rand = this.getProjectileEffectRand(projectile);
        const fragDef = this.weaponManager.getSubMunition(weapon.clusterType || 'clusterFrag');
        if (!fragDef) return;

        const count = weapon.clusters;
        for (let i = 0; i < count; i++) {
            const frag = this.weaponManager.createProjectileFor(fragDef, projectile.x, projectile.y - 12, 0, 1.0, rand);
            if (!frag) continue;
            frag.vx = (rand() - 0.5) * 360;
            frag.vy = -180 - rand() * 220;
            frag.shooter = projectile.shooter;
            this.projectiles.push(frag);
        }

        // Fragments need the projectile phase to keep running
        if (this.phase === 'projectile') {
            this.projectileGraceTimer = Math.max(this.projectileGraceTimer, 0.2);
        }
    }

    /**
     * Spawn burning fire patches around a point (petrol bomb / napalm)
     */
    spawnFirePatches(x, y, count, rand = null) {
        rand = rand || this.seededRandom || Math.random;
        for (let i = 0; i < count; i++) {
            this.firePatches.push({
                // Initial scatter leans downwind (WA napalm drifts with the gale)
                x: x + (rand() - 0.5) * 70,
                y: y - 10,
                vx: (rand() - 0.5) * 140 + this.wind * 100,
                vy: -60 - rand() * 120,
                settled: false,
                age: 0,
                lifetime: 5 + rand() * 3,
                tickTimer: 0,
                burnTimer: 0,
                flicker: rand() * Math.PI * 2
            });
        }
    }

    /**
     * Update fire patches: scatter (riding the wind), settle on terrain, burn
     * anyone standing in them, eat into the ground WA-style, then gutter out.
     */
    updateFirePatches(dt) {
        if (this.firePatches.length === 0) return;

        const isAuthoritativeClient = this.isPractice || !this.networkManager || this.networkManager.isHost;

        // Terrain the fire burns away this frame, batched into one sync
        // message so the guest's map stays identical to the host's
        const burnCraters = [];

        for (let i = this.firePatches.length - 1; i >= 0; i--) {
            const fire = this.firePatches[i];

            if (!fire.settled) {
                // Ballistic scatter until it lands; flames are light, so the
                // wind shoves them around hard (WA napalm behavior)
                fire.vy += 400 * dt;
                fire.vx += this.wind * this.physics.windAccel * 0.8 * dt;
                fire.x += fire.vx * dt;
                fire.y += fire.vy * dt;

                if (this.terrain.checkCollision(fire.x, fire.y + 4)) {
                    fire.settled = true;
                    fire.vx = 0;
                    fire.vy = 0;
                }

                // Fell into water or out of the world
                if (fire.y > this.waterLevel || fire.x < 0 || fire.x > this.worldWidth) {
                    this.firePatches.splice(i, 1);
                    continue;
                }
            } else {
                fire.age += dt;

                // WA-style fire creep: settled flames inch downwind along the
                // surface (blocked by walls), spreading the burn sideways
                if (Math.abs(this.wind) > 0.15) {
                    const nx = fire.x + this.wind * 30 * dt;
                    if (!this.terrain.checkCollision(nx, fire.y - 3)) {
                        fire.x = nx;
                    }
                }

                // Burn into the terrain: every few ticks the flame eats a
                // small pit under itself, then sinks into the hole it made —
                // exactly how WA fire chews channels through the landscape.
                // Terrain is host-authoritative; craters are synced below.
                fire.burnTimer += dt;
                if (fire.burnTimer >= 0.5) {
                    fire.burnTimer = 0;
                    if (isAuthoritativeClient) {
                        this.terrain.createCrater(fire.x, fire.y + 4, 9);
                        burnCraters.push({ x: fire.x, y: fire.y + 4, r: 9 });
                    }
                }

                // Ground burned away beneath it?
                if (!this.terrain.checkCollision(fire.x, fire.y + 4) &&
                    !this.terrain.checkCollision(fire.x, fire.y + 10)) {
                    fire.settled = false;
                }

                // Burn nearby koalas a tick at a time
                fire.tickTimer += dt;
                if (fire.tickTimer >= 0.45) {
                    fire.tickTimer = 0;

                    if (isAuthoritativeClient) {
                        for (const team of this.teams) {
                            for (const koala of team.koalas) {
                                if (!koala.isAlive) continue;
                                if (Math.hypot(koala.x - fire.x, koala.y - fire.y) < 30) {
                                    koala.takeDamage(5);
                                    // A hop so the burn is felt and escapable
                                    koala.applyKnockback((koala.x >= fire.x ? 1 : -1) * 60, -120);
                                    this.createFloatingText(koala.x, koala.y - 40, '-5', '#ff8800');
                                    this.audioManager.playDamage();
                                }
                            }
                        }
                        this.updateTeamHealth();

                        // Flames lick a nearby oil drum? Light its fuse.
                        // Authoritative-only: the guest sees the detonation
                        // via the synced drum id.
                        for (const drum of this.oilDrums) {
                            if (drum.detonated || drum.igniteTimer > 0) continue;
                            if (Math.hypot(drum.x - fire.x, (drum.y - 17) - fire.y) < 34) {
                                drum.igniteTimer = 0.6 + Math.random() * 0.5;
                            }
                        }
                    }
                }

                // Smoke and flame particles
                if (Math.random() > 0.7 && this.particles.length < this.maxParticles - 5) {
                    this.addParticle({
                        type: 'spark',
                        x: fire.x + (Math.random() - 0.5) * 14,
                        y: fire.y - 4,
                        vx: (Math.random() - 0.5) * 30,
                        vy: -40 - Math.random() * 60,
                        color: Math.random() > 0.5 ? '#ff6600' : '#ffaa00',
                        size: 2 + Math.random() * 3,
                        lifetime: 0.5,
                        time: 0
                    });
                }

                if (fire.age >= fire.lifetime) {
                    this.firePatches.splice(i, 1);
                }
            }
        }

        // Ship this frame's burn damage to the guest in one batched message
        // (guest fire is visual-only; its terrain comes from these craters)
        if (burnCraters.length > 0 && this.networkManager && !this.isPractice && this.networkManager.isHost) {
            this.networkManager.send({
                type: 'explosionSync',
                explosionX: 0,
                explosionY: 0,
                explosionRadius: 0, // no single crater — craters[] carries the burns
                craters: burnCraters,
                results: []
            });
        }
    }

    // ==================== MAP HAZARDS (landmines + oil drums) ====================

    /**
     * Scatter landmines and oil drums across the freshly generated map.
     * Runs on every client with the shared seeded RNG right after
     * createTeams(), so all clients place identical hazards. Spots come from
     * the same surface scan the koala spawner uses, kept clear of spawns.
     */
    spawnMapHazards() {
        this.oilDrums = [];
        const rand = this.seededRandom || Math.random;

        const spots = this.terrain.getAllSpawnPoints({
            topY: this.mapBounds?.topY || 0,
            waterLevel: this.waterLevel
        });
        if (spots.length === 0) {
            console.warn('⚠️ No valid surfaces for map hazards');
            return;
        }

        const koalas = [];
        for (const team of this.teams) {
            for (const k of team.koalas) koalas.push(k);
        }

        const placed = [];
        const pickSpot = (minKoalaDist, minSpacing) => {
            for (let attempt = 0; attempt < 40; attempt++) {
                const spot = spots[Math.floor(rand() * spots.length)];
                const gx = spot.x;
                const gy = spot.y + 20; // getAllSpawnPoints returns surfaceY - 20
                if (koalas.some(k => Math.hypot(k.x - gx, k.y - gy) < minKoalaDist)) continue;
                if (placed.some(p => Math.hypot(p.x - gx, p.y - gy) < minSpacing)) continue;
                placed.push({ x: gx, y: gy });
                return { x: gx, y: gy };
            }
            return null;
        };

        // Landmines: proximity-triggered, some are duds (WA-style).
        // Counts come from the match scheme; identical on all clients
        // because the scheme itself ships in the gameStart message.
        const mineCount = this.scheme.mineCount;
        let minesPlaced = 0;
        for (let i = 0; i < mineCount; i++) {
            const spot = pickSpot(130, 90);
            if (!spot) break;
            this.spawnLandmine(spot.x, spot.y, rand);
            minesPlaced++;
        }

        // Oil drums: explode when shot, burned or whacked
        const drumCount = this.scheme.oilDrumCount;
        for (let i = 0; i < drumCount; i++) {
            const spot = pickSpot(110, 120);
            if (!spot) break;
            this.oilDrums.push({
                id: 'drum_' + i,
                x: spot.x,
                y: spot.y,          // bottom-center, resting on the ground
                hp: 30,
                maxHp: 30,
                falling: false,
                vy: 0,
                igniteTimer: 0,     // > 0 = lit by fire, counting down to boom
                detonated: false,   // armed for a scheduled detonation
                effectSeed: Math.floor(rand() * 0xFFFFFFFF)
            });
        }

        console.log(`💣 Map hazards: ${minesPlaced} mines, ${this.oilDrums.length} oil drums`);
    }

    /**
     * Place one pre-armed landmine on the ground. It's a normal stationary
     * mine Projectile, so proximity triggering, dud behavior, falling when
     * the ground is destroyed, rendering and explosion sync all reuse the
     * existing weapon-mine pipeline.
     */
    spawnLandmine(x, y, rand) {
        // Always draw both rolls so the shared RNG stream advances identically
        // on every client regardless of the scheme's fixed-fuse setting.
        const fuseRoll = 1.5 + rand() * 1.5;
        const dudRoll = rand();
        const weapon = {
            id: 'mapmine',
            name: 'Mine',
            type: 'mine',
            damage: 45,
            explosionRadius: 65,
            knockback: 300,
            // Scheme: -1 = classic random fuse, otherwise a fixed delay
            triggerDelay: this.scheme.mineDelay === -1 ? fuseRoll : this.scheme.mineDelay,
            noContactExplosion: true
        };
        const mine = new Projectile({
            x,
            y: y - 5,
            vx: 0,
            vy: 0,
            type: 'mine',
            weapon,
            timer: null,
            triggeredByProximity: true,
            isDud: dudRoll < this.scheme.mineDudChance
        });
        mine.stationary = true;
        mine.hasTouchedTerrain = true;
        mine.effectSeed = Math.floor(rand() * 0xFFFFFFFF);
        this.projectiles.push(mine);
    }

    /**
     * Per-frame oil drum housekeeping: lit fuses burn down, unsupported
     * drums fall (and drown). Runs on all clients — falling converges
     * because the terrain is synced; fuses only ever start on the
     * authoritative client, and detonations are synced by id.
     */
    updateOilDrums(dt) {
        if (this.oilDrums.length === 0) return;

        for (let i = this.oilDrums.length - 1; i >= 0; i--) {
            const drum = this.oilDrums[i];

            // Lit by fire: sputter, then blow
            if (drum.igniteTimer > 0) {
                drum.igniteTimer -= dt;
                if (Math.random() > 0.4 && this.particles.length < this.maxParticles - 5) {
                    this.addParticle({
                        type: 'spark',
                        x: drum.x + (Math.random() - 0.5) * 10,
                        y: drum.y - 34,
                        vx: (Math.random() - 0.5) * 40,
                        vy: -60 - Math.random() * 60,
                        color: Math.random() > 0.5 ? '#ff6600' : '#ffaa00',
                        size: 2 + Math.random() * 2,
                        lifetime: 0.4,
                        time: 0
                    });
                }
                if (drum.igniteTimer <= 0) {
                    this.detonateOilDrum(drum);
                    continue;
                }
            }

            // Ground blown away underneath? Start falling.
            if (!drum.falling &&
                !this.terrain.checkCollision(drum.x, drum.y + 2) &&
                !this.terrain.checkCollision(drum.x, drum.y + 6)) {
                drum.falling = true;
                drum.vy = 0;
            }

            if (drum.falling) {
                drum.vy += 800 * dt;
                const targetY = drum.y + drum.vy * dt;
                let y = drum.y;
                let landed = false;
                while (y < targetY) {
                    y = Math.min(y + 2, targetY);
                    if (this.terrain.checkCollision(drum.x, y + 2)) {
                        landed = true;
                        break;
                    }
                }
                drum.y = y;
                if (landed) {
                    drum.falling = false;
                    drum.vy = 0;
                }

                // Splashed into the drink — gone for good
                if (drum.y > this.waterLevel + 10) {
                    this.createSplash(drum.x, this.waterLevel);
                    this.oilDrums.splice(i, 1);
                }
            }
        }
    }

    /**
     * Apply blast damage to drums near an explosion. Authoritative client
     * only — guests hear about resulting detonations via explosionSync.
     * Damaged-to-death drums blow after a short fuse so chain reactions pop
     * in sequence instead of all in one frame.
     */
    damageOilDrums(x, y, radius, damage) {
        for (const drum of this.oilDrums) {
            if (drum.detonated) continue;
            const dist = Math.hypot(drum.x - x, (drum.y - 17) - y);
            if (dist < radius + 13) {
                const falloff = Math.max(0.25, 1 - dist / (radius + 13));
                drum.hp -= Math.max(5, damage * falloff);
                if (drum.hp <= 0) {
                    drum.detonated = true;
                    this.scheduleDelayedAction(150 + Math.random() * 120, () => this.detonateOilDrum(drum));
                }
            }
        }
    }

    /**
     * Blow up an oil drum: big blast plus burning oil (WA-style). Visuals
     * and fire run on whichever client calls this; crater, koala damage and
     * the sync message are authoritative-only. Guests reach here via the
     * drum ids in explosionSync.
     */
    detonateOilDrum(drum) {
        const idx = this.oilDrums.indexOf(drum);
        if (idx === -1) return; // already gone (e.g. synced removal won the race)
        this.oilDrums.splice(idx, 1);

        const cx = drum.x;
        const cy = drum.y - 17;
        const radius = 75;
        const damage = 40;

        this.createExplosion(cx, cy, radius);
        this.createExplosionParticles(cx, cy, radius, '#ff8830');
        this.addScreenShake(radius / 8, 0.35);
        this.audioManager.playExplosion('large');

        // Burning oil sprays out — rolled from the drum's spawn seed so both
        // clients scatter identical flames
        this.spawnFirePatches(cx, cy, 6, this.createSeededRandom(drum.effectSeed));

        const isAuthoritativeClient = this.isPractice || !this.networkManager || this.networkManager.isHost;
        if (!isAuthoritativeClient) return;

        // Terrain + damage, mirroring handleProjectileImpact
        this.terrain.createCrater(cx, cy, radius);

        const explosionResults = [];
        const nearbyEntities = this.spatialGrid.queryRadius(cx, cy, radius);
        for (const { entity: koala, distance } of nearbyEntities) {
            if (koala.isAlive === undefined) continue;

            const falloff = 1 - distance / radius;
            const launchDamage = damage * falloff;
            const knockback = Math.min(launchDamage * 9, 900);
            const angle = Math.atan2(koala.y - (cy + 10), koala.x - cx);
            koala.applyKnockback(Math.cos(angle) * knockback, Math.sin(angle) * knockback * 1.3);

            if (koala.isAlive) {
                const dmg = Math.round(launchDamage);
                koala.takeDamage(dmg);
                if (dmg > 0) {
                    this.audioManager.playDamage();
                    this.createFloatingText(koala.x, koala.y - 40, `-${dmg}`, '#ff5544');
                }
                explosionResults.push({
                    koalaName: koala.name,
                    damage: dmg,
                    newHealth: koala.health,
                    x: koala.x,
                    y: koala.y,
                    vx: koala.vx,
                    vy: koala.vy
                });
            }
        }
        this.updateTeamHealth();

        // Chain reaction into neighboring drums
        this.damageOilDrums(cx, cy, radius, damage);

        if (this.networkManager && !this.isPractice && this.networkManager.isHost) {
            this.networkManager.send({
                type: 'explosionSync',
                explosionX: cx,
                explosionY: cy,
                explosionRadius: radius,
                drums: [drum.id],
                results: explosionResults
            });
        }
    }

    /**
     * Start following a projectile with camera (uses main update loop)
     */
    followProjectile(projectile) {
        // Store reference - updateCamera will handle following
        this.followingProjectile = projectile;
    }

    /**
     * Stop following projectile
     */
    stopFollowingProjectile() {
        this.followingProjectile = null;
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
     * Update camera position
     */
    updateCamera(dt) {
        // Decay screen shake
        if (this.camera.shake && this.camera.shake.time > 0) {
            this.camera.shake.time -= dt;
        }

        // Follow projectile if tracking one (O(1) check using destroyed flag)
        if (this.followingProjectile && !this.followingProjectile.destroyed) {
            this.centerCameraOn(this.followingProjectile.x, this.followingProjectile.y);
        } else if (this.followingProjectile) {
            // Projectile is destroyed, stop tracking
            this.followingProjectile = null;
        }

        const smoothing = 5;
        this.camera.x += (this.camera.targetX - this.camera.x) * smoothing * dt;
        this.camera.y += (this.camera.targetY - this.camera.y) * smoothing * dt;

        // Clamp to world bounds (account for zoom)
        const viewWidth = this.canvas.width / this.camera.zoom;
        const viewHeight = this.canvas.height / this.camera.zoom;
        this.camera.x = Math.max(0, Math.min(this.worldWidth - viewWidth, this.camera.x));
        this.camera.y = Math.max(0, Math.min(this.worldHeight - viewHeight, this.camera.y));
    }

    /**
     * Center the camera target on a world position (zoom-aware)
     */
    centerCameraOn(x, y) {
        this.camera.targetX = x - this.canvas.width / (2 * this.camera.zoom);
        this.camera.targetY = y - this.canvas.height / (2 * this.camera.zoom);
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
     * Update UI elements
     */
    updateTurnIndicator() {
        const team = this.getCurrentTeam();
        const indicator = this.dom.elements.turnIndicator;
        if (indicator && team) {
            // In multiplayer, show if it's your, an ally's, or an enemy's turn
            if (!this.isPractice && this.networkManager) {
                const isMyTurn = this.isMyTurn();
                let turnText;
                if (isMyTurn) {
                    turnText = 'Your Turn!';
                } else if (team.alliance && team.alliance === this.getMyAlliance()) {
                    turnText = "Ally's Turn";
                } else {
                    turnText = 'Enemy Turn';
                }
                indicator.innerHTML = `<span id="current-team" style="color: ${team.color}; ${isMyTurn ? 'font-weight: bold; text-shadow: 0 0 10px ' + team.color : ''}">${team.name}</span> - ${turnText}`;
            } else {
                indicator.innerHTML = `<span id="current-team" style="color: ${team.color}">${team.name}</span>'s Turn`;
            }
        }
    }

    updateTimerDisplay() {
        const el = this.dom.elements.turnTimer;
        if (el) {
            el.textContent = Math.ceil(this.turnTimer);
            el.style.color = this.turnTimer < 10 ? '#e74c3c' : '#f1c40f';
        }
    }

    updateWindDisplay() {
        const fill = this.dom.elements.windFill;
        const value = this.dom.elements.windValue;

        if (fill) {
            const absWind = Math.abs(this.wind);
            const widthPercent = absWind * 45; // Max 45% from center

            // Remove old classes
            fill.classList.remove('wind-left-fill', 'wind-right-fill');

            if (this.wind < 0) {
                // Left wind (green)
                fill.style.width = widthPercent + '%';
                fill.style.left = (50 - widthPercent) + '%';
                fill.classList.add('wind-left-fill');
            } else if (this.wind > 0) {
                // Right wind (red)
                fill.style.width = widthPercent + '%';
                fill.style.left = '50%';
                fill.classList.add('wind-right-fill');
            } else {
                // No wind
                fill.style.width = '0';
                fill.style.left = '50%';
            }

            // WA-style scrolling chevrons: stronger wind scrolls faster
            const stripeDuration = absWind > 0.01 ? (1.3 - absWind).toFixed(2) : 0;
            fill.style.setProperty('--wind-stripe-duration', stripeDuration + 's');

            // Gust pulse on the whole gauge whenever the wind changes
            const meter = fill.parentElement;
            if (meter) {
                meter.classList.remove('wind-gust');
                void meter.offsetWidth; // Restart the animation
                meter.classList.add('wind-gust');
            }
        }

        if (value) {
            const windStrength = Math.round(Math.abs(this.wind) * 100);
            const direction = this.wind < 0 ? '←' : (this.wind > 0 ? '→' : '');
            value.textContent = direction + windStrength;
            value.style.color = this.wind < 0 ? '#2ecc71' : (this.wind > 0 ? '#e74c3c' : '#fff');
        }
    }

    updateTeamHealth() {
        if (!this.teamHpEls) return;
        for (let i = 0; i < this.teams.length; i++) {
            const team = this.teams[i];
            const els = this.teamHpEls[i];
            if (!els) continue;

            const totalHealth = team.getTotalHealth();
            // Sum real max health (scheme-defined, not always 100 per koala)
            const maxHealth = team.koalas.reduce((sum, k) => sum + k.maxHealth, 0) || 1;
            const percent = (totalHealth / maxHealth) * 100;

            // Overhealing can push totalHealth above maxHealth; clamp the bar
            // width so it doesn't overflow, but show the true HP number.
            els.fill.style.width = Math.min(100, percent) + '%';
            els.value.textContent = totalHealth;
            els.row.classList.toggle('team-dead', !team.isAlive());
        }
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

        // Play end game sound
        if (winningTeam) {
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
                    color: winningTeam.color
                }
                : { name: winningTeam.name, color: winningTeam.color };
        }

        this.emit('gameOver', {
            winner: winnerDisplay,
            stats: this.calculateStats()
        });
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
        console.log(`🏳️ ${team.name} forfeits`);
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

        return { totalDamage, totalKills };
    }

    /**
     * Handle network action from other player
     */
    handleNetworkAction(action) {
        switch (action.type) {
            case 'move':
                // Sync koala position
                break;
            case 'fire':
                // Replay fire action
                const weapon = this.weaponManager.getWeapon(action.weapon);
                if (weapon) {
                    const proj = weapon.createProjectile(action.x, action.y - 10, action.angle, action.power);
                    this.projectiles.push(proj);
                    this.phase = 'projectile';
                }
                break;
        }
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
     * Update weapon UI (ammo counts) - Optimized with DOM caching
     */
    updateWeaponUI() {
        // Use cached weapon elements array (no querySelector!)
        const weaponEls = this.dom.weaponArray;
        const currentWeaponId = this.weaponManager.currentWeapon?.id;

        for (let i = 0; i < weaponEls.length; i++) {
            const el = weaponEls[i];
            const weaponId = el.dataset.weapon;
            const weapon = this.weaponManager.getWeapon(weaponId);

            if (weapon) {
                // Update selected state (only toggle if needed)
                const isSelected = weaponId === currentWeaponId;
                if (isSelected !== el.classList.contains('selected')) {
                    el.classList.toggle('selected', isSelected);
                }

                // Scheme unlock delay: locked weapons show a countdown badge
                const delayLeft = this.weaponDelayRemaining(weapon);
                const locked = delayLeft > 0;
                if (locked !== el.classList.contains('locked')) {
                    el.classList.toggle('locked', locked);
                }

                // Cache ammo element on the weapon element itself
                // This avoids querySelector on every update
                if (!el._cachedAmmoEl) {
                    el._cachedAmmoEl = el.querySelector('.ammo-count');
                }
                let ammoEl = el._cachedAmmoEl;

                if (locked || weapon.ammo !== Infinity) {
                    // Badge needed - create or update ammo element
                    if (!ammoEl) {
                        ammoEl = document.createElement('div');
                        ammoEl.className = 'ammo-count';
                        el.appendChild(ammoEl);
                        el._cachedAmmoEl = ammoEl; // Cache the new element
                    }

                    // Only update text if changed
                    const ammoStr = locked ? `🔒${delayLeft}` : weapon.ammo.toString();
                    if (ammoEl.textContent !== ammoStr) {
                        ammoEl.textContent = ammoStr;
                    }

                    // Update disabled state (only toggle if needed)
                    const shouldBeDisabled = locked || weapon.ammo <= 0;
                    if (shouldBeDisabled !== el.classList.contains('disabled')) {
                        el.classList.toggle('disabled', shouldBeDisabled);
                    }
                } else {
                    // Infinite ammo and unlocked - remove ammo element if exists
                    if (ammoEl) {
                        ammoEl.remove();
                        el._cachedAmmoEl = null; // Clear cache
                    }
                    el.classList.remove('disabled');
                }
            }
        }

        // Update active weapon card
        const currentWeapon = this.weaponManager.currentWeapon;
        if (currentWeapon) {
            const cardEl = this.dom.elements.activeWeaponCard;
            const iconContainer = this.dom.elements.activeWeaponIconContainer;
            const nameEl = this.dom.elements.activeWeaponName;
            const ammoEl = this.dom.elements.activeWeaponAmmo;

            if (cardEl && iconContainer && nameEl && ammoEl) {
                // Set weapon name
                nameEl.textContent = currentWeapon.name;

                // Set ammo (or the scheme unlock countdown)
                const cardDelayLeft = this.weaponDelayRemaining(currentWeapon);
                if (cardDelayLeft > 0) {
                    ammoEl.textContent = `🔒 Unlocks in ${cardDelayLeft} round${cardDelayLeft > 1 ? 's' : ''}`;
                } else if (currentWeapon.ammo === Infinity) {
                    ammoEl.textContent = "Ammo: ∞";
                } else {
                    ammoEl.textContent = `Ammo: ${currentWeapon.ammo}`;
                }

                // Set icon/image
                const matchEl = weaponEls.find(el => el.dataset.weapon === currentWeapon.id);
                if (matchEl) {
                    const imgEl = matchEl.querySelector('img');
                    const iconEl = matchEl.querySelector('.weapon-icon');
                    if (imgEl) {
                        iconContainer.innerHTML = `<img src="${imgEl.getAttribute('src')}" alt="${currentWeapon.name}" style="width: 30px; height: 30px; object-fit: contain; image-rendering: pixelated;">`;
                    } else if (iconEl) {
                        iconContainer.innerHTML = `<span class="weapon-icon" style="font-size: 1.4rem;">${iconEl.textContent}</span>`;
                    } else {
                        iconContainer.innerHTML = ``;
                    }
                } else {
                    iconContainer.innerHTML = currentWeapon.icon ? `<span class="weapon-icon" style="font-size: 1.4rem;">${currentWeapon.icon}</span>` : '';
                }

                // Gray out active weapon card if empty or still locked
                if (cardDelayLeft > 0 || (currentWeapon.ammo !== Infinity && currentWeapon.ammo <= 0)) {
                    cardEl.classList.add('out-of-ammo');
                } else {
                    cardEl.classList.remove('out-of-ammo');
                }
            }
        }
    }

    /**
     * Reset game for rematch
     * Re-runs the same initialization path as start() so custom maps,
     * countdown, loot state etc. all behave like a fresh game.
     */
    reset() {
        console.log('Resetting game...');

        // Stop current game loop
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }

        // Clear all transient state
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

        console.log('Game reset complete!');
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
    }

    // ==================== MULTIPLAYER NETWORK HANDLERS ====================

    /**
     * Check if current turn belongs to the local player
     */
    isMyTurn() {
        if (this.isPractice || !this.networkManager) {
            return true; // Always our turn in practice mode
        }
        return this.networkManager.isMyTurn(this.currentTeamIndex);
    }

    /**
     * Validate a remote action and, if our turn indices drifted, adopt the
     * acting player's turn — each client is authoritative about its OWN turn.
     *
     * The old gate ("ignore remote actions while it's my turn") silently
     * dropped legitimate actions whenever the two clients' turn clocks were a
     * moment apart: our timer flips the turn first, the opponent's last-second
     * shot arrives, and the projectile only ever exists on their screen. Now
     * we only reject actions claiming to come from OUR OWN team; a mismatched
     * turn index means we adopt theirs. Messages from old clients without
     * teamIndex fall back to the old rule.
     */
    adoptRemoteTurn(data, label) {
        if (this.isPractice || !this.networkManager) return false;

        if (data.teamIndex === undefined) {
            if (this.isMyTurn()) {
                console.warn(`Blocked remote ${label} during local turn (no teamIndex)`);
                return false;
            }
            return true;
        }
        if (this.networkManager.isMyTeam(data.teamIndex)) {
            console.warn(`Blocked remote ${label} claiming to be our own team`);
            return false;
        }
        if (this.currentTeamIndex !== data.teamIndex) {
            console.warn(`Turn drift on remote ${label}: local team ${this.currentTeamIndex}, acting team ${data.teamIndex} — adopting theirs`);
            this.currentTeamIndex = data.teamIndex;
            const team = this.teams[data.teamIndex];
            if (team && team.weapons) {
                this.weaponManager.weapons = team.weapons;
            }
            this.updateTurnIndicator();
        }
        if (data.koalaIndex !== undefined && this.currentKoalaIndex !== data.koalaIndex) {
            this.currentKoalaIndex = data.koalaIndex;
            const team = this.teams[data.teamIndex];
            if (team) team.currentKoalaIndex = data.koalaIndex;
        }
        return true;
    }

    /**
     * Handle remote player firing a weapon
     */
    handleRemoteFire(data) {
        console.log('🎯 Remote fire:', data);

        if (!this.adoptRemoteTurn(data, 'fire')) return;

        const koala = this.getCurrentKoala();
        if (!koala) return;

        // Set up the koala's state from remote data
        koala.x = data.x;
        koala.y = data.y;
        koala.aimAngle = data.angle;

        // Fire the weapon
        this.weaponManager.selectWeapon(data.weaponId);

        // Never drop a replayed fire over ammo drift — the shot already
        // happened on the acting client, so refusing it here desyncs the
        // whole match (they have a projectile in flight, we don't)
        const weapon = this.weaponManager.currentWeapon;
        if (weapon && weapon.ammo !== Infinity && weapon.ammo <= 0) {
            console.warn(`Ammo drift: ${data.weaponId} shows 0 here but the opponent fired it — correcting to 1`);
            weapon.ammo = 1;
        }

        this.fireWeapon(data.angle, data.power);
    }

    /**
     * Handle remote player movement
     */
    handleRemoteMove(data) {
        if (!this.adoptRemoteTurn(data, 'move')) return;
        const koala = this.getCurrentKoala();
        if (!koala) return;

        // Update koala position
        koala.x = data.x;
        koala.y = data.y;
        koala.facingLeft = data.facingLeft;
        if (data.blowtorchDigging !== undefined) {
            koala.blowtorchDigging = data.blowtorchDigging;
        }
    }

    /**
     * Handle remote player aiming
     */
    handleRemoteAim(data) {
        if (!this.adoptRemoteTurn(data, 'aim')) return;
        const koala = this.getCurrentKoala();
        if (!koala) return;

        koala.aimAngle = data.angle;
    }

    /**
     * Handle remote targeted weapon (airstrike, teleport)
     */
    handleRemoteTargetWeapon(data) {
        console.log('🎯 Remote target weapon:', data);

        if (!this.adoptRemoteTurn(data, 'target weapon')) return;

        this.weaponManager.selectWeapon(data.weaponId);
        const weapon = this.weaponManager.currentWeapon;

        if (weapon) {
            // Same ammo-drift guard as handleRemoteFire
            if (weapon.ammo !== Infinity && weapon.ammo <= 0) {
                console.warn(`Ammo drift: ${data.weaponId} shows 0 here but the opponent fired it — correcting to 1`);
                weapon.ammo = 1;
            }
            this.fireTargettedWeapon(weapon, data.targetX, data.targetY);
        }
    }

    /**
     * Handle remote weapon selection
     */
    handleRemoteWeaponSelect(data) {
        console.log('🔫 Remote weapon select:', data.weaponId);

        if (this.isMyTurn() && !this.isPractice) return;

        // Select the weapon on this client
        this.weaponManager.selectWeapon(data.weaponId);
        this.updateWeaponUI();
    }

    /**
     * Handle remote turn end signal
     */
    handleRemoteTurnEnd(data) {
        console.log('🔄 Remote turn end:', data);

        if (this.isMyTurn() && !this.isPractice) {
            console.warn('Blocked remote turn end signal during local turn');
            return;
        }

        // A turn-end message only ever means "the active player ended a tool
        // action (blowtorch) early." End the same action locally so this client
        // leaves the tool phase; from there the turn hands over deterministically
        // on BOTH clients (retreat -> settle -> nextTurn), exactly like a normal
        // shot. We must NOT force team/koala indices or call startTurn() here —
        // doing so fought the deterministic handover and handed the active team
        // a second turn whenever this client had already left the tool phase.
        if (this.phase === 'blowtorch') {
            this.endBlowtorch();
        } else if (this.phase === 'drill') {
            this.endDrill();
        }
    }

    // (Obsolete duplicate declarations of handleRemoteStateSync and sendFullStateSync removed)

    /**
     * Send local fire action to network
     */
    sendFireAction(weaponId, angle, power, x, y) {
        if (this.networkManager && !this.isPractice) {
            this.networkManager.sendFire(weaponId, angle, power, x, y);
        }
    }

    /**
     * Send local target weapon action to network
     */
    sendTargetWeaponAction(weaponId, targetX, targetY) {
        if (this.networkManager && !this.isPractice) {
            this.networkManager.sendTargetWeapon(weaponId, targetX, targetY);
        }
    }

    /**
     * Send turn end to network
     */
    sendTurnEnd() {
        if (this.networkManager && !this.isPractice) {
            this.networkManager.sendTurnEnd(this.currentTeamIndex, this.currentKoalaIndex);
        }
    }

    /**
     * Serialize all koala states for sync messages
     */
    serializeKoalas() {
        const out = [];
        for (const team of this.teams) {
            for (const koala of team.koalas) {
                out.push({
                    name: koala.name,
                    x: koala.x,
                    y: koala.y,
                    vx: koala.vx || 0,
                    vy: koala.vy || 0,
                    health: koala.health,
                    isAlive: koala.isAlive,
                    onGround: koala.onGround
                });
            }
        }
        return out;
    }

    /**
     * Apply authoritative koala states from a sync message, playing death
     * effects for anything that died on the other side but not here (and
     * quietly reviving anything we killed by mistake).
     */
    applyKoalaStates(koalas) {
        if (!Array.isArray(koalas)) return;
        for (const kd of koalas) {
            const koala = this.findKoalaByName(kd.name);
            if (!koala) continue;
            koala.x = kd.x;
            koala.y = kd.y;
            koala.vx = kd.vx || 0;
            koala.vy = kd.vy || 0;
            koala.health = kd.health;
            koala.onGround = kd.onGround;
            if (koala.isAlive && !kd.isAlive) {
                koala.die();
                this.createDeathEffect(koala);
            } else if (!koala.isAlive && kd.isAlive) {
                // Local drift killed it but the authority says it lives
                koala.isAlive = true;
            }
        }
        this.updateTeamHealth();
    }

    /**
     * Serialize per-team weapon ammo. Infinity is encoded as -1: the outbound
     * sanitizer strips non-finite numbers, which would otherwise turn every
     * unlimited weapon into 0 ammo on the receiving side.
     */
    serializeAmmo() {
        return this.teams.map(team => {
            const ammo = {};
            for (const [id, w] of Object.entries(team.weapons || {})) {
                ammo[id] = w.ammo === Infinity ? -1 : w.ammo;
            }
            return ammo;
        });
    }

    /**
     * Apply per-team ammo counts from a sync message (-1 = Infinity)
     */
    applyAmmoSync(ammoByTeam) {
        if (!Array.isArray(ammoByTeam)) return;
        ammoByTeam.forEach((ammo, i) => {
            const team = this.teams[i];
            if (!team || !team.weapons || !ammo) return;
            for (const [id, count] of Object.entries(ammo)) {
                if (team.weapons[id]) {
                    team.weapons[id].ammo = count === -1 ? Infinity : count;
                }
            }
        });
        this.updateWeaponUI();
    }

    /**
     * Announce the authoritative opening state of a new turn. Sent by the
     * client that drove the turn transition (see TurnManager.nextTurn); the
     * peer adopts it in handleRemoteTurnStart. This replaces the old
     * every-client-advances-on-its-own-clock model that caused double turns.
     */
    sendTurnStartSync() {
        if (!this.networkManager || this.isPractice) return;
        const tm = this.turnManager;
        this.networkManager.send({
            type: 'turnStart',
            turnCounter: tm.turnCounter,
            currentTeamIndex: this.currentTeamIndex,
            currentKoalaIndex: this.currentKoalaIndex,
            wind: this.wind,
            suddenDeathActive: tm.suddenDeathActive,
            roundNumber: tm.roundNumber,
            lastTeamIndex: tm.lastTeamIndex,
            turnTime: tm.turnTime,
            elapsedGameTime: tm.elapsedGameTime,
            waterLevel: this.waterLevel,
            ammo: this.serializeAmmo(),
            koalas: this.serializeKoalas()
        });
    }

    /**
     * Adopt the new turn announced by the client that ended the previous one
     */
    handleRemoteTurnStart(data) {
        if (this.isPractice || this.isGameOver) return;
        const tm = this.turnManager;

        // Stale or duplicate — e.g. our fallback watchdog already advanced us
        if (data.turnCounter !== undefined && data.turnCounter <= tm.turnCounter) {
            console.warn(`Ignoring stale turnStart #${data.turnCounter} (local turn #${tm.turnCounter})`);
            return;
        }

        console.log('🔄 Remote turn start #' + data.turnCounter);

        // Leave whatever phase we were parked in
        this.cleanupTurnInputState();
        this.kamikazeState = null;

        // Authoritative state from the turn driver
        this.applyKoalaStates(data.koalas);
        this.applyAmmoSync(data.ammo);
        if (data.elapsedGameTime !== undefined) tm.elapsedGameTime = data.elapsedGameTime;
        if (data.waterLevel !== undefined) this.waterLevel = data.waterLevel;

        // Adopt the new turn, then run our own startTurn so the shared RNG
        // advances symmetrically (wind draw), music/UI update, and the host
        // rolls loot exactly as if we had advanced ourselves
        tm.currentTeamIndex = data.currentTeamIndex;
        tm.currentKoalaIndex = data.currentKoalaIndex;
        const team = this.teams[data.currentTeamIndex];
        if (team) team.currentKoalaIndex = data.currentKoalaIndex;

        tm.startTurn();

        // Belt-and-braces: force anything that could still have drifted
        tm.currentKoalaIndex = data.currentKoalaIndex;
        if (team) team.currentKoalaIndex = data.currentKoalaIndex;
        if (data.wind !== undefined) {
            this.wind = data.wind;
            this.updateWindDisplay();
        }
        if (data.suddenDeathActive && !tm.suddenDeathActive) {
            tm.activateSuddenDeath();
        }
        if (data.roundNumber !== undefined) tm.roundNumber = data.roundNumber;
        if (data.lastTeamIndex !== undefined) tm.lastTeamIndex = data.lastTeamIndex;
        if (data.turnTime !== undefined) {
            tm.turnTime = data.turnTime;
            tm.turnTimer = Math.min(tm.turnTimer, data.turnTime);
        }
        if (data.turnCounter !== undefined) tm.turnCounter = data.turnCounter;
        this.updateTurnIndicator();
    }

    /**
     * The other client's authoritative turn flow ended the game
     */
    handleRemoteGameOver(data) {
        if (this.isGameOver) return;
        console.log('🏁 Remote game over:', data);
        const winner = (data.winnerTeamIndex >= 0 && this.teams[data.winnerTeamIndex]) || null;
        this.endGame(winner, { fromRemote: true });
    }

    /**
     * Send authoritative full state sync to peers. Used for reconnect
     * recovery — pass includeTerrain to ship a snapshot of the terrain canvas
     * so a rejoining guest gets every crater it missed.
     */
    sendFullStateSync(options = {}) {
        if (!this.networkManager || this.isPractice) return;

        console.log('🔄 Sending full state sync' + (options.includeTerrain ? ' (with terrain)' : ''));

        const tm = this.turnManager;
        const stateData = {
            type: 'stateSync',
            phase: this.phase,
            turnCounter: tm.turnCounter,
            currentTeamIndex: this.currentTeamIndex,
            currentKoalaIndex: this.currentKoalaIndex,
            wind: this.wind,
            // Sudden-death state — active player is authoritative so guests stay
            // in lockstep on when it triggers, how high the water is, etc.
            suddenDeathActive: tm.suddenDeathActive,
            roundNumber: tm.roundNumber,
            lastTeamIndex: tm.lastTeamIndex,
            turnTime: tm.turnTime,
            elapsedGameTime: tm.elapsedGameTime,
            waterLevel: this.waterLevel,
            ammo: this.serializeAmmo(),
            koalas: this.serializeKoalas(),
            crates: this.lootManager.serializeCrates()
        };

        if (options.includeTerrain) {
            const canvas = this.terrain.getCanvas ? this.terrain.getCanvas() : this.terrain.canvas;
            if (canvas) {
                stateData.terrain = canvas.toDataURL('image/png');
            }
        }

        this.networkManager.send(stateData);
    }

    /**
     * Replace the local terrain with a snapshot from the peer (reconnect sync)
     */
    applyTerrainSnapshot(dataUrl) {
        const img = new Image();
        img.onload = () => {
            this.terrain.ctx.clearRect(0, 0, this.terrain.width, this.terrain.height);
            this.terrain.ctx.drawImage(img, 0, 0);
            this.terrain.updateCollisionMask();
            console.log('🗺️ Terrain snapshot applied (reconnect sync)');
        };
        img.src = dataUrl;
    }

    /**
     * Handle explosion sync from remote player
     * This applies the authoritative damage/knockback values from the Host
     */
    handleRemoteExplosionSync(data) {
        if (this.networkManager && this.networkManager.isHost) {
            console.warn('🛡️ Blocked remote explosion sync (Host is authority)');
            return;
        }

        console.log('💥 Remote explosion sync:', data);

        // IMPORTANT: Apply terrain damage at the EXACT synced position
        // This ensures both clients have identical terrain
        if (data.explosionX !== undefined && data.explosionY !== undefined && data.explosionRadius > 0) {
            this.terrain.createCrater(data.explosionX, data.explosionY, data.explosionRadius);
            console.log(`   Terrain crater at (${data.explosionX.toFixed(0)}, ${data.explosionY.toFixed(0)}) radius ${data.explosionRadius}`);
        }

        // Batched craters (fire burning terrain) — apply at exact host positions
        if (Array.isArray(data.craters)) {
            for (const c of data.craters) {
                this.terrain.createCrater(c.x, c.y, c.r);
            }
        }

        // Oil drums the host detonated — replay locally (removal, blast
        // visuals, burning oil). detonateOilDrum is visual-only on a guest;
        // the crater and damage arrive with this same message.
        if (Array.isArray(data.drums)) {
            for (const id of data.drums) {
                const drum = this.oilDrums.find(d => d.id === id);
                if (drum) this.detonateOilDrum(drum);
            }
        }

        // Apply the synced results to each affected koala
        for (const result of data.results) {
            const koala = this.findKoalaByName(result.koalaName);
            if (koala) {
                // Sync health (authoritative from active player)
                koala.health = result.newHealth;

                // Sync position and velocity (for knockback)
                koala.x = result.x;
                koala.y = result.y;
                koala.vx = result.vx;
                koala.vy = result.vy;

                // Mirror the host's tumble from the synced launch velocity so
                // the guest sees the same spin (visual only — physics authority
                // stays with the host's vx/vy above).
                const launchSpeed = Math.hypot(koala.vx, koala.vy);
                if (launchSpeed > 60) {
                    koala.spinVel = (koala.vx >= 0 ? 1 : -1) * Math.min(launchSpeed / 45, 18);
                    koala.onGround = false;
                    koala.wasLaunched = true; // guest skips on landing like the host
                }

                // Show the same damage feedback the active player sees
                if (result.damage > 0) {
                    this.createFloatingText(koala.x, koala.y - 40, `-${result.damage}`, '#ff5544');
                }

                // Check for death
                if (koala.health <= 0 && koala.isAlive) {
                    koala.die();
                    this.createDeathEffect(koala);
                }

                console.log(`   ${koala.name}: HP=${koala.health}, pos=(${koala.x.toFixed(0)}, ${koala.y.toFixed(0)})`);
            }
        }

        // Update team health display
        this.updateTeamHealth();
    }

    /**
     * Find a koala by name across all teams
     */
    findKoalaByName(name) {
        for (const team of this.teams) {
            for (const koala of team.koalas) {
                if (koala.name === name) {
                    return koala;
                }
            }
        }
        return null;
    }

    /**
     * Handle remote jump action
     */
    handleRemoteJump(data) {
        console.log('🦘 Remote jump:', data);
        if (!this.adoptRemoteTurn(data, 'jump')) return;
        const koala = this.getCurrentKoala();
        if (koala) {
            koala.x = data.x;
            koala.y = data.y;
            koala.vx = data.vx || 0;
            koala.vy = data.vy;
            koala.onGround = false;
            koala.isJumping = true;
        }
    }

    /**
     * Handle remote high jump / backflip action
     */
    handleRemoteHighJump(data) {
        console.log('🦘 Remote high jump:', data);
        if (!this.adoptRemoteTurn(data, 'high jump')) return;
        const koala = this.getCurrentKoala();
        if (koala) {
            koala.x = data.x;
            koala.y = data.y;
            koala.vx = data.vx;
            koala.vy = data.vy;
            koala.facingLeft = data.facingLeft;
            koala.onGround = false;
            // Only the double-tap backflip somersaults; a plain high jump
            // (single Backspace) stays upright. Old clients omit `flip` and
            // get the somersault, matching their local animation.
            koala.isBackflipping = data.flip !== false;
            koala.backflipRotation = 0;
        }
    }

    /**
     * Handle full state sync from the authoritative client
     * This is used to correct any drift between clients
     */
    handleRemoteStateSync(data) {
        console.log('🔄 Remote state sync');

        // Sync all koala positions (with death effects / revive handling)
        this.applyKoalaStates(data.koalas);
        this.applyAmmoSync(data.ammo);
        if (data.crates) {
            this.lootManager.applyCrateSync(data.crates);
        }
        if (data.terrain) {
            this.applyTerrainSnapshot(data.terrain);
        }
        if (data.turnCounter !== undefined) {
            this.turnManager.turnCounter = Math.max(this.turnManager.turnCounter, data.turnCounter);
        }

        // Only sync team/koala index during the aiming phase to prevent the
        // double-turn bug where stateSync overwrites the current turn owner
        // mid-action — except on a full reconnect sync (terrain present),
        // where we adopt everything: our local state is stale by definition.
        const safeToSyncTurn = this.phase === 'aiming' || data.terrain !== undefined;

        if (safeToSyncTurn) {
            if (data.currentTeamIndex !== undefined) {
                this.currentTeamIndex = data.currentTeamIndex;
            }
            if (data.currentKoalaIndex !== undefined) {
                this.currentKoalaIndex = data.currentKoalaIndex;
            }
        }

        // Always sync phase and wind
        if (data.phase) {
            this.phase = data.phase;
        }
        if (data.wind !== undefined) {
            this.wind = data.wind;
            this.updateWindDisplay();
        }

        // Sudden-death state is authoritative from the active player
        if (data.suddenDeathActive !== undefined) {
            this.turnManager.suddenDeathActive = data.suddenDeathActive;
        }
        if (data.roundNumber !== undefined) this.turnManager.roundNumber = data.roundNumber;
        if (data.lastTeamIndex !== undefined) this.turnManager.lastTeamIndex = data.lastTeamIndex;
        if (data.turnTime !== undefined) this.turnManager.turnTime = data.turnTime;
        if (data.elapsedGameTime !== undefined) this.turnManager.elapsedGameTime = data.elapsedGameTime;
        if (data.waterLevel !== undefined) this.waterLevel = data.waterLevel;

        this.updateTeamHealth();
        this.updateTurnIndicator();
    }
}
