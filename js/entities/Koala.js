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

        // Tracking
        this.fallDistance = 0;
        this.damageDealt = 0;

        // Name
        this.name = 'Koala';
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
