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

        // Timer behavior
        this.timer = options.timer;
        this.timerStartsOnThrow = options.timerStartsOnThrow || false;
        this.timerStarted = this.timerStartsOnThrow; // Start immediately if flagged
        this.timeOnGround = 0;

        // Size for collision
        this.radius = 5;

        // Proximity detection (for mines)
        this.triggeredByProximity = options.triggeredByProximity || false;
        this.isTriggered = false;
        this.triggerTimer = 0;
        this.triggerDelay = options.weapon?.triggerDelay || 3.0;

        // Dud state (for mines)
        this.isDud = false;
        if (options.weapon?.dudChance && Math.random() < options.weapon.dudChance) {
            this.isDud = true;
        }

        // Explodes on settle (for holy hand grenade)
        this.explodesOnSettle = options.weapon?.explodesOnSettle || false;
        this.settleVelocityThreshold = options.weapon?.settleVelocityThreshold || 100;
        this.settleTime = 0; // Time spent below threshold
        this.settleRequiredTime = 0.3; // Must be slow for 0.3 seconds
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
        // Handle settle-based explosion (Holy Hand Grenade)
        // Check velocity ALWAYS, not just when stationary
        if (this.explodesOnSettle) {
            const speed = Math.hypot(this.vx, this.vy);
            if (speed < this.settleVelocityThreshold) {
                this.settleTime += dt;
                if (this.settleTime >= this.settleRequiredTime) {
                    return true; // Settled - BOOM!
                }
            } else {
                // Reset if moving too fast
                this.settleTime = 0;
            }
        }

        // Handle proximity-triggered mines
        if (this.triggeredByProximity && this.stationary) {
            if (this.isTriggered) {
                // Check if it's a dud
                if (this.isDud) {
                    // Dud doesn't explode, just returns special state
                    if (!this.dudActivated) {
                        this.dudActivated = true;
                        return 'dud'; // Signal for dud effect
                    }
                    return false; // Dud stays there
                }

                this.triggerTimer += dt;
                if (this.triggerTimer >= this.triggerDelay) {
                    return true; // BOOM
                }
            }
        }

        // Check timer (starts on throw or on terrain hit)
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
