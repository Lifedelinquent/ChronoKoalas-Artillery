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
            'airstrike', 'teleport', 'rope', 'mine', 'holygrenade'
        ];
        weapons.forEach(w => {
            this.sprites.weapons[w] = new Image();
            // Use same transparent loader for weapons
            this.loadTransparentSprite(`assets/weapon_${w}.png`, `weapon_${w}`);
        });
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
        ctx.save();
        ctx.translate(-camera.x, -camera.y);
        ctx.scale(camera.zoom, camera.zoom);

        // Draw clouds (parallax)
        this.drawClouds();

        // Draw terrain
        this.drawTerrain();

        // Draw powerups
        this.drawPowerups();

        // Draw koalas
        this.drawKoalas();

        // Draw projectiles
        this.drawProjectiles();

        // Draw particles
        this.drawParticles();

        // Draw water
        this.drawWater();

        // Draw aiming indicator
        this.drawAimingIndicator();

        // Restore transform
        ctx.restore();
    }

    /**
     * Draw sky background
     */
    drawSky() {
        // Use custom background color if set (from custom maps)
        if (this.game.customBackgroundColor) {
            this.ctx.fillStyle = this.game.customBackgroundColor;
        } else {
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

        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';

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
            const parallaxX = cloud.x - camera.x * 0.3;
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
     * Draw all koalas
     */
    drawKoalas() {
        const ctx = this.ctx;
        const currentKoala = this.game.getCurrentKoala();

        for (const team of this.game.teams) {
            for (const koala of team.koalas) {
                if (!koala.isAlive) continue;

                const isCurrent = koala === currentKoala;
                this.drawKoala(koala, isCurrent);
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

        // Apply backflip rotation if active
        if (koala.isBackflipping && koala.backflipRotation) {
            ctx.rotate(koala.backflipRotation);
        }

        // Flip based on facing direction
        // We need to know scale X for weapon rotation logic
        const scaleX = koala.facingLeft ? -1 : 1;
        if (koala.facingLeft) {
            ctx.scale(-1, 1);
        }

        // Determine sprite based on team color
        let sprite = this.sprites.red;
        if (koala.team.color.toLowerCase() === '#3498db') {
            sprite = this.sprites.blue;
        }

        // Draw Koala Sprite
        if (sprite.complete && sprite.naturalHeight !== 0) {
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
     * Draw health bar above koala
     */
    drawHealthBar(koala) {
        const ctx = this.ctx;
        const x = koala.x;
        const y = koala.y - 35;
        const width = 30;
        const height = 5;
        const healthPercent = koala.health / 100;

        // Background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(x - width / 2, y, width, height);

        // Health fill
        const healthColor = healthPercent > 0.5 ? '#2ecc71' :
            healthPercent > 0.25 ? '#f1c40f' : '#e74c3c';
        ctx.fillStyle = healthColor;
        ctx.fillRect(x - width / 2, y, width * healthPercent, height);

        // Border
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - width / 2, y, width, height);
    }

    /**
     * Draw arrow indicator above current koala
     */
    drawCurrentIndicator(koala) {
        const ctx = this.ctx;
        const x = Math.round(koala.x);
        const y = Math.round(koala.y - 55);
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
     * Draw name tag
     */
    drawNameTag(koala) {
        const ctx = this.ctx;
        ctx.fillStyle = '#fff';
        ctx.font = '10px Outfit';
        ctx.textAlign = 'center';
        ctx.fillText(koala.name, koala.x, koala.y - 42);
    }

    /**
     * Draw aiming indicator
     */
    drawAimingIndicator() {
        if (this.game.phase !== 'aiming' && this.game.phase !== 'firing') return;

        const koala = this.game.getCurrentKoala();
        if (!koala) return;

        const ctx = this.ctx;
        const weapon = this.game.weaponManager.currentWeapon;

        // Check if this is a targetted weapon (airstrike, teleport)
        if (weapon && weapon.targetted) {
            this.drawTargetCursor(ctx, koala.team.color, weapon.type);
            return;
        }

        // Regular aiming indicator
        // aimAngle is now the world angle directly (full 360)
        const worldAngle = koala.aimAngle;

        const length = 50;

        const startX = koala.x;
        const startY = koala.y - 10;
        const endX = startX + Math.cos(worldAngle) * length;
        const endY = startY + Math.sin(worldAngle) * length;

        // Dotted line
        ctx.strokeStyle = koala.team.color;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Crosshair at end
        ctx.fillStyle = koala.team.color;
        ctx.beginPath();
        ctx.arc(endX, endY, 5, 0, Math.PI * 2);
        ctx.fill();
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
     * Draw projectiles
     */
    drawProjectiles() {
        const ctx = this.ctx;

        for (const proj of this.game.projectiles) {
            ctx.save();
            ctx.translate(proj.x, proj.y);
            ctx.rotate(proj.rotation || 0);

            // Draw based on weapon type
            switch (proj.type) {
                case 'bazooka':
                case 'airstrike':
                    this.drawRocket(ctx);
                    break;
                case 'grenade':
                    this.drawGrenade(ctx, proj);
                    break;
                case 'shotgun':
                    this.drawBullet(ctx);
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
                default:
                    this.drawDefaultProjectile(ctx, proj);
            }

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
            }
        }
    }

    /**
     * Draw water at bottom of world
     */
    drawWater() {
        const ctx = this.ctx;
        const waterHeight = 200; // Extra tall to cover gaps below
        const waterY = this.game.worldHeight - 60; // Water surface position

        // Animate water
        this.waterOffset += 0.02;

        // Water gradient
        const gradient = ctx.createLinearGradient(0, waterY, 0, waterY + waterHeight);
        gradient.addColorStop(0, 'rgba(30, 144, 255, 0.9)');
        gradient.addColorStop(0.3, 'rgba(0, 100, 180, 1)');
        gradient.addColorStop(1, 'rgba(0, 30, 80, 1)');

        ctx.fillStyle = gradient;
        // Extend water way beyond world boundaries to fill at any zoom
        ctx.fillRect(-500, waterY, this.game.worldWidth + 1000, waterHeight);

        // Wave effect
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let x = 0; x < this.game.worldWidth; x += 5) {
            const waveY = waterY + Math.sin((x * 0.02) + this.waterOffset) * 3;
            if (x === 0) {
                ctx.moveTo(x, waveY);
            } else {
                ctx.lineTo(x, waveY);
            }
        }
        ctx.stroke();
    }
    /**
     * Draw all active powerups
     */
    drawPowerups() {
        const ctx = this.ctx;
        const time = performance.now() / 1000;

        for (const p of this.game.powerups) {
            ctx.save();

            // Hover animation
            const hover = Math.sin(time * 3) * 5;
            ctx.translate(p.x, p.y + hover);

            if (p.type === 'health') {
                // Glow effect
                const glow = 15 + Math.sin(time * 6) * 5;
                const gradient = ctx.createRadialGradient(0, 0, 5, 0, 0, glow);
                gradient.addColorStop(0, 'rgba(46, 204, 113, 0.4)');
                gradient.addColorStop(1, 'rgba(46, 204, 113, 0)');
                ctx.fillStyle = gradient;
                ctx.beginPath();
                ctx.arc(0, 0, glow, 0, Math.PI * 2);
                ctx.fill();

                // Health box
                ctx.fillStyle = '#ecf0f1';
                ctx.strokeStyle = '#27ae60';
                ctx.lineWidth = 2;
                ctx.beginPath();
                // Check if roundRect is supported, fallback to rect
                if (ctx.roundRect) {
                    ctx.roundRect(-12, -12, 24, 24, 4);
                } else {
                    ctx.rect(-12, -12, 24, 24);
                }
                ctx.fill();
                ctx.stroke();

                // Red cross
                ctx.fillStyle = '#e74c3c';
                // Vertical bar
                ctx.fillRect(-3, -8, 6, 16);
                // Horizontal bar
                ctx.fillRect(-8, -3, 16, 6);
            }

            ctx.restore();
        }
    }
}

