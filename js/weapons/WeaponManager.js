/**
 * Weapon Manager - Handles all weapons and projectiles
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

        // Select default weapon
        this.selectWeapon('bazooka');
    }

    /**
     * Create weapon definitions
     */
    createWeapons() {
        return {
            bazooka: {
                id: 'bazooka',
                name: 'Bazooka',
                type: 'bazooka',
                damage: 50,
                directDamage: 0,
                explosionRadius: 50,
                knockback: 300,
                speed: 900, // Increased for stronger throws
                gravity: 1,
                affectedByWind: true,
                ammo: Infinity
            },
            grenade: {
                id: 'grenade',
                name: 'Grenade',
                type: 'grenade',
                damage: 50,
                directDamage: 0,
                explosionRadius: 85, // Bigger explosion
                knockback: 300,
                speed: 800,
                gravity: 1,
                affectedByWind: false,
                bounces: true,
                bounciness: 0.7,
                usesTimer: true,
                timerStartsOnThrow: true, // NEW: Timer starts immediately when thrown
                defaultTimer: 3, // User can set 1-5 seconds
                noContactExplosion: true, // NEW: Don't explode on koala contact
                ammo: 5
            },
            shotgun: {
                id: 'shotgun',
                name: 'Shotgun',
                type: 'shotgun',
                damage: 8,           // Damage per pellet (6 pellets = 48 max)
                directDamage: 8,
                explosionRadius: 15, // Terrain damage per pellet
                knockback: 80,       // Per pellet
                speed: 1200,
                gravity: 0,          // Pellets travel straight (short range)
                affectedByWind: false,
                pelletCount: 6,      // Number of pellets per shot
                spreadAngle: 0.25,   // Spread in radians (~15 degrees total)
                maxRange: 200,       // Pellets disappear after this distance
                shotsPerTurn: 2,     // Can fire twice before turn ends
                ammo: Infinity
            },
            dynamite: {
                id: 'dynamite',
                name: 'Dynamite',
                type: 'dynamite',
                damage: 75,
                directDamage: 0,
                explosionRadius: 120, // Bigger explosion
                knockback: 400,
                speed: 0, // Can't be thrown, only dropped
                gravity: 1,
                affectedByWind: false,
                drops: true, // Drops straight down
                usesTimer: true,
                timerStartsOnThrow: true,
                fixedTimer: 5,
                noContactExplosion: true,
                ammo: 2
            },
            airstrike: {
                id: 'airstrike',
                name: 'Airstrike',
                type: 'airstrike',
                damage: 30,
                directDamage: 0,
                explosionRadius: 35,
                knockback: 200,
                targetted: true, // Click to target
                missiles: 5,
                ammo: 1
            },
            teleport: {
                id: 'teleport',
                name: 'Teleport',
                type: 'teleport',
                targetted: true,
                utility: true,
                ammo: 2
            },
            rope: {
                id: 'rope',
                name: 'Ninja Rope',
                type: 'rope',
                utility: true,
                speed: 1000,
                gravity: 0,
                ammo: 5
            },
            mine: {
                id: 'mine',
                name: 'Mine',
                type: 'mine',
                damage: 50,
                explosionRadius: 70,
                knockback: 300,
                speed: 300, // Throw it a bit
                drops: true,
                triggeredByProximity: true,
                usesTimer: true, // NEW: Uses timer when triggered
                fixedTimer: 3,   // Locked to 3 seconds
                triggerDelay: 3, // Delay from trigger to explosion
                dudChance: 0.15, // 15% chance of being a dud
                noContactExplosion: true, // NEW: Don't explode on contact
                ammo: 2
            },
            bat: {
                id: 'bat',
                name: 'Baseball Bat',
                type: 'melee',
                damage: 30,
                knockback: 800, // Sends them flying!
                range: 40,
                ammo: 1
            },
            holygrenade: {
                id: 'holygrenade',
                name: 'Holy Hand Grenade',
                type: 'holygrenade',
                damage: 100,
                directDamage: 0,
                explosionRadius: 150,
                knockback: 500,
                speed: 700,
                gravity: 1,
                bounces: true,
                bounciness: 0.6,
                explodesOnSettle: true, // NEW: Explodes when it stops moving
                settleVelocityThreshold: 63, // Balanced threshold for settling
                noContactExplosion: true, // NEW: Don't explode on koala contact
                ammo: 1
            },
            blowtorch: {
                id: 'blowtorch',
                name: 'Blowtorch',
                type: 'blowtorch',
                utility: true,
                meter: 100, // Full meter capacity
                speed: 80, // Forward movement speed while digging
                digRadius: 18, // Terrain destruction radius
                ammo: 2
            }
        };
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

        // Ensure minimum power of 0.2 so projectiles always move
        const actualPower = Math.max(0.2, power);
        const speed = weapon.speed * actualPower;

        // Use player-set timer, or weapon's default timer, or null
        let projectileTimer = null;
        if (weapon.usesTimer) {
            // Respect fixedTimer if it exists, otherwise use player set timer
            projectileTimer = (weapon.fixedTimer !== undefined) ? weapon.fixedTimer : (this.timer !== null ? this.timer : (weapon.defaultTimer || 3));
        }

        console.log('Creating projectile - weapon:', weapon.name, 'speed:', speed, 'power:', actualPower, 'timer:', projectileTimer);

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
            projectile.gravityMultiplier = weapon.gravity || 1;
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
            projectile.isDud = weapon.dudChance && Math.random() < weapon.dudChance;
            projectile.dudActivated = false;
            projectile.explodesOnSettle = weapon.explodesOnSettle || false;
            projectile.settleVelocityThreshold = weapon.settleVelocityThreshold || 100;
            projectile.settleTime = 0;
            projectile.settleRequiredTime = 0.3;
            projectile.stationary = false;
            projectile.destroyed = false;
            projectile.shooter = null;

            // Reset shotgun-specific properties so they don't persist
            projectile.isPellet = undefined;
            projectile.maxRange = undefined;
            projectile.startX = undefined;
            projectile.startY = undefined;
        } else {
            // Pool is empty, create new projectile
            projectile = new Projectile({
                x,
                y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                type: weapon.type,
                weapon: weapon,
                timer: projectileTimer,
                timerStartsOnThrow: weapon.timerStartsOnThrow || false,
                gravityMultiplier: weapon.gravity || 1,
                affectedByWind: weapon.affectedByWind !== false,
                bounces: weapon.bounces || false,
                bounciness: weapon.bounciness || 0.5,
                triggeredByProximity: weapon.triggeredByProximity || false
            });
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
