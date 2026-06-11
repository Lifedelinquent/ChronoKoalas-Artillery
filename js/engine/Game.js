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

export class Game extends EventEmitter {
    constructor(canvas, options = {}) {
        super();

        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.options = options;

        // Game dimensions
        this.worldWidth = 2400;
        this.worldHeight = 1200;

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
    }

    /**
     * Start the game
     */
    async start() {
        // Initialize audio (requires user interaction)
        this.audioManager.init();

        // Get game seed for multiplayer sync (or generate random for practice)
        const initialState = this.options.initialState;
        this.gameSeed = initialState?.seed || Math.floor(Math.random() * 1000000);
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

        // Create teams
        this.createTeams();

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
        let s = seed;
        return () => {
            s = Math.sin(s) * 10000;
            return s - Math.floor(s);
        };
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

                // Store custom background color
                if (mapData.backgroundColor) {
                    this.customBackgroundColor = mapData.backgroundColor;
                }

                // Store map bounds (for teleport/spawn validation)
                // Use provided bounds or fall back to calculating them
                if (mapData.mapBounds) {
                    this.mapBounds = mapData.mapBounds;
                    console.log(`📐 Using exported map bounds: Top=${this.mapBounds.topY}, Bottom=${this.mapBounds.bottomY}`);
                } else {
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
        const teamConfigs = [
            { name: 'Red Team', color: '#e74c3c', koalaCount: 3 },
            { name: 'Blue Team', color: '#3498db', koalaCount: 3 }
        ];

        // STEP 1: Pre-scan the entire map for valid spawn points
        // This must happen AFTER the map is loaded (which it is, since start() awaits loadCustomMap)
        console.log('🗺️ Scanning map for valid spawn points...');
        this.validSpawnPoints = this.terrain.getAllSpawnPoints();
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

        teamConfigs.forEach((config, teamIndex) => {
            const team = new Team(config.name, config.color);
            const teamKey = teamIndex === 0 ? 'team1' : 'team2';

            // Get spawn markers for this team (if any)
            const teamMarkers = customSpawns?.[teamKey] || [];
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
                    pos = this.findRandomSpawnPosition(spawnedPositions, minSpawnDistance);
                    console.log(`🐨 ${config.name} Koala ${i + 1}: Random spawn → (${pos?.x}, ${pos?.y})`);
                }

                if (pos) {
                    // BUGFIX: Snap to ground if close, to prevent falling through terrain on first frame
                    const groundY = this.terrain.getGroundBelow(pos.x, pos.y);
                    if (groundY < this.worldHeight && Math.abs(groundY - pos.y) < 100) {
                        console.log(`   ✨ Snapping Koala to ground: ${pos.y} -> ${groundY - 15}`);
                        pos.y = groundY - 15; // Place feet on ground (-15 is half height)
                    }

                    spawnedPositions.push(pos);
                    const koala = new Koala(pos.x, pos.y, team);
                    koala.name = this.getKoalaName(teamIndex, i);

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

        this.updateTeamHealth();
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
    findRandomSpawnPosition(existingPositions, minDistance) {
        // Helper: use seeded random if available (multiplayer sync)
        const rand = () => this.seededRandom ? this.seededRandom() : Math.random();

        // 1. Get ALL potentially valid spawn points from the terrain engine
        // This scans the entire map once per game start
        if (!this.validSpawnPoints || this.validSpawnPoints.length === 0) {
            this.validSpawnPoints = this.terrain.getAllSpawnPoints();
        }

        // If the map is completely empty or the scan failed, use a safety fallback
        if (!this.validSpawnPoints || this.validSpawnPoints.length === 0) {
            console.warn('⚠️ No spawn points found via scan, using safety fallback');
            return { x: 100 + rand() * (this.worldWidth - 200), y: 100 };
        }

        // 2. Use all valid points found in the scan
        const safePoints = this.validSpawnPoints;

        // 3. Shuffle the points for random selection (using seeded random for sync)
        const shuffledPoints = [...(safePoints.length > 0 ? safePoints : this.validSpawnPoints)]
            .sort(() => rand() - 0.5);

        // 4. Try to find a point that satisfies distance and Line-of-Sight requirements
        for (const point of shuffledPoints) {
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
        for (const point of shuffledPoints) {
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
        const randomIndex = Math.floor(rand() * shuffledPoints.length);
        const randomPoint = shuffledPoints[randomIndex];
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
        const names = [
            ['DelinquentKoala', 'Sleepy Steve', 'Chompy Charlie'],
            ['ChronoKoala', 'Koala Kate', 'Dropbear Dan']
        ];
        return names[teamIndex][index] || `Koala ${index + 1}`;
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
            case 'blowtorch':
                this.updateTurnTimer(dt);
                this.updateBlowtorch(dt);
                break;
            case 'retreat':
                this.updateRetreat(dt);
                break;
            case 'damage':
                // Damage phase is handled by processDamage timeout
                break;
        }

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

                // Animate backflip rotation
                if (koala.isBackflipping && !koala.onGround) {
                    // Spin speed - complete about 1.5 rotations during the jump
                    koala.backflipRotation += 12 * dt; // radians per second
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
                        // HIT!
                        target.takeDamage(weapon.damage);

                        // Massive knockback in the direction of the swing
                        const knockbackX = Math.cos(angle) * weapon.knockback;
                        const knockbackY = Math.sin(angle) * weapon.knockback;

                        target.vx += knockbackX;
                        target.vy += knockbackY;
                        target.onGround = false;

                        this.createFloatingText(target.x, target.y - 40, `-${weapon.damage}`, '#ff5544');
                        shooter.damageDealt = (shooter.damageDealt || 0) + weapon.damage;

                        explosionResults.push({
                            koalaName: target.name,
                            damage: weapon.damage,
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

        // Also check map objects (barrels, etc.)
        if (this.terrain.mapObjects) {
            for (let i = this.terrain.mapObjects.length - 1; i >= 0; i--) {
                const obj = this.terrain.mapObjects[i];
                const dx = obj.x - hitX;
                const dy = (obj.y - obj.height / 2) - hitY;
                const dist = Math.hypot(dx, dy);

                if (dist < weapon.range + 20) {
                    // HIT MAP OBJECT
                    if (obj.type === 'barrel') {
                        // Explode barrel
                        if (isAuthoritativeClient) {
                            this.createExplosion(obj.x, obj.y, 60);
                            this.terrain.createCrater(obj.x, obj.y, 60);
                            this.terrain.mapObjects.splice(i, 1);

                            // Let the explosion trigger its own network sync (as an explosion)
                            // We don't need to manually send a sync here since handleProjectileImpact / explosion handles it.
                            // Actually, wait, createExplosion does not sync! It just draws particles.
                            // We do need to handle the barrel explosion damage here, or better yet, since barrel explosions aren't networked,
                            // if isAuthoritativeClient is true, we should probably do a proper game explosion.
                            // For now, let the terrain crater happen. It will go out of sync if we don't sync the crater.
                            // But explosionSync supports an explosion point.
                        }
                        this.audioManager.playExplosion('medium');
                    } else {
                        // Just create particles
                        this.createExplosionParticles(obj.x, obj.y, 5, '#ccc');
                    }
                }
            }
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

        // Check if mouse button is held down to dig
        const isDigging = this.inputManager.mouse.down;
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
        // Cancel power charging
        this.inputManager.isCharging = false;
        this.weaponManager.isCharging = false;
        this.weaponManager.power = 0;

        // Clear blowtorch state
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
                // Count blocking projectiles without creating a new array (faster)
                let blockingCount = 0;
                for (let i = 0; i < this.projectiles.length; i++) {
                    const p = this.projectiles[i];
                    if (!p.stationary || (p.timer !== null && p.timerStarted) || p.isTriggered) {
                        blockingCount++;
                        break; // Early exit - we found at least one
                    }
                }

                if (blockingCount === 0) {
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

            // Apply physics to move the projectile FIRST
            if (!proj.stationary) {
                this.physics.updateProjectile(proj, dt);

                // Smoke trail for rockets and airstrike missiles
                if ((proj.type === 'bazooka' || proj.type === 'airstrike') &&
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
                    } else if (proj.type === 'rope') {
                        // Rope hits -> Pull player
                        this.handleRopeHit(proj);
                        this.removeProjectile(i);
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
            if (proj.y > this.worldHeight - 60 && proj.x > 0 && proj.x < this.worldWidth) {
                this.createSplash(proj.x, this.worldHeight - 60);
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
     * Handle projectile impact
     */
    handleProjectileImpact(projectile, directHitKoala = null) {
        const weapon = projectile.weapon;

        // Collect explosion results for network sync
        const explosionResults = [];

        // In multiplayer, the Host calculates authoritative damage/terrain
        // The Guest will receive synced data via explosionSync from the Host
        const isAuthoritativeClient = this.isPractice || !this.networkManager || this.networkManager.isHost;

        // Create explosion
        if (weapon.explosionRadius > 0) {
            // Play explosion sound based on size
            const size = weapon.explosionRadius > 60 ? 'large' : weapon.explosionRadius < 30 ? 'small' : 'medium';
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
                    const knockback = weapon.knockback * (1 - distance / weapon.explosionRadius);

                    // Apply knockback with biased origin (shifted down 10px)
                    // This ensures characters fly "up and out" instead of sliding sideways
                    // IMPORTANT: Apply knockback to BOTH alive AND dead koalas (ragdoll effect)
                    const biasedExplosionY = projectile.y + 10;
                    const angle = Math.atan2(koala.y - biasedExplosionY, koala.x - projectile.x);
                    koala.vx += Math.cos(angle) * knockback;
                    koala.vy += Math.sin(angle) * knockback * 1.3; // 30% extra upward force
                    koala.onGround = false; // Ensure they get launched

                    // Only apply damage to alive koalas
                    if (koala.isAlive) {
                        const damage = Math.round(weapon.damage * (1 - distance / weapon.explosionRadius));
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
            }
        }

        // Direct hit bonus - ONLY on authoritative client
        // Use ?? so weapons with an explicit directDamage of 0 (bazooka etc.)
        // don't get a phantom double-damage bonus on direct hits
        const directDamage = weapon.directDamage ?? weapon.damage;
        if (directHitKoala && isAuthoritativeClient && directDamage > 0) {
            directHitKoala.takeDamage(directDamage);
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
            this.scheduleDelayedAction(500, () => {
                if (this.projectiles.length === 0) {
                    this.startRetreat();
                }
            });

            // Decrement ammo
            if (weapon.ammo !== Infinity) {
                weapon.ammo--;
                this.updateWeaponUI();
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
                this.networkManager.sendFire(weapon.id, angle, power, koala.x, koala.y);
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
            this.networkManager.sendFire(weapon.id, angle, power, koala.x, koala.y);
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

        console.log('Firing targetted weapon:', weapon.name, 'at', targetX, targetY);

        // Play fire sound
        this.audioManager.playFire(weapon.id);

        // Decrement ammo
        if (weapon.ammo !== Infinity) {
            weapon.ammo--;
            console.log('Ammo remaining:', weapon.ammo);
            this.updateWeaponUI();
        }

        switch (weapon.type) {
            case 'teleport':
                this.executeTeleport(koala, targetX, targetY);
                break;
            case 'airstrike':
                this.executeAirstrike(targetX, targetY, weapon);
                break;
            default:
                console.warn('Unknown targetted weapon:', weapon.type);
                return;
        }

        // Send to network (only if this is our turn)
        if (this.networkManager && !this.isPractice && this.isMyTurn()) {
            this.networkManager.sendTargetWeapon(weapon.id, targetX, targetY);
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
            // Could add visual/audio feedback here
            return;
        }

        const groundY = validation.groundY;

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

        // End turn after teleport
        this.phase = 'damage';
        this.scheduleDelayedAction(500, () => this.processDamage());
    }

    /**
     * Execute airstrike - missiles fall from sky
     */
    executeAirstrike(targetX, targetY, weapon) {
        const missileCount = weapon.missiles || 5;
        const spread = 150; // Total spread width
        const spacing = spread / (missileCount - 1);
        const startX = targetX - spread / 2;

        this.phase = 'projectile';

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
                proj.affectedByWind = false;
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
                    affectedByWind: false,
                    bounces: false
                });
                // Override rotation to point downward
                proj.rotation = Math.PI / 2;
            }

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

    /**
     * Handle Ninja Rope logic (Grapple Pull)
     */
    handleRopeHit(proj) {
        if (!proj.shooter) return;
        const player = proj.shooter;

        // Calculate vector to hit point
        const dx = proj.x - player.x;
        const dy = proj.y - player.y;
        const dist = Math.hypot(dx, dy);

        if (dist > 0) {
            // Pull player towards hook
            // Give a strong impulse
            const speed = 1200;
            player.vx = (dx / dist) * speed;
            player.vy = (dy / dist) * speed * 1.5; // Extra vertical boost
            player.onGround = false;

            // Audio
            // this.audioManager.playRope(); // If exists
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
        // Use seeded random for multiplayer sync, or regular random for practice
        const rand = this.seededRandom ? this.seededRandom() : Math.random();
        this.wind = (rand - 0.5) * 2; // -1 to 1
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
            // In multiplayer, show if it's your turn or opponent's turn
            if (!this.isPractice && this.networkManager) {
                const isMyTurn = this.isMyTurn();
                const turnText = isMyTurn ? 'Your Turn!' : 'Opponent\'s Turn';
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
        }

        if (value) {
            const windStrength = Math.round(Math.abs(this.wind) * 100);
            const direction = this.wind < 0 ? '←' : (this.wind > 0 ? '→' : '');
            value.textContent = direction + windStrength;
            value.style.color = this.wind < 0 ? '#2ecc71' : (this.wind > 0 ? '#e74c3c' : '#fff');
        }
    }

    updateTeamHealth() {
        for (let i = 0; i < this.teams.length; i++) {
            const team = this.teams[i];
            const totalHealth = team.getTotalHealth();
            const maxHealth = team.koalas.length * 100;
            const percent = (totalHealth / maxHealth) * 100;

            // Use cached elements
            const fillEl = i === 0 ? this.dom.elements.redHpFill : this.dom.elements.blueHpFill;
            const valueEl = i === 0 ? this.dom.elements.redHpValue : this.dom.elements.blueHpValue;

            if (fillEl) fillEl.style.width = percent + '%';
            if (valueEl) valueEl.textContent = totalHealth;
        }
    }

    /**
     * End the game
     */
    endGame(winningTeam) {
        this.isGameOver = true;
        this.phase = 'gameOver';

        // Play end game sound
        if (winningTeam) {
            this.audioManager.playVictory();
        } else {
            this.audioManager.playDefeat();
        }

        this.emit('gameOver', {
            winner: winningTeam,
            stats: this.calculateStats()
        });
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

                // Cache ammo element on the weapon element itself
                // This avoids querySelector on every update
                if (!el._cachedAmmoEl) {
                    el._cachedAmmoEl = el.querySelector('.ammo-count');
                }
                let ammoEl = el._cachedAmmoEl;

                if (weapon.ammo !== Infinity) {
                    // Finite ammo - create or update ammo element
                    if (!ammoEl) {
                        ammoEl = document.createElement('div');
                        ammoEl.className = 'ammo-count';
                        el.appendChild(ammoEl);
                        el._cachedAmmoEl = ammoEl; // Cache the new element
                    }

                    // Only update text if changed
                    const ammoStr = weapon.ammo.toString();
                    if (ammoEl.textContent !== ammoStr) {
                        ammoEl.textContent = ammoStr;
                    }

                    // Update disabled state (only toggle if needed)
                    const shouldBeDisabled = weapon.ammo <= 0;
                    if (shouldBeDisabled !== el.classList.contains('disabled')) {
                        el.classList.toggle('disabled', shouldBeDisabled);
                    }
                } else {
                    // Infinite ammo - remove ammo element if exists
                    if (ammoEl) {
                        ammoEl.remove();
                        el._cachedAmmoEl = null; // Clear cache
                    }
                    el.classList.remove('disabled');
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
     * Handle remote player firing a weapon
     */
    handleRemoteFire(data) {
        console.log('🎯 Remote fire:', data);

        // Security check: Ignore remote events if it's currently the local player's turn
        if (this.isMyTurn() && !this.isPractice) {
            console.warn('Blocked remote fire during local turn');
            return;
        }

        const koala = this.getCurrentKoala();
        if (!koala) return;

        // Set up the koala's state from remote data
        koala.x = data.x;
        koala.y = data.y;
        koala.aimAngle = data.angle;

        // Fire the weapon
        this.weaponManager.selectWeapon(data.weaponId);
        this.fireWeapon(data.angle, data.power);
    }

    /**
     * Handle remote player movement
     */
    handleRemoteMove(data) {
        if (this.isMyTurn() && !this.isPractice) return;
        const koala = this.getCurrentKoala();
        if (!koala) return;

        // Update koala position
        koala.x = data.x;
        koala.y = data.y;
        koala.facingLeft = data.facingLeft;
    }

    /**
     * Handle remote player aiming
     */
    handleRemoteAim(data) {
        if (this.isMyTurn() && !this.isPractice) return;
        const koala = this.getCurrentKoala();
        if (!koala) return;

        koala.aimAngle = data.angle;
    }

    /**
     * Handle remote targeted weapon (airstrike, teleport)
     */
    handleRemoteTargetWeapon(data) {
        console.log('🎯 Remote target weapon:', data);

        if (this.isMyTurn() && !this.isPractice) {
            console.warn('Blocked remote target weapon during local turn');
            return;
        }

        this.weaponManager.selectWeapon(data.weaponId);
        const weapon = this.weaponManager.currentWeapon;

        if (weapon) {
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

        // Sync team/koala index if provided
        if (data.nextTeam !== undefined) {
            this.currentTeamIndex = data.nextTeam;
        }
        if (data.nextKoala !== undefined) {
            this.currentKoalaIndex = data.nextKoala;
        }

        // Start the next turn
        this.startTurn();
    }

    /**
     * Handle full state sync from remote player
     */
    handleRemoteStateSync(data) {
        console.log('🔄 Remote state sync:', data);

        if (this.isMyTurn() && !this.isPractice) {
            console.warn('Blocked remote state sync during local turn');
            return;
        }

        const state = data.state;
        if (!state) return;

        // Sync turn manager state
        this.currentTeamIndex = state.currentTeamIndex;
        this.currentKoalaIndex = state.currentKoalaIndex;
        this.turnTimer = state.turnTimer;
        this.phase = state.phase;
        this.wind = state.wind;

        // Sync all koalas
        if (state.teams) {
            state.teams.forEach(teamData => {
                teamData.koalas.forEach(koalaData => {
                    const koala = this.findKoalaByName(koalaData.name);
                    if (koala) {
                        koala.x = koalaData.x;
                        koala.y = koalaData.y;
                        koala.vx = koalaData.vx;
                        koala.vy = koalaData.vy;
                        koala.health = koalaData.health;

                        if (koalaData.isAlive !== koala.isAlive) {
                            if (koalaData.isAlive) {
                                // Resurrect? (unlikely in normal gameplay but good for sync)
                                koala.isAlive = true;
                            } else {
                                koala.die();
                            }
                        }
                    }
                });
            });
        }

        // Add visual indicator of sync
        if (this.turnManager) {
            this.updateTurnIndicator();
        }
    }

    /**
     * Send full state sync to network
     */
    sendFullStateSync() {
        if (!this.networkManager || this.isPractice) return;

        const state = {
            currentTeamIndex: this.currentTeamIndex,
            currentKoalaIndex: this.currentKoalaIndex,
            turnTimer: this.turnTimer,
            phase: this.phase,
            wind: this.wind,
            teams: this.teams.map(team => ({
                color: team.color,
                koalas: team.koalas.map(k => ({
                    name: k.name,
                    x: k.x,
                    y: k.y,
                    vx: k.vx,
                    vy: k.vy,
                    health: k.health,
                    isAlive: k.isAlive
                }))
            }))
        };

        this.networkManager.send({
            type: 'stateSync',
            state: state,
            timestamp: Date.now()
        });
    }

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
     * Send authoritative full state sync to peers
     */
    sendFullStateSync() {
        if (!this.networkManager || this.isPractice) return;

        console.log('🔄 Sending full state sync');

        const stateData = {
            type: 'stateSync',
            phase: this.phase,
            currentTeamIndex: this.currentTeamIndex,
            currentKoalaIndex: this.currentKoalaIndex,
            wind: this.wind,
            koalas: []
        };

        // Serialize all koalas
        for (const team of this.teams) {
            for (const koala of team.koalas) {
                stateData.koalas.push({
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

        this.networkManager.send(stateData);
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
        if (this.isMyTurn() && !this.isPractice) return;
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
        if (this.isMyTurn() && !this.isPractice) return;
        const koala = this.getCurrentKoala();
        if (koala) {
            koala.x = data.x;
            koala.y = data.y;
            koala.vx = data.vx;
            koala.vy = data.vy;
            koala.facingLeft = data.facingLeft;
            koala.onGround = false;
            koala.isBackflipping = true;
            koala.backflipRotation = 0;
        }
    }

    /**
     * Handle full state sync from the authoritative client
     * This is used to correct any drift between clients
     */
    handleRemoteStateSync(data) {
        console.log('🔄 Remote state sync');

        // Sync all koala positions
        if (data.koalas) {
            for (const koalaData of data.koalas) {
                const koala = this.findKoalaByName(koalaData.name);
                if (koala) {
                    koala.x = koalaData.x;
                    koala.y = koalaData.y;
                    koala.vx = koalaData.vx || 0;
                    koala.vy = koalaData.vy || 0;
                    koala.health = koalaData.health;
                    koala.isAlive = koalaData.isAlive;
                    koala.onGround = koalaData.onGround;
                }
            }
        }

        // IMPORTANT: Only sync team/koala index during aiming phase to prevent
        // the double-turn bug where stateSync overwrites the current turn owner
        // during projectile/retreat/damage phases
        const safeToSyncTurn = this.phase === 'aiming';

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

        this.updateTeamHealth();
        this.updateTurnIndicator();
    }
}
