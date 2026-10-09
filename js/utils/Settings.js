/**
 * Settings - persisted player preferences (key bindings + gameplay/visual
 * toggles). Stored in localStorage under one key; every reader goes through
 * getSettings() so a change made in the Settings screen applies live.
 *
 * Key bindings map an ACTION to a list of KeyboardEvent.code values. The
 * InputManager translates physical keys into actions at the edge, so the
 * rest of the game (and replays, which record actions) never sees raw keys.
 */

const SETTINGS_KEY = 'koala_settings';

/** Actions, in the order the Settings screen lists them. */
export const ACTIONS = [
    { id: 'left', label: 'Walk left' },
    { id: 'right', label: 'Walk right' },
    { id: 'aimUp', label: 'Aim up / climb rope' },
    { id: 'aimDown', label: 'Aim down / lower rope' },
    { id: 'fire', label: 'Fire (hold to charge, again to shoot)' },
    { id: 'jump', label: 'Jump (twice = back hop) / let go of rope' },
    { id: 'highJump', label: 'High jump (twice = backflip)' },
    { id: 'weaponMenu', label: 'Weapon menu' },
    { id: 'cancel', label: 'Cancel / close menu' },
    { id: 'timer1', label: 'Fuse 1 second' },
    { id: 'timer2', label: 'Fuse 2 seconds' },
    { id: 'timer3', label: 'Fuse 3 seconds' },
    { id: 'timer4', label: 'Fuse 4 seconds' },
    { id: 'timer5', label: 'Fuse 5 seconds' },
    { id: 'help', label: 'Show controls' },
    { id: 'chat', label: 'Chat (multiplayer)' }
];

export const DEFAULT_BINDINGS = {
    left: ['ArrowLeft', 'KeyA'],
    right: ['ArrowRight', 'KeyD'],
    aimUp: ['ArrowUp', 'KeyW'],
    aimDown: ['ArrowDown', 'KeyS'],
    fire: ['Space'],
    jump: ['Enter'],
    highJump: ['Backspace'],
    weaponMenu: ['Tab', 'Backquote'],
    cancel: ['Escape'],
    timer1: ['Digit1'],
    timer2: ['Digit2'],
    timer3: ['Digit3'],
    timer4: ['Digit4'],
    timer5: ['Digit5'],
    help: ['F1', 'KeyH'],
    chat: ['KeyT']
};

const DEFAULTS = {
    bindings: DEFAULT_BINDINGS,
    screenShake: true,
    instantReplay: true,     // replay the killing shot after a local turn
    autoCamera: true,        // zoom out to frame long shots / multi-blasts
    touchControls: 'auto',   // 'auto' | 'on' | 'off'
    seenTutorialPrompt: false
};

let cache = null;
const listeners = new Set();

function clone(v) {
    return JSON.parse(JSON.stringify(v));
}

export function getSettings() {
    if (cache) return cache;
    let stored = {};
    try {
        stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
    } catch (e) {
        stored = {};
    }
    const merged = { ...clone(DEFAULTS), ...stored };
    // Bindings merge per action so new actions added in an update still get
    // their defaults even when the player saved an older bindings object
    merged.bindings = { ...clone(DEFAULT_BINDINGS), ...(stored.bindings || {}) };
    for (const id in merged.bindings) {
        if (!Array.isArray(merged.bindings[id])) merged.bindings[id] = [];
    }
    cache = merged;
    return cache;
}

export function saveSettings(patch) {
    const next = { ...getSettings(), ...patch };
    cache = next;
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch (e) {
        console.warn('Failed to save settings:', e);
    }
    for (const fn of listeners) fn(next);
    return next;
}

export function resetBindings() {
    return saveSettings({ bindings: clone(DEFAULT_BINDINGS) });
}

export function onSettingsChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Reverse lookup: KeyboardEvent.code → [action ids]. */
export function actionsForCode(code) {
    const out = [];
    const b = getSettings().bindings;
    for (const id in b) {
        if (b[id].includes(code)) out.push(id);
    }
    return out;
}

/** Human-friendly key name for display ("KeyA" → "A", "ArrowLeft" → "←"). */
export function keyLabel(code) {
    if (!code) return '—';
    const special = {
        ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
        Space: 'Space', Enter: 'Enter', Backspace: 'Backspace', Escape: 'Esc',
        Tab: 'Tab', Backquote: '`', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift',
        ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'L-Alt', AltRight: 'R-Alt'
    };
    if (special[code]) return special[code];
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
    return code;
}

/** "← / A" style label for an action's current bindings. */
export function bindingLabel(actionId) {
    const codes = getSettings().bindings[actionId] || [];
    return codes.length ? codes.map(keyLabel).join(' / ') : 'unbound';
}
