/**
 * TouchControls - on-screen controls for phones and tablets.
 *
 * Buttons feed the same InputManager commands as the keyboard (press /
 * release of an action), so everything — including replays — works the
 * same. The battlefield itself takes gestures:
 *   - tap: aim at that point (or place a target for air strikes, teleport,
 *     girders and the homing marker)
 *   - one-finger drag: pan the camera
 *   - two-finger pinch: zoom
 *
 * Shown automatically on touch devices, or forced on/off in Settings.
 */

import { getSettings, onSettingsChange } from '../utils/Settings.js';

const BUTTONS = [
    // [action, label, cluster, extra class]
    ['left', '◀', 'move', ''],
    ['right', '▶', 'move', ''],
    ['aimUp', '▲', 'aim', ''],
    ['aimDown', '▼', 'aim', ''],
    ['jump', '⤴', 'act', 'small'],
    ['highJump', '⤒', 'act', 'small'],
    ['fire', 'FIRE', 'act', 'fire']
];

export function wantsTouchControls() {
    const mode = getSettings().touchControls;
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    return window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window;
}

export class TouchControls {
    constructor({ onHelp }) {
        this.onHelp = onHelp;
        this.game = null;
        this.root = document.getElementById('touch-controls');
        this.build();
        onSettingsChange(() => this.updateVisibility());

        this.touches = new Map();
        this.onTouchStart = this.onTouchStart.bind(this);
        this.onTouchMove = this.onTouchMove.bind(this);
        this.onTouchEnd = this.onTouchEnd.bind(this);
    }

    build() {
        if (!this.root) return;
        this.root.innerHTML = '';
        const clusters = {};
        for (const name of ['move', 'aim', 'act']) {
            clusters[name] = document.createElement('div');
            clusters[name].className = `touch-cluster touch-${name}`;
        }

        for (const [action, label, cluster, extra] of BUTTONS) {
            const b = document.createElement('button');
            b.className = `touch-btn ${extra}`.trim();
            b.textContent = label;
            b.dataset.action = action;
            const press = (e) => {
                e.preventDefault();
                b.classList.add('down');
                this.game?.inputManager.dispatch({ t: 'press', a: action });
            };
            const release = (e) => {
                e.preventDefault();
                if (!b.classList.contains('down')) return;
                b.classList.remove('down');
                this.game?.inputManager.dispatch({ t: 'release', a: action });
            };
            b.addEventListener('pointerdown', press);
            b.addEventListener('pointerup', release);
            b.addEventListener('pointercancel', release);
            b.addEventListener('pointerleave', release);
            clusters[cluster].appendChild(b);
        }

        // Utility row: weapons, fuse, help
        const util = document.createElement('div');
        util.className = 'touch-cluster touch-util';
        const weapons = this.makeUtil('🎒', 'Weapons', () => this.game?.inputManager.toggleWeaponMenu());
        this.fuseBtn = this.makeUtil('⏱3', 'Grenade fuse', () => {
            const wm = this.game?.weaponManager;
            if (!wm) return;
            const next = (wm.timer % 5) + 1;
            this.game.inputManager.dispatch({ t: 'press', a: 'timer' + next });
            this.game.inputManager.dispatch({ t: 'release', a: 'timer' + next });
            this.fuseBtn.textContent = '⏱' + next;
        });
        const help = this.makeUtil('?', 'Controls', () => this.onHelp?.());
        util.append(weapons, this.fuseBtn, help);

        const left = document.createElement('div');
        left.className = 'touch-side touch-left';
        left.append(clusters.move, clusters.aim);
        const right = document.createElement('div');
        right.className = 'touch-side touch-right';
        right.append(util, clusters.act);
        this.root.append(left, right);
    }

    makeUtil(label, title, fn) {
        const b = document.createElement('button');
        b.className = 'touch-btn util';
        b.textContent = label;
        b.title = title;
        b.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            fn();
        });
        return b;
    }

    attach(game) {
        this.detach();
        this.game = game;
        this.canvas = game.canvas;
        this.canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
        this.canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
        this.canvas.addEventListener('touchend', this.onTouchEnd, { passive: false });
        this.canvas.addEventListener('touchcancel', this.onTouchEnd, { passive: false });
        this.updateVisibility();
    }

    detach() {
        if (this.canvas) {
            this.canvas.removeEventListener('touchstart', this.onTouchStart);
            this.canvas.removeEventListener('touchmove', this.onTouchMove);
            this.canvas.removeEventListener('touchend', this.onTouchEnd);
            this.canvas.removeEventListener('touchcancel', this.onTouchEnd);
        }
        this.game = null;
        this.canvas = null;
        this.touches.clear();
        this.updateVisibility();
    }

    updateVisibility() {
        if (!this.root) return;
        const show = !!this.game && !this.game.isReplay && wantsTouchControls();
        this.root.classList.toggle('hidden', !show);
        document.body.classList.toggle('touch-mode', show);
    }

    // ---------------------------------------------------- canvas gestures

    onTouchStart(e) {
        e.preventDefault();
        for (const t of e.changedTouches) {
            this.touches.set(t.identifier, {
                x: t.clientX, y: t.clientY, startX: t.clientX, startY: t.clientY,
                moved: false, start: performance.now()
            });
        }
        if (this.touches.size === 2) {
            const [a, b] = [...this.touches.values()];
            this.pinch = {
                dist: Math.hypot(a.x - b.x, a.y - b.y),
                zoom: this.game.camera.zoom
            };
        }
    }

    onTouchMove(e) {
        e.preventDefault();
        const im = this.game?.inputManager;
        if (!im) return;
        for (const t of e.changedTouches) {
            const s = this.touches.get(t.identifier);
            if (!s) continue;
            const dx = t.clientX - s.x;
            const dy = t.clientY - s.y;
            s.x = t.clientX;
            s.y = t.clientY;
            if (Math.hypot(s.x - s.startX, s.y - s.startY) > 12) s.moved = true;

            if (this.touches.size === 1 && s.moved) {
                im.panCamera(dx, dy);
            }
        }
        if (this.touches.size === 2 && this.pinch) {
            const [a, b] = [...this.touches.values()];
            const dist = Math.hypot(a.x - b.x, a.y - b.y);
            im.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, this.pinch.zoom * (dist / this.pinch.dist));
        }
    }

    onTouchEnd(e) {
        e.preventDefault();
        const im = this.game?.inputManager;
        for (const t of e.changedTouches) {
            const s = this.touches.get(t.identifier);
            this.touches.delete(t.identifier);
            if (!s || !im || this.pinch) continue;
            // A tap (not a drag): aim there, or place a target
            if (!s.moved && performance.now() - s.start < 500) {
                this.tap(t.clientX, t.clientY);
            }
        }
        if (this.touches.size < 2) this.pinch = this.touches.size === 0 ? null : this.pinch;
    }

    tap(clientX, clientY) {
        const game = this.game;
        const im = game.inputManager;
        const p = im.screenToWorld(clientX, clientY);
        const weapon = game.weaponManager.currentWeapon;
        const placesTarget = weapon && game.phase === 'aiming' &&
            (weapon.targetted || (weapon.requiresTarget && !game.homingTarget));

        if (placesTarget) {
            im.dispatch({ t: 'pdown', x: p.x, y: p.y });
            im.dispatch({ t: 'pup' });
        } else {
            im.pointerMoveWorld(p.x, p.y);
        }
    }
}
