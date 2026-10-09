/**
 * SettingsUI - the Settings modal (key bindings + gameplay toggles) and the
 * in-game controls overlay.
 *
 * Bindings: every action shows up to two keys. Click a key slot, press the
 * new key (Esc cancels, the × clears the slot). A key can only drive one
 * action, so taking one that's already bound moves it here.
 */

import {
    ACTIONS, getSettings, saveSettings, resetBindings, keyLabel, bindingLabel
} from '../utils/Settings.js';

const TOGGLES = [
    { id: 'autoCamera', label: 'Auto camera', desc: 'Zoom out to keep long shots and multi-blasts in view' },
    { id: 'instantReplay', label: 'Instant replay', desc: 'Replay the shot after a turn that kills a koala (single player & hotseat)' },
    { id: 'screenShake', label: 'Screen shake', desc: 'Shake the camera on explosions' }
];

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

export class SettingsUI {
    constructor() {
        this.modal = document.getElementById('settings-modal');
        this.body = document.getElementById('settings-body');
        this.capture = null; // { action, slot } while waiting for a key

        document.getElementById('btn-settings-close')?.addEventListener('click', () => this.close());
        document.getElementById('btn-settings-reset')?.addEventListener('click', () => {
            if (confirm('Reset all key bindings to the defaults?')) {
                resetBindings();
                this.render();
            }
        });

        this.onCaptureKey = this.onCaptureKey.bind(this);
    }

    open(tab = 'controls') {
        this.tab = tab;
        this.modal.classList.remove('hidden');
        this.render();
    }

    close() {
        this.stopCapture();
        this.modal.classList.add('hidden');
    }

    render() {
        const settings = getSettings();
        this.body.innerHTML = '';

        // Tabs
        const tabs = el('div', 'settings-tabs');
        for (const [id, label] of [['controls', '⌨️ Controls'], ['gameplay', '🎮 Gameplay']]) {
            const b = el('button', 'settings-tab' + (this.tab === id ? ' active' : ''), label);
            b.addEventListener('click', () => { this.stopCapture(); this.tab = id; this.render(); });
            tabs.appendChild(b);
        }
        this.body.appendChild(tabs);

        if (this.tab === 'gameplay') {
            this.renderGameplay(settings);
        } else {
            this.renderControls(settings);
        }
    }

    renderControls(settings) {
        const hint = el('p', 'settings-hint',
            'Click a key to change it, then press the new key. Esc cancels. Mouse: left = aim & fire, right = weapon menu / cancel shot, right-drag = pan, wheel = zoom.');
        this.body.appendChild(hint);

        const table = el('div', 'bind-table');
        for (const action of ACTIONS) {
            const row = el('div', 'bind-row');
            row.appendChild(el('span', 'bind-label', action.label));
            const keys = settings.bindings[action.id] || [];
            for (let slot = 0; slot < 2; slot++) {
                const code = keys[slot];
                const capturing = this.capture && this.capture.action === action.id && this.capture.slot === slot;
                const chip = el('button', 'bind-key' + (code ? '' : ' empty') + (capturing ? ' capturing' : ''),
                    capturing ? 'Press a key…' : (code ? keyLabel(code) : '+'));
                chip.addEventListener('click', () => this.startCapture(action.id, slot));
                const wrap = el('span', 'bind-slot');
                wrap.appendChild(chip);
                if (code && !capturing) {
                    const clear = el('button', 'bind-clear', '×');
                    clear.title = 'Unbind';
                    clear.addEventListener('click', () => this.setKey(action.id, slot, null));
                    wrap.appendChild(clear);
                }
                row.appendChild(wrap);
            }
            table.appendChild(row);
        }
        this.body.appendChild(table);
        if (this.notice) {
            this.body.appendChild(el('p', 'settings-notice', this.notice));
            this.notice = null;
        }
    }

    renderGameplay(settings) {
        // Multiplayer display name (read by NetworkManager.getLocalName)
        const nameRow = el('label', 'settings-select-row');
        nameRow.appendChild(el('strong', null, 'Your name (multiplayer)'));
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.maxLength = 20;
        nameInput.className = 'settings-text';
        nameInput.placeholder = 'Player';
        try { nameInput.value = localStorage.getItem('koalaPlayerName') || ''; } catch (e) { /* no storage */ }
        nameInput.addEventListener('change', () => {
            try { localStorage.setItem('koalaPlayerName', nameInput.value.trim().slice(0, 20)); } catch (e) { /* no storage */ }
        });
        nameRow.appendChild(nameInput);
        this.body.appendChild(nameRow);

        for (const t of TOGGLES) {
            const row = el('label', 'settings-toggle');
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = settings[t.id] !== false;
            input.addEventListener('change', () => saveSettings({ [t.id]: input.checked }));
            const text = el('span', 'settings-toggle-text');
            text.appendChild(el('strong', null, t.label));
            text.appendChild(el('small', null, t.desc));
            row.append(input, text);
            this.body.appendChild(row);
        }

        const touchRow = el('div', 'settings-select-row');
        touchRow.appendChild(el('strong', null, 'On-screen touch controls'));
        const select = document.createElement('select');
        select.className = 'scheme-select';
        for (const [v, label] of [['auto', 'Automatic (touch devices)'], ['on', 'Always on'], ['off', 'Off']]) {
            const o = document.createElement('option');
            o.value = v;
            o.textContent = label;
            if (settings.touchControls === v) o.selected = true;
            select.appendChild(o);
        }
        select.addEventListener('change', () => saveSettings({ touchControls: select.value }));
        touchRow.appendChild(select);
        this.body.appendChild(touchRow);
    }

    startCapture(action, slot) {
        this.stopCapture();
        this.capture = { action, slot };
        window.addEventListener('keydown', this.onCaptureKey, true);
        this.render();
    }

    stopCapture() {
        if (!this.capture) return;
        this.capture = null;
        window.removeEventListener('keydown', this.onCaptureKey, true);
    }

    onCaptureKey(e) {
        e.preventDefault();
        e.stopPropagation();
        const { action, slot } = this.capture;
        this.stopCapture();
        if (e.code === 'Escape') {
            this.render();
            return;
        }
        this.setKey(action, slot, e.code);
    }

    setKey(action, slot, code) {
        const bindings = JSON.parse(JSON.stringify(getSettings().bindings));
        if (code) {
            // One key, one action: take it away from whoever had it
            for (const id in bindings) {
                if (id === action) continue;
                const i = bindings[id].indexOf(code);
                if (i !== -1) {
                    bindings[id].splice(i, 1);
                    const taken = ACTIONS.find(a => a.id === id);
                    this.notice = `${keyLabel(code)} was moved from "${taken?.label || id}".`;
                }
            }
        }
        const keys = bindings[action] || [];
        if (code) {
            const existing = keys.indexOf(code);
            if (existing !== -1) keys.splice(existing, 1);
            keys[slot] = code;
        } else {
            keys.splice(slot, 1);
        }
        bindings[action] = keys.filter(Boolean);
        saveSettings({ bindings });
        this.render();
    }
}

/**
 * In-game cheat sheet with the player's current bindings. Toggled by the
 * help action (H / F1) or the ? button in the HUD.
 */
export class ControlsOverlay {
    constructor() {
        this.root = document.getElementById('controls-overlay');
        this.root?.addEventListener('click', () => this.hide());
    }

    toggle() {
        if (!this.root) return;
        if (this.root.classList.contains('hidden')) this.show();
        else this.hide();
    }

    show() {
        if (!this.root) return;
        const rows = [
            ['Walk', `${bindingLabel('left')} · ${bindingLabel('right')}`],
            ['Aim', `Mouse, or ${bindingLabel('aimUp')} · ${bindingLabel('aimDown')}`],
            ['Fire', `Hold ${bindingLabel('fire')} or left mouse to charge, release to lock, press again to shoot`],
            ['Cancel shot', 'Right mouse while charging or locked'],
            ['Jump', `${bindingLabel('jump')} (twice quickly = back hop)`],
            ['High jump', `${bindingLabel('highJump')} (twice quickly = backflip)`],
            ['Weapons', `${bindingLabel('weaponMenu')} or right-click`],
            ['Grenade fuse', `${bindingLabel('timer1')}–${bindingLabel('timer5')}`],
            ['Ninja rope', `${bindingLabel('left')}/${bindingLabel('right')} swing · ${bindingLabel('aimUp')}/${bindingLabel('aimDown')} climb · ${bindingLabel('jump')} let go · ${bindingLabel('fire')} re-fire`],
            ['Targeted weapons', 'Click the map (air strike, teleport, girder, homing marker)'],
            ['Camera', 'Right-drag to pan · wheel to zoom'],
            ['This help', bindingLabel('help')]
        ];
        const list = rows.map(([k, v]) =>
            `<div class="controls-row"><span>${k}</span><span>${v}</span></div>`).join('');
        this.root.innerHTML = `<div class="controls-card">
            <h2>🎮 Controls</h2>${list}
            <p class="controls-foot">Change keys in Settings · click anywhere to close</p></div>`;
        this.root.classList.remove('hidden');
    }

    hide() {
        this.root?.classList.add('hidden');
    }
}
