/**
 * Terrain System - Worms-style destructible terrain
 * Uses pixel-based collision mask for destruction
 */

export class Terrain {
    constructor(width, height) {
        this.width = width;
        this.height = height;

        // Terrain data - true = solid, false = air
        this.data = null;

        // Visual canvas for terrain
        this.canvas = document.createElement('canvas');
        this.canvas.width = width;
        this.canvas.height = height;
        this.ctx = this.canvas.getContext('2d');

        // Collision mask canvas (for precise collision)
        this.maskCanvas = document.createElement('canvas');
        this.maskCanvas.width = width;
        this.maskCanvas.height = height;
        this.maskCtx = this.maskCanvas.getContext('2d');

        // Terrain colors
        this.grassColor = '#4a7c23';
        this.dirtColor = '#8B4513';
        this.dirtDarkColor = '#654321';
        this.skyColor = '#87CEEB';
    }

    /**
     * Generate terrain using Worms-style algorithm
     */
    generate() {
        // Implement the fixed map as requested
        this.generateFixedMap();
    }

    /**
     * Generate a fixed, well-thought-out map with levels, slopes, hills, and walls
     */
    /**
     * Generate a fixed map based on the 'Zoo' layout
     */
    generateFixedMap() {
        // Clear canvas
        this.ctx.fillStyle = 'transparent';
        this.ctx.clearRect(0, 0, this.width, this.height);

        const w = this.width;
        const h = this.height;

        // --- 1. Bottom Ground Layer (Barn Area & Tunnels) ---
        this.ctx.fillStyle = this.dirtColor;
        this.ctx.beginPath();
        // Start from off-screen left to fill edge
        this.ctx.moveTo(-50, h);
        this.ctx.lineTo(-50, h * 0.75); // Raised floor level
        this.ctx.lineTo(w * 0.25, h * 0.75);

        // Dip down for tunnel area (center bottom) - but stay above water
        this.ctx.quadraticCurveTo(w * 0.3, h * 0.75, w * 0.35, h * 0.82);
        this.ctx.lineTo(w * 0.65, h * 0.82);
        this.ctx.quadraticCurveTo(w * 0.7, h * 0.75, w * 0.75, h * 0.75);

        // Right bottom connection - extend beyond width to avoid gaps
        this.ctx.lineTo(w + 50, h * 0.75);
        this.ctx.lineTo(w + 50, h); // Fill to bottom
        this.ctx.lineTo(-50, h); // Fill to bottom left
        this.ctx.closePath();
        this.ctx.fill();

        // --- 2. Left Floating Island & Bridge ---
        // High floating island (Skunk area)
        this.createPlatform(w * 0.1, h * 0.35, w * 0.15, 60);

        // Lower floating island (Bird cage area)
        this.createPlatform(w * 0.25, h * 0.5, w * 0.15, 60);

        // Barn Roof (Shelter)
        this.ctx.fillStyle = this.dirtDarkColor;
        this.ctx.fillRect(w * 0.05, h * 0.75, w * 0.2, 20); // Roof
        // Pillars for barn
        this.ctx.fillRect(w * 0.06, h * 0.75, 10, h * 0.1);
        this.ctx.fillRect(w * 0.24, h * 0.75, 10, h * 0.1);


        // --- 3. Central Vertical Tower/Pillar ---
        this.ctx.fillStyle = this.dirtColor;
        this.ctx.beginPath();
        this.ctx.rect(w * 0.35, h * 0.4, w * 0.08, h * 0.55); // Tall pillar
        this.ctx.fill();

        // Platform on top of pillar
        this.createPlatform(w * 0.39, h * 0.4, w * 0.12, 30);


        // --- 4. Upper Central Platform (Cement Truck Area) ---
        // Large floating block
        this.ctx.beginPath();
        this.ctx.moveTo(w * 0.55, h * 0.45);
        this.ctx.lineTo(w * 0.7, h * 0.45); // Top flat
        this.ctx.lineTo(w * 0.65, h * 0.65); // Tapers down
        this.ctx.lineTo(w * 0.55, h * 0.6);
        this.ctx.closePath();
        this.ctx.fill();


        // --- 5. Right Side Mountain/Wazoo Area ---
        this.ctx.beginPath();
        this.ctx.moveTo(w + 500, h * 0.75); // Start way off-screen right
        this.ctx.lineTo(w * 0.85, h * 0.75);
        // Steps going up
        this.ctx.lineTo(w * 0.85, h * 0.6);
        this.ctx.lineTo(w * 0.9, h * 0.6);
        this.ctx.lineTo(w * 0.9, h * 0.45);
        this.ctx.lineTo(w * 0.95, h * 0.45);
        this.ctx.lineTo(w * 0.95, h * 0.25); // High peak
        this.ctx.lineTo(w + 500, h * 0.25); // Extends way off-screen right
        this.ctx.lineTo(w + 500, h + 500); // Anchor way below bottom right
        this.ctx.closePath();
        this.ctx.fill();

        // Lower right platform (Donkey area)
        this.createPlatform(w * 0.8, h * 0.65, w * 0.1, 30);


        // --- 6. Bridges / Connections ---
        this.ctx.lineWidth = 36; // 2x thicker bridges
        this.ctx.strokeStyle = '#5d4037'; // Wood color

        // Bridge: pillar to center
        this.ctx.beginPath();
        this.ctx.moveTo(w * 0.45, h * 0.4);
        this.ctx.quadraticCurveTo(w * 0.5, h * 0.45, w * 0.55, h * 0.45);
        this.ctx.stroke();

        // Bridge: center to right
        this.ctx.beginPath();
        this.ctx.moveTo(w * 0.7, h * 0.45);
        this.ctx.quadraticCurveTo(w * 0.75, h * 0.6, w * 0.8, h * 0.65);
        this.ctx.stroke();


        // --- 7. (Tunnels section removed to fill "hole") ---

        // --- Features: Map Objects (trees, boulders, crates, barrels) ---
        // Update mask so we can find ground level for objects
        this.updateCollisionMask();
        this.addMapObjects();

        // --- Polish ---
        this.addGlobalGrass();         // Add grass to all surfaces
        this.addTerrainTexture();      // Texture

        // Finalize Mask
        this.updateCollisionMask();
    }

    /**
     * Helper to create a floating platform
     */
    createPlatform(x, y, w, h) {
        this.ctx.save();
        this.ctx.translate(x, y);
        this.ctx.beginPath();
        this.ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
        this.ctx.fillStyle = this.dirtColor;
        this.ctx.fill();
        this.ctx.restore();
    }

    /**
     * Get visual ground surfaces at a given X coordinate
     */
    getVisualGroundY(x) {
        x = Math.floor(x);
        if (x < 0 || x >= this.width) return [];
        const imageData = this.ctx.getImageData(x, 0, 1, this.height);
        const data = imageData.data;
        const surfaces = [];

        // Scan from top to bottom, find all transitions from air to solid
        // Track previous pixel state, starting with assumption of "air above top of image"
        let previousWasAir = true; // Assume there's air above the image boundary
        let airStreak = 10; // Assume plenty of air above image

        for (let y = 0; y < this.height - 10; y++) {
            const alpha = data[y * 4 + 3];
            const isSolid = alpha >= 128;
            const isAir = !isSolid;

            if (previousWasAir && isSolid) {
                // Transition from air to solid = a surface!
                // Only count if there was meaningful air above (at least 3 pixels)
                if (airStreak >= 3) {
                    surfaces.push(y);
                }
                airStreak = 0;
            } else if (isAir) {
                airStreak++;
            }

            previousWasAir = isAir;
        }
        return surfaces;
    }

    /**
     * Add random destructible map objects (trees, boulders, crates, barrels)
     */
    addMapObjects() {
        const placedObjects = []; // Track positions {x, y, type}
        const minDistance = 100; // Minimum pixels between objects

        // Store barrel positions for explosion logic
        this.barrelPositions = [];

        // Helper to get visual ground Y (works before collision mask is rebuilt)
        const getVisualGroundY = (x) => this.getVisualGroundY(x);

        // Try to place an object anywhere on the map
        const tryPlaceObject = (type, minSpacing) => {
            // Try up to 50 times to find a valid spot
            for (let attempt = 0; attempt < 50; attempt++) {
                const x = 80 + Math.random() * (this.width - 160);
                const surfaces = getVisualGroundY(x);

                // Skip if no surfaces found
                if (surfaces.length === 0) continue;

                // Pick a random surface from all available
                const y = surfaces[Math.floor(Math.random() * surfaces.length)];

                // Skip if too close to edges
                if (y < 50) continue;

                // Check distance from other objects
                let tooClose = false;
                for (const obj of placedObjects) {
                    const dist = Math.hypot(x - obj.x, y - obj.y);
                    if (dist < minSpacing) {
                        tooClose = true;
                        break;
                    }
                }
                if (tooClose) continue;

                // Place the object
                switch (type) {
                    case 'tree':
                        this.createTree(x, y);
                        break;
                    case 'boulder':
                        this.createBoulder(x, y);
                        break;
                    case 'crate':
                        this.createCrate(x, y);
                        break;
                    case 'barrel':
                        this.createBarrel(x, y);
                        this.barrelPositions.push({ x, y });
                        break;
                }

                placedObjects.push({ x, y, type });
                return true;
            }
            return false;
        };

        // Spawn objects with variety
        // Trees: 12-15
        for (let i = 0; i < 15; i++) {
            tryPlaceObject('tree', minDistance);
        }

        // Boulders: 6-8
        for (let i = 0; i < 8; i++) {
            tryPlaceObject('boulder', 80);
        }

        // Crates: 4-6
        for (let i = 0; i < 6; i++) {
            tryPlaceObject('crate', 120);
        }

        // Explosive Barrels: 3-4
        for (let i = 0; i < 4; i++) {
            tryPlaceObject('barrel', 200);
        }
    }

    /**
     * Draw a thick destructible tree
     */
    createTree(x, y) {
        this.ctx.save();
        this.ctx.translate(x, y);

        // Trunk
        this.ctx.fillStyle = '#4e342e'; // Dark wood
        const trunkW = 18 + Math.random() * 12;
        const trunkH = 50 + Math.random() * 50;
        this.ctx.fillRect(-trunkW / 2, -trunkH, trunkW, trunkH);

        // Branches/Canopy
        this.ctx.fillStyle = '#2d5a27'; // Dark green leaves
        const canopySize = 50 + Math.random() * 35;

        this.ctx.beginPath();
        this.ctx.arc(0, -trunkH, canopySize, 0, Math.PI * 2);
        this.ctx.fill();

        // Extra leafy bits
        for (let j = 0; j < 4; j++) {
            this.ctx.beginPath();
            const lx = (Math.random() - 0.5) * canopySize * 1.4;
            const ly = -trunkH + (Math.random() - 0.5) * canopySize * 0.8;
            this.ctx.arc(lx, ly, canopySize * 0.5, 0, Math.PI * 2);
            this.ctx.fill();
        }

        this.ctx.restore();
    }

    /**
     * Draw a boulder/rock
     */
    createBoulder(x, y) {
        this.ctx.save();
        this.ctx.translate(x, y);

        const size = 25 + Math.random() * 20;

        // Main rock body
        this.ctx.fillStyle = '#5d5d5d'; // Gray
        this.ctx.beginPath();
        this.ctx.ellipse(0, -size / 2, size, size * 0.7, 0, 0, Math.PI * 2);
        this.ctx.fill();

        // Highlight
        this.ctx.fillStyle = '#7a7a7a';
        this.ctx.beginPath();
        this.ctx.ellipse(-size * 0.2, -size * 0.7, size * 0.4, size * 0.3, -0.3, 0, Math.PI * 2);
        this.ctx.fill();

        // Shadow/depth
        this.ctx.fillStyle = '#3d3d3d';
        this.ctx.beginPath();
        this.ctx.ellipse(size * 0.2, -size * 0.3, size * 0.3, size * 0.2, 0.5, 0, Math.PI * 2);
        this.ctx.fill();

        this.ctx.restore();
    }

    /**
     * Draw a wooden crate
     */
    createCrate(x, y) {
        this.ctx.save();
        this.ctx.translate(x, y);

        const size = 30 + Math.random() * 10;

        // Crate body
        this.ctx.fillStyle = '#8B4513'; // Wood brown
        this.ctx.fillRect(-size / 2, -size, size, size);

        // Wood grain lines
        this.ctx.strokeStyle = '#5D3A1A';
        this.ctx.lineWidth = 2;

        // Horizontal planks
        for (let i = 1; i < 4; i++) {
            this.ctx.beginPath();
            this.ctx.moveTo(-size / 2, -size + (size / 4) * i);
            this.ctx.lineTo(size / 2, -size + (size / 4) * i);
            this.ctx.stroke();
        }

        // Cross braces
        this.ctx.strokeStyle = '#4A2A0A';
        this.ctx.lineWidth = 3;
        this.ctx.beginPath();
        this.ctx.moveTo(-size / 2, -size);
        this.ctx.lineTo(size / 2, 0);
        this.ctx.moveTo(size / 2, -size);
        this.ctx.lineTo(-size / 2, 0);
        this.ctx.stroke();

        this.ctx.restore();
    }

    /**
     * Draw an explosive barrel
     */
    createBarrel(x, y) {
        this.ctx.save();
        this.ctx.translate(x, y);

        const width = 24;
        const height = 36;

        // Barrel body (red = explosive!)
        this.ctx.fillStyle = '#c0392b'; // Red
        this.ctx.beginPath();
        this.ctx.ellipse(0, -height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
        this.ctx.fill();

        // Metal bands
        this.ctx.strokeStyle = '#2c3e50';
        this.ctx.lineWidth = 3;
        this.ctx.beginPath();
        this.ctx.ellipse(0, -height * 0.25, width / 2 + 2, 4, 0, 0, Math.PI * 2);
        this.ctx.stroke();
        this.ctx.beginPath();
        this.ctx.ellipse(0, -height * 0.75, width / 2 + 2, 4, 0, 0, Math.PI * 2);
        this.ctx.stroke();

        // Warning symbol (skull/fire)
        this.ctx.fillStyle = '#f1c40f'; // Yellow
        this.ctx.font = 'bold 14px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('⚠', 0, -height / 2 + 5);

        // Highlight
        this.ctx.fillStyle = '#e74c3c';
        this.ctx.beginPath();
        this.ctx.ellipse(-width * 0.15, -height * 0.6, width * 0.15, height * 0.2, -0.2, 0, Math.PI * 2);
        this.ctx.fill();

        this.ctx.restore();
    }

    /**
     * Generate a more complex, varying heightmap
     */
    generateComplexHeightMap() {
        // Make the base terrain hillier but smoother to ensure walkability
        const heightMap = new Array(this.width);
        const waves = [
            { freq: 0.002, amp: 150, phase: Math.random() * 10 },
            { freq: 0.007, amp: 50, phase: Math.random() * 10 }
        ];

        // Adjusted from 0.65 to 0.45 to allow terrain higher up (above Y=600)
        const baseLevel = this.height * 0.45;

        for (let x = 0; x < this.width; x++) {
            let y = baseLevel;
            for (const w of waves) {
                y += Math.sin(x * w.freq + w.phase) * w.amp;
            }
            // Allow terrain as high as Y=50
            heightMap[x] = Math.max(50, Math.min(this.height - 50, y));
        }
        return heightMap;
    }

    /**
     * Carve open-air pockets (U-shapes) into the surface
     */
    carveTerracedPockets() {
        this.ctx.save();
        this.ctx.globalCompositeOperation = 'destination-out';
        this.ctx.fillStyle = 'rgba(255,255,255,1)';

        const numPockets = 8 + Math.random() * 5;

        // We need image data to check ground height
        // Since the collision mask isn't updated yet, we read from the visual canvas
        const currentData = this.ctx.getImageData(0, 0, this.width, this.height).data;

        // Helper to get ground Y from current visual state
        const getVisualGroundY = (vx) => {
            vx = Math.floor(vx);
            for (let y = 0; y < this.height; y++) {
                const idx = (y * this.width + vx) * 4;
                if (currentData[idx + 3] > 0) return y;
            }
            return this.height;
        };

        for (let i = 0; i < numPockets; i++) {
            const x = 200 + Math.random() * (this.width - 400);
            const groundY = getVisualGroundY(x);

            if (groundY < this.height - 50) {
                const radius = 40 + Math.random() * 30;

                // Draw a semi-circle bowl
                this.ctx.beginPath();
                this.ctx.arc(x, groundY - 10, radius, 0, Math.PI, false); // Bottom half arc
                this.ctx.fill();

                // Flatten the bottom slightly for easier standing
                this.ctx.fillRect(x - radius / 2, groundY, radius, radius / 2);
            }
        }
        this.ctx.restore();
    }

    /**
     * Add raised rims or "curved walls" around pockets
     */
    addProtectiveWalls() {
        // Need up-to-date data again after carving pockets
        const currentData = this.ctx.getImageData(0, 0, this.width, this.height).data;
        const getVisualGroundY = (vx) => {
            vx = Math.floor(vx);
            for (let y = 0; y < this.height; y++) {
                const idx = (y * this.width + vx) * 4;
                if (currentData[idx + 3] > 0) return y;
            }
            return this.height;
        };

        this.ctx.save();
        this.ctx.fillStyle = this.dirtColor;
        this.ctx.strokeStyle = this.dirtColor;
        this.ctx.lineWidth = 20;
        this.ctx.lineCap = 'round';

        // Add some random curved walls emerging from the ground
        for (let i = 0; i < 10; i++) {
            const x = 100 + Math.random() * (this.width - 200);
            const groundY = getVisualGroundY(x);

            if (groundY < this.height - 50) {
                this.ctx.beginPath();
                // A curve swooping up and out
                this.ctx.moveTo(x, groundY + 20);
                const height = 60 + Math.random() * 40;
                const lean = (Math.random() - 0.5) * 80;

                this.ctx.quadraticCurveTo(x + lean, groundY - height, x + lean * 1.5, groundY - height + 20);
                this.ctx.stroke();
            }
        }
        this.ctx.restore();
    }

    /**
     * Helper to find the Y coordinate of the ground at a given X
     * by scanning pixels from top to bottom.
     */
    getGroundY(x, startY = 0) {
        const surfaces = this.getVisualGroundY(x);
        if (surfaces.length > 0) {
            // Find the first surface that is >= startY
            const below = surfaces.find(s => s >= startY);
            if (below !== undefined) return below;

            // If none found below, return the top-most one as fallback
            return surfaces[0];
        }
        return this.height; // No ground found, return bottom of canvas
    }

    /**
     * Find the first ground surface BELOW a specific point
     * If no ground is found below, returns this.height
     */
    getGroundBelow(x, y) {
        const surfaces = this.getVisualGroundY(x);
        if (surfaces.length === 0) return this.height;

        // Find first surface >= y
        const below = surfaces.find(s => s >= y);
        return below !== undefined ? below : this.height;
    }

    /**
     * Pixel-scan grass application (renamed for clarity)
     */
    addGlobalGrass() {
        // Reuse the pixel logic from before
        this.addIslandGrass();
    }

    /**
     * Add grass to all top surfaces (islands, bridges, base)
     * uses pixel scanning to find top-most solid pixels
     */
    addIslandGrass() {
        const imageData = this.ctx.getImageData(0, 0, this.width, this.height);
        const data = imageData.data;
        const width = this.width;
        const height = this.height;

        // Color for grass (hex #5a9c23 -> rgb 90, 156, 35)
        const grassR = 90;
        const grassG = 156;
        const grassB = 35;

        for (let x = 0; x < width; x += 1) {
            let inGround = false;

            for (let y = 0; y < height; y++) {
                const idx = (y * width + x) * 4;
                const alpha = data[idx + 3];

                if (alpha > 100) {
                    // Found solid ground
                    if (!inGround) {
                        // We just hit ground from air -> this is a surface!
                        // Draw grass here (3 pixels deep)
                        for (let k = 0; k < 4; k++) {
                            const gIdx = ((y + k) * width + x) * 4;
                            if (gIdx < data.length) {
                                data[gIdx] = grassR;
                                data[gIdx + 1] = grassG;
                                data[gIdx + 2] = grassB;
                                data[gIdx + 3] = 255;
                            }
                        }

                        // Add occasional tufts (visual noise)
                        if (Math.random() < 0.1) {
                            // Draw a little tuft up into the air
                            for (let k = 1; k <= 3; k++) {
                                const tIdx = ((y - k) * width + x) * 4;
                                if (tIdx >= 0) {
                                    data[tIdx] = grassR;
                                    data[tIdx + 1] = grassG;
                                    data[tIdx + 2] = grassB;
                                    data[tIdx + 3] = 255;
                                }
                            }
                        }
                    }
                    inGround = true;
                } else {
                    inGround = false;
                }
            }
        }

        this.ctx.putImageData(imageData, 0, 0);
    }

    /**
     * Generate height map with Worms-style terrain
     */
    generateHeightMap() {
        const heightMap = new Array(this.width);
        // Changed from 0.5 to 0.4 - terrain now extends higher up the map
        const baseHeight = this.height * 0.4;

        // Layer multiple sine waves for natural-looking terrain
        const waves = [
            { freq: 0.002, amp: 150, phase: Math.random() * Math.PI * 2 },
            { freq: 0.005, amp: 80, phase: Math.random() * Math.PI * 2 },
            { freq: 0.01, amp: 40, phase: Math.random() * Math.PI * 2 },
            { freq: 0.02, amp: 20, phase: Math.random() * Math.PI * 2 },
            { freq: 0.05, amp: 8, phase: Math.random() * Math.PI * 2 }
        ];

        for (let x = 0; x < this.width; x++) {
            let y = baseHeight;

            for (const wave of waves) {
                y += Math.sin(x * wave.freq + wave.phase) * wave.amp;
            }

            // Create some flatter areas (platforms)
            if (Math.random() < 0.02) {
                const platformWidth = 50 + Math.random() * 100;
                for (let px = 0; px < platformWidth && x + px < this.width; px++) {
                    heightMap[x + px] = y;
                }
                x += platformWidth - 1;
            }

            // Add occasional vertical cliffs
            if (Math.random() < 0.01) {
                const cliffHeight = 50 + Math.random() * 100;
                y += (Math.random() > 0.5 ? 1 : -1) * cliffHeight;
            }

            // Clamp to valid range - now allows terrain up to Y=50 (was Y=100)
            heightMap[x] = Math.max(50, Math.min(this.height - 100, y));
        }

        // Smooth the height map
        for (let pass = 0; pass < 2; pass++) {
            for (let x = 1; x < this.width - 1; x++) {
                heightMap[x] = (heightMap[x - 1] + heightMap[x] + heightMap[x + 1]) / 3;
            }
        }

        return heightMap;
    }

    /**
     * Add grass layer on top of terrain
     */
    addGrassLayer(heightMap) {
        this.ctx.strokeStyle = this.grassColor;
        this.ctx.lineWidth = 4;
        this.ctx.beginPath();

        for (let x = 0; x < this.width; x++) {
            const y = heightMap[x];
            if (x === 0) {
                this.ctx.moveTo(x, y);
            } else {
                this.ctx.lineTo(x, y);
            }
        }

        this.ctx.stroke();

        // Add grass tufts
        this.ctx.fillStyle = '#5a9c23';
        for (let x = 0; x < this.width; x += 3) {
            const y = heightMap[x];
            if (Math.random() > 0.3) {
                const height = 3 + Math.random() * 5;
                this.ctx.beginPath();
                this.ctx.moveTo(x, y);
                this.ctx.lineTo(x - 2, y - height);
                this.ctx.lineTo(x + 2, y - height);
                this.ctx.closePath();
                this.ctx.fill();
            }
        }
    }

    /**
     * Get surface normal at a given point
     */
    getSurfaceNormal(x, y) {
        const radius = 5;
        let nx = 0;
        let ny = 0;

        // Sample nearby pixels to find average "push out" direction
        for (let ox = -radius; ox <= radius; ox++) {
            for (let oy = -radius; oy <= radius; oy++) {
                if (this.checkCollision(x + ox, y + oy)) {
                    nx -= ox;
                    ny -= oy;
                }
            }
        }

        const len = Math.hypot(nx, ny);
        if (len === 0) return { x: 0, y: -1 }; // Default to up
        return { x: nx / len, y: ny / len };
    }

    /**
     * Add texture to terrain
     */
    addTerrainTexture() {
        const imageData = this.ctx.getImageData(0, 0, this.width, this.height);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] > 0) { // If not transparent
                // Add noise
                const noise = (Math.random() - 0.5) * 20;
                data[i] = Math.max(0, Math.min(255, data[i] + noise));
                data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
                data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
            }
        }

        this.ctx.putImageData(imageData, 0, 0);
    }

    /**
     * Add terrain features like caves and overhangs
     */
    addTerrainFeatures() {
        // Add some caves
        const numCaves = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < numCaves; i++) {
            const cx = 200 + Math.random() * (this.width - 400);
            // Allow caves anywhere between top (20%) and bottom (80%)
            const cy = this.height * 0.2 + Math.random() * (this.height * 0.6);
            const radius = 30 + Math.random() * 50;

            this.createCrater(cx, cy, radius, false);
        }

        // Add some horizontal tunnels
        const numTunnels = Math.floor(Math.random() * 2);
        for (let i = 0; i < numTunnels; i++) {
            const startX = Math.random() * this.width * 0.3;
            // Allow tunnels anywhere between top (20%) and bottom (70%)
            const y = this.height * 0.2 + Math.random() * (this.height * 0.5);
            const length = 100 + Math.random() * 200;
            const height = 30 + Math.random() * 20;

            this.ctx.save();
            this.ctx.globalCompositeOperation = 'destination-out';
            this.ctx.fillStyle = 'rgba(255,255,255,1)';
            this.ctx.beginPath();
            this.ctx.ellipse(startX + length / 2, y, length / 2, height / 2, 0, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.restore();
        }

        this.updateCollisionMask();
    }

    /**
     * Update collision mask from visual terrain
     */
    updateCollisionMask() {
        // Copy terrain to mask
        this.maskCtx.clearRect(0, 0, this.width, this.height);
        this.maskCtx.drawImage(this.canvas, 0, 0);

        // Get image data for collision detection
        this.imageData = this.maskCtx.getImageData(0, 0, this.width, this.height);
        const data = this.imageData.data;

        // Force binary mask to prevent invisible collision
        // Any pixel with alpha < 128 is treated as air
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 128) {
                data[i + 3] = 0;
            } else {
                data[i + 3] = 255;
            }
        }

        this.maskCtx.putImageData(this.imageData, 0, 0);
    }

    /**
     * Check if a point collides with terrain
     */
    checkCollision(x, y) {
        x = Math.floor(x);
        y = Math.floor(y);

        if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
            return y >= this.height; // Below world = collision
        }

        const idx = (y * this.width + x) * 4;
        return this.imageData.data[idx + 3] > 128; // Alpha > 50%
    }



    /**
     * Create explosion crater in terrain
     */
    createCrater(cx, cy, radius, updateMask = true) {
        // Use destination-out to remove terrain
        this.ctx.save();
        this.ctx.globalCompositeOperation = 'destination-out';

        // Create soft-edged crater
        const gradient = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        gradient.addColorStop(0, 'rgba(255,255,255,1)');
        gradient.addColorStop(0.7, 'rgba(255,255,255,1)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');

        this.ctx.fillStyle = gradient;
        this.ctx.beginPath();
        this.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        this.ctx.fill();

        this.ctx.restore();

        // Add crater edge/burn marks
        this.ctx.save();
        this.ctx.globalCompositeOperation = 'source-atop';
        this.ctx.strokeStyle = '#2d1810';
        this.ctx.lineWidth = 3;
        this.ctx.beginPath();
        this.ctx.arc(cx, cy, radius * 0.9, 0, Math.PI * 2);
        this.ctx.stroke();
        this.ctx.restore();

        if (updateMask) {
            this.updateCollisionMask();
        }
    }

    /**
     * Check line of sight between two points
     */
    lineOfSight(x1, y1, x2, y2) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const dist = Math.hypot(dx, dy);
        const steps = Math.ceil(dist / 2);

        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const x = x1 + dx * t;
            const y = y1 + dy * t;

            if (this.checkCollision(x, y)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Get the terrain canvas for rendering
     */
    getCanvas() {
        return this.canvas;
    }

    /**
     * Scan the entire map for all valid spawn points (ground with air above).
     * This ensures the top half and multi-layered areas are all considered.
     */
    getAllSpawnPoints() {
        const points = [];
        if (!this.imageData) return points;

        const data = this.imageData.data;
        const width = this.width;
        const height = this.height;

        // Scan columns within map bounds
        for (let x = 100; x < width - 100; x += 10) {
            // Scan from top to absolute bottom (covering 100% of height)
            for (let y = 1; y < height - 10; y++) {
                const idx = (y * width + x) * 4;
                const aboveIdx = ((y - 1) * width + x) * 4;

                const isSolid = data[idx + 3] > 128;
                const isAirAbove = data[aboveIdx + 3] < 128;

                if (isSolid && isAirAbove) {
                    // This is a top surface.
                    // Check if there is enough vertical clearance above for a koala (approx 40px)
                    let clearance = true;
                    for (let checkY = y - 1; checkY > y - 40 && checkY > 0; checkY--) {
                        const cIdx = (Math.floor(checkY) * width + x) * 4;
                        if (data[cIdx + 3] > 128) {
                            clearance = false;
                            break;
                        }
                    }

                    if (clearance) {
                        points.push({ x, y: y - 20 });
                        // Skip ahead to avoid multiple points too close together on the same vertical stack
                        y += 50;
                    }
                }
            }
        }

        console.log(`🗺️ Found ${points.length} potential spawn points across the map.`);
        return points;
    }
}
