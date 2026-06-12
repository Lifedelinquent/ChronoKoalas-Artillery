/**
 * Koala Entity - Player character
 */

export class Koala {
    constructor(x, y, team) {
        // Position
        this.x = x;
        this.y = y;

        // Velocity
        this.vx = 0;
        this.vy = 0;

        // Dimensions
        this.width = 24;
        this.height = 30;

        // Team reference
        this.team = team;

        // Stats
        this.health = 100;
        this.maxHealth = 100;
        this.isAlive = true;

        // State
        this.onGround = false;
        this.facingLeft = false;
        this.aimAngle = 0;

        // Hit-reaction physics (tumble + squash/stretch). Purely visual/feel —
        // these are driven by applyKnockback() and integrated in Physics.
        this.spin = 0;          // current visual rotation from being launched (radians)
        this.spinVel = 0;       // angular velocity while tumbling (radians/sec)
        this.squash = 1;        // squash & stretch scale (1 = neutral)
        this.landingImpact = 0; // downward speed captured the frame we touch down

        // Tracking
        this.fallDistance = 0;
        this.damageDealt = 0;

        // Name
        this.name = 'Koala';

        // Spawn Protection: Minimal ignore gravity to prevent falling through map on initial load
        this.spawnTimer = 0.1;
    }

    /**
     * Update koala state
     */
    update(dt) {
        if (this.spawnTimer > 0) {
            this.spawnTimer -= dt;
        }
    }

    /**
     * Launch this koala from a hit (explosion or melee).
     * Adds the impulse and kicks off a tumble whose spin scales with how hard
     * they were hit and whose direction follows their horizontal travel.
     */
    applyKnockback(kx, ky) {
        this.vx += kx;
        this.vy += ky;
        this.onGround = false;

        const speed = Math.hypot(kx, ky);
        if (speed > 60) {
            const dir = kx >= 0 ? 1 : -1; // spin the way they're flung
            const target = dir * Math.min(speed / 45, 18); // rad/s, capped
            // Keep the wilder of the two so repeated hits add chaos, not cancel it
            if (Math.abs(target) > Math.abs(this.spinVel)) this.spinVel = target;
        }
    }

    /**
     * Take damage
     */
    takeDamage(amount) {
        if (!this.isAlive) return;

        this.health = Math.max(0, this.health - amount);

        if (this.health <= 0) {
            // Will be processed in damage phase
        }
    }

    /**
     * Heal
     */
    heal(amount) {
        if (!this.isAlive) return;

        this.health = Math.min(this.maxHealth, this.health + amount);
    }

    /**
     * Die
     */
    die() {
        this.isAlive = false;
        // Play death animation/sound
    }

    /**
     * Check if point is inside koala hitbox
     */
    containsPoint(x, y) {
        return x >= this.x - this.width / 2 &&
            x <= this.x + this.width / 2 &&
            y >= this.y - this.height / 2 &&
            y <= this.y + this.height / 2;
    }

    /**
     * Get center position
     */
    getCenter() {
        return { x: this.x, y: this.y };
    }
}
