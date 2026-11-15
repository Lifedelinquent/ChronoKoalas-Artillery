/**
 * Hash - FNV-1a helpers for fingerprinting simulation state.
 *
 * Multiplayer compares these fingerprints between clients every turn, so
 * they hash the EXACT bit pattern of each number: two doubles that differ
 * only in their last bit produce different hashes.
 */

export const FNV_OFFSET = 0x811C9DC5;
const FNV_PRIME = 0x01000193;

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

/** Fold a 32-bit integer into a hash. */
export function hashInt(h, n) {
    let w = n >>> 0;
    for (let b = 0; b < 4; b++) {
        h ^= w & 0xFF;
        h = Math.imul(h, FNV_PRIME);
        w >>>= 8;
    }
    return h >>> 0;
}

/** Fold a number (all 64 bits of its double) into a hash. */
export function hashNumber(h, n) {
    f64[0] = n;
    return hashInt(hashInt(h, u32[0]), u32[1]);
}

/** Fold a string into a hash. */
export function hashString(h, s) {
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i) & 0xFFFF;
        h = Math.imul(h, FNV_PRIME);
    }
    return hashInt(h, s.length);
}

/**
 * Fold any JSON-like value (numbers, strings, booleans, null, arrays, plain
 * objects) into a hash. Objects are walked in their own key order, so build
 * the value the same way on every client.
 */
export function hashValue(h, v) {
    if (typeof v === 'number') return hashNumber(h, v);
    if (typeof v === 'string') return hashString(h, v);
    if (typeof v === 'boolean') return hashInt(h, v ? 1 : 2);
    if (v === null || v === undefined) return hashInt(h, 3);
    if (Array.isArray(v)) {
        h = hashInt(h, v.length);
        for (let i = 0; i < v.length; i++) h = hashValue(h, v[i]);
        return h;
    }
    for (const key in v) {
        h = hashString(h, key);
        h = hashValue(h, v[key]);
    }
    return hashInt(h, 4);
}
