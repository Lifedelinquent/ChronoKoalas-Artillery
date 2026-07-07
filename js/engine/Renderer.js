/**
 * Renderer - Draws the game world
 */

export class Renderer {
    constructor(game) {
        this.game = game;
        this.canvas = game.canvas;
        this.ctx = game.ctx;

        // Sky gradient
        this.skyGradient = null;
        this.createSkyGradient();

        // Water animation
        this.waterOffset = 0;
        // Eased water-surface Y, lerped toward game.waterLevel so sudden-death
        // rises glide up instead of snapping. Initialized on first draw.
        this.renderWaterY = null;

        // Load Sprites
        this.sprites = {
            red: new Image(),
            blue: new Image(),
            weapons: {}
        };

        // Load character sprites
        this.loadTransparentSprite('assets/koala_red.png', 'red');
        this.loadTransparentSprite('assets/koala_blue.png', 'blue');

        // Load weapon sprites
        this.sprites.weapons = {};
        const weapons = [
            'bazooka', 'grenade', 'shotgun', 'bat', 'dynamite',
            'airstrike', 'teleport', 'rope', 'mine', 'holygrenade', 'blowtorch'
        ];
        weapons.forEach(w => {
            this.sprites.weapons[w] = new Image();
            // Use same transparent loader for weapons
            this.loadTransparentSprite(`assets/weapon_${w}.png`, `weapon_${w}`);
        });

        // Tinted koala variants for teams beyond red/blue (green/yellow in
        // 4-player games) — built lazily from the red sprite, cached per colour
        this.tintedSprites = {};
    }

    /**
     * Sprite (Image or canvas) for a team colour. Red and blue have real
     * art; any other colour gets the red sprite recoloured with a
     * source-atop overlay so 4-player squads stay tellable apart.
     */
    getTeamSprite(color) {
        const c = (color || '').toLowerCase();
        if (c === '#3498db') return this.sprites.blue;
        if (c === '#e74c3c' || !c) return this.sprites.red;

        const base = this.sprites.red;
        // Rebuild the tint if the base sprite was swapped for the processed
        // (background-removed) version after we cached
        const cached = this.tintedSprites[c];
        if (cached && cached.base === base) return cached.canvas;

        if (!base.complete || base.naturalHeight === 0) return base;

        const canvas = document.createElement('canvas');
        canvas.width = base.naturalWidth;
        canvas.height = base.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(base, 0, 0);
        ctx.globalCompositeOperation = 'source-atop';
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        this.tintedSprites[c] = { base, canvas };
        return canvas;
    }

    /**
     * True when a team sprite (Image or tinted canvas) is drawable
     */
    isSpriteReady(sprite) {
        if (!sprite) return false;
        if (sprite instanceof HTMLCanvasElement) return true;
        return sprite.complete && sprite.naturalHeight !== 0;
    }

    /**
     * Load sprite and remove background (client-side chroma key)
     */
    loadTransparentSprite(src, key) {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.src = src;

        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');

            // Draw original image
            ctx.drawImage(img, 0, 0);

            // Get pixel data
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;

            // Flood Fill Algorithm to remove background starting from corners
            // This prevents removing white parts inside the sprite (eyes, etc)
            const w = canvas.width;
            const h = canvas.height;
            const visited = new Uint8Array(w * h);
            const queue = [];

            // Add corners to queue
            const addPixel = (x, y) => {
                if (x >= 0 && x < w && y >= 0 && y < h) {
                    queue.push(y * w + x);
                }
            };

            addPixel(0, 0);
            addPixel(w - 1, 0);
            addPixel(0, h - 1);
            addPixel(w - 1, h - 1);

            // Get background reference color from top-left
            const bgR = data[0];
            const bgG = data[1];
            const bgB = data[2];
            const tolerance = 50; // High tolerance for compression artifacts

            while (queue.length > 0) {
                const idx = queue.pop();
                if (visited[idx]) continue;
                visited[idx] = 1;

                const i = idx * 4;
                const r = data[i];
                const g = data[i + 1];
                const b = data[i + 2];

                // Check if this pixel matches background (using top-left as valid ref)
                // Or is very bright white (safety for white backgrounds)
                const isBg = (Math.abs(r - bgR) <= tolerance &&
                    Math.abs(g - bgG) <= tolerance &&
                    Math.abs(b - bgB) <= tolerance) ||
                    (r > 230 && g > 230 && b > 230);

                if (isBg) {
                    data[i + 3] = 0; // Make transparent

                    // Add neighbors
                    const x = idx % w;
                    const y = Math.floor(idx / w);

                    // Simple 4-way connectivity
                    if (x > 0 && !visited[idx - 1]) queue.push(idx - 1);
                    if (x < w - 1 && !visited[idx + 1]) queue.push(idx + 1);
                    if (y > 0 && !visited[idx - w]) queue.push(idx - w);
                    if (y < h - 1 && !visited[idx + w]) queue.push(idx + w);
                }
            }

            // Put processed data back
            ctx.putImageData(imageData, 0, 0);

            // Create a new image from the processed canvas
            const processedImg = new Image();
            processedImg.src = canvas.toDataURL();

            // Update the sprite registry
            // Handle storing in nested weapon object or root sprite object
            if (key.startsWith('weapon_')) {
                const weaponName = key.replace('weapon_', '');
                this.sprites.weapons[weaponName] = processedImg;
            } else {
                this.sprites[key] = processedImg;
            }
        };
    }

    /**
     * Create sky background gradient
     */
    createSkyGradient() {
        this.skyGradient = this.ctx.createLinearGradient(0, 0, 0, this.game.worldHeight);
        this.skyGradient.addColorStop(0, '#1e3c72');
        this.skyGradient.addColorStop(0.3, '#2a5298');
        this.skyGradient.addColorStop(0.6, '#87CEEB');
        this.skyGradient.addColorStop(1, '#e0f7fa');
    }

    /**
     * Main render function
     */
    render() {
        const ctx = this.ctx;
        const camera = this.game.camera;

        // Clear canvas
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Draw sky (fixed, not affected by camera)
        this.drawSky();

        // Apply camera transform
        // IMPORTANT: scale THEN translate so screen = (world - camera) * zoom,
        // matching the input mapping (world = screen / zoom + camera)
        ctx.save();

        // Screen shake offset (decays in Game.updateCamera)
        let shakeX = 0, shakeY = 0;
        const shake = this.game.camera.shake;
        if (shake && shake.time > 0) {
            const falloff = shake.time / shake.duration;
            shakeX = (Math.random() - 0.5) * 2 * shake.intensity * falloff;
            shakeY = (Math.random() - 0.5) * 2 * shake.intensity * falloff;
        }

        ctx.scale(camera.zoom, camera.zoom);
        ctx.translate(-camera.x + shakeX, -camera.y + shakeY);

        // Draw clouds (parallax)
        this.drawClouds();

        // Draw terrain
        this.drawTerrain();

        // Draw loot crates
        this.drawLootCrates();

        // Draw oil drums (map hazards)
        this.drawOilDrums();

        // Draw the ninja rope (behind its koala)
        this.drawRope();

        // Draw koalas
        this.drawKoalas();

        // Draw projectiles
        this.drawProjectiles();

        // Draw burning ground (petrol / napalm)
        this.drawFirePatches();

        // Draw particles
        this.drawParticles();

        // Draw weather (rain/snow/ash in front of the action, WA-style)
        this.game.weather.render(ctx);

        // Draw water
        this.drawWater();

        // Draw aiming indicator
        this.drawAimingIndicator();

        // Restore transform
        ctx.restore();

        // Draw HUD elements (not affected by camera)
        this.drawCountdown();
    }

    /**
     * Draw sky background
     */
    drawSky() {
        // Use custom background color if set (from custom maps)
        if (this.game.customBackgroundColor) {
            this.ctx.fillStyle = this.game.customBackgroundColor;
        } else {
            // Themed sky for generated maps (falls back to the default
            // gradient for custom/editor maps with no theme)
            const theme = this.game.terrain.theme;
            if (theme && (this._skyThemeId !== theme.id || this._skyHeight !== this.canvas.height)) {
                const grad = this.ctx.createLinearGradient(0, 0, 0, this.canvas.height);
                const stops = [0, 0.35, 0.7, 1];
                theme.sky.forEach((color, i) => grad.addColorStop(stops[i], color));
                this.skyGradient = grad;
                this._skyThemeId = theme.id;
                this._skyHeight = this.canvas.height;
            }
            this.ctx.fillStyle = this.skyGradient;
        }
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    /**
     * Draw parallax clouds
     */
    drawClouds() {
        const ctx = this.ctx;
        const camera = this.game.camera;

        ctx.fillStyle = this.game.terrain.theme?.cloud || 'rgba(255, 255, 255, 0.8)';

        // Clouds drift with the wind (WA-style), wrapping around the world
        this.cloudDrift = (this.cloudDrift || 0) + this.game.wind * 0.6;
        const span = this.game.worldWidth + 600;

        // Simple cloud shapes with parallax
        const clouds = [
            { x: 200, y: 100, w: 120, h: 40 },
            { x: 600, y: 150, w: 100, h: 35 },
            { x: 1100, y: 80, w: 150, h: 50 },
            { x: 1600, y: 120, w: 90, h: 30 },
            { x: 2000, y: 90, w: 130, h: 45 }
        ];

        for (const cloud of clouds) {
            // Parallax effect - clouds move slower than camera
            const driftX = ((cloud.x + this.cloudDrift) % span + span) % span - 300;
            const parallaxX = driftX - camera.x * 0.3;
            const parallaxY = cloud.y;

            // Draw cloud as overlapping circles
            ctx.beginPath();
            ctx.ellipse(parallaxX, parallaxY, cloud.w * 0.4, cloud.h, 0, 0, Math.PI * 2);
            ctx.ellipse(parallaxX - cloud.w * 0.3, parallaxY + 5, cloud.w * 0.3, cloud.h * 0.8, 0, 0, Math.PI * 2);
            ctx.ellipse(parallaxX + cloud.w * 0.3, parallaxY + 5, cloud.w * 0.35, cloud.h * 0.9, 0, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    /**
     * Draw terrain
     */
    drawTerrain() {
        const terrainCanvas = this.game.terrain.getCanvas();
        this.ctx.drawImage(terrainCanvas, 0, 0);
    }

    /**
     * Draw all koalas (alive and dead)
     */
    drawKoalas() {
        const ctx = this.ctx;
        const currentKoala = this.game.getCurrentKoala();

        for (const team of this.game.teams) {
            for (const koala of team.koalas) {
                // Draw dead koalas first (so alive ones render on top)
                if (!koala.isAlive) {
                    this.drawDeadKoala(koala);
                }
            }
        }

        // Draw alive koalas
        for (const team of this.game.teams) {
            for (const koala of team.koalas) {
                if (koala.isAlive) {
                    const isCurrent = koala === currentKoala;
                    this.drawKoala(koala, isCurrent);
                }
            }
        }
    }

    /**
     * Draw a single koala
     */
    drawKoala(koala, isCurrent) {
        const ctx = this.ctx;
        const x = Math.round(koala.x);
        const y = Math.round(koala.y);

        ctx.save();
        ctx.translate(x, y);

        // Parachute canopy while drifting down
        if (koala.parachuteDeployed) {
            ctx.fillStyle = '#e74c3c';
            ctx.beginPath();
            ctx.arc(0, -45, 26, Math.PI, 0);
            ctx.fill();
            ctx.fillStyle = '#f5f5f0';
            ctx.beginPath();
            ctx.arc(0, -45, 26, Math.PI + 0.6, Math.PI + 1.2);
            ctx.arc(0, -45, 26, -1.2, -0.6);
            ctx.lineTo(0, -45);
            ctx.fill();

            // Strings
            ctx.strokeStyle = '#888';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(-22, -38); ctx.lineTo(-6, -8);
            ctx.moveTo(22, -38); ctx.lineTo(6, -8);
            ctx.moveTo(0, -45); ctx.lineTo(0, -10);
            ctx.stroke();
        }

        // Apply backflip rotation if active
        if (koala.isBackflipping && koala.backflipRotation) {
            ctx.rotate(koala.backflipRotation);
        }

        // Hit-reaction tumble: rotate the whole body when launched
        if (koala.spin) {
            ctx.rotate(koala.spin);
        }

        // Squash & stretch: flatten and widen on hard landings, ease back to 1
        if (koala.squash !== undefined && koala.squash !== 1) {
            ctx.scale(2 - koala.squash, koala.squash);
        }

        // Flip based on facing direction
        // We need to know scale X for weapon rotation logic
        const scaleX = koala.facingLeft ? -1 : 1;
        if (koala.facingLeft) {
            ctx.scale(-1, 1);
        }

        // Determine sprite based on team color
        const sprite = this.getTeamSprite(koala.team.color);

        // Draw Koala Sprite
        if (this.isSpriteReady(sprite)) {
            const size = 48; // Original size
            // Draw centered but slightly moved up to align feet with ground
            ctx.drawImage(sprite, -size / 2, -size / 2 - 2, size, size);
        } else {
            // Fallback: draw minimal placeholder
            ctx.fillStyle = koala.team.color;
            ctx.fillRect(-10, -15, 20, 30);
        }

        // Draw Weapon (if current koala)
        if (isCurrent) {
            const currentWeapon = this.game.weaponManager.currentWeapon;
            if (currentWeapon && this.sprites.weapons[currentWeapon.id]) {
                const weaponSprite = this.sprites.weapons[currentWeapon.id];
                if (weaponSprite.complete && weaponSprite.naturalHeight !== 0) {
                    ctx.save();

                    // Position weapon at "hand" position (center of body, slightly up)
                    // Matches the (-10) offset in InputManager for perfect aiming alignment
                    ctx.translate(0, -10);

                    // Rotate weapon to aim angle
                    // aimAngle is world angle. Since we scaled by -1 if facing left, we need to adjust
                    let rotation = koala.aimAngle;
                    if (koala.facingLeft) {
                        // Mirror angle across Y axis logic
                        rotation = Math.PI - rotation;
                    }

                    // Apply melee swing rotation
                    if (koala.isSwinging) {
                        // Swing in a 180-degree arc (-90 to +90 degrees relative to aim)
                        const swingArc = Math.PI;
                        const swingOffset = (koala.swingProgress - 0.5) * swingArc;
                        rotation += swingOffset;
                    }

                    ctx.rotate(rotation);

                    // Draw weapon slightly offset so it looks held
                    const wSize = 32; // Standard weapon sprite size
                    // Draw from the center of the weapon sprite, slightly offset
                    // The weapon's "pivot" point is its center, so we draw it centered
                    // at the translated origin (0,0) after rotation.
                    // Adjust x-offset to make it look like it's held forward.
                    // Adjust y-offset to align with hand.
                    ctx.drawImage(weaponSprite, 0, -wSize / 2, wSize, wSize);

                    // Check for fuse timer indicator while aiming/held (only for current player)
                    // Only show if it's adjustable (usesTimer is true but fixedTimer is not defined)
                    if (isCurrent && currentWeapon && currentWeapon.usesTimer && currentWeapon.fixedTimer === undefined) {
                        ctx.save();
                        // Draw near weapon, UPRIGHT (un-rotate the aim rotation)
                        ctx.rotate(-rotation);
                        // Translate to position slightly above and forward of the weapon
                        ctx.translate(15, -15);
                        ctx.fillStyle = '#fff';
                        ctx.strokeStyle = '#000';
                        ctx.lineWidth = 3;
                        ctx.font = 'bold 16px Arial';
                        ctx.textAlign = 'center';
                        const timerValue = (currentWeapon.fixedTimer !== undefined) ? currentWeapon.fixedTimer : (this.game.weaponManager.timer || 3);
                        ctx.strokeText(timerValue, 0, 0);
                        ctx.fillText(timerValue, 0, 0);
                        ctx.restore();
                    }

                    ctx.restore();
                }
            }
        }

        ctx.restore();

        // Health bar above koala
        this.drawHealthBar(koala);

        // Current koala indicator
        if (isCurrent) {
            this.drawCurrentIndicator(koala);
        }

        // Name tag
        this.drawNameTag(koala);
    }

    /**
     * Draw a dead koala (ghost sprite - faded, tilted, with halo)
     */
    drawDeadKoala(koala) {
        const ctx = this.ctx;
        const x = Math.round(koala.x);
        const y = Math.round(koala.y);

        ctx.save();
        ctx.translate(x, y);

        // Ghost effect: semi-transparent
        ctx.globalAlpha = 0.5;

        // Fallen over - tilted 90 degrees. While being flung by an explosion
        // (airborne), add the tumble spin so corpses ragdoll instead of gliding.
        ctx.rotate(Math.PI / 2 + (koala.onGround ? 0 : (koala.spin || 0)));

        // Determine sprite based on team color
        const sprite = this.getTeamSprite(koala.team.color);

        // Draw faded koala sprite
        if (this.isSpriteReady(sprite)) {
            const size = 48;
            ctx.drawImage(sprite, -size / 2, -size / 2 - 2, size, size);
        } else {
            // Fallback: draw grey placeholder
            ctx.fillStyle = '#666';
            ctx.fillRect(-10, -15, 20, 30);
        }

        ctx.restore();

        // Draw halo above the body (not rotated)
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = '#ffd700'; // Gold
        ctx.lineWidth = 2;

        // Floating animation
        const floatOffset = Math.sin(performance.now() / 500) * 3;

        // Draw halo ellipse above the koala
        ctx.beginPath();
        ctx.ellipse(x, y - 35 + floatOffset, 12, 4, 0, 0, Math.PI * 2);
        ctx.stroke();

        // Draw halo glow
        ctx.strokeStyle = 'rgba(255, 215, 0, 0.3)';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.ellipse(x, y - 35 + floatOffset, 14, 5, 0, 0, Math.PI * 2);
        ctx.stroke();

        ctx.restore();

        // Draw name tag (faded)
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.font = 'bold 10px Outfit';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.lineWidth = 2;
        ctx.strokeText(koala.name, x, y - 50 + floatOffset);
        ctx.fillStyle = '#888';
        ctx.fillText(koala.name, x, y - 50 + floatOffset);
        ctx.restore();
    }

    /**
     * Draw health number above koala (replaces bar)
     */
    drawHealthBar(koala) {
        const ctx = this.ctx;
        const x = koala.x;
        const y = koala.y - 38;
        const health = Math.ceil(koala.health);
        // Color relative to the scheme-defined max, not a hardcoded 100
        const healthPercent = koala.health / (koala.maxHealth || 100);

        // Health color based on percentage
        const healthColor = healthPercent > 0.5 ? '#2ecc71' :
            healthPercent > 0.25 ? '#f1c40f' : '#e74c3c';

        // Draw pill-shaped background
        const text = health.toString();
        ctx.font = 'bold 14px Outfit';
        const textWidth = ctx.measureText(text).width;
        const pillWidth = textWidth + 10;
        const pillHeight = 16;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.beginPath();
        ctx.roundRect(x - pillWidth / 2, y - pillHeight / 2, pillWidth, pillHeight, 8);
        ctx.fill();

        // Draw colored border
        ctx.strokeStyle = healthColor;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Draw health number
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        ctx.fillText(text, x, y);
    }

    /**
     * Draw arrow indicator above current koala
     */
    drawCurrentIndicator(koala) {
        const ctx = this.ctx;
        const x = Math.round(koala.x);
        const y = Math.round(koala.y - 70); // Higher to clear name tag
        const time = performance.now() / 600; // Slower timing
        const bounce = Math.sin(time) * 3; // Reduced bounce height

        ctx.fillStyle = koala.team.color;
        ctx.beginPath();
        ctx.moveTo(x, y + bounce + 8);
        ctx.lineTo(x - 6, y + bounce);
        ctx.lineTo(x + 6, y + bounce);
        ctx.closePath();
        ctx.fill();
    }

    /**
     * Draw name tag with style
     */
    drawNameTag(koala) {
        const ctx = this.ctx;
        const x = koala.x;
        const y = koala.y - 55;

        ctx.font = 'bold 12px Outfit';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Draw outline/shadow for visibility
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.lineWidth = 3;
        ctx.strokeText(koala.name, x, y);

        // Draw text in team color
        ctx.fillStyle = koala.team.color;
        ctx.fillText(koala.name, x, y);
    }

    /**
     * Draw aiming indicator
     */
    drawAimingIndicator() {
        const phase = this.game.phase;
        if (phase !== 'aiming' && phase !== 'firing' && phase !== 'armed' && phase !== 'rope') return;

        const koala = this.game.getCurrentKoala();
        if (!koala) return;

        const ctx = this.ctx;
        const weapon = this.game.weaponManager.currentWeapon;

        // Check if this is a targetted weapon (airstrike, teleport)
        if (weapon && weapon.targetted) {
            this.drawTargetCursor(ctx, koala.team.color, weapon.type);
            return;
        }

        // Homing missile: show the placed target marker; until one is placed,
        // the mouse is a placement cursor and there's nothing to aim yet
        if (weapon && weapon.requiresTarget) {
            if (!this.game.homingTarget) {
                if (phase === 'aiming') {
                    this.drawTargetCursor(ctx, koala.team.color, weapon.type);
                }
                return;
            }
            this.drawHomingTargetMarker(this.game.homingTarget.x, this.game.homingTarget.y);
        }

        // Regular aiming indicator
        // aimAngle is now the world angle directly (full 360)
        const worldAngle = koala.aimAngle;
        const armed = phase === 'armed';

        const length = 50;
        const startX = koala.x;
        const startY = koala.y - 10;
        const endX = startX + Math.cos(worldAngle) * length;
        const endY = startY + Math.sin(worldAngle) * length;

        // When armed, the reticle glows gold and pulses to signal "ready to fire"
        const reticleColor = armed ? '#ffd54a' : koala.team.color;

        // Dotted aim line from koala
        ctx.save();
        ctx.strokeStyle = reticleColor;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Crosshair at end — armed gets a pulsing glowing ring
        if (armed) {
            const t = performance.now() / 1000;
            const pulse = 6 + Math.sin(t * 6) * 2;
            ctx.shadowColor = reticleColor;
            ctx.shadowBlur = 12;
            ctx.strokeStyle = reticleColor;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(endX, endY, pulse, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.fillStyle = reticleColor;
        ctx.beginPath();
        ctx.arc(endX, endY, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Trajectory preview while charging (live) or armed (locked-in)
        if ((phase === 'firing' || armed) && weapon && weapon.speed > 0 &&
            !weapon.targetted && weapon.type !== 'melee' && weapon.type !== 'blowtorch') {
            this.drawTrajectoryPreview(koala, weapon, worldAngle, armed);
        }
    }

    /**
     * Draw a short trajectory hint while charging or armed.
     * Worms-style: only the first stretch of the arc is shown, wind is NOT
     * factored in, and there is no impact marker — the player judges the
     * landing spot (and the wind) themselves.
     */
    drawTrajectoryPreview(koala, weapon, angle, armed) {
        const ctx = this.ctx;
        const wm = this.game.weaponManager;
        // While armed the power is locked; renderer still reads it from wm.power
        const power = Math.max(0.2, wm.power / wm.maxPower);
        const speed = weapon.speed * power;

        const spawnOffset = 30;
        let x = koala.x + Math.cos(angle) * spawnOffset;
        let y = (koala.y - 10) + Math.sin(angle) * spawnOffset;
        let vx = Math.cos(angle) * speed;
        let vy = Math.sin(angle) * speed;

        // Gravity only — deliberately ignoring wind so the real flight
        // deviates from the hint and you have to read the wind gauge
        const gravity = this.game.physics.gravity * (weapon.gravity ?? 1);

        const step = 1 / 60;
        const maxSteps = 45; // ~0.75s of flight — just the launch direction

        const points = [];
        for (let i = 0; i < maxSteps; i++) {
            vy += gravity * step;
            x += vx * step;
            y += vy * step;

            if (this.game.terrain.checkCollision(x, y)) break;
            if (y > this.game.worldHeight) break;
            if (x < 0 || x > this.game.worldWidth) break;

            points.push(x, y);
        }

        ctx.save();

        // Brighter once the shot is locked in; the hint fades out hard toward
        // its end so it reads as a direction, not a destination
        const baseColor = armed ? '255, 213, 74' : '255, 255, 255';
        const dotSpacing = 5;        // draw a dot every N samples
        const flow = Math.floor(performance.now() / 45); // marching offset for "flow"

        for (let p = 0; p < points.length / 2; p++) {
            if ((p + flow) % dotSpacing !== 0) continue;
            const px = points[p * 2];
            const py = points[p * 2 + 1];
            const progress = p / (points.length / 2);
            const alpha = (armed ? 0.9 : 0.75) * (1 - progress * 0.95);
            const radius = armed ? 3 : 2.5;
            ctx.globalAlpha = alpha;
            ctx.fillStyle = `rgba(${baseColor}, 1)`;
            ctx.beginPath();
            ctx.arc(px, py, radius, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();

        // Floating "CLICK TO FIRE" prompt above the reticle when armed
        if (armed) {
            this.drawFirePrompt(koala, angle);
        }
    }

    /**
     * Floating, pulsing "CLICK TO FIRE" prompt shown while a shot is armed.
     */
    drawFirePrompt(koala, angle) {
        const ctx = this.ctx;
        const t = performance.now() / 1000;
        const alpha = 0.7 + Math.sin(t * 5) * 0.3;

        const px = koala.x;
        const py = koala.y - 55;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = 'bold 13px Outfit, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const text = 'CLICK TO FIRE';
        const w = ctx.measureText(text).width + 16;

        // Pill background
        ctx.globalAlpha = alpha * 0.85;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        this._roundRect(ctx, px - w / 2, py - 11, w, 22, 11);
        ctx.fill();

        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#ffd54a';
        ctx.fillText(text, px, py);
        ctx.restore();
    }

    /**
     * Small helper: trace a rounded rectangle path.
     */
    _roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    /**
     * Draw pre-match countdown overlay
     */
    drawCountdown() {
        if (this.game.phase !== 'countdown') return;

        const ctx = this.ctx;
        const timer = this.game.countdownTimer;

        // Darken screen slightly
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        // Calculate text, scale, and alpha for smooth animation
        let text = '';
        let scale = 1.0;
        let alpha = 1.0;

        if (timer > 0.5) {
            // Numbers phase: 3, 2, 1
            const secondsLeft = Math.ceil(timer - 0.5);
            text = secondsLeft.toString();

            // Calculate progress within current second (1.0 -> 0.0)
            const timeIntoSecond = (timer - 0.5) % 1.0;
            const progress = timeIntoSecond === 0 ? 1.0 : timeIntoSecond;

            // Scale: starts at 2.0 and shrinks to 1.0 over the second
            scale = 1.0 + progress;
        } else {
            // GO! phase (last 0.5 seconds)
            text = 'GO!';

            // Scale: explodes outward from 1.0 to 3.0
            const goProgress = (0.5 - timer) / 0.5; // 0.0 -> 1.0
            scale = 1.0 + goProgress * 2.0;

            // Fade out as it grows
            alpha = 1.0 - goProgress;
        }

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
        ctx.scale(scale, scale);

        // Draw shadow/outline
        ctx.font = 'bold 120px Outfit';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        ctx.strokeStyle = '#000';
        ctx.lineWidth = 10;
        ctx.strokeText(text, 0, 0);

        // Draw main text with gradient
        const grad = ctx.createLinearGradient(0, -60, 0, 60);
        grad.addColorStop(0, '#fff');
        grad.addColorStop(1, '#ffd700'); // Gold
        ctx.fillStyle = grad;
        ctx.fillText(text, 0, 0);

        ctx.restore();
    }

    /**
     * Draw the homing missile's placed target marker — a WA-style red/white
     * bullseye that pulses gently so it stays visible over any terrain
     */
    drawHomingTargetMarker(x, y) {
        const ctx = this.ctx;
        const pulse = 1 + Math.sin(performance.now() / 200) * 0.1;

        ctx.save();
        ctx.translate(x, y);
        ctx.scale(pulse, pulse);

        // Concentric bullseye rings
        ctx.fillStyle = '#d92b2b';
        ctx.beginPath();
        ctx.arc(0, 0, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(0, 0, 9.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#d92b2b';
        ctx.beginPath();
        ctx.arc(0, 0, 5, 0, Math.PI * 2);
        ctx.fill();

        // Thin outline so it reads against bright backgrounds too
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, 14, 0, Math.PI * 2);
        ctx.stroke();

        ctx.restore();
    }

    /**
     * Draw target cursor for targetted weapons
     */
    drawTargetCursor(ctx, color, weaponType) {
        const mouse = this.game.inputManager.mouse;
        const x = mouse.x;
        const y = mouse.y;

        const time = performance.now() / 500;
        const pulseSize = 20 + Math.sin(time * 3) * 5;

        // Outer pulsing circle
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, pulseSize, 0, Math.PI * 2);
        ctx.stroke();

        // Inner crosshair
        ctx.lineWidth = 2;
        ctx.beginPath();
        // Horizontal line
        ctx.moveTo(x - 10, y);
        ctx.lineTo(x + 10, y);
        // Vertical line
        ctx.moveTo(x, y - 10);
        ctx.lineTo(x, y + 10);
        ctx.stroke();

        // Center dot
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();

        // Weapon-specific indicator
        if (weaponType === 'airstrike') {
            // Show bombing zone (horizontal line where bombs will fall)
            ctx.strokeStyle = 'rgba(255, 100, 100, 0.5)';
            ctx.lineWidth = 3;
            ctx.setLineDash([10, 5]);
            ctx.beginPath();
            ctx.moveTo(x - 75, 30);
            ctx.lineTo(x + 75, 30);
            ctx.stroke();
            ctx.setLineDash([]);

            // Arrow pointing down
            ctx.fillStyle = 'rgba(255, 100, 100, 0.7)';
            for (let i = 0; i < 5; i++) {
                const bx = x - 75 + (i * 37.5);
                ctx.beginPath();
                ctx.moveTo(bx, 40);
                ctx.lineTo(bx - 5, 30);
                ctx.lineTo(bx + 5, 30);
                ctx.closePath();
                ctx.fill();
            }
        } else if (weaponType === 'teleport') {
            // Show teleport destination with sparkle effect
            ctx.strokeStyle = '#00ffff';
            ctx.lineWidth = 1;
            const sparkleCount = 8;
            for (let i = 0; i < sparkleCount; i++) {
                const angle = (i / sparkleCount) * Math.PI * 2 + time;
                const dist = 25 + Math.sin(time * 2 + i) * 5;
                const sx = x + Math.cos(angle) * dist;
                const sy = y + Math.sin(angle) * dist;
                ctx.beginPath();
                ctx.arc(sx, sy, 2, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
    }

    /**
     * Draw the ninja rope: taut segments from the koala's hands through every
     * wrap pivot to the anchor, plus a little grapple claw at the hook.
     */
    drawRope() {
        const rs = this.game.ropeState;
        if (!rs || !rs.koala) return;

        const ctx = this.ctx;
        const koala = rs.koala;
        const hx = koala.x;
        const hy = koala.y - 8; // Game.ROPE_HAND_OFFSET

        // Points from anchor to hands
        const points = rs.mode === 'attached'
            ? [...rs.pivots.map(p => ({ x: p.x, y: p.y })), { x: hx, y: hy }]
            : [{ x: rs.hook.x, y: rs.hook.y }, { x: hx, y: hy }];

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Dark core with a light highlight on top reads as a twisted rope
        ctx.strokeStyle = '#5b3d22';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.stroke();

        ctx.strokeStyle = '#a97b4d';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // Grapple claw at the hook end
        const hook = points[0];
        const next = points[1];
        const ang = Math.atan2(hook.y - next.y, hook.x - next.x);
        ctx.strokeStyle = '#c8ccd4';
        ctx.lineWidth = 2.5;
        for (const spread of [-0.7, 0, 0.7]) {
            ctx.beginPath();
            ctx.moveTo(hook.x, hook.y);
            ctx.lineTo(hook.x + Math.cos(ang + spread) * 7,
                hook.y + Math.sin(ang + spread) * 7);
            ctx.stroke();
        }

        ctx.restore();
    }

    /**
     * Draw projectiles
     */
    drawProjectiles() {
        const ctx = this.ctx;

        for (const proj of this.game.projectiles) {
            // In-flight homing missiles keep their target marker visible
            if (proj.homingTarget) {
                this.drawHomingTargetMarker(proj.homingTarget.x, proj.homingTarget.y);
            }

            ctx.save();
            ctx.translate(proj.x, proj.y);
            ctx.rotate(proj.rotation || 0);

            // Draw based on weapon type
            switch (proj.type) {
                case 'bazooka':
                case 'airstrike':
                case 'homing':
                    this.drawRocket(ctx);
                    break;
                case 'grenade':
                    this.drawGrenade(ctx, proj);
                    break;
                case 'shotgun':
                case 'gunburst':
                    this.drawPellet(ctx, proj);
                    break;
                case 'dynamite':
                    this.drawDynamite(ctx, proj);
                    break;
                case 'mine':
                    this.drawMine(ctx, proj);
                    break;
                case 'holygrenade':
                    this.drawHolyGrenade(ctx, proj);
                    break;
                case 'mortar':
                    this.drawMortarShell(ctx);
                    break;
                case 'cluster':
                case 'clusterFrag':
                    this.drawClusterBomb(ctx, proj);
                    break;
                case 'banana':
                    this.drawBanana(ctx);
                    break;
                case 'petrol':
                    this.drawPetrolBomb(ctx);
                    break;
                case 'arrow':
                    this.drawArrow(ctx);
                    break;
                case 'sheep':
                    this.drawSheep(ctx, proj);
                    break;
                case 'meteor':
                    this.drawMeteor(ctx);
                    break;
                default:
                    this.drawDefaultProjectile(ctx, proj);
            }

            ctx.restore();

            // Draw timer indicator if active and started - UPRIGHT
            // User requested: Hide timer on grenades after throw (they only want it before throw)
            if (proj.timerStarted && proj.timer !== null && proj.type !== 'grenade') {
                const timeLeft = Math.ceil(proj.timer - proj.timeOnGround);
                if (timeLeft >= 0) {
                    ctx.save();
                    ctx.translate(proj.x, proj.y);
                    ctx.fillStyle = '#fff';
                    ctx.strokeStyle = '#000';
                    ctx.lineWidth = 3;
                    ctx.font = 'bold 18px Arial';
                    ctx.textAlign = 'center';
                    ctx.strokeText(timeLeft, 0, -25);
                    ctx.fillText(timeLeft, 0, -25);
                    ctx.restore();
                }
            } else if (proj.isTriggered && proj.triggerTimer !== undefined) {
                // Show countdown for triggered mines
                const timeLeft = Math.ceil(proj.triggerDelay - proj.triggerTimer);
                if (timeLeft >= 0) {
                    ctx.save();
                    ctx.translate(proj.x, proj.y);
                    ctx.fillStyle = '#ff0'; // Yellow for triggered mines
                    ctx.strokeStyle = '#000';
                    ctx.lineWidth = 3;
                    ctx.font = 'bold 18px Arial';
                    ctx.textAlign = 'center';
                    ctx.strokeText(timeLeft, 0, -25);
                    ctx.fillText(timeLeft, 0, -25);
                    ctx.restore();
                }
            }
        }
    }

    /**
     * Draw burning fire patches (petrol bomb / napalm strike)
     */
    drawFirePatches(ctx = this.ctx) {
        const patches = this.game.firePatches;
        if (!patches || patches.length === 0) return;

        const now = performance.now();
        for (const fire of patches) {
            ctx.save();
            ctx.translate(fire.x, fire.y);

            const flicker = Math.sin(now / 70 + fire.flicker);
            const h = 14 + flicker * 4;

            // Outer flame
            ctx.fillStyle = 'rgba(255, 100, 0, 0.85)';
            ctx.beginPath();
            ctx.moveTo(-9, 2);
            ctx.quadraticCurveTo(-7, -h * 0.6, 0, -h);
            ctx.quadraticCurveTo(7, -h * 0.6, 9, 2);
            ctx.closePath();
            ctx.fill();

            // Inner flame
            ctx.fillStyle = 'rgba(255, 210, 60, 0.9)';
            ctx.beginPath();
            ctx.moveTo(-4, 2);
            ctx.quadraticCurveTo(-3, -h * 0.35, 0, -h * 0.55);
            ctx.quadraticCurveTo(3, -h * 0.35, 4, 2);
            ctx.closePath();
            ctx.fill();

            // Ground glow
            ctx.fillStyle = 'rgba(255, 140, 0, 0.25)';
            ctx.beginPath();
            ctx.ellipse(0, 2, 14, 5, 0, 0, Math.PI * 2);
            ctx.fill();

            ctx.restore();
        }
    }

    /**
     * Draw rocket projectile
     */
    drawRocket(ctx) {
        // Rocket body
        ctx.fillStyle = '#555';
        ctx.beginPath();
        ctx.ellipse(0, 0, 12, 4, 0, 0, Math.PI * 2);
        ctx.fill();

        // Rocket tip
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        ctx.moveTo(12, 0);
        ctx.lineTo(6, -4);
        ctx.lineTo(6, 4);
        ctx.closePath();
        ctx.fill();

        // Fins
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.moveTo(-10, 0);
        ctx.lineTo(-14, -6);
        ctx.lineTo(-8, 0);
        ctx.lineTo(-14, 6);
        ctx.closePath();
        ctx.fill();

        // Trail
        ctx.fillStyle = 'rgba(255, 150, 0, 0.5)';
        ctx.beginPath();
        ctx.moveTo(-10, 0);
        ctx.lineTo(-25, -3);
        ctx.lineTo(-25, 3);
        ctx.closePath();
        ctx.fill();
    }

    /**
     * Draw grenade projectile
     */
    drawGrenade(ctx, proj) {
        if (this.sprites.weapons['grenade'] && this.sprites.weapons['grenade'].complete) {
            const size = 24;
            ctx.drawImage(this.sprites.weapons['grenade'], -size / 2, -size / 2, size, size);
        } else {
            // Fallback drawing
            ctx.fillStyle = '#2ecc71';
            ctx.beginPath();
            ctx.arc(0, 0, 8, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.strokeStyle = '#27ae60';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Fuse
        ctx.fillStyle = '#8B4513';
        ctx.fillRect(-2, -12, 4, 6);

        // Spark on fuse (animate faster when timer is running)
        const sparkSpeed = proj.timerStarted ? 50 : 100;
        const sparkSize = 2 + Math.sin(performance.now() / sparkSpeed) * 2;
        ctx.fillStyle = proj.timerStarted ? '#ff4444' : '#ff0';
        ctx.beginPath();
        ctx.arc(0, -14, sparkSize, 0, Math.PI * 2);
        ctx.fill();

        // Draw timer countdown if timer has started
        if (proj.timerStarted && proj.timer !== null) {
            const timeLeft = Math.max(0, proj.timer - proj.timeOnGround);
            const displayTime = Math.ceil(timeLeft);

            ctx.save();
            // Counter-rotate so text is always upright
            ctx.rotate(-proj.rotation);

            // Timer background
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.beginPath();
            ctx.arc(0, -25, 12, 0, Math.PI * 2);
            ctx.fill();

            // Timer text
            ctx.fillStyle = timeLeft <= 1 ? '#ff4444' : '#ffffff';
            ctx.font = 'bold 14px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(displayTime.toString(), 0, -25);

            ctx.restore();
        }
    }

    /**
     * Draw bullet
     */
    drawBullet(ctx) {
        ctx.fillStyle = '#f1c40f';
        ctx.beginPath();
        ctx.ellipse(0, 0, 6, 3, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#d4ac0d';
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    /**
     * Draw shotgun pellet (smaller than bullet)
     */
    drawPellet(ctx, proj) {
        // Small metallic pellet
        ctx.fillStyle = '#888';
        ctx.beginPath();
        ctx.arc(0, 0, 3, 0, Math.PI * 2);
        ctx.fill();

        // Highlight for 3D effect
        ctx.fillStyle = '#ccc';
        ctx.beginPath();
        ctx.arc(-1, -1, 1, 0, Math.PI * 2);
        ctx.fill();
    }

    /**
     * Draw mortar shell - stubby grey shell with a red band
     */
    drawMortarShell(ctx) {
        ctx.fillStyle = '#666';
        ctx.beginPath();
        ctx.ellipse(0, 0, 9, 4, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#c0392b';
        ctx.fillRect(2, -4, 3, 8);

        ctx.fillStyle = '#444';
        ctx.beginPath();
        ctx.moveTo(-9, 0);
        ctx.lineTo(-13, -4);
        ctx.lineTo(-13, 4);
        ctx.closePath();
        ctx.fill();
    }

    /**
     * Draw cluster bomb / fragment - grey orb with a warning band
     */
    drawClusterBomb(ctx, proj) {
        const r = proj.type === 'cluster' ? 8 : 5;
        ctx.fillStyle = '#95a5a6';
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#e67e22';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.stroke();

        // Highlight
        ctx.fillStyle = '#ccc';
        ctx.beginPath();
        ctx.arc(-r / 3, -r / 3, r / 4, 0, Math.PI * 2);
        ctx.fill();
    }

    /**
     * Draw banana bomb - yellow crescent
     */
    drawBanana(ctx) {
        ctx.strokeStyle = '#f1c40f';
        ctx.lineWidth = 6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(0, -3, 9, 0.3, Math.PI - 0.3);
        ctx.stroke();

        // Tips
        ctx.fillStyle = '#7d6608';
        ctx.beginPath();
        ctx.arc(-8, 0, 2, 0, Math.PI * 2);
        ctx.arc(8, 0, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineCap = 'butt';
    }

    /**
     * Draw petrol bomb - bottle with a burning rag
     */
    drawPetrolBomb(ctx) {
        // Bottle
        ctx.fillStyle = 'rgba(120, 180, 90, 0.85)';
        ctx.fillRect(-4, -8, 8, 14);
        ctx.fillRect(-2, -13, 4, 6);

        // Liquid
        ctx.fillStyle = 'rgba(220, 160, 40, 0.9)';
        ctx.fillRect(-3, -2, 6, 7);

        // Burning rag
        const flicker = Math.sin(performance.now() / 60) * 2;
        ctx.fillStyle = '#ff6600';
        ctx.beginPath();
        ctx.arc(0, -15, 3 + flicker * 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffcc00';
        ctx.beginPath();
        ctx.arc(0, -15, 1.5, 0, Math.PI * 2);
        ctx.fill();
    }

    /**
     * Draw longbow arrow
     */
    drawArrow(ctx) {
        // Shaft
        ctx.strokeStyle = '#8B5A2B';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-12, 0);
        ctx.lineTo(8, 0);
        ctx.stroke();

        // Head
        ctx.fillStyle = '#aaa';
        ctx.beginPath();
        ctx.moveTo(14, 0);
        ctx.lineTo(7, -3);
        ctx.lineTo(7, 3);
        ctx.closePath();
        ctx.fill();

        // Fletching
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        ctx.moveTo(-12, 0);
        ctx.lineTo(-16, -4);
        ctx.lineTo(-10, 0);
        ctx.lineTo(-16, 4);
        ctx.closePath();
        ctx.fill();
    }

    /**
     * Draw the sheep - fluffy body, dark head, trotting legs
     */
    drawSheep(ctx, proj) {
        // Keep the sheep upright regardless of velocity
        ctx.rotate(-(proj.rotation || 0));

        const trot = Math.sin(performance.now() / 80) * 2;

        // Legs
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-5, 5); ctx.lineTo(-5, 11 + trot);
        ctx.moveTo(5, 5); ctx.lineTo(5, 11 - trot);
        ctx.stroke();

        // Fluffy body
        ctx.fillStyle = '#f5f5f0';
        ctx.beginPath();
        ctx.arc(-5, 0, 6, 0, Math.PI * 2);
        ctx.arc(0, -3, 7, 0, Math.PI * 2);
        ctx.arc(5, 0, 6, 0, Math.PI * 2);
        ctx.arc(0, 2, 6, 0, Math.PI * 2);
        ctx.fill();

        // Head (faces walking direction)
        const dir = proj.walkDir || 1;
        ctx.fillStyle = '#2c2c2c';
        ctx.beginPath();
        ctx.ellipse(9 * dir, -4, 5, 4, 0, 0, Math.PI * 2);
        ctx.fill();

        // Eye
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(11 * dir, -5, 1.2, 0, Math.PI * 2);
        ctx.fill();
    }

    /**
     * Draw meteor - flaming rock
     */
    drawMeteor(ctx) {
        // Flame trail (behind, opposite travel direction)
        ctx.fillStyle = 'rgba(255, 120, 0, 0.6)';
        ctx.beginPath();
        ctx.moveTo(-8, 0);
        ctx.lineTo(-26, -5);
        ctx.lineTo(-26, 5);
        ctx.closePath();
        ctx.fill();

        // Rock
        ctx.fillStyle = '#6e4b2a';
        ctx.beginPath();
        ctx.arc(0, 0, 9, 0, Math.PI * 2);
        ctx.fill();

        // Molten cracks
        ctx.strokeStyle = '#ff9933';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(-4, -3); ctx.lineTo(2, 1);
        ctx.moveTo(0, -6); ctx.lineTo(3, -1);
        ctx.stroke();

        // Glow
        ctx.strokeStyle = 'rgba(255, 150, 50, 0.5)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, 11, 0, Math.PI * 2);
        ctx.stroke();
    }

    /**
     * Draw dynamite projectile
     */
    drawDynamite(ctx, proj) {
        if (this.sprites.weapons['dynamite'] && this.sprites.weapons['dynamite'].complete) {
            const size = 32;
            // Draw upright (dynamite sprite is vertical)
            ctx.drawImage(this.sprites.weapons['dynamite'], -size / 2, -size / 2, size, size);
        } else {
            // Red stick
            ctx.fillStyle = '#e74c3c';
            ctx.fillRect(-4, -15, 8, 30);
        }

        // Fuse
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, -15);
        ctx.quadraticCurveTo(5, -20, 10, -15);
        ctx.stroke();

        // Spark
        if (Math.random() > 0.5) {
            ctx.fillStyle = '#f1c40f';
            ctx.fillRect(9, -16, 2, 2);
        }
    }

    /**
     * Draw mine projectile/object
     */
    drawMine(ctx, proj) {
        if (this.sprites.weapons['mine'] && this.sprites.weapons['mine'].complete) {
            const size = 28;
            ctx.drawImage(this.sprites.weapons['mine'], -size / 2, -size / 2, size, size);
        } else {
            ctx.fillStyle = '#7f8c8d';
            ctx.beginPath();
            ctx.arc(0, 0, 10, 0, Math.PI * 2);
            ctx.fill();
        }

        // Pulsing glow when triggered
        if (proj.isTriggered) {
            const pulseSpeed = 50; // Faster pulse when triggered
            const glowAlpha = 0.5 + Math.sin(Date.now() / pulseSpeed) * 0.3;
            const glowRadius = 12 + Math.sin(Date.now() / pulseSpeed) * 2;

            ctx.strokeStyle = `rgba(231, 76, 60, ${glowAlpha})`; // Red glow
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(0, 0, glowRadius, 0, Math.PI * 2);
            ctx.stroke();
        } else {
            // Blinking light (original logic, slightly modified for consistency)
            let blinkSpeed = 500;
            if (Math.floor(Date.now() / blinkSpeed) % 2 === 0) {
                ctx.fillStyle = '#e74c3c';
                ctx.beginPath();
                ctx.arc(0, -6, 2, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Draw numeric countdown if triggered
        if (proj.isTriggered && proj.triggerTimer !== null && proj.triggerDelay !== null) {
            const timeLeft = Math.max(0, proj.triggerDelay - proj.triggerTimer);
            const displayTime = Math.ceil(timeLeft);

            ctx.save();
            // Counter-rotate so text is always upright
            ctx.rotate(-proj.rotation);

            // Timer background
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.beginPath();
            ctx.arc(0, -25, 12, 0, Math.PI * 2);
            ctx.fill();

            // Timer text
            ctx.fillStyle = timeLeft <= 1 ? '#ff4444' : '#ffffff';
            ctx.font = 'bold 14px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(displayTime.toString(), 0, -25);

            ctx.restore();
        }
    }
    /**
     * Draw holy grenade projectile
     */
    drawHolyGrenade(ctx, proj) {
        if (this.sprites.weapons['holygrenade'] && this.sprites.weapons['holygrenade'].complete) {
            const size = 32;
            ctx.drawImage(this.sprites.weapons['holygrenade'], -size / 2, -size / 2, size, size);
        } else {
            // Gold orb with cross
            ctx.fillStyle = '#f1c40f';
            ctx.beginPath();
            ctx.arc(0, 0, 10, 0, Math.PI * 2);
            ctx.fill();

            // Cross
            ctx.fillStyle = '#ecf0f1';
            ctx.fillRect(-2, -16, 4, 8);
            ctx.fillRect(-6, -14, 12, 4);
        }

        // Halo effect (pulse faster when timer is running)
        const pulseSpeed = proj.timerStarted ? 50 : 100;
        ctx.strokeStyle = `rgba(241, 196, 15, ${0.5 + Math.sin(Date.now() / pulseSpeed) * 0.3})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, 14, 0, Math.PI * 2);
        ctx.stroke();

        // Draw timer countdown if timer has started
        if (proj.timerStarted && proj.timer !== null) {
            const timeLeft = Math.max(0, proj.timer - proj.timeOnGround);
            const displayTime = Math.ceil(timeLeft);

            ctx.save();
            // Counter-rotate so text is always upright
            ctx.rotate(-proj.rotation);

            // Timer background (golden for holy grenade)
            ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
            ctx.beginPath();
            ctx.arc(0, -30, 14, 0, Math.PI * 2);
            ctx.fill();

            // Golden border
            ctx.strokeStyle = '#f1c40f';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Timer text
            ctx.fillStyle = timeLeft <= 1 ? '#ff4444' : '#f1c40f';
            ctx.font = 'bold 16px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(displayTime.toString(), 0, -30);

            ctx.restore();
        }
    }

    /**
     * Draw default projectile
     */
    drawDefaultProjectile(ctx, proj) {
        // Make it more visible with a bigger, brighter circle
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(0, 0, 8, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#f1c40f';
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    /**
     * Draw particles
     */
    drawParticles() {
        const ctx = this.ctx;

        for (const p of this.game.particles) {
            if (p.type === 'explosion') {
                // Explosion ring
                ctx.strokeStyle = `rgba(255, 200, 50, ${p.alpha})`;
                ctx.lineWidth = 5;
                const currentRadius = p.maxRadius * (p.time / p.lifetime);
                ctx.beginPath();
                ctx.arc(p.x, p.y, currentRadius, 0, Math.PI * 2);
                ctx.stroke();

                // Inner flash
                ctx.fillStyle = `rgba(255, 255, 200, ${p.alpha * 0.5})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, currentRadius * 0.5, 0, Math.PI * 2);
                ctx.fill();
            } else if (p.type === 'debris') {
                ctx.fillStyle = p.color;
                ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
            } else if (p.type === 'floatingText') {
                const alpha = 1 - (p.time / p.lifetime);
                ctx.save();
                ctx.font = `bold ${p.size}px Arial`;
                ctx.fillStyle = p.color;
                ctx.globalAlpha = alpha;
                ctx.textAlign = 'center';
                ctx.shadowColor = '#000';
                ctx.shadowBlur = 4;
                ctx.fillText(p.text, p.x, p.y);
                ctx.restore();
            } else if (p.type === 'spark') {
                const alpha = 1 - (p.time / p.lifetime);
                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.fillStyle = p.color;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            } else if (p.type === 'smoke') {
                const progress = p.time / p.lifetime;
                const alpha = (1 - progress) * 0.6;
                const size = p.size * (1 + progress); // Expand as it dissipates
                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.fillStyle = p.color || '#888';
                ctx.beginPath();
                ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            } else if (p.type === 'splash') {
                const alpha = 1 - (p.time / p.lifetime);
                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.fillStyle = p.color || 'rgba(120, 190, 255, 0.9)';
                ctx.beginPath();
                ctx.ellipse(p.x, p.y, p.size, p.size * 1.4, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }
        }
    }

    /**
     * Draw water at bottom of world
     */
    drawWater() {
        const ctx = this.ctx;
        const waterHeight = 260; // Extra tall to cover gaps below

        // Water surface position — ease toward the logical (possibly rising) level
        const targetWaterY = this.game.waterLevel ?? (this.game.worldHeight - 60);
        if (this.renderWaterY === null) {
            this.renderWaterY = targetWaterY;
        } else {
            this.renderWaterY += (targetWaterY - this.renderWaterY) * 0.08;
        }

        // Waves scroll with the wind (WA-style); a slight ambient drift keeps
        // the surface alive in dead calm. Separate clock drives the tide bob.
        this.waterOffset += 0.012 + this.game.wind * 0.06;
        this.waterTime = (this.waterTime || 0) + 0.016;
        const bob = Math.sin(this.waterTime * 0.9) * 1.5;
        const waterY = this.renderWaterY + bob;

        // Only draw the visible stretch (plus margins) instead of the whole world
        const camera = this.game.camera;
        const viewLeft = camera.x - 100;
        const viewRight = camera.x + this.canvas.width / camera.zoom + 100;

        // Sudden death turns the rising water murky and angry
        const suddenDeath = this.game.turnManager?.suddenDeathActive;
        const layers = suddenDeath
            ? [
                { amp: 5, freq: 0.014, speed: 0.5, lift: 8, color: 'rgba(70, 30, 90, 0.85)' },
                { amp: 6, freq: 0.019, speed: 1.0, lift: 4, color: 'rgba(95, 35, 110, 0.9)' },
                { amp: 8, freq: 0.024, speed: 1.6, lift: 0, color: null }
            ]
            : [
                { amp: 3, freq: 0.014, speed: 0.5, lift: 6, color: 'rgba(15, 75, 145, 0.85)' },
                { amp: 4, freq: 0.019, speed: 1.0, lift: 3, color: 'rgba(20, 105, 190, 0.9)' },
                { amp: 5, freq: 0.024, speed: 1.6, lift: 0, color: null }
            ];

        const traceWave = (layer) => {
            ctx.beginPath();
            let first = true;
            for (let x = viewLeft; x <= viewRight; x += 6) {
                const waveY = waterY - layer.lift +
                    Math.sin(x * layer.freq + this.waterOffset * layer.speed + layer.lift) * layer.amp;
                if (first) {
                    ctx.moveTo(x, waveY);
                    first = false;
                } else {
                    ctx.lineTo(x, waveY);
                }
            }
        };

        for (const layer of layers) {
            if (layer.color) {
                ctx.fillStyle = layer.color;
            } else {
                // Front layer carries the main body gradient
                const gradient = ctx.createLinearGradient(0, waterY, 0, waterY + waterHeight);
                if (suddenDeath) {
                    gradient.addColorStop(0, 'rgba(150, 60, 160, 0.95)');
                    gradient.addColorStop(0.3, 'rgba(90, 30, 110, 1)');
                    gradient.addColorStop(1, 'rgba(30, 5, 45, 1)');
                } else {
                    gradient.addColorStop(0, 'rgba(30, 144, 255, 0.9)');
                    gradient.addColorStop(0.3, 'rgba(0, 100, 180, 1)');
                    gradient.addColorStop(1, 'rgba(0, 30, 80, 1)');
                }
                ctx.fillStyle = gradient;
            }
            traceWave(layer);
            ctx.lineTo(viewRight, waterY + waterHeight);
            ctx.lineTo(viewLeft, waterY + waterHeight);
            ctx.closePath();
            ctx.fill();
        }

        // Sparkling crest highlight along the front wave
        const front = layers[layers.length - 1];
        ctx.strokeStyle = suddenDeath ? 'rgba(255, 180, 255, 0.4)' : 'rgba(255, 255, 255, 0.35)';
        ctx.lineWidth = 2;
        traceWave(front);
        ctx.stroke();
    }
    /**
     * Draw all active loot crates
     */
    drawLootCrates() {
        // Delegate to LootManager
        this.game.lootManager.render(this.ctx);
    }

    /**
     * Draw the explosive oil drums (WA-style map hazards).
     * drum.y is the bottom-center resting point.
     */
    drawOilDrums() {
        const drums = this.game.oilDrums;
        if (!drums || drums.length === 0) return;
        const ctx = this.ctx;

        const w = 26;
        const h = 34;

        for (const drum of drums) {
            ctx.save();
            ctx.translate(drum.x, drum.y);

            // Body with a metallic side-lit gradient
            const grad = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
            grad.addColorStop(0, '#3a3f44');
            grad.addColorStop(0.35, '#6a7178');
            grad.addColorStop(0.55, '#7d858d');
            grad.addColorStop(1, '#2e3236');
            ctx.fillStyle = grad;
            this._roundRect(ctx, -w / 2, -h, w, h, 3);
            ctx.fill();

            // Red hazard band around the middle
            ctx.fillStyle = '#c0392b';
            ctx.fillRect(-w / 2, -h * 0.68, w, 8);

            // Rolled steel ribs
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
            ctx.lineWidth = 1.5;
            for (const ry of [-h * 0.25, -h * 0.82]) {
                ctx.beginPath();
                ctx.moveTo(-w / 2 + 1, ry);
                ctx.lineTo(w / 2 - 1, ry);
                ctx.stroke();
            }

            // Lid
            ctx.fillStyle = '#8b939b';
            ctx.beginPath();
            ctx.ellipse(0, -h, w / 2 - 1, 3.5, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Flame warning mark on the band
            ctx.fillStyle = '#f5d76e';
            ctx.font = 'bold 8px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('🔥', 0, -h * 0.68 + 4);

            // Lit fuse: flickering glow that ramps up as the fuse burns down
            if (drum.igniteTimer > 0) {
                const flicker = 0.45 + Math.sin(Date.now() / 45) * 0.25;
                ctx.strokeStyle = `rgba(255, 140, 40, ${flicker})`;
                ctx.lineWidth = 3;
                this._roundRect(ctx, -w / 2 - 2, -h - 2, w + 4, h + 4, 4);
                ctx.stroke();
            } else if (drum.hp < drum.maxHp) {
                // Battle damage: dent marks once it's taken hits
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(-w * 0.25, -h * 0.45);
                ctx.lineTo(-w * 0.05, -h * 0.38);
                ctx.moveTo(w * 0.1, -h * 0.52);
                ctx.lineTo(w * 0.28, -h * 0.42);
                ctx.stroke();
            }

            ctx.restore();
        }
    }
}
