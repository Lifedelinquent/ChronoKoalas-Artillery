/**
 * ProjectileSystem - Projectile flight, collision, pooling and the explosion/impact pipeline.
 *
 * Installed onto Game.prototype (see the bottom of Game.js), so every
 * method runs with `this` bound to the Game instance.
 */

import { DAMAGE_RADIUS_SCALE, DAMAGE_CORE_FRACTION } from '../GameConstants.js';
import { log } from '../../utils/Logger.js';
import { getWeaponBehavior } from '../../weapons/WeaponBehaviors.js';

export const ProjectileSystem = {
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
    },

    /**
     * Get a projectile from the pool or create a new one
     */
    getProjectileFromPool() {
        if (this.projectilePool.length > 0) {
            return this.projectilePool.pop();
        }
        // Pool is empty, will need to create new one
        return null;
    },

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
    },

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
    },

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
                    log.debug(`🔄 Phase transition check: shotgunShotsRemaining=${this.shotgunShotsRemaining}, projectiles=${this.projectiles.length}`);

                    // Special handling for shotgun multi-shot
                    if (this.shotgunShotsRemaining > 0) {
                        log.debug(`🔫 Shotgun ready for shot ${2 - this.shotgunShotsRemaining + 1}`);
                        this.phase = 'aiming'; // Return to aiming for next shot
                        return;
                    }

                    // Reset shotgun counter when turn ends
                    this.shotgunShotsRemaining = 0;
                    log.debug('🏃 Starting retreat');
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

            // Per-type flight behaviour (homing steering, sheep walking,
            // smoke trails) lives in weapons/WeaponBehaviors.js
            const behavior = getWeaponBehavior(proj.type);
            behavior.beforeMove?.(this, proj, dt);

            // Apply physics to move the projectile FIRST
            if (!proj.stationary) {
                this.physics.updateProjectile(proj, dt);
                behavior.afterMove?.(this, proj, dt);
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
                    log.debug('Mine triggered by', target.name);
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
                    log.debug('💨 Mine was a DUD!');
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

                // 2. Crates block shots too — hitting one blows it up (WA-style)
                let hitCrate = null;
                for (const crate of this.lootManager.crates) {
                    if (crate.collected) continue;
                    if (Math.hypot(checkX - crate.x, checkY - crate.y) < 16) {
                        hitCrate = crate;
                        break;
                    }
                }

                if (hitCrate) {
                    hitResult = { type: 'crate', x: checkX, y: checkY, crate: hitCrate };
                    break;
                }

                // 3. Check terrain next at this step
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
                        log.debug(proj.weapon.name, 'hit koala but noContactExplosion is true');
                    } else {
                        // Normal explosion on contact
                        this.handleProjectileImpact(proj, hitResult.koala);
                        this.removeProjectile(i);
                    }
                    continue;
                }
                else if (hitResult.type === 'crate') {
                    // Shot crate blows up (its own fused blast); the shell
                    // explodes on the box unless it's a pass-through weapon
                    this.lootManager.destroyCrate(hitResult.crate);
                    if (!proj.weapon.noContactExplosion) {
                        this.handleProjectileImpact(proj);
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
    },

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
    },

    /** Full damage inside the core, linear falloff to the blast edge. */
    blastFalloff(distance, damageRadius) {
        const core = damageRadius * DAMAGE_CORE_FRACTION;
        return Math.max(0, Math.min(1, (damageRadius - distance) / (damageRadius - core)));
    },

    /**
     * WA-style: blasts kick resting mines (and dud mines) flying instead of
     * leaving them glued to the ground. Runs UNGATED on every client — mine
     * physics is deterministic, and both clients replay the same impact, so
     * the mines land in the same place everywhere.
     */
    pushProjectilesFromBlast(cx, cy, radius, exclude = null) {
        const pushRadius = radius * DAMAGE_RADIUS_SCALE;
        for (const p of this.projectiles) {
            if (p === exclude || !p.stationary) continue;
            const dist = Math.hypot(p.x - cx, p.y - cy);
            if (dist > pushRadius) continue;

            const falloff = this.blastFalloff(dist, pushRadius);
            const push = 200 + 500 * falloff;

            // Same biased origin as koala knockback: mines fly up and out
            const angle = Math.atan2(p.y - (cy + 10), p.x - cx);
            p.stationary = false;
            p.vx += Math.cos(angle) * push;
            p.vy += Math.sin(angle) * push * 1.1 - 80 * falloff;
        }
    },

    /**
     * Handle projectile impact
     */
    handleProjectileImpact(projectile, directHitKoala = null) {
        // Damage from this impact (and anything it chains into) is credited
        // to whoever fired it
        if (!this.stats || !projectile.shooter) {
            return this.applyProjectileImpact(projectile, directHitKoala);
        }
        return this.stats.withAttacker(projectile.shooter,
            () => this.applyProjectileImpact(projectile, directHitKoala));
    },

    applyProjectileImpact(projectile, directHitKoala = null) {
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

            // Kick nearby resting mines flying (symmetric on all clients)
            this.pushProjectilesFromBlast(projectile.x, projectile.y, weapon.explosionRadius, projectile);

            // Crates caught in the blast blow up too (symmetric on all clients)
            this.lootManager.damageCrates(projectile.x, projectile.y, weapon.explosionRadius);

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
                // Blast reach extends beyond the hole, WA-style
                const damageRadius = weapon.explosionRadius * DAMAGE_RADIUS_SCALE;
                const nearbyEntities = this.spatialGrid.queryRadius(
                    projectile.x, projectile.y, damageRadius
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
                    const falloff = this.blastFalloff(distance, damageRadius);
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
                            if (projectile.shooter && koala.team.alliance !== projectile.shooter.team?.alliance) {
                                this.stats?.onImpactHit(projectile, projectile.x, projectile.y);
                            }
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
                    damageRadius, weapon.damage * damageMultiplier);
            }
        }

        // Direct hit bonus - ONLY on authoritative client
        // Use ?? so weapons with an explicit directDamage of 0 (bazooka etc.)
        // don't get a phantom double-damage bonus on direct hits
        const directDamage = Math.round((weapon.directDamage ?? weapon.damage) * damageMultiplier);
        if (directHitKoala && isAuthoritativeClient && directDamage > 0) {
            directHitKoala.takeDamage(directDamage);
            if (projectile.shooter && directHitKoala.team.alliance !== projectile.shooter.team?.alliance) {
                this.stats?.onImpactHit(projectile, projectile.x, projectile.y);
            }

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
    },

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
    },
};
