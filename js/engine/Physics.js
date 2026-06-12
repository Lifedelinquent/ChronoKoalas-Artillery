/**
 * Physics System - Gravity, collisions, and movement
 */

export class Physics {
    constructor(game) {
        this.game = game;

        // Physics constants
        this.gravity = 400; // pixels per second squared
        // Worms Armageddon-style wind: at full strength the sideways pull is a
        // substantial fraction of gravity, enough to visibly bend a bazooka
        // shot or blow a slow lob backwards. game.wind (-1..1) scales this.
        this.windAccel = 240; // px/s² at |wind| = 1
        // Friction is now split between ground and air, and applied in a
        // frame-rate-independent way (see updateEntity). Air friction is nearly
        // 1.0 so jump/backflip arcs keep their horizontal momentum (no more
        // floaty near-vertical drops); ground friction is strong so a koala
        // stops where it lands instead of sliding down slopes.
        this.groundFriction = 0.80; // per 1/60s — kills residual slide in ~0.2s
        this.airFriction = 0.995;   // per 1/60s — negligible drag, natural arcs
        this.bounciness = 0.5;
        this.terminalVelocity = 800;

        // Worms-style slope rules: terrain steeper than stickSlope (rise/run,
        // 1.7 ≈ 60°) can't be stood on — landing there redirects momentum
        // along the slope and the koala skids downhill. Anything gentler is
        // standable, like Worms lets you perch on fairly steep hills. Once a
        // skid is going it only stops below slideRelease (hysteresis, so a
        // slide doesn't stutter on/off across bumpy pixels).
        this.stickSlope = 1.7;
        this.slideRelease = 1.2;
        this.slideFriction = 0.99; // per 1/60s — barely slows a downhill skid
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

        // Low gravity crate buff: everything falls gently during that team's turn
        const gravityScale = this.game.getCurrentTeam?.()?.buffs?.lowGravity ? 0.45 : 1;

        // Apply gravity (unless spawn protected)
        if (!entity.spawnTimer || entity.spawnTimer <= 0) {
            entity.vy += this.gravity * gravityScale * dt;
        } else {
            // Force zero velocity during spawn protection to "stick" the landing
            entity.vy = 0;
        }

        // Clamp velocity
        entity.vy = Math.min(entity.vy, this.terminalVelocity);

        // Parachute: caps descent to a gentle drift and rides the wind
        if (entity.parachuteActive && !entity.onGround && entity.vy > 0) {
            entity.parachuteDeployed = true;
            entity.vy = Math.min(entity.vy, 70);
            // WA parachutes ride the wind hard — drifting with a gale carries
            // you across the map, drifting against it barely moves you
            entity.vx += this.game.wind * 150 * dt;
            // A drifting descent shouldn't count as a damaging fall
            entity.peakY = entity.y;
        } else {
            entity.parachuteDeployed = false;
        }

        // Apply velocity
        entity.x += entity.vx * dt;
        entity.y += entity.vy * dt;

        // Apply friction (frame-rate independent). Strong on the ground so the
        // koala stops where it lands; nearly none while skidding down a steep
        // slope or in the air so jumps and backflips keep their momentum.
        const frictionCoeff = entity.onGround
            ? (entity.isSliding ? this.slideFriction : this.groundFriction)
            : this.airFriction;
        entity.vx *= Math.pow(frictionCoeff, dt * 60);

        // Terrain collision
        this.resolveTerrainCollision(entity);

        // Worms-style slope skid: accelerate downhill while standing on
        // terrain too steep to stick to
        this.updateSliding(entity, dt);

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

            // Bouncy launches: a koala slammed down by a hit rebounds and keeps
            // skipping like a stone instead of dead-stopping. Runs AFTER fall
            // damage so a hard fall still hurts — then bounces for flair.
            // ONLY knockback launches skip (Worms-style); jumps and plain
            // falls always plant so platforming stays predictable.
            if (entity.wasLaunched && entity.landingImpact > 250) {
                entity.vy = -entity.landingImpact * 0.45;
                entity.onGround = false;
                entity.spinVel *= 0.6; // keep tumbling, a touch calmer each bounce
                entity.peakY = entity.y;
                // Dust puff where they hit
                if (this.game.createExplosionParticles) {
                    this.game.createExplosionParticles(
                        entity.x, entity.y + entity.height / 2, 6, '#d9c7a3'
                    );
                }
            } else {
                // Came to rest (or never launched) — clear the hit state
                entity.wasLaunched = false;
            }
            entity.landingImpact = 0; // consumed — don't re-bounce next frame
        } else if (entity.vy < 0) {
            // Moving up, update peak
            entity.peakY = Math.min(entity.peakY, entity.y);
        }

        // INSTANT DEATH - check if entity touched water OR went out of side bounds (Ring Out)
        // waterLevel rises during sudden death, so read the live value off the game.
        const waterLevel = this.game.waterLevel;
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

        // Hit-reaction tumble + squash easing (purely visual). Uses the final
        // onGround for this frame: spin freely while airborne, settle upright
        // once planted, and relax squash/stretch back to neutral.
        if (entity.spin !== undefined) {
            if (entity.onGround) {
                entity.spinVel = 0;
                entity.spin += (0 - entity.spin) * Math.min(1, dt * 12);
                if (Math.abs(entity.spin) < 0.02) entity.spin = 0;
            } else {
                entity.spin += entity.spinVel * dt;
            }
            entity.squash += (1 - entity.squash) * Math.min(1, dt * 12);
        }
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

            const impactVy = entity.vy; // downward speed at the moment of contact
            entity.vy = 0;

            // Landing: Worms-style stick or slide. On walkable ground we
            // absorb most horizontal momentum so the koala plants where it
            // lands; on terrain steeper than stickSlope the fall is redirected
            // along the surface and they skid downhill instead.
            if (!wasOnGround) {
                const slope = this.getSlopeAt(entity.x, entity.y + entity.height / 2);
                const steep = slope !== null && Math.abs(slope) > this.stickSlope;

                if (steep) {
                    // Project incoming velocity onto the slope tangent so the
                    // impact speed carries into the skid
                    const t = 1 / Math.hypot(1, slope);
                    const vAlong = entity.vx * t + impactVy * slope * t;
                    entity.vx = vAlong * t;
                    entity.isSliding = true;
                } else {
                    const hard = entity.wasLaunched && impactVy > 250;
                    // Hard knockback slams keep more momentum so they skip
                    // across terrain; jumps and soft landings plant where
                    // they touch down.
                    entity.vx *= hard ? 0.7 : 0.4;
                    entity.isSliding = false;
                }

                // Stash the impact so updateEntity can bounce AFTER fall damage,
                // and squash the sprite proportional to how hard they hit.
                entity.landingImpact = impactVy;
                if (entity.squash !== undefined && impactVy > 60) {
                    entity.squash = 1 - Math.min(impactVy / 800, 1) * 0.45;
                }
            }

            entity.onGround = true;

            // Reset jump/backflip state on landing
            entity.isJumping = false;
            entity.isBackflipping = false;
            entity.backflipRotation = 0;
            entity.jumpType = null;
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
     * Measure the terrain slope under a point as rise/run (positive = ground
     * falls away to the right, since Y grows downward). Samples the surface
     * height a few pixels either side of x. Returns null when there's no
     * surface within range on one side (e.g. standing on a ledge lip).
     */
    getSlopeAt(x, footY) {
        const terrain = this.game.terrain;
        const span = 6;

        const surfaceY = (sx) => {
            if (terrain.checkCollision(sx, footY)) {
                // Inside terrain — walk up to the surface
                let y = footY;
                while (y > footY - 24 && terrain.checkCollision(sx, y - 1)) y--;
                return y;
            }
            // In air — scan down a short way for the surface
            for (let d = 1; d <= 18; d++) {
                if (terrain.checkCollision(sx, footY + d)) return footY + d;
            }
            return null;
        };

        const yL = surfaceY(x - span);
        const yR = surfaceY(x + span);
        if (yL === null || yR === null) return null;
        return (yR - yL) / (span * 2);
    }

    /**
     * Worms-style slope skid: while grounded on terrain steeper than
     * stickSlope, gravity pulls the entity downhill (slideFriction barely
     * slows it). Once the ground flattens out the strong groundFriction
     * takes over and they stop — i.e. you slide until you reach somewhere
     * you can stand.
     */
    updateSliding(entity, dt) {
        if (!entity.onGround) {
            entity.isSliding = false;
            return;
        }

        const slope = this.getSlopeAt(entity.x, entity.y + entity.height / 2);
        // Hysteresis: it takes stickSlope (~60°) to START a skid, but an
        // active skid keeps going until the ground eases below slideRelease
        const threshold = entity.isSliding ? this.slideRelease : this.stickSlope;
        const steep = slope !== null && Math.abs(slope) > threshold;

        if (steep) {
            entity.isSliding = true;
            const downhill = slope > 0 ? 1 : -1;
            const angle = Math.atan(Math.abs(slope));
            entity.vx += downhill * this.gravity * Math.sin(angle) * dt;
        } else {
            entity.isSliding = false;
        }
    }

    /**
     * Update projectile physics
     */
    updateProjectile(proj, dt) {
        // Wind affects projectiles
        const windForce = this.game.wind * this.windAccel;

        // Apply gravity (some projectiles may have custom gravity;
        // the low-gravity crate buff floats shots too)
        const gravityScale = this.game.getCurrentTeam?.()?.buffs?.lowGravity ? 0.45 : 1;
        const gravityMult = proj.gravityMultiplier || 1;
        proj.vy += this.gravity * gravityMult * gravityScale * dt;

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
