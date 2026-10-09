/**
 * TeamEditor - WA-style team editor modal. Create, edit, delete and pick
 * the active team (name, koala names, hat, gravestone, voice, dance), with
 * a live preview and voice test.
 */

import {
    HATS, GRAVES, VOICES, DANCES, loadTeams, saveTeams, sanitizeStyle, defaultStyle
} from '../utils/TeamStyles.js';
import { drawHat, drawGrave, applyDancePose } from '../engine/Cosmetics.js';
import { globalAudioManager } from '../engine/AudioManager.js';

let keyedSprite = null;

/** Koala sprite with its white background keyed out (cached). */
function loadPreviewSprite() {
    if (keyedSprite) return keyedSprite;
    keyedSprite = document.createElement('canvas');
    const img = new Image();
    img.onload = () => {
        const c = keyedSprite;
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, c.width, c.height);
        const d = data.data;
        const w = c.width, h = c.height;
        const seen = new Uint8Array(w * h);
        const stack = [0, w - 1, (h - 1) * w, h * w - 1];
        while (stack.length) {
            const idx = stack.pop();
            if (seen[idx]) continue;
            seen[idx] = 1;
            const i = idx * 4;
            if (d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225) {
                d[i + 3] = 0;
                const x = idx % w, y = (idx / w) | 0;
                if (x > 0) stack.push(idx - 1);
                if (x < w - 1) stack.push(idx + 1);
                if (y > 0) stack.push(idx - w);
                if (y < h - 1) stack.push(idx + w);
            }
        }
        ctx.putImageData(data, 0, 0);
        c.ready = true;
    };
    img.src = 'assets/koala_red.png';
    return keyedSprite;
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

export class TeamEditor {
    constructor() {
        this.modal = document.getElementById('team-modal');
        this.body = document.getElementById('team-body');
        document.getElementById('btn-team-close')?.addEventListener('click', () => this.close());
    }

    open() {
        this.data = loadTeams();
        this.editing = this.data.teams.find(t => t.id === this.data.active) || this.data.teams[0];
        this.modal.classList.remove('hidden');
        this.render();
        this.startPreview();
    }

    close() {
        cancelAnimationFrame(this.previewRaf);
        this.modal.classList.add('hidden');
    }

    persist() {
        // Sanitize the stored copy only: the form's inputs keep references
        // to the live team objects they edit
        saveTeams({ active: this.data.active, teams: this.data.teams.map(sanitizeStyle) });
    }

    render() {
        const { teams, active } = this.data;
        const team = this.editing;
        this.body.innerHTML = '';

        // ---- Team list ----
        const list = el('div', 'team-list');
        for (const t of teams) {
            const item = el('button', 'team-list-item' + (t.id === team.id ? ' selected' : ''));
            item.appendChild(el('span', null, t.name));
            if (t.id === active) item.appendChild(el('small', 'team-active-badge', 'ACTIVE'));
            item.addEventListener('click', () => {
                this.editing = t;
                this.render();
            });
            list.appendChild(item);
        }
        const add = el('button', 'team-list-add', '＋ New team');
        add.addEventListener('click', () => {
            const t = defaultStyle();
            t.id = 'team_' + Date.now().toString(36);
            t.name = `Team ${teams.length + 1}`;
            t.koalaNames = ['Bluey', 'Bingo', 'Muffin', 'Socks'];
            teams.push(t);
            this.editing = t;
            this.persist();
            this.render();
        });
        list.appendChild(add);

        // ---- Editor form ----
        const form = el('div', 'team-form');
        const field = (label, input) => {
            const row = el('label', 'team-field');
            row.appendChild(el('span', null, label));
            row.appendChild(input);
            form.appendChild(row);
            return input;
        };
        const text = (value, max, onInput) => {
            const i = document.createElement('input');
            i.type = 'text';
            i.maxLength = max;
            i.value = value;
            i.addEventListener('input', () => { onInput(i.value); this.persist(); this.refreshList(); });
            return i;
        };

        field('Team name', text(team.name, 24, v => { team.name = v; }));
        const names = el('div', 'team-koala-names');
        team.koalaNames.forEach((n, idx) => {
            names.appendChild(text(n, 18, v => { team.koalaNames[idx] = v; }));
        });
        field('Koala names', names);

        const picker = (label, options, key, preview = null) => {
            const wrap = el('div', 'team-picker');
            for (const o of options) {
                const b = el('button', 'team-pick' + (team[key] === o.id ? ' selected' : ''),
                    o.icon ? `${o.icon} ${o.label}` : o.label);
                b.addEventListener('click', () => {
                    team[key] = o.id;
                    this.persist();
                    preview?.(o);
                    this.render();
                });
                wrap.appendChild(b);
            }
            field(label, wrap);
        };
        picker('Hat', HATS, 'hat');
        picker('Gravestone', GRAVES, 'grave');
        picker('Voice', VOICES, 'voice', (v) => {
            globalAudioManager.init();
            globalAudioManager.playVoice('gday', 1, v.id);
        });
        picker('Victory dance', DANCES, 'dance');

        // ---- Preview + actions ----
        const side = el('div', 'team-side');
        this.previewCanvas = el('canvas', 'team-preview');
        this.previewCanvas.width = 220;
        this.previewCanvas.height = 180;
        side.appendChild(this.previewCanvas);

        const useBtn = el('button', 'menu-btn primary small', team.id === active ? '✓ Active team' : 'Use this team');
        useBtn.disabled = team.id === active;
        useBtn.addEventListener('click', () => {
            this.data.active = team.id;
            this.persist();
            this.render();
        });
        side.appendChild(useBtn);

        const del = el('button', 'menu-btn danger small', 'Delete team');
        del.disabled = teams.length <= 1;
        del.addEventListener('click', () => {
            if (!confirm(`Delete "${team.name}"?`)) return;
            this.data.teams = teams.filter(t => t !== team);
            if (this.data.active === team.id) this.data.active = this.data.teams[0].id;
            this.editing = this.data.teams[0];
            this.persist();
            this.render();
        });
        side.appendChild(del);

        const layout = el('div', 'team-layout');
        layout.append(list, form, side);
        this.body.appendChild(layout);
    }

    /** Update list labels while typing without rebuilding the form. */
    refreshList() {
        const items = this.body.querySelectorAll('.team-list-item span');
        this.data.teams.forEach((t, i) => {
            if (items[i]) items[i].textContent = t.name;
        });
    }

    startPreview() {
        const sprite = loadPreviewSprite();
        const t0 = performance.now();
        const draw = () => {
            const c = this.previewCanvas;
            if (!c || this.modal.classList.contains('hidden')) return;
            const ctx = c.getContext('2d');
            const team = this.editing;
            const t = (performance.now() - t0) / 1000;
            ctx.clearRect(0, 0, c.width, c.height);

            // Ground
            ctx.fillStyle = '#4a6b3a';
            ctx.fillRect(0, 150, c.width, 30);
            ctx.fillStyle = '#5d8a4e';
            ctx.fillRect(0, 148, c.width, 4);

            // Grave on the left
            ctx.save();
            ctx.translate(48, 150);
            ctx.scale(1.6, 1.6);
            drawGrave(ctx, 0, 0, team.grave);
            ctx.restore();

            // Koala dancing on the right, 2x scale
            ctx.save();
            ctx.translate(140, 116);
            ctx.scale(2, 2);
            applyDancePose(ctx, team.dance, t);
            if (sprite.ready) ctx.drawImage(sprite, -24, -26, 48, 48);
            drawHat(ctx, team.hat, '#e74c3c');
            ctx.restore();

            ctx.fillStyle = '#fff';
            ctx.font = '700 13px Outfit, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(team.koalaNames[0] || '', 140, 20);

            this.previewRaf = requestAnimationFrame(draw);
        };
        cancelAnimationFrame(this.previewRaf);
        this.previewRaf = requestAnimationFrame(draw);
    }
}
