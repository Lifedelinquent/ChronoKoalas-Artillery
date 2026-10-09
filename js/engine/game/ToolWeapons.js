/**
 * ToolWeapons - Weapons that are not plain projectiles: melee, tools, strikes, bursts.
 *
 * Installed onto Game.prototype (see the bottom of Game.js), so every
 * method runs with `this` bound to the Game instance.
 */

import { Projectile } from '../../weapons/Projectile.js';
import { log } from '../../utils/Logger.js';

export const ToolWeapons = {
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
                    log.debug('Melee hit on', target.name, 'knockback:', weapon.knockback);
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
    },

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

        log.debug('Blowtorch activated for', koala.name);
    },

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

        // ACTIVE CLIENT (or local game): pointer-driven digging. The pointer
        // is the human's, or the CPU's virtual pad on a CPU turn.
        const control = this.getControl();
        const isDigging = this.hasLocalControl() ? control.simPointer.down : koala.blowtorchDigging;
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
            // Dig toward the pointer
            const pointer = control.simPointer;
            const dx = pointer.x - koala.x;
            const dy = pointer.y - (koala.y - 10);
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
    },

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
    },

    /**
     * Execute teleport - move koala to target location (Worms Armageddon style)
     * The koala drops from the sky above the target ground position.
     */
    executeTeleport(koala, targetX, targetY) {
        // Validate the target location
        const validation = this.terrain.isValidTeleportTarget(targetX);

        if (!validation.valid) {
            log.debug(`Cannot teleport: ${validation.reason}`);
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
    },

    /**
     * Place / move the homing missile's target marker (WA-style: click marks
     * the target, then the missile is aimed and fired like a normal launcher)
     */
    setHomingTarget(x, y) {
        this.homingTarget = { x, y };
        this.audioManager.playClick();
        this.createFloatingText(x, y - 30, 'Target locked!', '#ff6b6b');
    },

    /**
     * Clear the placed homing target (right-click / Escape) so the next
     * left click can place a fresh one
     */
    clearHomingTarget() {
        if (!this.homingTarget) return;
        const { x, y } = this.homingTarget;
        this.homingTarget = null;
        this.audioManager.playClick();
        this.createFloatingText(x, y - 30, 'Target cleared', '#aaaaaa');
    },

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
                    log.debug('Cannot place girder on a koala');
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
    },

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
    },

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
    },

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
        log.debug('🪛 Drill activated for', koala.name);
    },

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
    },

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
    },

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
        log.debug('✈️ KAMIKAZE!', koala.name);
    },

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

            // The pilot doesn't come back — vaporised in their own blast
            // (no separate death explosion), leaving only a gravestone
            koala.health = 0;
            koala.die();
            koala.vanished = true;
            this.graves.push({ x: koala.x, y: koala.y + koala.height / 2, vy: 0, falling: true, style: koala.team?.style?.grave });
            this.createDeathEffect(koala);
            this.updateTeamHealth();

            // Final blast reuses the standard impact pipeline via a stub projectile
            const blast = this.weaponManager.getSubMunition('kamikazeBlast');
            this.handleProjectileImpact({ x: koala.x, y: koala.y, weapon: blast, shooter: koala });

            this.phase = 'damage';
            const kamikazeTurn = this.turnManager.turnCounter;
            this.scheduleDelayedAction(800, () => {
                if (this.turnManager.turnCounter === kamikazeTurn) this.processDamage();
            });
        }
    },

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
        log.debug('☄️ ARMAGEDDON!');
    },
};
