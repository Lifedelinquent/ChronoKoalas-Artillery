/**
 * Shared simulation constants. Kept in their own module so the Game
 * subsystems (js/engine/game/*) can use them without importing Game.js.
 * Game re-exposes the gameplay ones as statics (Game.DAMAGE_RADIUS_SCALE...).
 */

// Phases during which the active player is in control of their koala. If that
// koala dies during one of these (e.g. drowns), the turn is handed over.
export const LIVE_TURN_PHASES = ['aiming', 'armed', 'firing', 'blowtorch', 'drill', 'rope'];

// WA-style blast reach: koalas are hurt and flung beyond the visible
// hole (damage zone = explosionRadius * this)
export const DAMAGE_RADIUS_SCALE = 1.4;

// Full damage anywhere inside this fraction of the damage radius,
// then linear falloff to zero at the edge — close hits hit HARD
export const DAMAGE_CORE_FRACTION = 0.25;

// The ninja rope is held slightly above the koala's center (its "hands")
export const ROPE_HAND_OFFSET = 8;
export const ROPE_MIN_LENGTH = 22;

// Fixed simulation step (60 Hz). Every client, replay and test steps the
// world with exactly this dt, which is what makes the simulation
// reproducible.
export const FIXED_DT = 1 / 60;
