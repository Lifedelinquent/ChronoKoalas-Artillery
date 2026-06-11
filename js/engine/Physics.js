/**
 * Physics System - Gravity, collisions, and movement
 */

export class Physics {
    constructor(game) {
        this.game = game;

        // Physics constants
        this.gravity = 400; // pixels per second squared
        this.friction = 0.95;
        this.bounciness = 0.5;
        this.terminalVelocity = 800;
    }

    /**
     * Update all physics entities
     */
    update(dt) {
        // Update koalas (both alive AND dead - dead can still be flung by explosions)
        for (const team of this.game.teams) {
            for (const koala of team.koalas) {
                this.updateEntity(koala, dt);
            }
        }

        // Note: Projectile physics is now handled inline in Game.updateProjectiles()
        // to ensure proper ray-casting collision detection (position must update
        // before collision check)
    }

    /**
     * Update a single entity (koala)
     */
    updateEntity(entity, dt) {
        const prevY = entity.y;

        // Apply gravity (unless spawn protected)
        if (!entity.spawnTimer || entity.spawnTimer <= 0) {
            entity.vy += this.gravity * dt;
        } else {
            // Force zero velocity during spawn protection to "stick" the landing
            entity.vy = 0;
        }

        // Clamp velocity
        entity.vy = Math.min(entity.vy, this.terminalVelocity);

        // Apply velocity
        entity.x += entity.vx * dt;
        entity.y += entity.vy * dt;

        // Apply friction
        entity.vx *= this.friction;

        // Terrain collision
        this.resolveTerrainCollision(entity);

        // Update peakY: track the highest point (lowest numerical Y) since leaving ground
        if (entity.peakY === undefined) entity.peakY = entity.y;
        if (!entity.onGround && entity.y < entity.peakY) {
            entity.peakY = entity.y;
        }

        // Check for landing impact or falling
        const justLanded = entity.onGround && prevY < entity.y && entity.vy >= 0;

        if (justLanded) {
            const fallAmount = entity.y - entity.peakY;

            if (fallAmount > 0) {
                // INSTANT FALL DAMAGE - apply on landing if over threshold
                if (entity.isAlive && fallAmount > 260) {
                    const damage = Math.floor((fallAmount - 260) / 5);
                    entity.takeDamage(damage);
                    console.log(`💥 ${entity.name} took ${damage} fall damage (fell ${fallAmount.toFixed(1)}px from peak Y:${entity.peakY.toFixed(1)})`);

                    // If this is the current player's koala, end their turn
                    const currentKoala = this.game.getCurrentKoala();
                    const interactivePhase = this.game.phase === 'aiming' ||
                        this.game.phase === 'firing' || this.game.phase === 'armed';
                    if (entity === currentKoala && interactivePhase) {
                        console.log('🛑 Fall damage ends turn!');
                        this.game.endTurn();
                    }
                }

                // Accumulate into maxFallDistance for TurnManager summary
                entity.maxFallDistance = Math.max((entity.maxFallDistance || 0), fallAmount);
            }

            // Reset peakY now that we landed safely or took damage
            entity.peakY = entity.y;
            entity.fallDistance = 0; // Legacy property cleanup
        } else if (entity.vy < 0) {
            // Moving up, update peak
            entity.peakY = Math.min(entity.peakY, entity.y);
        }

        // INSTANT DEATH - check if entity touched water OR went out of side bounds (Ring Out)
        const waterLevel = this.game.worldHeight - 60;
        if (entity.isAlive && (entity.y > waterLevel || entity.x < -100 || entity.x > this.game.worldWidth + 100)) {
            entity.die();
            this.game.createSplash(entity.x, waterLevel);
            if (this.game.audioManager) {
                this.game.audioManager.playSplash();
                this.game.audioManager.playDeath();
            }
        }

        // World bounds - Remove horizontal clamping so they can fly out of bounds (Ring Out)
        // Only clamp vertical top to prevent flying permanently above screen
        entity.y = Math.max(-500, Math.min(this.game.worldHeight + 100, entity.y));
    }

    /**
     * Resolve collision with terrain
     */
    resolveTerrainCollision(entity) {
        const terrain = this.game.terrain;
        const wasOnGround = entity.onGround;
        entity.onGround = false;

        // Check feet
        // Check feet with "thick" raycast to prevent tunneling through thin terrain
        const footY = entity.y + entity.height / 2;

        // Check current foot position AND a few pixels up/down to catch thin lines
        // This acts as a poor man's Continuous Collision Detection (CCD)
        let hitGround = false;
        let groundY = Math.floor(footY);

        // Check 5 pixels range normally, but 10 pixels DOWN if we were already grounded
        // This "Sticky Feet" logic prevents vibrating off slopes or falling through thin floors
        const searchDown = wasOnGround ? 10 : 3;

        for (let offset = -2; offset <= searchDown; offset++) {
            if (terrain.checkCollision(entity.x, footY + offset)) {
                hitGround = true;
                groundY = Math.floor(footY + offset);
                break;
            }
        }

        if (hitGround) {
            // If entity is jumping upward, don't snap to ground
            // This prevents the "slide instead of jump" bug
            if (entity.vy < 0) {
                entity.onGround = false;
                return; // Let them leave the ground
            }

            // Find surface normal (walk up)
            while (groundY > 0 && terrain.checkCollision(entity.x, groundY)) {
                groundY--;
            }

            // Snap entity Y so it sits perfectly on the ground pixel
            const targetY = (groundY + 1) - entity.height / 2;

            // SMOOTH STICKY FEET: Limit downward snapping to prevent teleportation jitter on steep slopes
            if (entity.onGround && targetY > entity.y) {
                // Moving down slope: ease it (max 4px per frame)
                entity.y = Math.min(entity.y + 4, targetY);
            } else {
                // Moving up slope or initial landing: snap instantly
                entity.y = targetY;
            }

            entity.vy = 0;
            entity.onGround = true;

            // Reset jump/backflip state on landing
            entity.isJumping = false;
            entity.isBackflipping = false;
            entity.backflipRotation = 0;
        }

        // Check head (for ceilings)
        const headY = entity.y - entity.height / 2;
        if (terrain.checkCollision(entity.x, headY)) {
            let ceilingY = headY;
            while (ceilingY < this.game.worldHeight && terrain.checkCollision(entity.x, ceilingY)) {
                ceilingY++;
            }
            entity.y = ceilingY + entity.height / 2;
            entity.vy = Math.abs(entity.vy) * 0.5; // Bounce down
        }

        // Check sides
        const sideCheckY = entity.y;

        // Right side
        if (terrain.checkCollision(entity.x + entity.width / 2, sideCheckY)) {
            let wallX = entity.x + entity.width / 2;
            while (wallX > 0 && terrain.checkCollision(wallX, sideCheckY)) {
                wallX--;
            }
            entity.x = wallX - entity.width / 2;
            entity.vx = -entity.vx * this.bounciness;
        }

        // Left side
        if (terrain.checkCollision(entity.x - entity.width / 2, sideCheckY)) {
            let wallX = entity.x - entity.width / 2;
            while (wallX < this.game.worldWidth && terrain.checkCollision(wallX, sideCheckY)) {
                wallX++;
            }
            entity.x = wallX + entity.width / 2;
            entity.vx = -entity.vx * this.bounciness;
        }
    }

    /**
     * Update projectile physics
     */
    updateProjectile(proj, dt) {
        // Wind affects projectiles
        const windForce = this.game.wind * 100;

        // Apply gravity (some projectiles may have custom gravity)
        const gravityMult = proj.gravityMultiplier || 1;
        proj.vy += this.gravity * gravityMult * dt;

        // Apply wind
        if (proj.affectedByWind !== false) {
            proj.vx += windForce * dt;
        }

        // Apply velocity
        proj.x += proj.vx * dt;
        proj.y += proj.vy * dt;

        // Update rotation for visual
        proj.rotation = Math.atan2(proj.vy, proj.vx);
    }

    /**
     * Check if entity can walk up a slope or small bump
     * Allows stepping over obstacles up to maxClimb pixels high
     * Blocks movement if wall is taller than maxClimb
     */
    canWalkUp(entity, dx) {
        const terrain = this.game.terrain;
        const maxClimb = 8; // Max pixels to step up (user-specified)

        const newX = entity.x + dx;
        const footY = entity.y + entity.height / 2;

        // First check: Is the next position at foot level clear?
        if (!terrain.checkCollision(newX, footY)) {
            // Clear path - but we should also check for stepping DOWN onto slopes
            // Find where the ground actually is below the new position
            const maxStepDown = 16; // Snap down up to 16px - sticks to terrain well
            for (let down = 0; down <= maxStepDown; down++) {
                if (terrain.checkCollision(newX, footY + down)) {
                    // Found ground - snap to it (step down)
                    return { canMove: true, newY: entity.y + down };
                }
            }
            // No ground within 4px - allow move and let gravity handle falling
            return { canMove: true, newY: entity.y };
        }

        // Path is blocked at foot level - try stepping UP
        for (let climb = 1; climb <= maxClimb; climb++) {
            const testY = footY - climb;

            // Check if this height is clear
            if (!terrain.checkCollision(newX, testY)) {
                // Found air! But also verify the body can fit
                // Check a point at head level to ensure we're not walking into an overhang
                const headY = entity.y - entity.height / 2 - climb;
                if (!terrain.checkCollision(newX, headY)) {
                    return { canMove: true, newY: entity.y - climb };
                }
            }
        }

        // Wall is taller than maxClimb pixels - block movement
        return { canMove: false };
    }

    /**
     * Apply explosion force to an entity
     */
    applyExplosionForce(entity, explosionX, explosionY, force) {
        const dx = entity.x - explosionX;
        const dy = entity.y - explosionY;
        const dist = Math.hypot(dx, dy);

        if (dist > 0) {
            const nx = dx / dist;
            const ny = dy / dist;

            entity.vx += nx * force;
            entity.vy += ny * force;
            entity.onGround = false;
        }
    }
}
