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
import { AudioManager } from './AudioManager.js';

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
        this.audioManager = new AudioManager();

        // Game state
        this.teams = [];
        this.projectiles = [];
        this.particles = [];
        this.currentTeamIndex = 0;
        this.currentKoalaIndex = 0;
        this.turnTime = 30;
        this.turnTimer = this.turnTime;
        this.wind = 0; // -1 to 1

        // Game phases
        this.phase = 'waiting'; // waiting, aiming, firing, projectile, retreat, damage, nextTurn
        this.isPaused = false;
        this.isGameOver = false;

        // Retreat time settings
        this.retreatTime = 5; // 5 seconds to retreat after firing
        this.retreatTimer = 0;

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

        // Powerups
        this.powerups = [];
        this.powerupSpawnTimer = 300; // 5 minutes in seconds
        this.maxPowerupsOnMap = 2;
    }

    /**
     * Start the game
     */
    async start() {
        // Initialize audio (requires user interaction)
        this.audioManager.init();

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
            // Generate terrain procedurally
            this.terrain.generate();
        }

        // Create teams
        this.createTeams();

        // Randomize wind
        this.randomizeWind();

        // Start first turn
        this.startTurn();

        // Start game loop
        this.lastTime = performance.now();
        this.gameLoop();

        console.log('🎮 Game started!');
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

        this.updateTeamHealth();
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

        // Check if marker position has valid ground nearby
        const isValidSpawn = this.isValidSpawnPoint(x, y);

        if (isValidSpawn) {
            // Marker is in a valid spot - use it directly
            // (or apply small jitter if reusing same marker)
            if (addJitter) {
                x += (Math.random() - 0.5) * 50;
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
        // 1. Get ALL potentially valid spawn points from the terrain engine
        // This scans the entire map once per game start
        if (!this.validSpawnPoints || this.validSpawnPoints.length === 0) {
            this.validSpawnPoints = this.terrain.getAllSpawnPoints();
        }

        // If the map is completely empty or the scan failed, use a safety fallback
        if (!this.validSpawnPoints || this.validSpawnPoints.length === 0) {
            console.warn('⚠️ No spawn points found via scan, using safety fallback');
            return { x: 100 + Math.random() * (this.worldWidth - 200), y: 100 };
        }

        // 2. Use all valid points found in the scan
        const safePoints = this.validSpawnPoints;

        // 3. Shuffle the points for random selection
        const shuffledPoints = [...(safePoints.length > 0 ? safePoints : this.validSpawnPoints)]
            .sort(() => Math.random() - 0.5);

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

        // 6. Hard fallback: Just pick any valid point from the list at random
        const randomPoint = shuffledPoints[Math.floor(Math.random() * shuffledPoints.length)];
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

        const deltaTime = (currentTime - this.lastTime) / 1000;
        this.lastTime = currentTime;

        // Performance debugging
        if (window.debugPerformance) {
            const frameStart = performance.now();
            let updateTime = 0, renderTime = 0;

            if (!this.isPaused) {
                const t0 = performance.now();
                this.update(deltaTime);
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
                this.update(deltaTime);
            }
            this.render();
        }

        this.animationId = requestAnimationFrame((t) => this.gameLoop(t));
    }

    /**
     * Update game state
     */
    update(dt) {
        // Cap delta time to prevent physics issues
        dt = Math.min(dt, 0.05);

        // Detailed profiling when debugging
        const profile = window.debugPerformance && window.debugPerformanceDetail;
        let t0, t1;

        switch (this.phase) {
            case 'aiming':
                this.updateTurnTimer(dt);
                this.updateAiming(dt);
                break;
            case 'firing':
                this.updateTurnTimer(dt);
                this.updateFiring(dt);
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

        // Update particles
        if (profile) t0 = performance.now();
        this.updateParticles(dt);
        if (profile) { t1 = performance.now(); if (t1 - t0 > 2) console.log(`  ✨ Particles: ${(t1 - t0).toFixed(1)}ms`); }

        // Update powerups and collection
        if (profile) t0 = performance.now();
        this.updatePowerups(dt);
        if (profile) { t1 = performance.now(); if (t1 - t0 > 2) console.log(`  🎁 Powerups: ${(t1 - t0).toFixed(1)}ms`); }

        // Update koala animations (backflip etc) and state
        this.updateKoalaAnimations(dt);

        // Update individual koalas (timers, etc)
        this.teams.forEach(team => {
            team.koalas.forEach(koala => {
                if (koala.isAlive) koala.update(dt);
            });
        });

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

        // Check for targets (koalas)
        for (const team of this.teams) {
            for (const target of team.koalas) {
                if (!target.isAlive || target === shooter) continue;

                const dist = Math.hypot(target.x - hitX, target.y - hitY);
                if (dist < weapon.range + 10) {
                    // HIT!
                    target.takeDamage(weapon.damage);
                    this.audioManager.playDamage();

                    // Massive knockback in the direction of the swing
                    const knockbackX = Math.cos(angle) * weapon.knockback;
                    const knockbackY = Math.sin(angle) * weapon.knockback;

                    target.vx += knockbackX;
                    target.vy += knockbackY;
                    target.onGround = false;

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
                        this.createExplosion(obj.x, obj.y, 60);
                        this.terrain.createCrater(obj.x, obj.y, 60);
                        this.terrain.mapObjects.splice(i, 1);
                        this.audioManager.playExplosion('medium');
                    } else {
                        // Just create particles
                        this.createExplosionParticles(obj.x, obj.y, 5, '#ccc');
                    }
                }
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
        this.turnTimer -= dt;

        // Update timer display
        const timerEl = document.getElementById('turn-timer');
        if (timerEl) {
            const seconds = Math.max(0, Math.ceil(this.turnTimer));
            timerEl.textContent = seconds;

            // Flash red when low
            if (seconds <= 5) {
                timerEl.classList.add('low-time');
            } else {
                timerEl.classList.remove('low-time');
            }
        }

        // Timer warning sound (last 5 seconds, once per second)
        if (this.turnTimer <= 5 && this.turnTimer > 0 && !this.isPractice) {
            const prevSec = Math.ceil(prevTimer);
            const currSec = Math.ceil(this.turnTimer);
            if (prevSec !== currSec) {
                this.audioManager.playTimerTick();
            }
        }

        // Time ran out - force end turn
        if (this.turnTimer <= 0) {
            this.turnTimer = 0;
            this.phase = 'damage';
            setTimeout(() => this.processDamage(), 500);
        }
    }

    /**
     * Start retreat phase after firing
     */
    startRetreat() {
        this.phase = 'retreat';
        this.retreatTimer = this.retreatTime;

        // Update UI to show retreat timer
        const timerEl = document.getElementById('turn-timer');
        if (timerEl) {
            timerEl.classList.add('retreat-mode');
        }

        // Show retreat indicator
        const turnIndicator = document.getElementById('turn-indicator');
        if (turnIndicator) {
            turnIndicator.innerHTML = '<span class="retreat-label">RETREAT!</span>';
        }
    }

    /**
     * Update during retreat phase
     */
    updateRetreat(dt) {
        this.retreatTimer -= dt;

        // Allow walking during retreat
        const koala = this.getCurrentKoala();
        if (koala) {
            this.inputManager.updateAiming(koala, dt);
        }

        // Update timer display
        const timerEl = document.getElementById('turn-timer');
        if (timerEl) {
            const seconds = Math.max(0, Math.ceil(this.retreatTimer));
            timerEl.textContent = seconds;
        }

        // Retreat time over
        if (this.retreatTimer <= 0) {
            this.retreatTimer = 0;

            // Remove retreat UI classes
            const timerEl = document.getElementById('turn-timer');
            if (timerEl) {
                timerEl.classList.remove('retreat-mode');
            }

            this.phase = 'damage';
            setTimeout(() => this.processDamage(), 500);
        }
    }

    /**
     * Remove a projectile and mark it as destroyed (for camera tracking)
     */
    removeProjectile(index) {
        const proj = this.projectiles[index];
        if (proj) {
            proj.destroyed = true;
        }
        this.projectiles.splice(index, 1);
    }

    /**
     * Update projectiles
     */
    updateProjectiles(dt) {
        // Handle turn phase transition
        if (this.phase === 'projectile') {
            const isBlocking = p => !p.stationary || (p.timer !== null && p.timerStarted) || p.isTriggered;
            const blockingProjectiles = this.projectiles.filter(isBlocking);

            if (blockingProjectiles.length === 0) {
                this.startRetreat();
                return;
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
            }

            // Update timer and check for timer-based explosion
            const shouldExplode = proj.update(dt, this.wind);

            // Check mine proximity
            if (proj.triggeredByProximity && proj.stationary && !proj.isTriggered) {
                const target = this.findNearbyKoala(proj.x, proj.y, 65);
                if (target) {
                    proj.isTriggered = true;
                    this.audioManager.playTimerTick(); // Beep!
                    console.log('Mine triggered by', target.name);
                }
            }

            if (shouldExplode) {
                this.handleProjectileImpact(proj);
                this.removeProjectile(i);
                continue;
            }

            // If stationary, no need for collision detection
            if (proj.stationary) continue;

            // Ray-casting collision detection to prevent tunneling
            // Check multiple points along the path from previous to current position
            const dx = proj.x - prevX;
            const dy = proj.y - prevY;
            const distance = Math.hypot(dx, dy);
            const steps = Math.max(1, Math.ceil(distance / 4)); // Check every 4 pixels for better precision

            let hitTerrain = false;
            let hitX = proj.x;
            let hitY = proj.y;

            for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                const checkX = prevX + dx * t;
                const checkY = prevY + dy * t;

                // First check: direct collision (point is inside terrain)
                if (this.terrain.checkCollision(checkX, checkY)) {
                    hitTerrain = true;
                    hitX = checkX;
                    hitY = checkY;
                    break;
                }

                // Second check removed: This caused floating islands to block everything below them.
                // We rely on the pixel-perfect raycasting above.
            }

            if (hitTerrain) {
                // Set projectile position to impact point
                proj.x = hitX;
                proj.y = hitY;

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
                } else {
                    // Non-bouncing, non-timer weapons explode on impact
                    this.handleProjectileImpact(proj);
                    this.removeProjectile(i);
                }
                continue;
            }

            // Check out of bounds
            if (proj.x < -100 || proj.x > this.worldWidth + 100 ||
                proj.y > this.worldHeight + 100) {
                this.removeProjectile(i);
                continue;
            }

            // Check koala collision with ray-casting too
            let hitKoala = null;
            let hitKoalaX = proj.x;
            let hitKoalaY = proj.y;

            for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                const checkX = prevX + dx * t;
                const checkY = prevY + dy * t;

                for (const team of this.teams) {
                    for (const koala of team.koalas) {
                        // Skip the shooter
                        if (koala === proj.shooter) continue;

                        if (koala.isAlive) {
                            const dist = Math.hypot(checkX - koala.x, checkY - koala.y);
                            if (dist < 20) { // Collision radius
                                hitKoala = koala;
                                hitKoalaX = checkX;
                                hitKoalaY = checkY;
                                break;
                            }
                        }
                    }
                    if (hitKoala) break;
                }
                if (hitKoala) break;
            }

            if (hitKoala) {
                proj.x = hitKoalaX;
                proj.y = hitKoalaY;
                this.handleProjectileImpact(proj, hitKoala);
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

        // Create explosion
        if (weapon.explosionRadius > 0) {
            // Play explosion sound based on size
            const size = weapon.explosionRadius > 60 ? 'large' : weapon.explosionRadius < 30 ? 'small' : 'medium';
            this.audioManager.playExplosion(size);

            this.createExplosion(projectile.x, projectile.y, weapon.explosionRadius);

            // Damage terrain
            this.terrain.createCrater(projectile.x, projectile.y, weapon.explosionRadius);

            // Damage koalas in radius
            for (const team of this.teams) {
                for (const koala of team.koalas) {
                    if (!koala.isAlive) continue;

                    const dist = Math.hypot(koala.x - projectile.x, koala.y - projectile.y);
                    if (dist < weapon.explosionRadius) {
                        const damage = Math.round(weapon.damage * (1 - dist / weapon.explosionRadius));
                        const knockback = weapon.knockback * (1 - dist / weapon.explosionRadius);

                        koala.takeDamage(damage);

                        // Play damage sound
                        if (damage > 0) {
                            this.audioManager.playDamage();
                        }

                        // Apply knockback
                        const angle = Math.atan2(koala.y - projectile.y, koala.x - projectile.x);
                        koala.vx += Math.cos(angle) * knockback;
                        koala.vy += Math.sin(angle) * knockback;
                    }
                }
            }
        }

        // Direct hit bonus
        if (directHitKoala) {
            directHitKoala.takeDamage(weapon.directDamage || weapon.damage);
        }

        // Create particles
        this.createExplosionParticles(projectile.x, projectile.y, weapon.explosionRadius);
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
    createExplosionParticles(x, y, radius) {
        const count = Math.floor(radius / 2);
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 50 + Math.random() * 150;
            this.particles.push({
                type: 'debris',
                x, y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 50,
                size: 2 + Math.random() * 4,
                color: Math.random() > 0.5 ? '#654321' : '#8B4513',
                lifetime: 1 + Math.random(),
                time: 0
            });
        }
    }

    /**
     * Update particles
     */
    updateParticles(dt) {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.time += dt;

            if (p.time >= p.lifetime) {
                this.particles.splice(i, 1);
                continue;
            }

            if (p.type === 'debris') {
                p.vy += 400 * dt; // gravity
                p.x += p.vx * dt;
                p.y += p.vy * dt;
            } else if (p.type === 'explosion') {
                p.alpha = 1 - (p.time / p.lifetime);
            }
        }
    }

    /**
     * Process damage phase
     */
    processDamage() {
        // Check for deaths
        let anyDied = false;
        for (const team of this.teams) {
            for (const koala of team.koalas) {
                if (koala.health <= 0 && koala.isAlive) {
                    koala.die();
                    this.audioManager.playDeath();
                    anyDied = true;
                }
            }
        }

        this.updateTeamHealth();

        // Check win condition
        const aliveTeams = this.teams.filter(t => t.isAlive());
        if (aliveTeams.length <= 1) {
            this.endGame(aliveTeams[0] || null);
            return;
        }

        // Apply fall damage and wait for physics to settle
        setTimeout(() => {
            this.applyFallDamage();
            this.nextTurn();
        }, anyDied ? 1000 : 300);
    }

    /**
     * Apply fall damage to koalas that fell
     */
    applyFallDamage() {
        for (const team of this.teams) {
            for (const koala of team.koalas) {
                if (koala.isAlive && koala.fallDistance > 50) {
                    const damage = Math.floor((koala.fallDistance - 50) / 5);
                    koala.takeDamage(damage);
                    koala.fallDistance = 0;
                }

                // Check if fell in water
                if (koala.isAlive && koala.y > this.worldHeight - 50) {
                    koala.die();
                }
            }
        }
        this.updateTeamHealth();
    }

    /**
     * Start a new turn
     */
    startTurn() {
        this.phase = 'aiming';
        this.turnTimer = this.turnTime;
        this.randomizeWind();

        // Update timer display
        const timerEl = document.getElementById('turn-timer');
        if (timerEl) {
            timerEl.textContent = Math.ceil(this.turnTimer);
            timerEl.classList.remove('low-time', 'retreat-mode');
        }

        // Play turn start sound
        this.audioManager.playTurnStart();

        // Switch to current team's inventory
        const team = this.teams[this.currentTeamIndex];
        if (team && team.weapons) {
            // Swap inventory
            this.weaponManager.weapons = team.weapons;

            // Select the team's last used weapon, or default to bazooka
            const lastWeaponId = team.lastSelectedWeapon || 'bazooka';
            if (team.weapons[lastWeaponId] && team.weapons[lastWeaponId].ammo > 0) {
                this.weaponManager.selectWeapon(lastWeaponId);
            } else {
                this.weaponManager.selectWeapon('bazooka');
            }
        }

        // Find next alive koala
        this.selectNextKoala();

        const koala = this.getCurrentKoala();
        if (koala) {
            // Center camera on current koala
            this.camera.targetX = koala.x - this.canvas.width / 2;
            this.camera.targetY = koala.y - this.canvas.height / 2;

            // Update UI
            this.updateTurnIndicator();
            this.updateWeaponUI();
        }
    }

    /**
     * Select next koala for turn
     */
    selectNextKoala() {
        const team = this.teams[this.currentTeamIndex];

        // Find next alive koala on current team, starting from the team's saved index
        let found = false;
        for (let i = 0; i < team.koalas.length; i++) {
            const idx = (team.currentKoalaIndex + i) % team.koalas.length;
            if (team.koalas[idx].isAlive) {
                this.currentKoalaIndex = idx;
                team.currentKoalaIndex = idx; // Update team's index to the one we found
                found = true;
                break;
            }
        }

        if (!found) {
            // Team has no alive koalas (should be handled by nextTeam, but safety first)
            this.nextTeam();
        }
    }

    /**
     * Move to next team
     */
    nextTeam() {
        // 1. Increment the koala index for the team that JUST finished their turn
        // so that next time it's their turn, they pick the next teammate
        const finishedTeam = this.teams[this.currentTeamIndex];
        if (finishedTeam) {
            finishedTeam.currentKoalaIndex = (this.currentKoalaIndex + 1) % finishedTeam.koalas.length;
        }

        // 2. Cycle to the next alive team
        const startTeam = this.currentTeamIndex;
        do {
            this.currentTeamIndex = (this.currentTeamIndex + 1) % this.teams.length;
        } while (!this.teams[this.currentTeamIndex].isAlive() &&
            this.currentTeamIndex !== startTeam);

        // 3. Set the game's active index to the new team's next-in-line
        this.currentKoalaIndex = this.teams[this.currentTeamIndex].currentKoalaIndex;
    }

    /**
     * End current turn
     */
    endTurn() {
        this.phase = 'damage';
        this.processDamage();
    }

    /**
     * Move to next turn
     */
    nextTurn() {
        this.nextTeam();
        this.selectNextKoala();
        this.startTurn();
    }

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
            setTimeout(() => {
                if (this.projectiles.length === 0) {
                    this.startRetreat();
                }
            }, 500);

            // Decrement ammo
            if (weapon.ammo !== Infinity) {
                weapon.ammo--;
            }
            return;
        }

        this.phase = 'projectile';

        // Decrement ammo
        if (weapon.ammo !== Infinity) {
            weapon.ammo--;
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

        // Follow projectile with camera
        this.followProjectile(projectile);

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
        this.camera.targetX = targetX - this.canvas.width / 2;
        this.camera.targetY = dropY - this.canvas.height / 2;

        // End turn after teleport
        this.phase = 'damage';
        setTimeout(() => this.processDamage(), 500);
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

            // Create a proper Projectile instance
            const proj = new Projectile({
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

            this.projectiles.push(proj);

            // Play a sound for each missile
            this.audioManager.playMissileDrop();
        };

        // Create first missile immediately so phase doesn't revert
        spawnMissile(0);

        // Schedule remaining missiles
        for (let i = 1; i < missileCount; i++) {
            // Stagger the missiles slightly
            setTimeout(() => {
                // Only spawn if game is still active
                if (!this.isGameOver) {
                    spawnMissile(i);
                    // Ensure phase stays as projectile while missiles are still falling
                    if (this.phase !== 'projectile') {
                        this.phase = 'projectile';
                    }
                }
            }, i * 200); // 200ms spacing for better effect
        }

        // Move camera to target area (center on impact point)
        this.camera.targetX = targetX - this.canvas.width / 2;
        this.camera.targetY = targetY - this.canvas.height / 2;
    }

    /**
     * Create teleport visual effect
     */
    createTeleportEffect(x, y) {
        // ... handled by particle system mostly, but could add here
        for (let i = 0; i < 10; i++) {
            this.particles.push({
                type: 'smoke',
                x: x,
                y: y,
                vx: (Math.random() - 0.5) * 100,
                vy: (Math.random() - 0.5) * 100,
                life: 1,
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
     * Randomize wind
     */
    randomizeWind() {
        this.wind = (Math.random() - 0.5) * 2; // -1 to 1
        this.updateWindDisplay();
    }

    /**
     * Update camera position
     */
    updateCamera(dt) {
        // Follow projectile if tracking one (O(1) check using destroyed flag)
        if (this.followingProjectile && !this.followingProjectile.destroyed) {
            this.camera.targetX = this.followingProjectile.x - this.canvas.width / 2;
            this.camera.targetY = this.followingProjectile.y - this.canvas.height / 2;
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
     * Find nearest koala within range
     */
    findNearbyKoala(x, y, radius) {
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
        const el = document.getElementById('current-team');
        if (el && team) {
            el.textContent = team.name;
            el.style.color = team.color;
        }
    }

    updateTimerDisplay() {
        const el = document.getElementById('turn-timer');
        if (el) {
            el.textContent = Math.ceil(this.turnTimer);
            el.style.color = this.turnTimer < 10 ? '#e74c3c' : '#f1c40f';
        }
    }

    updateWindDisplay() {
        const arrow = document.getElementById('wind-arrow');
        if (arrow) {
            const width = Math.abs(this.wind) * 50;
            const offset = this.wind > 0 ? 0 : -width;
            arrow.style.width = width + '%';
            arrow.style.marginLeft = (50 + offset) + '%';
            arrow.style.background = this.wind > 0
                ? 'linear-gradient(90deg, transparent, #3498db)'
                : 'linear-gradient(270deg, transparent, #3498db)';
        }
    }

    updateTeamHealth() {
        for (let i = 0; i < this.teams.length; i++) {
            const team = this.teams[i];
            const totalHealth = team.getTotalHealth();
            const maxHealth = team.koalas.length * 100;
            const percent = (totalHealth / maxHealth) * 100;

            const fillId = i === 0 ? 'red-hp-fill' : 'blue-hp-fill';
            const valueId = i === 0 ? 'red-hp-value' : 'blue-hp-value';

            const fillEl = document.getElementById(fillId);
            const valueEl = document.getElementById(valueId);

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
     * Update weapon UI (ammo counts) - Optimized to minimize DOM operations
     */
    updateWeaponUI() {
        const weaponEls = document.querySelectorAll('.weapon');
        const currentWeaponId = this.weaponManager.currentWeapon?.id;

        weaponEls.forEach(el => {
            const weaponId = el.dataset.weapon;
            const weapon = this.weaponManager.getWeapon(weaponId);

            if (weapon) {
                // Update selected state (only toggle if needed)
                const isSelected = weaponId === currentWeaponId;
                if (isSelected !== el.classList.contains('selected')) {
                    el.classList.toggle('selected', isSelected);
                }

                // Handle ammo count element
                let ammoEl = el.querySelector('.ammo-count');

                if (weapon.ammo !== Infinity) {
                    // Finite ammo - create or update ammo element
                    if (!ammoEl) {
                        ammoEl = document.createElement('div');
                        ammoEl.className = 'ammo-count';
                        el.appendChild(ammoEl);
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
                    }
                    el.classList.remove('disabled');
                }
            }
        });
    }

    /**
     * Update powerups (spawning and collection)
     */
    updatePowerups(dt) {
        // Handle spawning timer
        this.powerupSpawnTimer -= dt;
        if (this.powerupSpawnTimer <= 0) {
            this.powerupSpawnTimer = 300; // Reset to 5 mins
            if (this.powerups.length < this.maxPowerupsOnMap) {
                this.spawnPowerup();
            }
        }

        // Check for collection
        for (let i = this.powerups.length - 1; i >= 0; i--) {
            const powerup = this.powerups[i];

            for (const team of this.teams) {
                for (const koala of team.koalas) {
                    if (!koala.isAlive) continue;

                    const dx = koala.x - powerup.x;
                    const dy = koala.y - powerup.y;
                    const dist = Math.hypot(dx, dy);

                    if (dist < 25) { // Collection radius
                        // Heal koala
                        const healAmount = 25;
                        koala.health = Math.min(100, koala.health + healAmount);

                        // Visual effects
                        this.createExplosionParticles(powerup.x, powerup.y, 10, '#2ecc71');

                        // Play a heal sound (using turn start as placeholder or damage?)
                        // Let's use gain chime if available
                        this.audioManager.playTurnStart();

                        // Remove powerup
                        this.powerups.splice(i, 1);

                        this.updateTeamHealth();
                        console.log(koala.name, 'picked up health!');
                        return; // Exit both loops for this powerup
                    }
                }
            }
        }
    }

    /**
     * Spawn a health powerup on the map
     */
    spawnPowerup() {
        // Try to find a valid spot
        for (let attempt = 0; attempt < 100; attempt++) {
            const x = 200 + Math.random() * (this.worldWidth - 400);
            const surfaces = this.terrain.getVisualGroundY(x);

            if (surfaces.length > 0) {
                // Pick a random surface
                const y = surfaces[Math.floor(Math.random() * surfaces.length)];

                // Add the powerup
                this.powerups.push({
                    x,
                    y: y - 10, // Slightly above visual ground
                    type: 'health',
                    id: 'powerup_' + Date.now()
                });

                console.log('Health powerup spawned at:', x, y);
                return true;
            }
        }
        return false;
    }

    /**
     * Reset game for rematch
     */
    reset() {
        console.log('Resetting game...');

        // Stop current game loop
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }

        // Reset game state
        this.teams = [];
        this.projectiles = [];
        this.particles = [];
        this.currentTeamIndex = 0;
        this.currentKoalaIndex = 0;
        this.isGameOver = false;
        this.isPaused = false;
        this.phase = 'waiting';
        this.turnTimer = this.turnTime;

        // Regenerate terrain
        this.terrain.generate();

        // Create new teams
        this.createTeams();

        // Reset wind
        this.randomizeWind();

        // Reset weapon manager
        // Reset weapon manager
        this.weaponManager.reset();
        this.updateWeaponUI();

        // Reset input manager state
        this.inputManager.isCharging = false;

        // Start first turn
        this.startTurn();

        // Restart game loop
        this.lastTime = performance.now();
        this.gameLoop();

        console.log('Game reset complete!');
    }

    /**
     * Destroy game instance
     */
    destroy() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
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
        const koala = this.getCurrentKoala();
        if (!koala) return;

        koala.aimAngle = data.angle;
    }

    /**
     * Handle remote targeted weapon (airstrike, teleport)
     */
    handleRemoteTargetWeapon(data) {
        console.log('🎯 Remote target weapon:', data);

        this.weaponManager.selectWeapon(data.weaponId);
        const weapon = this.weaponManager.currentWeapon;

        if (weapon) {
            this.fireTargettedWeapon(weapon, data.targetX, data.targetY);
        }
    }

    /**
     * Handle remote turn end signal
     */
    handleRemoteTurnEnd(data) {
        console.log('🔄 Remote turn end:', data);

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
}
