/**
 * Weapon Manager - Handles all weapons and projectiles
 *
 * Arsenal layout is inspired by classic turn-based artillery games:
 * weapons are grouped into categories, some start with limited ammo
 * and the rarest ones only ever come from crates (ammo: 0).
 */

import { Projectile } from './Projectile.js';

export class WeaponManager {
    constructor(game) {
        this.game = game;

        // Power charging
        this.power = 0;
        this.maxPower = 100;
        this.chargeSpeed = 100; // per second
        this.isCharging = false;

        // Weapon timer (for grenades, etc.)
        this.timer = 3;

        // Current weapon
        this.currentWeapon = null;

        // Define all weapons
        this.weapons = this.createWeapons();

        // Sub-munitions (cluster fragments etc.) - not selectable, not in crates
        this.subMunitions = this.createSubMunitions();

        // Select default weapon
        this.selectWeapon('bazooka');
    }

    /**
     * Create weapon definitions.
     * category groups weapons in the selection panel.
     * ammo: Infinity = always available, 0 = crate-only.
     *
     * NOTE: explosion knockback is Worms Armageddon-style — launch speed is
     * derived from the damage dealt (see Game.handleProjectileImpact), so the
     * `knockback` field only drives melee swings and special cases.
     */
    createWeapons() {
        return {
            // ============ LAUNCHERS ============
            bazooka: {
                id: 'bazooka',
                name: 'Bazooka',
                category: 'launchers',
                icon: null, // uses sprite image
                type: 'bazooka',
                damage: 50,
                directDamage: 0,
                explosionRadius: 50,
                knockback: 300,
                speed: 900,
                gravity: 1,
                affectedByWind: true,
                ammo: Infinity
            },
            homing: {
                id: 'homing',
                name: 'Homing Missile',
                category: 'launchers',
                icon: '🛰️',
                type: 'homing',
                damage: 50,
                directDamage: 0,
                explosionRadius: 50,
                knockback: 300,
                speed: 500,
                gravity: 0.15,
                affectedByWind: false,
                targetted: true,        // click to set the target, missile launches instantly
                homing: true,
                ammo: 2
            },
            mortar: {
                id: 'mortar',
                name: 'Mortar',
                category: 'launchers',
                icon: '🎇',
                type: 'mortar',
                damage: 35,
                directDamage: 0,
                explosionRadius: 40,
                knockback: 250,
                speed: 850,
                gravity: 1,
                affectedByWind: false,
                clusters: 5,            // splits into fragments on impact
                clusterType: 'clusterFrag',
                ammo: 4
            },

            // ============ BOMBS ============
            grenade: {
                id: 'grenade',
                name: 'Grenade',
                category: 'bombs',
                icon: null,
                type: 'grenade',
                damage: 50,
                directDamage: 0,
                explosionRadius: 85,
                knockback: 300,
                speed: 800,
                gravity: 1,
                affectedByWind: false,
                bounces: true,
                bounciness: 0.7,
                usesTimer: true,
                timerStartsOnThrow: true,
                defaultTimer: 3,
                noContactExplosion: true,
                ammo: Infinity
            },
            cluster: {
                id: 'cluster',
                name: 'Cluster Bomb',
                category: 'bombs',
                icon: '💥',
                type: 'cluster',
                damage: 30,
                directDamage: 0,
                explosionRadius: 40,
                knockback: 220,
                speed: 800,
                gravity: 1,
                affectedByWind: false,
                bounces: true,
                bounciness: 0.5,
                usesTimer: true,
                timerStartsOnThrow: true,
                defaultTimer: 3,
                noContactExplosion: true,
                clusters: 5,
                clusterType: 'clusterFrag',
                ammo: 4
            },
            banana: {
                id: 'banana',
                name: 'Banana Bomb',
                category: 'bombs',
                icon: '🍌',
                type: 'banana',
                damage: 75,
                directDamage: 0,
                explosionRadius: 60,
                knockback: 400,
                speed: 800,
                gravity: 1,
                affectedByWind: false,
                bounces: true,
                bounciness: 0.6,
                usesTimer: true,
                timerStartsOnThrow: true,
                defaultTimer: 3,
                noContactExplosion: true,
                clusters: 6,
                clusterType: 'bananaFrag',
                ammo: 0 // crate-only
            },
            petrol: {
                id: 'petrol',
                name: 'Petrol Bomb',
                category: 'bombs',
                icon: '🍾',
                type: 'petrol',
                damage: 20,
                directDamage: 10,
                explosionRadius: 30,
                knockback: 150,
                speed: 800,
                gravity: 1,
                affectedByWind: false,
                spawnsFire: true,
                fireCount: 7,
                ammo: 2
            },
            holygrenade: {
                id: 'holygrenade',
                name: 'Holy Hand Grenade',
                category: 'bombs',
                icon: null,
                type: 'holygrenade',
                damage: 100,
                directDamage: 0,
                explosionRadius: 150,
                knockback: 500,
                speed: 700,
                gravity: 1,
                bounces: true,
                bounciness: 0.6,
                explodesOnSettle: true,
                settleVelocityThreshold: 63,
                noContactExplosion: true,
                ammo: 1
            },

            // ============ GUNS ============
            shotgun: {
                id: 'shotgun',
                name: 'Shotgun',
                category: 'guns',
                icon: null,
                type: 'shotgun',
                damage: 8,
                directDamage: 8,
                explosionRadius: 15,
                knockback: 80,
                speed: 1200,
                gravity: 0,
                affectedByWind: false,
                pelletCount: 6,
                spreadAngle: 0.25,
                maxRange: 200,
                shotsPerTurn: 2,
                ammo: Infinity
            },
            handgun: {
                id: 'handgun',
                name: 'Handgun',
                category: 'guns',
                icon: '🔫',
                type: 'gunburst',
                damage: 7,
                directDamage: 7,
                explosionRadius: 10,
                knockback: 60,
                speed: 1300,
                gravity: 0,
                affectedByWind: false,
                burstCount: 6,
                burstInterval: 0.13,
                burstSpread: 0.02,
                maxRange: 600,
                ammo: Infinity
            },
            uzi: {
                id: 'uzi',
                name: 'Uzi',
                category: 'guns',
                icon: '🔩',
                type: 'gunburst',
                damage: 5,
                directDamage: 5,
                explosionRadius: 8,
                knockback: 40,
                speed: 1300,
                gravity: 0,
                affectedByWind: false,
                burstCount: 12,
                burstInterval: 0.06,
                burstSpread: 0.07,
                maxRange: 450,
                ammo: Infinity
            },
            minigun: {
                id: 'minigun',
                name: 'Minigun',
                category: 'guns',
                icon: '⚙️',
                type: 'gunburst',
                damage: 6,
                directDamage: 6,
                explosionRadius: 10,
                knockback: 50,
                speed: 1300,
                gravity: 0,
                affectedByWind: false,
                burstCount: 25,
                burstInterval: 0.045,
                burstSpread: 0.1,
                maxRange: 500,
                ammo: 0 // crate-only
            },
            longbow: {
                id: 'longbow',
                name: 'Longbow',
                category: 'guns',
                icon: '🏹',
                type: 'arrow',
                damage: 0,
                directDamage: 30,
                directKnockback: 250,
                explosionRadius: 0,
                knockback: 0,
                speed: 1000,
                gravity: 0.4,
                affectedByWind: false,
                ammo: 3
            },

            // ============ MELEE ============
            firepunch: {
                id: 'firepunch',
                name: 'Fire Punch',
                category: 'melee',
                icon: '🔥',
                type: 'melee',
                damage: 30,
                knockback: 550,
                range: 35,
                verticalKnockback: true, // launches the target upward
                ammo: Infinity
            },
            dragonball: {
                id: 'dragonball',
                name: 'Dragon Ball',
                category: 'melee',
                icon: '🐉',
                type: 'melee',
                damage: 30,
                knockback: 600,
                range: 35,
                flatKnockback: true, // mostly horizontal launch
                ammo: Infinity
            },
            bat: {
                id: 'bat',
                name: 'Baseball Bat',
                category: 'melee',
                icon: null,
                type: 'melee',
                damage: 30,
                knockback: 800,
                range: 40,
                ammo: 1
            },
            prod: {
                id: 'prod',
                name: 'Prod',
                category: 'melee',
                icon: '👉',
                type: 'melee',
                damage: 0,        // pure push, no damage
                knockback: 120,
                range: 28,
                pushKnockback: true, // WA-style nudge: horizontal only, no tumble
                ammo: Infinity
            },
            kamikaze: {
                id: 'kamikaze',
                name: 'Kamikaze',
                category: 'melee',
                icon: '✈️',
                type: 'kamikaze',
                damage: 50,            // final explosion
                explosionRadius: 75,
                knockback: 350,
                dashDamage: 30,        // damage to anyone touched during the dash
                dashSpeed: 480,
                dashDistance: 380,
                ammo: 1
            },

            // ============ EXPLOSIVES ============
            dynamite: {
                id: 'dynamite',
                name: 'Dynamite',
                category: 'explosives',
                icon: null,
                type: 'dynamite',
                damage: 75,
                directDamage: 0,
                explosionRadius: 120,
                knockback: 400,
                speed: 0,
                gravity: 1,
                affectedByWind: false,
                drops: true,
                usesTimer: true,
                timerStartsOnThrow: true,
                fixedTimer: 5,
                noContactExplosion: true,
                ammo: 1
            },
            mine: {
                id: 'mine',
                name: 'Mine',
                category: 'explosives',
                icon: null,
                type: 'mine',
                damage: 50,
                explosionRadius: 70,
                knockback: 300,
                speed: 300,
                drops: true,
                triggeredByProximity: true,
                usesTimer: true,
                fixedTimer: 3,
                triggerDelay: 3,
                dudChance: 0.15,
                noContactExplosion: true,
                ammo: 2
            },
            sheep: {
                id: 'sheep',
                name: 'Sheep',
                category: 'explosives',
                icon: '🐑',
                type: 'sheep',
                damage: 75,
                directDamage: 0,
                explosionRadius: 90,
                knockback: 400,
                speed: 300,
                gravity: 1,
                affectedByWind: false,
                isWalker: true,         // walks along terrain and hops obstacles
                walkSpeed: 140,
                usesTimer: true,
                timerStartsOnThrow: true,
                fixedTimer: 8,
                ammo: 1
            },

            // ============ STRIKES (targetted, from the sky) ============
            airstrike: {
                id: 'airstrike',
                name: 'Air Strike',
                category: 'strikes',
                icon: null,
                type: 'airstrike',
                damage: 30,
                directDamage: 0,
                explosionRadius: 35,
                knockback: 200,
                targetted: true,
                missiles: 5,
                ammo: 1
            },
            napalmstrike: {
                id: 'napalmstrike',
                name: 'Napalm Strike',
                category: 'strikes',
                icon: '🧨',
                type: 'airstrike',
                damage: 15,
                directDamage: 0,
                explosionRadius: 25,
                knockback: 120,
                targetted: true,
                missiles: 5,
                spawnsFire: true,
                fireCount: 4,
                ammo: 1
            },
            minestrike: {
                id: 'minestrike',
                name: 'Mine Strike',
                category: 'strikes',
                icon: '☢️',
                type: 'airstrike',
                damage: 50,
                explosionRadius: 70,
                knockback: 300,
                targetted: true,
                missiles: 5,
                dropsMines: true,
                ammo: 0 // crate-only
            },
            armageddon: {
                id: 'armageddon',
                name: 'Armageddon',
                category: 'strikes',
                icon: '☄️',
                type: 'armageddon',
                damage: 40,
                explosionRadius: 55,
                knockback: 300,
                meteorCount: 14,
                ammo: 0 // crate-only super weapon
            },

            // ============ TOOLS ============
            blowtorch: {
                id: 'blowtorch',
                name: 'Blowtorch',
                category: 'tools',
                icon: null,
                type: 'blowtorch',
                utility: true,
                meter: 100,
                speed: 80,
                digRadius: 18,
                ammo: 3
            },
            drill: {
                id: 'drill',
                name: 'Pneumatic Drill',
                category: 'tools',
                icon: '🪛',
                type: 'drill',
                utility: true,
                digSpeed: 75,     // px/s straight down
                digRadius: 16,
                duration: 2.5,    // seconds of digging
                ammo: 3
            },
            girder: {
                id: 'girder',
                name: 'Girder',
                category: 'tools',
                icon: '🌉',
                type: 'girder',
                utility: true,
                targetted: true,
                keepsTurn: true,  // placing a girder doesn't end the turn
                ammo: 3
            },
            rope: {
                id: 'rope',
                name: 'Ninja Rope',
                category: 'tools',
                icon: null,
                type: 'rope',
                utility: true,
                speed: 1000,
                gravity: 0,
                ammo: 5
            },
            parachute: {
                id: 'parachute',
                name: 'Parachute',
                category: 'tools',
                icon: '🪂',
                type: 'parachute',
                utility: true,
                keepsTurn: true,  // deploying doesn't end the turn
                ammo: 2
            },
            teleport: {
                id: 'teleport',
                name: 'Teleport',
                category: 'tools',
                icon: null,
                type: 'teleport',
                targetted: true,
                utility: true,
                ammo: 2
            },

            // ============ OTHER ============
            skip: {
                id: 'skip',
                name: 'Skip Go',
                category: 'other',
                icon: '⏭️',
                type: 'skip',
                utility: true,
                ammo: Infinity
            },
            surrender: {
                id: 'surrender',
                name: 'Surrender',
                category: 'other',
                icon: '🏳️',
                type: 'surrender',
                utility: true,
                ammo: Infinity
            }
        };
    }

    /**
     * Sub-munition definitions: spawned by other weapons (cluster fragments,
     * banana fragments, napalm missiles, meteors). Never selectable.
     */
    createSubMunitions() {
        return {
            clusterFrag: {
                id: 'clusterFrag',
                name: 'Cluster Fragment',
                type: 'clusterFrag',
                damage: 25,
                directDamage: 0,
                explosionRadius: 30,
                knockback: 180,
                gravity: 1,
                affectedByWind: false
            },
            bananaFrag: {
                id: 'bananaFrag',
                name: 'Banana',
                type: 'banana',
                damage: 75,
                directDamage: 0,
                explosionRadius: 60,
                knockback: 400,
                gravity: 1,
                affectedByWind: false
            },
            meteor: {
                id: 'meteor',
                name: 'Meteor',
                type: 'meteor',
                damage: 40,
                directDamage: 0,
                explosionRadius: 55,
                knockback: 300,
                gravity: 0.6,
                affectedByWind: false
            },
            kamikazeBlast: {
                id: 'kamikazeBlast',
                name: 'Kamikaze',
                type: 'kamikaze',
                damage: 50,
                directDamage: 0,
                explosionRadius: 75,
                knockback: 350
            }
        };
    }

    /**
     * Get a sub-munition definition by ID
     */
    getSubMunition(id) {
        return this.subMunitions[id];
    }

    /**
     * Get the weapon categories in display order
     */
    static get CATEGORIES() {
        return ['launchers', 'bombs', 'guns', 'melee', 'explosives', 'strikes', 'tools', 'other'];
    }

    /**
     * Select a weapon by ID
     */
    selectWeapon(weaponId) {
        if (this.weapons[weaponId]) {
            this.currentWeapon = this.weapons[weaponId];
        }
    }

    /**
     * Get weapon by ID
     */
    getWeapon(weaponId) {
        return this.weapons[weaponId];
    }

    /**
     * Set timer for timed weapons
     */
    setTimer(seconds) {
        this.timer = Math.max(1, Math.min(5, seconds));
    }

    /**
     * Start charging power
     */
    startCharge() {
        this.power = 0;
        this.isCharging = true;
    }

    /**
     * Update power while charging
     */
    updatePower(dt) {
        if (this.isCharging) {
            this.power = Math.min(this.maxPower, this.power + this.chargeSpeed * dt);

            // Update power bar UI using cached element
            const fill = this.game.dom.elements.powerFill;
            if (fill) {
                fill.style.width = this.power + '%';
            }
        }
    }

    /**
     * Get current power (0-1)
     */
    getPower() {
        this.isCharging = false;
        return this.power / this.maxPower;
    }

    /**
     * Create a projectile from current weapon
     * Uses object pooling for better performance
     */
    createProjectile(x, y, angle, power) {
        const weapon = this.currentWeapon;
        if (!weapon) return null;
        return this.createProjectileFor(weapon, x, y, angle, power);
    }

    /**
     * Create a projectile for a specific weapon definition (selected weapon
     * or sub-munition). Uses object pooling for better performance.
     */
    createProjectileFor(weapon, x, y, angle, power) {
        if (!weapon) return null;

        // Ensure minimum power of 0.2 so projectiles always move
        const actualPower = Math.max(0.2, power);
        const speed = (weapon.speed || 0) * actualPower;

        // Use player-set timer, or weapon's default timer, or null
        let projectileTimer = null;
        if (weapon.usesTimer) {
            // Respect fixedTimer if it exists, otherwise use player set timer
            projectileTimer = (weapon.fixedTimer !== undefined) ? weapon.fixedTimer : (this.timer !== null ? this.timer : (weapon.defaultTimer || 3));
        }

        // Roll dud chance once, using seeded random so multiplayer clients agree
        const rand = this.game.seededRandom || Math.random;
        const isDud = !!(weapon.dudChance && rand() < weapon.dudChance);

        // Try to get from pool first
        let projectile = this.game.getProjectileFromPool();

        if (projectile) {
            // Reuse pooled projectile - reinitialize properties
            projectile.x = x;
            projectile.y = y;
            projectile.vx = Math.cos(angle) * speed;
            projectile.vy = Math.sin(angle) * speed;
            projectile.type = weapon.type;
            projectile.weapon = weapon;
            projectile.rotation = Math.atan2(projectile.vy, projectile.vx);
            projectile.gravityMultiplier = weapon.gravity ?? 1;
            projectile.affectedByWind = weapon.affectedByWind !== false;
            projectile.bounces = weapon.bounces || false;
            projectile.bounciness = weapon.bounciness || 0.5;
            projectile.timer = projectileTimer;
            projectile.timerStartsOnThrow = weapon.timerStartsOnThrow || false;
            projectile.timerStarted = weapon.timerStartsOnThrow || false;
            projectile.timeOnGround = 0;
            projectile.bounceCount = 0;
            projectile.triggeredByProximity = weapon.triggeredByProximity || false;
            projectile.isTriggered = false;
            projectile.triggerTimer = 0;
            projectile.triggerDelay = weapon.triggerDelay || 3.0;
            projectile.isDud = isDud;
            projectile.dudActivated = false;
            projectile.explodesOnSettle = weapon.explodesOnSettle || false;
            projectile.settleVelocityThreshold = weapon.settleVelocityThreshold || 100;
            projectile.settleTime = 0;
            projectile.settleRequiredTime = 0.3;
            projectile.hasTouchedTerrain = false;
            projectile.stationary = false;
            projectile.destroyed = false;
            projectile.shooter = null;

            // Reset gun/walker/homing properties so they don't persist
            projectile.isPellet = undefined;
            projectile.maxRange = undefined;
            projectile.startX = undefined;
            projectile.startY = undefined;
            projectile.isWalker = weapon.isWalker || false;
            projectile.walkDir = 0;
            projectile.homingTarget = null;
            projectile.homingDelay = 0;
            projectile.homingFuel = 0;
        } else {
            projectile = new Projectile({
                x,
                y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                type: weapon.type,
                weapon: weapon,
                timer: projectileTimer,
                timerStartsOnThrow: weapon.timerStartsOnThrow || false,
                gravityMultiplier: weapon.gravity ?? 1,
                affectedByWind: weapon.affectedByWind !== false,
                bounces: weapon.bounces || false,
                bounciness: weapon.bounciness || 0.5,
                triggeredByProximity: weapon.triggeredByProximity || false,
                isDud: isDud
            });
            projectile.isDud = isDud;
            projectile.isWalker = weapon.isWalker || false;
        }

        return projectile;
    }
    /**
     * Reset weapons (restore ammo)
     */
    reset() {
        this.weapons = this.createWeapons();
        this.selectWeapon('bazooka');
        this.power = 0;
        this.isCharging = false;
    }
}
