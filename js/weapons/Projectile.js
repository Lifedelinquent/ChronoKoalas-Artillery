/**
 * Projectile - Flying weapon object
 */

export class Projectile {
    constructor(options) {
        this.x = options.x;
        this.y = options.y;
        this.vx = options.vx;
        this.vy = options.vy;

        this.type = options.type;
        this.weapon = options.weapon;

        this.rotation = Math.atan2(this.vy, this.vx);
        this.gravityMultiplier = options.gravityMultiplier || 1;
        this.affectedByWind = options.affectedByWind !== false;

        // Bouncing
        this.bounces = options.bounces || false;
        this.bounciness = options.bounciness || 0.5;
        this.bounceCount = 0;
        this.maxBounces = 3;

        // Timer (for grenades) - only starts after first terrain hit
        this.timer = options.timer;
        this.timerStarted = false; // Timer hasn't started yet
        this.timeOnGround = 0; // Time since first terrain hit

        // Size for collision
        this.radius = 5;

        // Proximity detection (for mines)
        this.triggeredByProximity = options.triggeredByProximity || false;
        this.isTriggered = false;
        this.triggerTimer = 0;
        this.triggerDelay = 3.0; // Seconds from detection to blast
    }

    /**
     * Called when projectile first hits terrain - starts the timer
     */
    onTerrainHit() {
        if (!this.timerStarted && this.timer !== null) {
            this.timerStarted = true;
            this.timeOnGround = 0;
        }
    }

    /**
     * Update projectile
     */
    update(dt, wind) {
        // Handle proximity-triggered mines
        if (this.triggeredByProximity && this.stationary) {
            if (this.isTriggered) {
                this.triggerTimer += dt;
                if (this.triggerTimer >= this.triggerDelay) {
                    return true; // BOOM
                }
            }
        }

        // Check timer only if it has started (after terrain hit)
        if (this.timer !== null && this.timerStarted) {
            this.timeOnGround += dt;
            if (this.timeOnGround >= this.timer) {
                // Timer expired - will explode
                return true; // Signal to explode
            }
        }

        // Physics is handled by Physics.js
        // Just update rotation
        if (!this.stationary) {
            this.rotation = Math.atan2(this.vy, this.vx);
        }

        return false;
    }

    /**
     * Handle bounce off terrain
     */
    bounce(normalX, normalY) {
        if (!this.bounces) return false;
        if (this.bounceCount >= this.maxBounces) return false;

        // Reflect velocity
        const dot = this.vx * normalX + this.vy * normalY;
        this.vx = (this.vx - 2 * dot * normalX) * this.bounciness;
        this.vy = (this.vy - 2 * dot * normalY) * this.bounciness;

        this.bounceCount++;

        // Stop if moving too slowly
        const speed = Math.hypot(this.vx, this.vy);
        return speed > 20;
    }

    /**
     * Check if projectile hit a koala
     */
    checkKoalaHit(koala) {
        const dist = Math.hypot(this.x - koala.x, this.y - koala.y);
        return dist < this.radius + 15; // Koala radius ~15
    }
}
