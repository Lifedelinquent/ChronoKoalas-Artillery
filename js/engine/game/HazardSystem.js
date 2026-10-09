/**
 * HazardSystem - Map hazards: burning ground, landmines and oil drums.
 *
 * Installed onto Game.prototype (see the bottom of Game.js), so every
 * method runs with `this` bound to the Game instance.
 */

import { DAMAGE_RADIUS_SCALE } from '../GameConstants.js';
import { Projectile } from '../../weapons/Projectile.js';
import { log } from '../../utils/Logger.js';

export const HazardSystem = {
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
    },

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
                                drum.igniteTimer = 0.6 + this.hostRandom() * 0.5;
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
    },

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

        log.debug(`💣 Map hazards: ${minesPlaced} mines, ${this.oilDrums.length} oil drums`);
    },

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
    },

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
    },

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
                    this.scheduleDelayedAction(150 + this.hostRandom() * 120, () => this.detonateOilDrum(drum));
                }
            }
        }
    },

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

        // Kick nearby resting mines flying (symmetric on all clients)
        this.pushProjectilesFromBlast(cx, cy, radius);

        // Crates caught in the drum blast blow up too
        this.lootManager.damageCrates(cx, cy, radius);

        // Burning oil sprays out — rolled from the drum's spawn seed so both
        // clients scatter identical flames
        this.spawnFirePatches(cx, cy, 6, this.createSeededRandom(drum.effectSeed));

        const isAuthoritativeClient = this.isPractice || !this.networkManager || this.networkManager.isHost;
        if (!isAuthoritativeClient) return;

        // Terrain + damage, mirroring handleProjectileImpact
        this.terrain.createCrater(cx, cy, radius);

        const explosionResults = [];
        // Blast reach extends beyond the hole, WA-style
        const damageRadius = radius * DAMAGE_RADIUS_SCALE;
        const nearbyEntities = this.spatialGrid.queryRadius(cx, cy, damageRadius);
        for (const { entity: koala, distance } of nearbyEntities) {
            if (koala.isAlive === undefined) continue;

            const falloff = this.blastFalloff(distance, damageRadius);
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
        this.damageOilDrums(cx, cy, damageRadius, damage);

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
    },
};
