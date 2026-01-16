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
                damage: 45,
                directDamage: 0,
                explosionRadius: 75,
                knockback: 250,
                speed: 800, // Increased for stronger throws
                gravity: 1,
                affectedByWind: false,
                bounces: true,
                bounciness: 0.7,
                usesTimer: true,
                defaultTimer: 3, // 3 seconds after first terrain hit
                ammo: 5
            },
            shotgun: {
                id: 'shotgun',
                name: 'Shotgun',
                type: 'shotgun',
                damage: 25,
                directDamage: 25,
                explosionRadius: 15,
                knockback: 150,
                speed: 1500,
                gravity: 0.3,
                affectedByWind: false,
                shots: 2,
                ammo: Infinity
            },
            dynamite: {
                id: 'dynamite',
                name: 'Dynamite',
                type: 'dynamite',
                damage: 75,
                directDamage: 0,
                explosionRadius: 100,
                knockback: 400,
                speed: 200,
                gravity: 1,
                affectedByWind: false,
                drops: true, // Drops straight down
                fuseTime: 5,
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
                speed: 700, // Increased for stronger throws
                gravity: 1,
                bounces: true,
                bounciness: 0.6,
                usesTimer: true,
                defaultTimer: 3, // 3 seconds after first terrain hit
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

            // Update power bar UI
            const fill = document.getElementById('power-fill');
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
            projectileTimer = this.timer !== null ? this.timer : (weapon.defaultTimer || 3);
        }

        console.log('Creating projectile - weapon:', weapon.name, 'speed:', speed, 'power:', actualPower, 'timer:', projectileTimer);

        const projectile = new Projectile({
            x,
            y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            type: weapon.type,
            weapon: weapon,
            timer: projectileTimer,
            gravityMultiplier: weapon.gravity || 1,
            affectedByWind: weapon.affectedByWind !== false,
            bounces: weapon.bounces || false,
            bounciness: weapon.bounciness || 0.5,
            triggeredByProximity: weapon.triggeredByProximity || false
        });

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
