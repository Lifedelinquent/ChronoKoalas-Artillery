/**
 * SpawnSystem - Team creation and koala spawn placement.
 *
 * Installed onto Game.prototype (see the bottom of Game.js), so every
 * method runs with `this` bound to the Game instance.
 */

import { Koala } from '../../entities/Koala.js';
import { Team } from '../../entities/Team.js';
import { AIController } from '../../ai/AIController.js';
import { log } from '../../utils/Logger.js';
import { sanitizeStyle } from '../../utils/TeamStyles.js';
import { TEAM_COLORS, TEAM_COLOR_LABELS } from '../../utils/TeamColors.js';

export const SpawnSystem = {
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
        // Single player passes an explicit teamsConfig (human + CPU squads).
        // Practice keeps the classic red-vs-blue setup.
        const players = this.options.initialState?.players;
        const spTeams = this.options.teamsConfig;
        let teamConfigs;
        // Team customisation (name, koala names, hat, grave, voice, dance)
        // rides along as `style` — cosmetic, see utils/TeamStyles.js
        if (Array.isArray(spTeams) && spTeams.length >= 2) {
            teamConfigs = spTeams.map(c => {
                const style = sanitizeStyle(c.style);
                return {
                    name: style?.name || c.name || `${TEAM_COLOR_LABELS[c.color] || c.color} Team`,
                    color: TEAM_COLORS[c.color] || c.color,
                    alliance: c.alliance || c.color,
                    koalaCount: c.koalaCount || koalaCount,
                    isCPU: !!c.isCPU,
                    difficulty: c.difficulty ?? 0,
                    health: c.health,
                    style
                };
            });
        } else if (Array.isArray(players) && players.length >= 2) {
            teamConfigs = players.map(p => {
                const style = sanitizeStyle(p.style);
                return {
                    name: style?.name || p.name || `${TEAM_COLOR_LABELS[p.color] || p.color} Team`,
                    color: TEAM_COLORS[p.color] || p.color,
                    alliance: p.color,
                    koalaCount,
                    style
                };
            });
        } else {
            const styles = (this.options.teamStyles || []).map(sanitizeStyle);
            teamConfigs = [
                { name: styles[0]?.name || 'Red Team', color: '#e74c3c', alliance: 'red', koalaCount, style: styles[0] || null },
                { name: styles[1]?.name || 'Blue Team', color: '#3498db', alliance: 'blue', koalaCount, style: styles[1] || null }
            ];
        }

        // Koala names identify koalas in network messages: keep them unique
        const usedNames = new Set();
        const uniqueName = (name) => {
            let candidate = name;
            for (let n = 2; usedNames.has(candidate); n++) candidate = `${name} ${n}`;
            usedNames.add(candidate);
            return candidate;
        };

        // STEP 1: Pre-scan the entire map for valid spawn points
        // This must happen AFTER the map is loaded (which it is, since start() awaits loadCustomMap)
        log.debug('🗺️ Scanning map for valid spawn points...');
        this.validSpawnPoints = this.terrain.getAllSpawnPoints(this.getSpawnScanBounds());
        log.debug(`✅ Found ${this.validSpawnPoints.length} valid spawn points on map`);

        // Track all spawned positions to avoid overlap
        const spawnedPositions = [];
        const minSpawnDistance = this.options.customMap ? 80 : 150;

        // Get custom spawn markers from the map editor (if any)
        const customSpawns = this.options.customMap?.spawns || null;
        const hasCustomSpawns = customSpawns &&
            ((customSpawns.team1 && customSpawns.team1.length > 0) ||
                (customSpawns.team2 && customSpawns.team2.length > 0));

        log.debug('🎯 Custom spawn markers:', hasCustomSpawns ? JSON.stringify(customSpawns) : 'None');

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
        log.debug('⚔️ Team spawn bands →', teamConfigs.map((c, i) =>
            `${c.name}: ${Math.round(teamBands[i].minX)}-${Math.round(teamBands[i].maxX)}`).join(', '));

        teamConfigs.forEach((config, teamIndex) => {
            const team = new Team(config.name, config.color, config.alliance);
            // CPU-controlled squad (single player): flag drives isMyTurn()
            // input gating and the AIController's turn handling
            team.isCPU = !!config.isCPU;
            team.style = config.style || null;
            team.aiDifficulty = config.difficulty ?? 0;
            // Custom-map spawn markers only define two groups; teams beyond
            // the second fall back to random band spawning (empty marker list)
            const teamKey = teamIndex === 0 ? 'team1' : (teamIndex === 1 ? 'team2' : null);

            // Get spawn markers for this team (if any)
            const teamMarkers = (teamKey && customSpawns?.[teamKey]) || [];
            log.debug(`📍 ${config.name}: ${teamMarkers.length} spawn marker(s)`);

            // Place koalas on terrain
            for (let i = 0; i < config.koalaCount; i++) {
                let pos = null;

                // PRIORITY 1: Try spawn marker (if available)
                if (teamMarkers.length > 0) {
                    // Cycle through markers if fewer than koalas
                    const markerIndex = i % teamMarkers.length;
                    const marker = teamMarkers[markerIndex];

                    pos = this.resolveSpawnPosition(marker, spawnedPositions, i >= teamMarkers.length);
                    log.debug(`🐨 ${config.name} Koala ${i + 1}: Using marker #${markerIndex + 1} → (${pos.x}, ${pos.y})`);
                }
                // PRIORITY 2: No markers - use random valid spawn
                else {
                    pos = this.findRandomSpawnPosition(spawnedPositions, minSpawnDistance, {
                        band: teamBands[teamIndex]
                    });
                    log.debug(`🐨 ${config.name} Koala ${i + 1}: Random spawn → (${pos?.x}, ${pos?.y})`);
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
                            log.debug(`   ⚠️ Spawn over gap/water at (${pos.x}, ${pos.y}), relocating to (${nearest.x}, ${nearest.y})`);
                            pos.x = nearest.x;
                            pos.y = nearest.y;
                            groundY = this.terrain.getGroundBelow(pos.x, pos.y);
                        }
                    }

                    if (groundY < waterLevel) {
                        log.debug(`   ✨ Snapping Koala to ground: ${pos.y} -> ${groundY - 15}`);
                        pos.y = groundY - 15; // Place feet on ground (-15 is half height)
                    }

                    spawnedPositions.push(pos);
                    const koala = new Koala(pos.x, pos.y, team);
                    koala.name = uniqueName(config.style?.koalaNames?.[i] || this.getKoalaName(teamIndex, i));

                    // Match statistics observe every hit and death
                    koala.onDamaged = (k, amount) => this.stats?.onDamage(k, amount);
                    koala.onDied = (k) => this.stats?.onDeath(k);

                    // Scheme-defined starting health (single-player team
                    // configs may override it, e.g. 1 HP training targets)
                    const startHp = config.health || this.scheme.startingHealth;
                    koala.maxHealth = startHp;
                    koala.health = startHp;

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

        // Spin up (or drop) the CPU brain depending on this match's teams —
        // recreated fresh on every start/reset so no turn state leaks over
        this.aiController = this.teams.some(t => t.isCPU) ? new AIController(this) : null;

        this.buildTeamHealthUI();
        this.updateTeamHealth();
    },

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

        log.debug(`📏 Spawn scan: topY=${rawTopY} + margin=${topMargin} → effective=${adjustedTopY}, waterLevel=${waterLevel}`);

        return {
            topY: adjustedTopY,
            waterLevel,
        };
    },

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
            log.debug(`   ⚠️ Marker (${x}, ${y}) is above spawn ceiling (${spawnBounds.topY}), relocating...`);
            const nearest = this.findNearestValidSpawn(x, y, existingPositions);
            if (nearest) {
                log.debug(`   ✅ Relocated to (${nearest.x}, ${nearest.y})`);
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
        log.debug(`   ⚠️ Marker (${x}, ${y}) is not a valid spawn, finding nearest...`);
        const nearest = this.findNearestValidSpawn(x, y, existingPositions);

        if (nearest) {
            log.debug(`   ✅ Found nearest valid spawn at (${nearest.x}, ${nearest.y})`);
            return nearest;
        }

        // Absolute fallback: spawn at marker anyway and let physics handle it
        log.debug(`   ❌ No valid spawn found, using marker position anyway`);
        return { x: marker.x, y: marker.y };
    },

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
    },

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
    },

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
        log.debug('Relaxing spawn requirements (ignoring Line-of-Sight)...');
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
    },

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
    },

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
    },

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
    },
};
