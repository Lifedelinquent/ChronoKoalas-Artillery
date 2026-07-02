/**
 * Terrain System - Worms-style destructible terrain
 * Uses pixel-based collision mask for destruction
 */

import { imageHasAir, deriveTerrainFromOpaqueImage } from '../utils/TerrainMask.js';

export class Terrain {
    constructor(width, height) {
        this.width = width;
        this.height = height;

        // Terrain data - true = solid, false = air
        this.data = null;

        // Seeded random function for multiplayer sync
        // If not set, falls back to this.random()
        this._seededRandom = null;

        // Visual canvas for terrain
        // willReadFrequently because getVisualGroundY uses getImageData
        this.canvas = document.createElement('canvas');
        this.canvas.width = width;
        this.canvas.height = height;
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

        // Collision mask canvas (for precise collision)
        // willReadFrequently tells the browser we'll call getImageData often
        this.maskCanvas = document.createElement('canvas');
        this.maskCanvas.width = width;
        this.maskCanvas.height = height;
        this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true });

        // Terrain colors (legacy defaults; generated maps use this.theme)
        this.grassColor = '#4a7c23';
        this.dirtColor = '#8B4513';
        this.dirtDarkColor = '#654321';
        this.skyColor = '#87CEEB';

        // Visual theme chosen by generate(). Null for custom/editor maps —
        // the renderer falls back to its default sky.
        this.theme = null;
    }

    /**
     * Set a seeded random function for multiplayer sync
     */
    setSeededRandom(seededRandom) {
        this._seededRandom = seededRandom;
    }

    /**
     * Get a random number (uses seeded random if available)
     */
    random() {
        return this._seededRandom ? this._seededRandom() : Math.random();
    }

    /**
     * Generate a fresh random battlefield.
     *
     * Every draw goes through this.random() (the shared seeded RNG in
     * multiplayer), so both clients build a pixel-identical map from the
     * match seed.
     */
    generate() {
        this.theme = this.pickTheme();
        const layout = this.pickLayout();
        console.log(`🗺️ Generating map: theme=${this.theme.id}, layout=${layout}`);

        this.ctx.clearRect(0, 0, this.width, this.height);

        // 1. Sculpt the landmass silhouette
        const heightMap = this.buildHeightMap(layout);
        this.paintLandmass(heightMap);
        this.addStrataBands();
        this.addBuriedRocks();

        // 2. Carve winding caves and surface scoops, then hang islands in the sky
        this.carveCaves(heightMap);
        this.addFloatingIslands(heightMap);

        // 3. Destructible scenery, painted into the terrain
        this.addMapObjects();

        // 4. Polish: grain, depth shading, then the surface coat + dark
        //    outline that gives every edge a clean cartoon rim
        this.addTerrainTexture();
        this.applyDepthShading();
        this.applySurfaceCoating();
        this.addSurfaceDecor();

        this.updateCollisionMask();
    }

    /**
     * Visual themes. Each is a complete palette: sky gradient stops, soil
     * strata (top -> bottom), the surface coat (grass/sand/snow/crust), the
     * outline rim, buried rocks, decoration accents and vegetation style.
     */
    pickTheme() {
        const themes = [
            {
                id: 'grassland',
                sky: ['#173d63', '#2a5c8f', '#7ec8e3', '#dff3f7'],
                cloud: 'rgba(255, 255, 255, 0.8)',
                strata: ['#9a6a35', '#7f5128', '#633d1e', '#452a15'],
                deepShade: 'rgba(20, 10, 4, 0.5)',
                surface: '#4f9e2b',
                surfaceTop: '#7cc94e',
                surfaceDepth: 7,
                outline: '#2b1a0c',
                rock: ['#8a8a8a', '#6f6f6f'],
                accents: ['#e74c3c', '#f1c40f', '#ecf0f1'],
                decorStyle: 'flowers',
                treeStyle: 'gum',
                canopy: ['#2f6b2a', '#3e8a35', '#57a344'],
                trunk: '#5a4030'
            },
            {
                id: 'desert',
                sky: ['#2c1e4a', '#8e3b60', '#e8804f', '#f7d488'],
                cloud: 'rgba(255, 240, 220, 0.55)',
                strata: ['#d9a45f', '#c08744', '#9c6b33', '#7a5126'],
                deepShade: 'rgba(60, 25, 5, 0.45)',
                surface: '#e8c479',
                surfaceTop: '#f6dfa0',
                surfaceDepth: 6,
                outline: '#4a2c12',
                rock: ['#b08d62', '#8d6f4a'],
                accents: ['#c98f4a', '#a5713a', '#e0b070'],
                decorStyle: 'pebbles',
                treeStyle: 'cactus',
                canopy: ['#2e8b57', '#3cb371', '#57c785'],
                trunk: '#7c5a3a'
            },
            {
                id: 'tundra',
                sky: ['#0b1e3d', '#20456e', '#6fa3c8', '#d8ecf5'],
                cloud: 'rgba(255, 255, 255, 0.65)',
                strata: ['#7d8a99', '#5f6c7b', '#47525f', '#333c47'],
                deepShade: 'rgba(8, 12, 22, 0.5)',
                surface: '#dfeef7',
                surfaceTop: '#ffffff',
                surfaceDepth: 8,
                outline: '#1f2733',
                rock: ['#9fb2c4', '#7b8ea0'],
                accents: ['#9fdcef', '#cfe8ff', '#7fc4e8'],
                decorStyle: 'crystals',
                treeStyle: 'pine',
                canopy: ['#1e4d3b', '#2a6b50', '#357f61'],
                trunk: '#4a3527'
            },
            {
                id: 'volcanic',
                sky: ['#1a090d', '#451114', '#8c2f1b', '#e07b39'],
                cloud: 'rgba(90, 70, 70, 0.5)',
                strata: ['#5a4a44', '#463833', '#332824', '#221a17'],
                deepShade: 'rgba(0, 0, 0, 0.5)',
                surface: '#6d6660',
                surfaceTop: '#8a817a',
                surfaceDepth: 6,
                outline: '#120c0a',
                rock: ['#54483f', '#3c332d'],
                accents: ['#ff6b35', '#ffa62b', '#ff8c42'],
                decorStyle: 'embers',
                treeStyle: 'dead',
                canopy: ['#3a2e26'],
                trunk: '#33241c'
            }
        ];
        return themes[Math.floor(this.random() * themes.length)];
    }

    /**
     * Landmass archetypes: gentle rolling hills, dramatic highlands with
     * peaks and passes, or an archipelago of separate masses with water gaps.
     */
    pickLayout() {
        const roll = this.random();
        if (roll < 0.4) return 'rolling';
        if (roll < 0.7) return 'highlands';
        return 'archipelago';
    }

    /**
     * 1D value noise: seeded random control points with smoothstep
     * interpolation. Returns a function of x.
     */
    makeValueNoise(wavelength, amplitude) {
        const count = Math.ceil(this.width / wavelength) + 3;
        const values = [];
        for (let i = 0; i < count; i++) values.push(this.random() * 2 - 1);
        return (x) => {
            const fx = x / wavelength;
            const i = Math.floor(fx);
            const t = fx - i;
            const s = t * t * (3 - 2 * t);
            return (values[i] * (1 - s) + values[i + 1] * s) * amplitude;
        };
    }

    /**
     * Build the surface heightmap from layered value noise. Archipelago
     * layouts pinch the land into 2-3 masses that sink below the water line
     * between them.
     */
    buildHeightMap(layout) {
        const w = this.width;
        const scale = layout === 'highlands' ? 1.35 : layout === 'rolling' ? 0.8 : 1.0;
        const octaves = [
            this.makeValueNoise(w / 3.2, 190 * scale),
            this.makeValueNoise(w / 8, 85 * scale),
            this.makeValueNoise(w / 20, 34 * scale),
            this.makeValueNoise(w / 55, 12)
        ];
        const base = layout === 'highlands'
            ? this.height * (0.52 + this.random() * 0.08)
            : this.height * (0.60 + this.random() * 0.08);

        let envelope = null;
        if (layout === 'archipelago') {
            const count = 2 + Math.floor(this.random() * 2); // 2-3 landmasses
            const slot = w / count;
            const islands = [];
            for (let i = 0; i < count; i++) {
                islands.push({
                    c: slot * i + slot * (0.3 + this.random() * 0.4),
                    r: slot * (0.34 + this.random() * 0.12)
                });
            }
            envelope = (x) => {
                let e = 0;
                for (const isl of islands) {
                    const d = Math.abs(x - isl.c) / isl.r;
                    if (d < 1) e = Math.max(e, 1 - d * d);
                }
                return e;
            };
        }

        // Mainland never dips below the water line; archipelago is allowed
        // to sink between masses (that's what makes the open water gaps)
        const maxY = layout === 'archipelago' ? this.height + 70 : this.height - 85;
        const heightMap = new Float32Array(w);
        for (let x = 0; x < w; x++) {
            let y = base;
            for (const o of octaves) y += o(x);
            if (envelope) {
                const seaFloor = this.height + 70;
                y = seaFloor - (seaFloor - y) * Math.pow(Math.max(0, envelope(x)), 0.75);
            }
            heightMap[x] = Math.max(this.height * 0.15, Math.min(maxY, y));
        }

        // Light smoothing so slopes stay walkable
        for (let pass = 0; pass < 2; pass++) {
            for (let x = 1; x < w - 1; x++) {
                heightMap[x] = (heightMap[x - 1] + heightMap[x] + heightMap[x + 1]) / 3;
            }
        }
        return heightMap;
    }

    /**
     * Fill the land under the heightmap with a vertical soil-strata gradient
     */
    paintLandmass(heightMap) {
        const ctx = this.ctx;
        let minY = this.height;
        for (let x = 0; x < this.width; x++) minY = Math.min(minY, heightMap[x]);

        const strata = this.theme.strata;
        const grad = ctx.createLinearGradient(0, minY, 0, this.height);
        grad.addColorStop(0, strata[0]);
        grad.addColorStop(0.3, strata[1]);
        grad.addColorStop(0.65, strata[2]);
        grad.addColorStop(1, strata[3]);
        ctx.fillStyle = grad;

        ctx.beginPath();
        ctx.moveTo(-10, this.height + 10);
        ctx.lineTo(-10, heightMap[0]);
        for (let x = 0; x < this.width; x++) {
            ctx.lineTo(x, heightMap[x]);
        }
        ctx.lineTo(this.width + 10, heightMap[this.width - 1]);
        ctx.lineTo(this.width + 10, this.height + 10);
        ctx.closePath();
        ctx.fill();
    }

    /**
     * Subtle wavy sedimentary bands inside the soil (clipped to terrain)
     */
    addStrataBands() {
        const ctx = this.ctx;
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        const bands = 4 + Math.floor(this.random() * 3);
        for (let i = 0; i < bands; i++) {
            const baseY = this.height * (0.45 + this.random() * 0.5);
            const thickness = 8 + this.random() * 18;
            const wobble = this.makeValueNoise(300 + this.random() * 300, 14 + this.random() * 18);
            ctx.fillStyle = this.random() < 0.5 ? 'rgba(0, 0, 0, 0.10)' : 'rgba(255, 255, 255, 0.06)';
            ctx.beginPath();
            ctx.moveTo(0, baseY + wobble(0));
            for (let x = 24; x <= this.width; x += 24) ctx.lineTo(x, baseY + wobble(x));
            for (let x = this.width; x >= 0; x -= 24) ctx.lineTo(x, baseY + wobble(x) + thickness);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    }

    /**
     * Scatter buried rocks through the soil (recolored terrain, still
     * destructible — pure texture)
     */
    addBuriedRocks() {
        const ctx = this.ctx;
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        const count = 24 + Math.floor(this.random() * 16);
        for (let i = 0; i < count; i++) {
            const x = this.random() * this.width;
            const y = this.height * 0.45 + this.random() * this.height * 0.5;
            const r = 4 + this.random() * 14;
            ctx.fillStyle = this.theme.rock[Math.floor(this.random() * this.theme.rock.length)];
            ctx.beginPath();
            ctx.ellipse(x, y, r, r * (0.6 + this.random() * 0.4), this.random() * Math.PI, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    /**
     * Carve winding cave tunnels underground plus a few open scoops in the
     * surface for koalas to shelter in
     */
    carveCaves(heightMap) {
        const ctx = this.ctx;
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = 'rgba(255,255,255,1)';

        const caves = 2 + Math.floor(this.random() * 3);
        for (let i = 0; i < caves; i++) {
            let x = 200 + this.random() * (this.width - 400);
            const surf = heightMap[Math.floor(x)];
            if (surf > this.height - 220) continue; // skip water gaps / low land
            let y = surf + 80 + this.random() * 120;
            let angle = this.random() * Math.PI;
            let r = 26 + this.random() * 22;
            const segments = 5 + Math.floor(this.random() * 6);
            for (let s = 0; s < segments; s++) {
                y = Math.max(surf + 50, Math.min(this.height - 140, y));
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fill();
                angle += (this.random() - 0.5) * 1.2;
                x += Math.cos(angle) * r * 1.2;
                y += Math.sin(angle) * r * 0.8;
                r *= 0.92 + this.random() * 0.12;
            }
        }

        // Shallow surface scoops (open-air foxholes)
        const scoops = 3 + Math.floor(this.random() * 3);
        for (let i = 0; i < scoops; i++) {
            const x = 150 + this.random() * (this.width - 300);
            const surfY = heightMap[Math.floor(x)];
            if (surfY > this.height - 180) continue;
            const r = 35 + this.random() * 30;
            ctx.beginPath();
            ctx.ellipse(x, surfY, r, r * 0.6, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    /**
     * Hang 1-3 floating islands in the sky where there's clearance below
     */
    addFloatingIslands(heightMap) {
        const count = 1 + Math.floor(this.random() * 3);
        for (let i = 0; i < count; i++) {
            for (let attempt = 0; attempt < 12; attempt++) {
                const w = 180 + this.random() * 220;
                const x = 150 + this.random() * (this.width - 300 - w);
                const cx = x + w / 2;
                let minSurf = Infinity;
                for (let sx = Math.floor(x); sx < x + w; sx += 10) {
                    minSurf = Math.min(minSurf, heightMap[sx]);
                }
                const y = Math.max(140, minSurf - 260 - this.random() * 160);
                if (minSurf - y < 180) continue; // not enough air underneath
                this.paintIsland(cx, y, w);
                break;
            }
        }
    }

    /**
     * A floating island: wavy flat-ish top with a bulging, bumpy underbelly
     */
    paintIsland(cx, topY, w) {
        const ctx = this.ctx;
        const half = w / 2;
        const depth = 40 + this.random() * 50 + w * 0.15;

        const grad = ctx.createLinearGradient(0, topY, 0, topY + depth);
        grad.addColorStop(0, this.theme.strata[0]);
        grad.addColorStop(1, this.theme.strata[2]);
        ctx.fillStyle = grad;

        ctx.beginPath();
        ctx.moveTo(cx - half, topY + 8);
        const bumps = 5;
        for (let b = 0; b <= bumps; b++) {
            ctx.lineTo(cx - half + (w * b) / bumps, topY + (this.random() - 0.4) * 10);
        }
        const bottomBumps = 4 + Math.floor(this.random() * 3);
        for (let b = 0; b <= bottomBumps; b++) {
            const t = b / bottomBumps;
            const sag = Math.sin(Math.PI * t) * depth;
            ctx.lineTo(cx + half - w * t, topY + 10 + sag * (0.7 + this.random() * 0.5));
        }
        ctx.closePath();
        ctx.fill();
    }

    /**
     * Darken the soil with depth (clipped to terrain) — cheap fake lighting
     */
    applyDepthShading() {
        const ctx = this.ctx;
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        const grad = ctx.createLinearGradient(0, this.height * 0.35, 0, this.height);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, this.theme.deepShade);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, this.width, this.height);
        ctx.restore();
    }

    /** Parse '#rrggbb' into [r, g, b] */
    hexToRgb(hex) {
        const v = parseInt(hex.slice(1), 16);
        return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    }

    /**
     * The "premium" finishing pass, done at pixel level:
     * - every walkable top surface gets a coat of the theme surface color
     *   (grass/sand/snow/crust) with a bright 2px highlight and the odd tuft
     * - every other solid edge (sides, undersides, cave ceilings) gets a
     *   2px dark outline rim, Worms-style
     */
    applySurfaceCoating() {
        const img = this.ctx.getImageData(0, 0, this.width, this.height);
        const d = img.data;
        const W = this.width;
        const H = this.height;

        // Solidity snapshot BEFORE painting, so the passes don't feed on
        // their own output
        const solid = new Uint8Array(W * H);
        for (let i = 0, p = 3; i < W * H; i++, p += 4) solid[i] = d[p] >= 128 ? 1 : 0;

        const surface = this.hexToRgb(this.theme.surface);
        const surfaceTop = this.hexToRgb(this.theme.surfaceTop);
        const outline = this.hexToRgb(this.theme.outline);
        const depth = this.theme.surfaceDepth;

        const paint = (idx, c) => {
            const p = idx * 4;
            d[p] = c[0];
            d[p + 1] = c[1];
            d[p + 2] = c[2];
            d[p + 3] = 255;
        };

        // Pass 1: coat top surfaces (air above, solid below).
        // Above-canvas counts as solid: terrain flush with the map top is a
        // ceiling, not ground (mirrors getVisualGroundY).
        for (let x = 0; x < W; x++) {
            let airRun = 0;
            for (let y = 0; y < H; y++) {
                const i = y * W + x;
                if (solid[i]) {
                    if (airRun >= 4) {
                        for (let k = 0; k < depth && y + k < H; k++) {
                            const j = (y + k) * W + x;
                            if (!solid[j]) break;
                            paint(j, k < 2 ? surfaceTop : surface);
                        }
                        // Occasional tuft poking up into the air
                        if (this.random() < 0.08) {
                            const tuftH = 2 + Math.floor(this.random() * 3);
                            for (let k = 1; k <= tuftH && y - k >= 0; k++) {
                                paint((y - k) * W + x, surfaceTop);
                            }
                        }
                    }
                    airRun = 0;
                } else {
                    airRun++;
                }
            }
        }

        // Pass 2: dark rim on side/bottom edges (skip grassed tops)
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                if (!solid[i]) continue;
                const airAbove =
                    (y >= 1 && !solid[i - W]) ||
                    (y >= 2 && !solid[i - 2 * W]) ||
                    (y >= 3 && !solid[i - 3 * W]);
                if (airAbove) continue;
                const airBeside =
                    (x >= 1 && !solid[i - 1]) || (x >= 2 && !solid[i - 2]) ||
                    (x + 1 < W && !solid[i + 1]) || (x + 2 < W && !solid[i + 2]) ||
                    (y + 1 < H && !solid[i + W]) || (y + 2 < H && !solid[i + 2 * W]);
                if (airBeside) paint(i, outline);
            }
        }

        this.ctx.putImageData(img, 0, 0);
    }

    /**
     * Sprinkle tiny themed decorations on top surfaces (flowers, pebbles,
     * ice crystals, glowing embers). Painted after the coating so they stay
     * crisp — they're a few pixels of destructible terrain like everything
     * else.
     */
    addSurfaceDecor() {
        const count = 20 + Math.floor(this.random() * 14);
        for (let i = 0; i < count; i++) {
            const x = 60 + this.random() * (this.width - 120);
            const surfaces = this.getVisualGroundY(x);
            if (surfaces.length === 0) continue;
            const y = surfaces[Math.floor(this.random() * surfaces.length)];
            if (y < 60 || y > this.height - 100) continue;
            this.drawAccent(x, y);
        }
    }

    /** One tiny themed decoration at a surface point */
    drawAccent(x, y) {
        const ctx = this.ctx;
        const accents = this.theme.accents;
        const color = accents[Math.floor(this.random() * accents.length)];
        ctx.save();
        ctx.translate(x, y);
        switch (this.theme.decorStyle) {
            case 'flowers': {
                const h = 5 + this.random() * 5;
                ctx.strokeStyle = '#3e7a2a';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(0, 0);
                ctx.lineTo(0, -h);
                ctx.stroke();
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(0, -h - 2, 2.5, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#ffe680';
                ctx.beginPath();
                ctx.arc(0, -h - 2, 1, 0, Math.PI * 2);
                ctx.fill();
                break;
            }
            case 'crystals': {
                const h = 6 + this.random() * 8;
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.moveTo(-3, 0);
                ctx.lineTo(0, -h);
                ctx.lineTo(3, 0);
                ctx.closePath();
                ctx.fill();
                break;
            }
            case 'pebbles': {
                ctx.fillStyle = color;
                for (let j = 0; j < 3; j++) {
                    ctx.beginPath();
                    ctx.ellipse((this.random() - 0.5) * 12, -1.5, 2 + this.random() * 2, 1.5, 0, 0, Math.PI * 2);
                    ctx.fill();
                }
                break;
            }
            case 'embers': {
                ctx.strokeStyle = color;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(-4 - this.random() * 4, -1);
                ctx.lineTo(4 + this.random() * 4, -1);
                ctx.stroke();
                break;
            }
        }
        ctx.restore();
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

        // Scan from top to bottom, find all transitions from air to solid.
        // Start by treating the area above the image as SOLID, not air: terrain
        // pressed flush against the top edge is the map's ceiling/border, not a
        // surface you can stand on (there's no headroom inside the play area).
        // Without this, a map whose top row is solid (e.g. an imported image with
        // an opaque sky) reports a phantom surface at y=0, and characters get
        // spawned in the empty space above the map. A normal map with a
        // transparent sky still works: the first real air pixels build the streak
        // and the true ground surface below is detected normally.
        let previousWasAir = false; // Assume solid (border) above the image
        let airStreak = 0;          // No usable air above the top edge

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
     * Find the first ground Y position at a given X coordinate
     * Used for loot crate placement
     */
    findGroundY(x) {
        const surfaces = this.getVisualGroundY(x);
        return surfaces.length > 0 ? surfaces[0] : null;
    }

    /**
     * Scatter destructible scenery (trees, boulders, shrubs) across the map.
     * All of it is painted into the terrain, so it blocks shots and blows up
     * like the ground itself. Explosive barrels are no longer painted here —
     * oil drums are live entities managed by Game.
     */
    addMapObjects() {
        const placedObjects = []; // Track positions {x, y}

        // Try to place an object anywhere on the map
        const tryPlaceObject = (draw, minSpacing) => {
            // Try up to 50 times to find a valid spot
            for (let attempt = 0; attempt < 50; attempt++) {
                const x = 80 + this.random() * (this.width - 160);
                const surfaces = this.getVisualGroundY(x);
                if (surfaces.length === 0) continue;

                // Pick a random surface from all available
                const y = surfaces[Math.floor(this.random() * surfaces.length)];

                // Skip if too close to the top edge or under water
                if (y < 60 || y > this.height - 90) continue;

                // Check distance from other objects
                let tooClose = false;
                for (const obj of placedObjects) {
                    if (Math.hypot(x - obj.x, y - obj.y) < minSpacing) {
                        tooClose = true;
                        break;
                    }
                }
                if (tooClose) continue;

                draw(x, y);
                placedObjects.push({ x, y });
                return true;
            }
            return false;
        };

        const trees = 9 + Math.floor(this.random() * 6);
        for (let i = 0; i < trees; i++) {
            tryPlaceObject((x, y) => this.createTree(x, y), 110);
        }

        const boulders = 5 + Math.floor(this.random() * 4);
        for (let i = 0; i < boulders; i++) {
            tryPlaceObject((x, y) => this.createBoulder(x, y), 90);
        }

        const shrubs = 6 + Math.floor(this.random() * 5);
        for (let i = 0; i < shrubs; i++) {
            tryPlaceObject((x, y) => this.createShrub(x, y), 70);
        }
    }

    /**
     * Draw a themed destructible tree
     */
    createTree(x, y) {
        switch (this.theme.treeStyle) {
            case 'pine': return this.drawPineTree(x, y);
            case 'cactus': return this.drawCactus(x, y);
            case 'dead': return this.drawDeadTree(x, y);
            default: return this.drawGumTree(x, y);
        }
    }

    /** Grassland gum tree: leaning trunk with layered canopy blobs */
    drawGumTree(x, y) {
        const ctx = this.ctx;
        ctx.save();
        ctx.translate(x, y);

        const trunkW = 14 + this.random() * 10;
        const trunkH = 55 + this.random() * 55;
        const lean = (this.random() - 0.5) * 20;

        ctx.fillStyle = this.theme.trunk;
        ctx.beginPath();
        ctx.moveTo(-trunkW / 2, 2);
        ctx.quadraticCurveTo(lean / 2, -trunkH / 2, lean - trunkW / 3, -trunkH);
        ctx.lineTo(lean + trunkW / 3, -trunkH);
        ctx.quadraticCurveTo(lean / 2 + trunkW / 4, -trunkH / 2, trunkW / 2, 2);
        ctx.closePath();
        ctx.fill();

        // Layered canopy, dark base to light top, for depth
        const canopySize = 42 + this.random() * 30;
        const colors = this.theme.canopy;
        for (let layer = 0; layer < colors.length; layer++) {
            ctx.fillStyle = colors[layer];
            const spread = canopySize * (1 - layer * 0.22);
            ctx.beginPath();
            ctx.arc(lean - layer * 3, -trunkH - layer * 8, spread * 0.9, 0, Math.PI * 2);
            ctx.fill();
            for (let j = 0; j < 4 - layer; j++) {
                ctx.beginPath();
                ctx.arc(
                    lean + (this.random() - 0.5) * spread * 1.6,
                    -trunkH + (this.random() - 0.55) * spread,
                    spread * (0.4 + this.random() * 0.25),
                    0, Math.PI * 2
                );
                ctx.fill();
            }
        }
        ctx.restore();
    }

    /** Tundra pine: stacked triangle tiers on a stubby trunk */
    drawPineTree(x, y) {
        const ctx = this.ctx;
        ctx.save();
        ctx.translate(x, y);

        const trunkW = 10 + this.random() * 6;
        const trunkH = 18 + this.random() * 18;
        ctx.fillStyle = this.theme.trunk;
        ctx.fillRect(-trunkW / 2, -trunkH, trunkW, trunkH + 2);

        const tiers = 3 + Math.floor(this.random() * 3);
        const baseW = 46 + this.random() * 26;
        const tierH = 26 + this.random() * 10;
        const colors = this.theme.canopy;
        let ty = -trunkH;
        for (let t = 0; t < tiers; t++) {
            const w = baseW * (1 - t / (tiers + 0.5));
            ctx.fillStyle = colors[Math.min(t, colors.length - 1)];
            ctx.beginPath();
            ctx.moveTo(-w / 2, ty);
            ctx.lineTo(w / 2, ty);
            ctx.lineTo(0, ty - tierH * 1.4);
            ctx.closePath();
            ctx.fill();
            ty -= tierH * 0.75;
        }
        ctx.restore();
    }

    /** Desert saguaro cactus: ribbed column with 1-2 arms */
    drawCactus(x, y) {
        const ctx = this.ctx;
        ctx.save();
        ctx.translate(x, y);

        const h = 45 + this.random() * 45;
        const w = 16 + this.random() * 8;
        const colors = this.theme.canopy;
        const body = colors[Math.floor(this.random() * colors.length)];

        const column = (cx, top, cw, ch) => {
            ctx.fillStyle = body;
            ctx.beginPath();
            ctx.moveTo(cx - cw / 2, 0 - top);
            ctx.lineTo(cx - cw / 2, -top - ch + cw / 2);
            ctx.arc(cx, -top - ch + cw / 2, cw / 2, Math.PI, 0);
            ctx.lineTo(cx + cw / 2, -top);
            ctx.closePath();
            ctx.fill();
        };

        // Main column
        column(0, -2, w, h);

        // Arms: horizontal stub then a vertical rise
        const arms = 1 + Math.floor(this.random() * 2);
        for (let a = 0; a < arms; a++) {
            const side = a === 0 ? (this.random() < 0.5 ? -1 : 1) : (this.random() < 0.5 ? -1 : 1);
            const armY = h * (0.35 + this.random() * 0.3);
            const armLen = 12 + this.random() * 10;
            const armH = 16 + this.random() * 16;
            ctx.fillStyle = body;
            ctx.fillRect(side > 0 ? 0 : -w / 2 - armLen, -armY - w * 0.35, w / 2 + armLen, w * 0.7);
            column(side * (w / 2 + armLen - w * 0.35), armY - w * 0.35, w * 0.7, armH);
        }

        // Ribs
        ctx.strokeStyle = 'rgba(0, 60, 30, 0.35)';
        ctx.lineWidth = 1.5;
        for (let r = -1; r <= 1; r++) {
            ctx.beginPath();
            ctx.moveTo(r * w * 0.25, 0);
            ctx.lineTo(r * w * 0.25, -h + w / 2);
            ctx.stroke();
        }
        ctx.restore();
    }

    /** Volcanic dead tree: crooked bare branches */
    drawDeadTree(x, y) {
        const ctx = this.ctx;
        ctx.save();
        ctx.translate(x, y);
        ctx.strokeStyle = this.theme.trunk;
        ctx.lineCap = 'round';

        const branch = (bx, by, angle, len, width, depth) => {
            const ex = bx + Math.cos(angle) * len;
            const ey = by + Math.sin(angle) * len;
            ctx.lineWidth = width;
            ctx.beginPath();
            ctx.moveTo(bx, by);
            ctx.lineTo(ex, ey);
            ctx.stroke();
            if (depth <= 0 || width < 2) return;
            const splits = 1 + Math.floor(this.random() * 2);
            for (let s = 0; s < splits; s++) {
                branch(ex, ey, angle + (this.random() - 0.5) * 1.4, len * (0.55 + this.random() * 0.2), width * 0.6, depth - 1);
            }
        };

        const trunkH = 40 + this.random() * 40;
        branch(0, 2, -Math.PI / 2 + (this.random() - 0.5) * 0.3, trunkH, 9 + this.random() * 5, 3);
        ctx.restore();
    }

    /**
     * Draw a themed boulder
     */
    createBoulder(x, y) {
        const ctx = this.ctx;
        ctx.save();
        ctx.translate(x, y);

        const size = 22 + this.random() * 22;
        const [bodyColor, shadeColor] = this.theme.rock;

        // Irregular polygon body
        ctx.fillStyle = bodyColor;
        ctx.beginPath();
        const points = 7;
        for (let p = 0; p <= points; p++) {
            const a = Math.PI + (Math.PI * p) / points; // upper half arc
            const r = size * (0.8 + this.random() * 0.3);
            const px = Math.cos(a + Math.PI / 2) * r;
            const py = -size * 0.55 + Math.sin(a + Math.PI / 2) * r * 0.62;
            if (p === 0) ctx.moveTo(px, Math.min(py, 2));
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();

        // Shadowed underside
        ctx.fillStyle = shadeColor;
        ctx.beginPath();
        ctx.ellipse(size * 0.15, -size * 0.25, size * 0.6, size * 0.28, 0.15, 0, Math.PI * 2);
        ctx.fill();

        // Sun-lit top
        ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
        ctx.beginPath();
        ctx.ellipse(-size * 0.2, -size * 0.75, size * 0.45, size * 0.22, -0.25, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    /**
     * Draw a small themed shrub (leafy clump, or a rock pile in dead/desert
     * themes)
     */
    createShrub(x, y) {
        const ctx = this.ctx;
        ctx.save();
        ctx.translate(x, y);

        if (this.theme.treeStyle === 'dead') {
            // Rubble pile
            for (let j = 0; j < 3; j++) {
                ctx.fillStyle = this.theme.rock[Math.floor(this.random() * this.theme.rock.length)];
                ctx.beginPath();
                ctx.ellipse((this.random() - 0.5) * 18, -4 - this.random() * 4, 5 + this.random() * 5, 4 + this.random() * 3, this.random() * Math.PI, 0, Math.PI * 2);
                ctx.fill();
            }
        } else {
            const colors = this.theme.canopy;
            for (let j = 0; j < 3; j++) {
                ctx.fillStyle = colors[Math.floor(this.random() * colors.length)];
                ctx.beginPath();
                ctx.arc((this.random() - 0.5) * 20, -6 - this.random() * 5, 8 + this.random() * 6, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();
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
     * Find the actual top boundary of the map (highest Y with any terrain).
     * Useful for teleport and spawn systems to know where the "real" map starts.
     * Returns Y coordinate of the highest terrain pixel, or 0 if map is empty.
     */
    getMapTopBoundary() {
        if (!this.imageData) return 0;

        const data = this.imageData.data;
        const width = this.width;
        const height = this.height;

        // Sample columns across the map to find highest terrain
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x += 10) { // Sample every 10 pixels for speed
                const idx = (y * width + x) * 4;
                if (data[idx + 3] > 128) {
                    // Found terrain at this Y level
                    return y;
                }
            }
        }

        return 0; // No terrain found
    }

    /**
     * Find the "sky" position above a specific ground point.
     * This is the first air pixel when scanning upward from the ground.
     * Used for Worms-style teleport (drop from above the ground).
     * @param {number} x - X coordinate
     * @param {number} groundY - Y coordinate of the ground surface
     * @returns {number} Y coordinate of the sky position above the ground
     */
    getSkyAboveGround(x, groundY) {
        if (!this.imageData) return Math.max(50, groundY - 100);

        const data = this.imageData.data;
        const width = this.width;
        const minY = 5; // Never start above Y=5

        // Scan upward from just above ground until we find air
        let skyY = Math.max(minY, groundY - 100); // Default to a reasonable drop height

        for (let y = groundY - 1; y > minY; y--) {
            const idx = (y * width + Math.floor(x)) * 4;
            if (data[idx + 3] <= 128) {
                // Found air! This is the sky position
                skyY = y;
                break;
            }
        }

        // IMPORTANT: Verify the found position is actually in open air
        // If ground is detected at skyY, scan DOWNWARD until we find free space
        let finalY = Math.max(minY, skyY);
        const checkIdx = (finalY * width + Math.floor(x)) * 4;

        if (data[checkIdx + 3] > 128) {
            // We're inside ground! Scan downward to find open air
            for (let y = finalY; y < groundY - 30; y++) {
                const idx = (y * width + Math.floor(x)) * 4;
                if (data[idx + 3] <= 128) {
                    // Found air below the obstruction
                    finalY = y;
                    break;
                }
            }
        }

        // Final safety clamp: must be at least minY
        return Math.max(minY, finalY);
    }

    /**
     * Check if a given X coordinate is a valid teleport destination.
     * Valid = within map bounds, has ground below, not in water.
     * @param {number} x - X coordinate to check
     * @returns {Object} { valid: boolean, groundY: number, reason: string }
     */
    isValidTeleportTarget(x) {
        // Check X bounds (leave margin at edges)
        if (x < 50 || x > this.width - 50) {
            return { valid: false, groundY: this.height, reason: 'outside_bounds' };
        }

        const groundY = this.getGroundY(x);

        // Check if ground is in water zone
        const waterLevel = this.height - 60;
        if (groundY >= waterLevel) {
            return { valid: false, groundY: groundY, reason: 'water' };
        }

        // Check if there's actual terrain at this X (not just empty column)
        if (groundY >= this.height - 10) {
            return { valid: false, groundY: groundY, reason: 'no_ground' };
        }

        return { valid: true, groundY: groundY, reason: 'ok' };
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
                const noise = (this.random() - 0.5) * 20;
                data[i] = Math.max(0, Math.min(255, data[i] + noise));
                data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
                data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
            }
        }

        this.ctx.putImageData(imageData, 0, 0);
    }

    /**
     * Update collision mask from visual terrain
     * @param {Object} region - Optional {x, y, width, height} to update only a specific area
     */
    updateCollisionMask(region = null) {
        if (region) {
            // OPTIMIZED: Only update the specified region
            const x = Math.max(0, Math.floor(region.x));
            const y = Math.max(0, Math.floor(region.y));
            const w = Math.min(this.width - x, Math.ceil(region.width));
            const h = Math.min(this.height - y, Math.ceil(region.height));

            if (w <= 0 || h <= 0) return;

            // Copy just this region from terrain canvas to mask
            this.maskCtx.clearRect(x, y, w, h);
            this.maskCtx.drawImage(this.canvas, x, y, w, h, x, y, w, h);

            // Get just this region's image data
            const regionData = this.maskCtx.getImageData(x, y, w, h);
            const data = regionData.data;

            // Binarize alpha
            for (let i = 0; i < data.length; i += 4) {
                data[i + 3] = data[i + 3] < 128 ? 0 : 255;
            }

            this.maskCtx.putImageData(regionData, x, y);

            // Update the main imageData cache for this region
            // We need to copy the region data back into our full imageData
            const fullData = this.imageData.data;
            for (let ry = 0; ry < h; ry++) {
                for (let rx = 0; rx < w; rx++) {
                    const srcIdx = (ry * w + rx) * 4;
                    const dstIdx = ((y + ry) * this.width + (x + rx)) * 4;
                    fullData[dstIdx + 3] = data[srcIdx + 3];
                }
            }
        } else {
            // FULL UPDATE: Original behavior for initial load
            this.maskCtx.clearRect(0, 0, this.width, this.height);
            this.maskCtx.drawImage(this.canvas, 0, 0);

            this.imageData = this.maskCtx.getImageData(0, 0, this.width, this.height);
            const data = this.imageData.data;

            for (let i = 0; i < data.length; i += 4) {
                data[i + 3] = data[i + 3] < 128 ? 0 : 255;
            }

            this.maskCtx.putImageData(this.imageData, 0, 0);
        }
    }

    /**
     * Safety net for custom maps saved as a fully-opaque image (before the map
     * editor learned to auto-convert imported pictures). Such a map has no air
     * anywhere, so every pixel is solid and there's nowhere to play. If we
     * detect that, derive a playable terrain mask from the picture's brightness
     * — exactly what the editor now does on import — and rebuild the collision
     * mask. Maps that already contain air (drawn maps, silhouettes, and pictures
     * imported with the current editor) are left untouched.
     *
     * @returns {boolean} true if the terrain was converted
     */
    ensurePlayableTerrain() {
        const imageData = this.ctx.getImageData(0, 0, this.width, this.height);
        if (imageHasAir(imageData.data, this.width * this.height)) return false;

        deriveTerrainFromOpaqueImage(imageData.data, this.width, this.height);
        this.ctx.putImageData(imageData, 0, 0);
        this.updateCollisionMask();
        return true;
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
            // OPTIMIZED: Only update the crater region
            const padding = 5; // Extra padding to catch edge effects
            this.updateCollisionMask({
                x: cx - radius - padding,
                y: cy - radius - padding,
                width: (radius + padding) * 2,
                height: (radius + padding) * 2
            });
        }
    }

    /**
     * Add a steel girder beam to the terrain (utility weapon).
     * Draws solid pixels onto the terrain canvas and refreshes the
     * collision mask for that region.
     */
    addGirder(cx, cy, width = 90, height = 12) {
        const x = cx - width / 2;
        const y = cy - height / 2;

        this.ctx.save();
        this.ctx.globalCompositeOperation = 'source-over';

        // Steel beam body
        const gradient = this.ctx.createLinearGradient(x, y, x, y + height);
        gradient.addColorStop(0, '#9aa5b1');
        gradient.addColorStop(0.5, '#6b7684');
        gradient.addColorStop(1, '#4a525e');
        this.ctx.fillStyle = gradient;
        this.ctx.fillRect(x, y, width, height);

        // Top/bottom flanges
        this.ctx.fillStyle = '#3a414b';
        this.ctx.fillRect(x, y, width, 2);
        this.ctx.fillRect(x, y + height - 2, width, 2);

        // Rivets
        this.ctx.fillStyle = '#2c323a';
        for (let rx = x + 8; rx < x + width - 4; rx += 14) {
            this.ctx.beginPath();
            this.ctx.arc(rx, cy, 1.8, 0, Math.PI * 2);
            this.ctx.fill();
        }

        this.ctx.restore();

        // Refresh collision data for the new beam
        const padding = 4;
        this.updateCollisionMask({
            x: x - padding,
            y: y - padding,
            width: width + padding * 2,
            height: height + padding * 2
        });
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
    getAllSpawnPoints(options = {}) {
        const points = [];
        if (!this.imageData) return points;
        options = options || {};

        // Respect map bounds so we never seed spawns in the dead zone above an
        // imported map, nor in/below the water line.
        const topLimit = Math.max(1, Math.floor(options.topY || 0));
        const waterLevel = options.waterLevel !== undefined
            ? options.waterLevel
            : this.height - 60;

        // Adaptive horizontal margins (fall back to a small inset on full maps).
        const minX = Math.max(20, Math.floor(options.minX ?? 20));
        const maxX = Math.min(this.width - 20, Math.floor(options.maxX ?? (this.width - 20)));

        const KOALA_CLEARANCE = 40; // vertical air a koala needs to stand

        // Scan columns across the map. We reuse getVisualGroundY() so the spawn
        // scan detects surfaces with the EXACT same logic the snap/physics path
        // uses (getGroundBelow). This keeps the two halves of the pipeline in
        // agreement and naturally surfaces every distinct level on multi-level
        // maps (no arbitrary vertical skipping).
        for (let x = minX; x <= maxX; x += 10) {
            const surfaces = this.getVisualGroundY(x);

            for (const surfaceY of surfaces) {
                // Skip surfaces above the real map top or at/below the water line.
                if (surfaceY < topLimit) continue;
                if (surfaceY >= waterLevel) continue;

                // Require enough headroom for the koala's body to stand here.
                let clearance = true;
                for (let cy = surfaceY - 1; cy > surfaceY - KOALA_CLEARANCE && cy > 0; cy--) {
                    if (this.checkCollision(x, cy)) {
                        clearance = false;
                        break;
                    }
                }
                if (!clearance) continue;

                // Require solid ground BENEATH the surface so we never spawn on a
                // thin floating sliver. Editor-drawn maps often leave a 1-2px
                // terrain detail near the top with open sky above it; that passes
                // the headroom check and leaves "just enough" air to fit a koala,
                // so characters end up stranded outside the playable area at the
                // very top. A real surface is backed by a meaningful slab of solid
                // terrain below it.
                const GROUND_DEPTH = 12; // px of terrain expected under a surface
                let solidBelow = 0;
                for (let dy = 0; dy < GROUND_DEPTH && surfaceY + dy < this.height; dy++) {
                    if (this.checkCollision(x, surfaceY + dy)) solidBelow++;
                }
                if (solidBelow < GROUND_DEPTH * 0.6) continue;

                points.push({ x, y: surfaceY - 20 });
            }
        }

        console.log(`🗺️ Found ${points.length} potential spawn points across the map.`);
        return points;
    }
}
