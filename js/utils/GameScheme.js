/**
 * GameScheme - Worms Armageddon-style match rule schemes.
 *
 * A scheme is a plain JSON-safe object describing every tunable match rule:
 * health, timers, sudden death, wind, hazards, crates and the per-weapon
 * starting ammo / round delay. The host's scheme ships inside the 'gameStart'
 * network message, so BOTH clients must be able to sanitize an arbitrary
 * received object back into safe ranges.
 *
 * JSON/network safety: infinite ammo is stored as -1 (never Infinity —
 * PeerJS's BinaryPack throws on non-finite numbers). WeaponManager converts
 * -1 back to Infinity when it builds a real inventory.
 */

import { WeaponManager } from '../weapons/WeaponManager.js';

const STORAGE_KEY = 'koala_custom_schemes';

// Weapons that must never be limited or delayed (turn management, not arms)
export const UNEDITABLE_WEAPONS = ['skip', 'surrender'];

/**
 * Numeric limits for every scheme field: [min, max, step].
 * Used by sanitizeScheme and by the editor UI to build its sliders.
 */
export const SCHEME_LIMITS = {
    startingHealth: [1, 500, 1],
    koalasPerTeam: [1, 6, 1],
    turnTime: [5, 90, 5],
    retreatTime: [0, 15, 1],
    windStrength: [0, 2, 0.25],
    fallDamageMultiplier: [0, 2, 0.25],
    damageMultiplier: [0.25, 3, 0.25],
    suddenDeathTime: [-1, 1800, 1],   // seconds; -1 = never
    suddenDeathHealthCap: [1, 200, 1],
    suddenDeathDecay: [0, 25, 1],
    waterRisePerTurn: [0, 60, 2],
    mineCount: [0, 24, 1],
    mineDudChance: [0, 1, 0.05],
    mineDelay: [-1, 5, 0.5],          // seconds; -1 = random (1.5-3s)
    oilDrumCount: [0, 16, 1],
    crateDropChance: [0, 1, 0.05],
    maxCratesOnMap: [0, 10, 1]
};

/**
 * Build the default weapon table without a full Game instance: a bare object
 * on the WeaponManager prototype (so createWeapons can call its own helper
 * methods) with no game attached (so no scheme overrides get applied).
 */
export function bareWeaponDefs() {
    const stub = Object.create(WeaponManager.prototype);
    stub.game = null;
    return stub.createWeapons();
}

/**
 * Default per-weapon scheme entries, derived from the live weapon
 * definitions so the two can never drift apart.
 */
export function defaultWeaponScheme() {
    const defs = bareWeaponDefs();
    const out = {};
    for (const id in defs) {
        if (UNEDITABLE_WEAPONS.includes(id)) continue;
        const ammo = defs[id].ammo;
        out[id] = {
            ammo: ammo === Infinity ? -1 : ammo,
            delay: 0
        };
    }
    return out;
}

/**
 * The baseline scheme: matches the game's historical hard-coded behavior.
 */
export function defaultScheme() {
    return {
        name: 'Classic',
        version: 1,
        // Teams & health
        startingHealth: 100,
        koalasPerTeam: 3,
        // Timers
        turnTime: 30,
        retreatTime: 5,
        // Environment
        windStrength: 1,
        fallDamageMultiplier: 1,
        damageMultiplier: 1,
        artilleryMode: false,
        // Sudden death
        suddenDeathTime: 180,
        suddenDeathHealthCap: 25,
        suddenDeathDecay: 5,
        waterRisePerTurn: 12,
        // Map hazards
        mineCount: 6,
        mineDudChance: 0.12,
        mineDelay: -1,
        oilDrumCount: 5,
        // Crates
        crateDropChance: 0.33,
        maxCratesOnMap: 5,
        // Per-weapon ammo (-1 = infinite) and delay (rounds before usable)
        weapons: defaultWeaponScheme()
    };
}

function clampNum(value, [min, max], fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

/**
 * Coerce an arbitrary (possibly remote / stale / hand-edited) object into a
 * complete, in-range scheme. Always returns a fresh object.
 */
export function sanitizeScheme(raw) {
    const scheme = defaultScheme();
    if (!raw || typeof raw !== 'object') return scheme;

    if (typeof raw.name === 'string' && raw.name.trim()) {
        scheme.name = raw.name.trim().slice(0, 32);
    }
    for (const key in SCHEME_LIMITS) {
        if (raw[key] !== undefined) {
            scheme[key] = clampNum(raw[key], SCHEME_LIMITS[key], scheme[key]);
        }
    }
    // -1 sentinels must survive clamping exactly
    if (raw.suddenDeathTime === -1) scheme.suddenDeathTime = -1;
    if (raw.mineDelay === -1) scheme.mineDelay = -1;
    scheme.artilleryMode = !!raw.artilleryMode;

    if (raw.weapons && typeof raw.weapons === 'object') {
        for (const id in scheme.weapons) {
            const ov = raw.weapons[id];
            if (!ov || typeof ov !== 'object') continue;
            const entry = scheme.weapons[id];
            if (ov.ammo !== undefined) {
                entry.ammo = ov.ammo === -1 ? -1 : Math.round(clampNum(ov.ammo, [0, 25], entry.ammo));
            }
            if (ov.delay !== undefined) {
                entry.delay = Math.round(clampNum(ov.delay, [0, 10], entry.delay));
            }
        }
    }
    return scheme;
}

/**
 * Build a preset: defaults + shallow field overrides + weapon overrides.
 * weaponOverrides: { '*': {ammo}, bazooka: {ammo, delay}, ... } — '*' applies
 * to every editable weapon first, then specific ids refine it.
 */
function makePreset(name, overrides = {}, weaponOverrides = null) {
    const scheme = defaultScheme();
    Object.assign(scheme, overrides);
    scheme.name = name;
    if (weaponOverrides) {
        if (weaponOverrides['*']) {
            for (const id in scheme.weapons) {
                Object.assign(scheme.weapons[id], weaponOverrides['*']);
            }
        }
        for (const id in weaponOverrides) {
            if (id === '*' || !scheme.weapons[id]) continue;
            Object.assign(scheme.weapons[id], weaponOverrides[id]);
        }
    }
    return scheme;
}

/**
 * Built-in presets, modeled on classic Worms Armageddon schemes.
 */
export function getPresetSchemes() {
    return [
        makePreset('Classic'),

        // Gentle intro: tanky koalas, long turns, calm wind, generous crates
        makePreset('Beginner', {
            startingHealth: 150,
            turnTime: 60,
            windStrength: 0.5,
            crateDropChance: 0.5,
            mineCount: 3,
            mineDudChance: 0.3,
            oilDrumCount: 3,
            suddenDeathTime: 300
        }),

        // Skill duel: no crates, no hazards, wilder wind, standard arsenal
        makePreset('Pro', {
            turnTime: 45,
            windStrength: 1.5,
            crateDropChance: 0,
            maxCratesOnMap: 0,
            mineCount: 0,
            oilDrumCount: 0,
            suddenDeathTime: 300
        }),

        // The purist's classic: bazookas and grenades only, full wind
        makePreset('Bazookas & Grenades', {
            windStrength: 2,
            crateDropChance: 0,
            maxCratesOnMap: 0,
            mineCount: 0,
            oilDrumCount: 0,
            suddenDeathTime: 600
        }, {
            '*': { ammo: 0 },
            bazooka: { ammo: -1 },
            grenade: { ammo: -1 }
        }),

        // Everything comes from crates — rope over and shop 'til you drop
        makePreset('Shopper', {
            startingHealth: 150,
            turnTime: 45,
            crateDropChance: 1,
            maxCratesOnMap: 8,
            suddenDeathTime: 600
        }, {
            '*': { ammo: 0 },
            rope: { ammo: -1 },
            parachute: { ammo: 2 }
        }),

        // No walking, no jumping — pure aim. Movement tools removed.
        makePreset('Artillery', {
            artilleryMode: true,
            crateDropChance: 0.2,
            suddenDeathTime: 300
        }, {
            rope: { ammo: 0 },
            teleport: { ammo: 0 },
            parachute: { ammo: 0 },
            drill: { ammo: 0 },
            blowtorch: { ammo: 0 }
        }),

        // Watch your step: the map is carpeted in instant, live mines
        makePreset('Minefield', {
            mineCount: 24,
            mineDudChance: 0,
            mineDelay: 0,
            oilDrumCount: 12,
            crateDropChance: 0.25
        }),

        // Total chaos: every weapon unlocked and infinite, short turns
        makePreset('Full Armageddon', {
            turnTime: 20,
            crateDropChance: 0.5,
            suddenDeathTime: 240
        }, {
            '*': { ammo: -1 }
        }),

        // Race the flood: sudden death almost immediately, fast-rising water
        makePreset('Sudden Sinking', {
            startingHealth: 75,
            turnTime: 20,
            suddenDeathTime: 60,
            suddenDeathHealthCap: 50,
            suddenDeathDecay: 8,
            waterRisePerTurn: 45
        })
    ];
}

/**
 * Custom schemes saved by the player (localStorage).
 */
export function loadCustomSchemes() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const list = JSON.parse(raw);
        if (!Array.isArray(list)) return [];
        return list.map(sanitizeScheme);
    } catch (e) {
        console.warn('Failed to load custom schemes:', e);
        return [];
    }
}

export function saveCustomScheme(scheme) {
    const clean = sanitizeScheme(scheme);
    const list = loadCustomSchemes().filter(s => s.name !== clean.name);
    list.push(clean);
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch (e) {
        console.warn('Failed to save custom scheme:', e);
    }
    return clean;
}

export function deleteCustomScheme(name) {
    const list = loadCustomSchemes().filter(s => s.name !== name);
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch (e) {
        console.warn('Failed to delete custom scheme:', e);
    }
}
