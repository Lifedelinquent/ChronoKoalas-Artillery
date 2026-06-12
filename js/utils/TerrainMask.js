/**
 * TerrainMask - shared logic for turning an arbitrary image into a *playable*
 * terrain mask.
 *
 * Used in two places so the behaviour is identical:
 *  - The map editor, when you import a picture (js/editor/MapEditor.js).
 *  - The engine, as a safety net when loading a custom map that was saved as a
 *    fully-opaque image before the editor learned to convert it (js/engine/Game.js).
 *
 * Convention: in an RGBA buffer a pixel is "air" (open space) when its alpha is
 * below 128, and "solid" terrain otherwise.
 */

/**
 * Does this RGBA buffer contain a meaningful amount of transparency? A proper
 * silhouette / drawn map has plenty of air; a flattened photo has essentially
 * none.
 *
 * @param {Uint8ClampedArray} data - RGBA pixel data
 * @param {number} pixels - number of pixels (data.length / 4)
 * @param {number} [threshold=0.02] - minimum air fraction to count as "has air"
 */
export function imageHasAir(data, pixels, threshold = 0.02) {
    let transparent = 0;
    for (let p = 0, i = 3; p < pixels; p++, i += 4) {
        if (data[i] < 128) transparent++;
    }
    return transparent / pixels > threshold;
}

/**
 * Build an air mask (1 = air) from the image's brightness so the map is played
 * *inside* its structure (caves, ledges, tunnels) rather than on a flat top.
 *
 * Bright landmasses become solid terrain and darker regions become open air.
 * The split point is chosen automatically with Otsu's method (the brightness
 * that best separates the image into two groups), so it adapts to any picture
 * instead of a hand-tuned constant. Polarity is detected from the top edge:
 * whichever side of the threshold the sky/background sits on is treated as air,
 * so it works for both dark-sky and light-sky images.
 *
 * @param {Uint8ClampedArray} data - RGBA pixel data (read-only here)
 * @param {Uint8Array} air - output mask, set to 1 for air pixels
 */
export function maskFromLuminance(data, air, W, H) {
    const N = W * H;
    const lum = new Uint8Array(N);
    const hist = new Float64Array(256);
    for (let p = 0, i = 0; p < N; p++, i += 4) {
        const L = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
        lum[p] = L;
        hist[L]++;
    }

    // Otsu: pick the threshold maximising between-class variance.
    let total = 0;
    for (let t = 0; t < 256; t++) total += t * hist[t];
    let sumB = 0, wB = 0, maxVar = -1, thr = 128;
    for (let t = 0; t < 256; t++) {
        wB += hist[t];
        if (wB === 0) continue;
        const wF = N - wB;
        if (wF <= 0) break;
        sumB += t * hist[t];
        const mB = sumB / wB;
        const mF = (total - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > maxVar) { maxVar = between; thr = t; }
    }

    // Polarity: the sky/background normally touches the top edge. Whichever side
    // of the threshold the top edge falls on is the air side.
    let topSum = 0, topN = 0;
    for (let x = 0; x < W; x += 7) { topSum += lum[x]; topN++; }
    const skyIsDark = (topSum / topN) < thr;

    for (let p = 0; p < N; p++) {
        const solid = skyIsDark ? lum[p] >= thr : lum[p] < thr;
        if (!solid) air[p] = 1;
    }
}

/**
 * Guarantee that a derived map is actually playable, no matter the picture:
 *  - If almost no air was found (terrain fills the frame), force the upper
 *    portion of the map to air so there's room to move/aim.
 *  - If almost nothing is solid (near-uniform image), restore a solid floor
 *    across the bottom so koalas have ground to stand on.
 *
 * @param {Uint8Array} air - air mask, mutated in place
 */
export function ensurePlayableSpace(air, W, H) {
    let airCount = 0;
    for (let p = 0; p < air.length; p++) airCount += air[p];
    const airFrac = airCount / air.length;

    if (airFrac < 0.10) {
        // Terrain fills the frame — open up the top third.
        const cutoff = Math.floor(H * 0.33);
        for (let y = 0; y < cutoff; y++) {
            const row = y * W;
            for (let x = 0; x < W; x++) air[row + x] = 1;
        }
    } else if (airFrac > 0.92) {
        // Almost nothing left solid — lay down a floor in the bottom third.
        const floorTop = Math.floor(H * 0.66);
        for (let y = floorTop; y < H; y++) {
            const row = y * W;
            for (let x = 0; x < W; x++) air[row + x] = 0;
        }
    }
}

/**
 * Convert an opaque picture (no transparency) into a playable terrain mask, in
 * place: air pixels become fully transparent, solid pixels keep their colour at
 * full opacity.
 *
 * @param {Uint8ClampedArray} data - RGBA pixel data, mutated in place
 */
export function deriveTerrainFromOpaqueImage(data, W, H) {
    const pixels = W * H;
    const air = new Uint8Array(pixels);
    maskFromLuminance(data, air, W, H);
    ensurePlayableSpace(air, W, H);
    for (let p = 0, i = 0; p < pixels; p++, i += 4) {
        if (air[p]) {
            data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0;
        } else {
            data[i + 3] = 255;
        }
    }
}

/**
 * Normalise an image that already encodes terrain via transparency into a clean
 * binary mask (no partially-transparent pixels), in place.
 *
 * @param {Uint8ClampedArray} data - RGBA pixel data, mutated in place
 */
export function normaliseSilhouette(data) {
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) {
            data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0;
        } else {
            data[i + 3] = 255;
        }
    }
}

/**
 * Turn any imported image into a playable terrain mask, in place. Silhouette
 * images (with real transparency) are respected; opaque pictures are converted
 * from their brightness.
 *
 * @param {Uint8ClampedArray} data - RGBA pixel data, mutated in place
 * @returns {boolean} true if the image was an opaque picture that got converted
 */
export function processTerrainImage(data, W, H) {
    const pixels = W * H;
    if (imageHasAir(data, pixels)) {
        normaliseSilhouette(data);
        return false;
    }
    deriveTerrainFromOpaqueImage(data, W, H);
    return true;
}
