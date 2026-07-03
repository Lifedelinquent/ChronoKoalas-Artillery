/**
 * SchemeEditor - Full-screen modal for editing every match rule in a
 * GameScheme: health, timers, environment, sudden death, hazards, crates and
 * the per-weapon ammo / unlock-delay table. Opened from the map-selection
 * modal's "Customize" button.
 *
 * The DOM is generated from metadata (SETTING_SECTIONS below + the live
 * weapon definitions) so new scheme fields and weapons show up automatically.
 */

import {
    defaultScheme, sanitizeScheme, getPresetSchemes,
    loadCustomSchemes, saveCustomScheme, deleteCustomScheme,
    UNEDITABLE_WEAPONS, bareWeaponDefs
} from '../utils/GameScheme.js';
import { WeaponManager } from '../weapons/WeaponManager.js';

// Slider/toggle metadata: how each general setting renders and formats.
// fmt receives the raw value and returns the label shown next to the slider.
const SETTING_SECTIONS = [
    {
        title: '🐨 Teams & Health',
        settings: [
            { key: 'startingHealth', label: 'Starting Health', min: 25, max: 300, step: 25, fmt: v => `${v} HP` },
            { key: 'koalasPerTeam', label: 'Koalas per Team', min: 1, max: 6, step: 1, fmt: v => `${v}` }
        ]
    },
    {
        title: '⏱️ Timers',
        settings: [
            { key: 'turnTime', label: 'Turn Time', min: 5, max: 90, step: 5, fmt: v => `${v}s` },
            { key: 'retreatTime', label: 'Retreat Time', min: 0, max: 15, step: 1, fmt: v => `${v}s` }
        ]
    },
    {
        title: '🌍 Environment',
        settings: [
            { key: 'windStrength', label: 'Wind Strength', min: 0, max: 2, step: 0.25, fmt: v => v === 0 ? 'None' : `${Math.round(v * 100)}%` },
            { key: 'fallDamageMultiplier', label: 'Fall Damage', min: 0, max: 2, step: 0.25, fmt: v => v === 0 ? 'Off' : `${Math.round(v * 100)}%` },
            { key: 'damageMultiplier', label: 'Weapon Damage', min: 0.25, max: 3, step: 0.25, fmt: v => `${Math.round(v * 100)}%` },
            { key: 'artilleryMode', label: 'Artillery Mode (no walking or jumping)', toggle: true }
        ]
    },
    {
        title: '💀 Sudden Death',
        settings: [
            {
                key: 'suddenDeathTime', label: 'Starts After', min: -1, max: 900, step: 60,
                // Slider snaps -1 (never) then whole minutes
                fmt: v => v === -1 ? 'Never' : `${Math.round(v / 60)} min`,
                snap: v => v <= 0 ? -1 : Math.max(60, Math.round(v / 60) * 60)
            },
            { key: 'suddenDeathHealthCap', label: 'Health Cap', min: 1, max: 200, step: 1, fmt: v => `${v} HP` },
            { key: 'suddenDeathDecay', label: 'HP Drain per Turn', min: 0, max: 25, step: 1, fmt: v => v === 0 ? 'Off' : `${v} HP` },
            { key: 'waterRisePerTurn', label: 'Water Rise per Turn', min: 0, max: 60, step: 2, fmt: v => v === 0 ? 'Off' : `${v}px` }
        ]
    },
    {
        title: '💣 Map Hazards',
        settings: [
            { key: 'mineCount', label: 'Landmines', min: 0, max: 24, step: 1, fmt: v => v === 0 ? 'None' : `${v}` },
            { key: 'mineDudChance', label: 'Dud Mine Chance', min: 0, max: 1, step: 0.05, fmt: v => `${Math.round(v * 100)}%` },
            {
                key: 'mineDelay', label: 'Mine Fuse', min: -1, max: 5, step: 0.5,
                fmt: v => v === -1 ? 'Random' : v === 0 ? 'Instant' : `${v}s`,
                snap: v => v < 0 ? -1 : v
            },
            { key: 'oilDrumCount', label: 'Oil Drums', min: 0, max: 16, step: 1, fmt: v => v === 0 ? 'None' : `${v}` }
        ]
    },
    {
        title: '📦 Crates',
        settings: [
            { key: 'crateDropChance', label: 'Drop Chance per Turn', min: 0, max: 1, step: 0.05, fmt: v => `${Math.round(v * 100)}%` },
            { key: 'maxCratesOnMap', label: 'Max Crates on Map', min: 0, max: 10, step: 1, fmt: v => `${v}` }
        ]
    }
];

// Weapons that ship a sprite instead of an emoji icon
const WEAPON_SPRITES = ['bazooka', 'grenade', 'shotgun', 'bat', 'dynamite', 'mine',
    'holygrenade', 'airstrike', 'teleport', 'rope', 'blowtorch'];

const MAX_AMMO = 9; // stepper cycles 0..9 then ∞ (-1)

export class SchemeEditor {
    constructor() {
        this.modal = document.getElementById('scheme-editor-modal');
        this.body = document.getElementById('scheme-editor-body');
        this.scheme = defaultScheme();
        this.onApply = null;
        this.onSchemesChanged = null;

        // Live weapon defs for names/categories/icons in the weapons table
        this.weaponDefs = bareWeaponDefs();

        this.buildStaticControls();
    }

    /**
     * Open the editor seeded with a scheme. onApply(scheme) fires when the
     * player confirms; onSchemesChanged() whenever a custom scheme is
     * saved/deleted (so the map modal can refresh its dropdown).
     */
    open(scheme, onApply, onSchemesChanged = null) {
        this.scheme = sanitizeScheme(scheme);
        this.onApply = onApply;
        this.onSchemesChanged = onSchemesChanged;
        this.render();
        this.modal.classList.remove('hidden');
    }

    close() {
        this.modal.classList.add('hidden');
    }

    /**
     * Wire the footer buttons (present in index.html) once.
     */
    buildStaticControls() {
        document.getElementById('btn-scheme-cancel').addEventListener('click', () => this.close());

        document.getElementById('btn-scheme-apply').addEventListener('click', () => {
            const nameInput = document.getElementById('scheme-name-input');
            if (nameInput && nameInput.value.trim()) {
                this.scheme.name = nameInput.value.trim().slice(0, 32);
            }
            this.close();
            if (this.onApply) this.onApply(sanitizeScheme(this.scheme));
        });

        document.getElementById('btn-scheme-save').addEventListener('click', () => {
            const nameInput = document.getElementById('scheme-name-input');
            const name = (nameInput?.value.trim() || this.scheme.name || 'My Scheme').slice(0, 32);
            // Don't shadow a built-in preset name
            const clash = getPresetSchemes().some(p => p.name.toLowerCase() === name.toLowerCase());
            this.scheme.name = clash ? `${name} (Custom)` : name;
            if (nameInput) nameInput.value = this.scheme.name;
            saveCustomScheme(this.scheme);
            this.flashStatus(`💾 Saved "${this.scheme.name}"`);
            if (this.onSchemesChanged) this.onSchemesChanged();
        });
    }

    flashStatus(text) {
        const el = document.getElementById('scheme-editor-status');
        if (!el) return;
        el.textContent = text;
        el.classList.add('visible');
        clearTimeout(this._statusTimer);
        this._statusTimer = setTimeout(() => el.classList.remove('visible'), 2500);
    }

    /**
     * (Re)build the whole editor body from the current scheme.
     */
    render() {
        this.body.innerHTML = '';
        this.body.appendChild(this.renderHeader());

        const grid = document.createElement('div');
        grid.className = 'scheme-sections';
        for (const section of SETTING_SECTIONS) {
            grid.appendChild(this.renderSection(section));
        }
        this.body.appendChild(grid);

        this.body.appendChild(this.renderWeaponsSection());
    }

    /**
     * Header: scheme name input + load-preset dropdown.
     */
    renderHeader() {
        const header = document.createElement('div');
        header.className = 'scheme-header';

        const nameLabel = document.createElement('label');
        nameLabel.className = 'scheme-name-label';
        nameLabel.textContent = 'Scheme Name';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.id = 'scheme-name-input';
        nameInput.maxLength = 32;
        nameInput.value = this.scheme.name;
        nameInput.addEventListener('input', () => {
            this.scheme.name = nameInput.value.trim() || 'My Scheme';
        });
        nameLabel.appendChild(nameInput);
        header.appendChild(nameLabel);

        const loadLabel = document.createElement('label');
        loadLabel.className = 'scheme-name-label';
        loadLabel.textContent = 'Load Preset';
        const loadSelect = document.createElement('select');
        loadSelect.className = 'scheme-select';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = '— pick to load —';
        loadSelect.appendChild(placeholder);

        const presets = getPresetSchemes();
        const customs = loadCustomSchemes();
        for (const s of presets) {
            loadSelect.appendChild(new Option(s.name, `preset:${s.name}`));
        }
        for (const s of customs) {
            loadSelect.appendChild(new Option(`★ ${s.name}`, `custom:${s.name}`));
        }
        loadSelect.addEventListener('change', () => {
            const v = loadSelect.value;
            if (!v) return;
            const [kind, ...nameParts] = v.split(':');
            const name = nameParts.join(':');
            const source = kind === 'preset' ? presets : loadCustomSchemes();
            const found = source.find(s => s.name === name);
            if (found) {
                this.scheme = sanitizeScheme(found);
                this.render(); // full refresh with the loaded values
            }
        });
        loadLabel.appendChild(loadSelect);
        header.appendChild(loadLabel);

        // Delete button for saved custom schemes matching the current name
        const delBtn = document.createElement('button');
        delBtn.className = 'menu-btn danger small scheme-delete-btn';
        delBtn.textContent = '🗑 Delete Saved';
        delBtn.addEventListener('click', () => {
            deleteCustomScheme(this.scheme.name);
            this.flashStatus(`🗑 Deleted "${this.scheme.name}"`);
            if (this.onSchemesChanged) this.onSchemesChanged();
            this.render();
        });
        header.appendChild(delBtn);

        return header;
    }

    /**
     * One titled card of sliders/toggles.
     */
    renderSection(section) {
        const card = document.createElement('div');
        card.className = 'scheme-section';

        const h = document.createElement('h3');
        h.textContent = section.title;
        card.appendChild(h);

        for (const setting of section.settings) {
            card.appendChild(setting.toggle
                ? this.renderToggle(setting)
                : this.renderSlider(setting));
        }
        return card;
    }

    renderSlider(setting) {
        const row = document.createElement('div');
        row.className = 'scheme-row';

        const label = document.createElement('span');
        label.className = 'scheme-row-label';
        label.textContent = setting.label;

        const value = document.createElement('span');
        value.className = 'scheme-row-value';
        value.textContent = setting.fmt(this.scheme[setting.key]);

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'editor-slider scheme-slider';
        slider.min = setting.min;
        slider.max = setting.max;
        slider.step = setting.step;
        slider.value = this.scheme[setting.key];
        slider.addEventListener('input', () => {
            let v = parseFloat(slider.value);
            if (setting.snap) v = setting.snap(v);
            this.scheme[setting.key] = v;
            value.textContent = setting.fmt(v);
        });

        const top = document.createElement('div');
        top.className = 'scheme-row-top';
        top.appendChild(label);
        top.appendChild(value);
        row.appendChild(top);
        row.appendChild(slider);
        return row;
    }

    renderToggle(setting) {
        const row = document.createElement('div');
        row.className = 'scheme-row scheme-toggle-row';

        const label = document.createElement('span');
        label.className = 'scheme-row-label';
        label.textContent = setting.label;

        const btn = document.createElement('button');
        btn.className = 'scheme-toggle' + (this.scheme[setting.key] ? ' on' : '');
        btn.textContent = this.scheme[setting.key] ? 'ON' : 'OFF';
        btn.addEventListener('click', () => {
            this.scheme[setting.key] = !this.scheme[setting.key];
            btn.classList.toggle('on', this.scheme[setting.key]);
            btn.textContent = this.scheme[setting.key] ? 'ON' : 'OFF';
        });

        row.appendChild(label);
        row.appendChild(btn);
        return row;
    }

    /**
     * The per-weapon table: ammo stepper (0-9, ∞) + unlock delay stepper,
     * grouped by category, with quick-fill buttons.
     */
    renderWeaponsSection() {
        const wrap = document.createElement('div');
        wrap.className = 'scheme-section scheme-weapons';

        const headRow = document.createElement('div');
        headRow.className = 'scheme-weapons-head';
        const h = document.createElement('h3');
        h.textContent = '🔫 Weapons — ammo & unlock delay (rounds)';
        headRow.appendChild(h);

        // Quick-fill buttons
        const quick = document.createElement('div');
        quick.className = 'scheme-quick-fill';
        const quickBtns = [
            { label: 'Default', apply: () => { this.scheme.weapons = defaultScheme().weapons; } },
            { label: 'All ∞', apply: () => { for (const id in this.scheme.weapons) this.scheme.weapons[id].ammo = -1; } },
            { label: 'None (crates only)', apply: () => { for (const id in this.scheme.weapons) this.scheme.weapons[id].ammo = 0; } },
            { label: 'No Delays', apply: () => { for (const id in this.scheme.weapons) this.scheme.weapons[id].delay = 0; } }
        ];
        for (const qb of quickBtns) {
            const btn = document.createElement('button');
            btn.className = 'menu-btn secondary small';
            btn.textContent = qb.label;
            btn.addEventListener('click', () => {
                qb.apply();
                this.render();
            });
            quick.appendChild(btn);
        }
        headRow.appendChild(quick);
        wrap.appendChild(headRow);

        const grid = document.createElement('div');
        grid.className = 'scheme-weapon-grid';

        for (const category of WeaponManager.CATEGORIES) {
            const ids = Object.keys(this.weaponDefs).filter(id =>
                this.weaponDefs[id].category === category && !UNEDITABLE_WEAPONS.includes(id));
            if (ids.length === 0) continue;

            const catLabel = document.createElement('div');
            catLabel.className = 'scheme-weapon-category';
            catLabel.textContent = category.charAt(0).toUpperCase() + category.slice(1);
            grid.appendChild(catLabel);

            for (const id of ids) {
                grid.appendChild(this.renderWeaponRow(id));
            }
        }
        wrap.appendChild(grid);
        return wrap;
    }

    renderWeaponRow(id) {
        const def = this.weaponDefs[id];
        const entry = this.scheme.weapons[id];

        const row = document.createElement('div');
        row.className = 'scheme-weapon-row';

        // Icon: sprite when one exists, emoji otherwise
        const icon = document.createElement('span');
        icon.className = 'scheme-weapon-icon';
        if (WEAPON_SPRITES.includes(id)) {
            icon.innerHTML = `<img src="assets/weapon_${id}.png" alt="${def.name}">`;
        } else {
            icon.textContent = def.icon || '❓';
        }
        row.appendChild(icon);

        const name = document.createElement('span');
        name.className = 'scheme-weapon-name';
        name.textContent = def.name;
        row.appendChild(name);

        // Ammo stepper: 0..9 then ∞
        row.appendChild(this.makeStepper('Ammo', () => entry.ammo, (v) => { entry.ammo = v; },
            (v) => v === -1 ? '∞' : `${v}`,
            (v, dir) => {
                if (dir > 0) return v === -1 ? -1 : (v >= MAX_AMMO ? -1 : v + 1);
                return v === -1 ? MAX_AMMO : Math.max(0, v - 1);
            }));

        // Delay stepper: 0..10 rounds
        row.appendChild(this.makeStepper('Delay', () => entry.delay, (v) => { entry.delay = v; },
            (v) => v === 0 ? '—' : `${v}`,
            (v, dir) => Math.max(0, Math.min(10, v + dir))));

        return row;
    }

    makeStepper(title, get, set, fmt, step) {
        const box = document.createElement('div');
        box.className = 'scheme-stepper';
        box.title = title;

        const minus = document.createElement('button');
        minus.textContent = '−';
        const val = document.createElement('span');
        val.className = 'scheme-stepper-value' + (title === 'Delay' ? ' delay' : '');
        val.textContent = fmt(get());
        const plus = document.createElement('button');
        plus.textContent = '+';

        const bump = (dir) => {
            set(step(get(), dir));
            val.textContent = fmt(get());
            val.classList.toggle('zero', get() === 0 && title === 'Ammo');
        };
        minus.addEventListener('click', () => bump(-1));
        plus.addEventListener('click', () => bump(1));
        val.classList.toggle('zero', get() === 0 && title === 'Ammo');

        box.appendChild(minus);
        box.appendChild(val);
        box.appendChild(plus);
        return box;
    }
}
