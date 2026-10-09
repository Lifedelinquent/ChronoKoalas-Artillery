/**
 * RopeSystem - Worms Armageddon-style ninja rope.
 *
 * Installed onto Game.prototype (see the bottom of Game.js), so every
 * method runs with `this` bound to the Game instance.
 */

import { ROPE_HAND_OFFSET, ROPE_MIN_LENGTH } from '../GameConstants.js';
import { log } from '../../utils/Logger.js';

export const RopeSystem = {
    /**
     * Fire the rope hook from a koala (called from fireWeapon on every client)
     */
    startRope(koala, weapon, angle) {
        const handY = koala.y - ROPE_HAND_OFFSET;
        this.ropeState = {
            mode: 'flying',
            koala,
            weapon,
            hook: { x: koala.x, y: handY },
            startX: koala.x,
            startY: handY,
            dirX: Math.cos(angle),
            dirY: Math.sin(angle),
            hookSpeed: weapon.hookSpeed || 1500,
            maxLength: weapon.maxLength || 420,
            swingAccel: weapon.swingAccel || 380,
            climbSpeed: weapon.climbSpeed || 150,
            // While attached: pivots[0] is the anchor, the last pivot is the
            // live swing center. `consumed` is the rope length eaten by the
            // wrap that created the pivot (returned when it unwraps).
            pivots: null,
            length: 0
        };
        this.phase = 'rope';
    },

    /**
     * Per-frame rope update (both hook flight and swinging). Runs on every
     * client; only the turn owner applies input and integrates the koala.
     */
    updateRope(dt) {
        const rs = this.ropeState;
        if (!rs) {
            this.phase = 'aiming';
            return;
        }
        const koala = rs.koala;
        if (!koala || !koala.isAlive) {
            this.clearRope();
            this.phase = 'aiming';
            return;
        }

        if (rs.mode === 'flying') {
            this.updateRopeFlight(rs, dt);
        } else {
            this.updateRopeSwing(rs, dt);
        }

        // Keep the action in frame on every client, like a followed projectile
        if (this.ropeState) {
            this.centerCameraOn(koala.x, koala.y);
        }
    },

    /**
     * Hook flight: straight line, no gravity/wind, raycast in small steps.
     * Attaches to the first terrain pixel, or fizzles at max rope length.
     */
    updateRopeFlight(rs, dt) {
        const move = rs.hookSpeed * dt;
        const steps = Math.max(1, Math.ceil(move / 4));

        for (let s = 1; s <= steps; s++) {
            const nx = rs.hook.x + rs.dirX * (move / steps);
            const ny = rs.hook.y + rs.dirY * (move / steps);

            if (this.terrain.checkCollision(nx, ny)) {
                rs.hook.x = nx;
                rs.hook.y = ny;
                this.attachRope(rs);
                return;
            }

            rs.hook.x = nx;
            rs.hook.y = ny;

            const flown = Math.hypot(rs.hook.x - rs.startX, rs.hook.y - rs.startY);
            if (flown >= rs.maxLength ||
                rs.hook.y > this.waterLevel ||
                rs.hook.x < -50 || rs.hook.x > this.worldWidth + 50) {
                // Out of rope — nothing to grab. Turn continues.
                log.debug('🪢 Rope missed');
                this.audioManager.playClick();
                this.clearRope();
                this.phase = 'aiming';
                return;
            }
        }
    },

    /**
     * Hook found terrain: become a pendulum around it.
     */
    attachRope(rs) {
        const koala = rs.koala;
        rs.mode = 'attached';
        rs.pivots = [{ x: rs.hook.x, y: rs.hook.y, consumed: 0 }];

        const d = Math.hypot(koala.x - rs.hook.x, (koala.y - ROPE_HAND_OFFSET) - rs.hook.y);
        rs.length = Math.max(ROPE_MIN_LENGTH, Math.min(d, rs.maxLength));

        koala.onRope = true;
        koala.onGround = false;
        koala.isSliding = false;
        koala.isJumping = false;
        koala.isBackflipping = false;
        koala.parachuteActive = false; // rope overrides an open chute
        this.emit('ropeAttached', { koala });

        this.audioManager.playBounce();
        log.debug(`🪢 Rope attached at ${rs.hook.x.toFixed(0)},${rs.hook.y.toFixed(0)} (length ${rs.length.toFixed(0)})`);
    },

    /**
     * Swinging on the rope. The turn owner integrates the pendulum + input;
     * remote clients only recompute wrap pivots around the streamed position.
     */
    updateRopeSwing(rs, dt) {
        const koala = rs.koala;

        if (this.hasLocalControl()) {
            // Held actions from the human's input or the CPU's virtual pad
            const control = this.getControl();

            // Left/right: pump the swing
            let swing = 0;
            if (control.isHeld('left')) { swing = -1; koala.facingLeft = true; }
            if (control.isHeld('right')) { swing = 1; koala.facingLeft = false; }
            koala.vx += swing * rs.swingAccel * dt;

            // Up/down: climb the rope. Total rope (wrapped + free) caps at maxLength.
            const used = rs.pivots.reduce((sum, p) => sum + p.consumed, 0);
            if (control.isHeld('aimUp')) {
                rs.length = Math.max(ROPE_MIN_LENGTH, rs.length - rs.climbSpeed * dt);
            }
            if (control.isHeld('aimDown')) {
                rs.length = Math.min(Math.max(ROPE_MIN_LENGTH, rs.maxLength - used), rs.length + rs.climbSpeed * dt);
            }

            // Pendulum integration: gravity, then constrain to the rope circle
            koala.vy += this.physics.gravity * dt;
            const prevX = koala.x, prevY = koala.y;
            koala.x += koala.vx * dt;
            koala.y += koala.vy * dt;

            const p = rs.pivots[rs.pivots.length - 1];
            const dx = koala.x - p.x;
            const dy = (koala.y - ROPE_HAND_OFFSET) - p.y;
            const d = Math.hypot(dx, dy);
            if (d > rs.length && d > 0) {
                const nx = dx / d, ny = dy / d;
                koala.x = p.x + nx * rs.length;
                koala.y = p.y + ny * rs.length + ROPE_HAND_OFFSET;
                // Kill outward radial velocity; keep the tangential component
                // (this is what makes the swing feel like WA — energy carries)
                const vr = koala.vx * nx + koala.vy * ny;
                if (vr > 0) {
                    koala.vx -= vr * nx;
                    koala.vy -= vr * ny;
                }
            }

            // Don't swing through walls: if the body ended up inside terrain,
            // step back and deaden the impact (a soft thud, not a bounce)
            if (this.ropeBodyCollides(koala)) {
                koala.x = prevX;
                koala.y = prevY;
                koala.vx *= -0.3;
                koala.vy *= -0.3;
            }

            // Swung into the drink: let go, normal physics handles the splash
            if (koala.y + koala.height / 2 > this.waterLevel) {
                this.releaseRope();
                return;
            }

            // Stream position over the wire like walking does (20/s)
            if (this.networkManager && !this.isPractice) {
                const now = performance.now();
                if (!this.lastRopeSync || now - this.lastRopeSync > 50) {
                    this.networkManager.sendMove(
                        koala.x, koala.y, koala.facingLeft, undefined,
                        this.currentTeamIndex, this.currentKoalaIndex
                    );
                    this.lastRopeSync = now;
                }
            }
        }

        this.updateRopeWrap(rs);
    },

    /**
     * Rope wrapping: if terrain blocks the line from the active pivot to the
     * koala, the rope bends at the last clear point (new pivot, rope gets
     * effectively shorter). When the line from the PREVIOUS pivot clears
     * again, the bend unwinds and the length comes back.
     */
    updateRopeWrap(rs) {
        const koala = rs.koala;
        const hx = koala.x;
        const hy = koala.y - ROPE_HAND_OFFSET;

        // Unwrap any bends whose corner no longer blocks the line
        while (rs.pivots.length > 1) {
            const prev = rs.pivots[rs.pivots.length - 2];
            if (this.ropeRaycast(prev.x, prev.y, hx, hy)) break; // still blocked
            const removed = rs.pivots.pop();
            rs.length += removed.consumed;
        }

        // Wrap around any terrain that cuts the current segment (a single
        // frame can wrap around several corners of a jagged overhang)
        let guard = 0;
        while (guard++ < 8 && rs.pivots.length < 48) {
            const p = rs.pivots[rs.pivots.length - 1];
            const hit = this.ropeRaycast(p.x, p.y, hx, hy);
            if (!hit) break;
            const consumed = Math.hypot(hit.x - p.x, hit.y - p.y);
            if (consumed < 3) break; // degenerate corner right at the pivot
            rs.pivots.push({ x: hit.x, y: hit.y, consumed });
            rs.length = Math.max(8, rs.length - consumed);
        }
    },

    /**
     * March from (x1,y1) toward (x2,y2) in ~3px steps. Returns the last clear
     * point before the first terrain hit, or null if the line is clear. Skips
     * a few px at both ends (the pivot hugs a corner and the koala's body
     * overlaps the line) so touching endpoints don't read as blockage.
     */
    ropeRaycast(x1, y1, x2, y2) {
        const dx = x2 - x1, dy = y2 - y1;
        const dist = Math.hypot(dx, dy);
        if (dist < 10) return null;

        const steps = Math.ceil(dist / 3);
        let clearX = x1, clearY = y1;
        for (let s = 1; s < steps; s++) {
            const t = s / steps;
            const px = x1 + dx * t;
            const py = y1 + dy * t;
            const fromStart = dist * t;
            if (fromStart < 5 || dist - fromStart < 6) { clearX = px; clearY = py; continue; }
            if (this.terrain.checkCollision(px, py)) {
                return { x: clearX, y: clearY };
            }
            clearX = px;
            clearY = py;
        }
        return null;
    },

    /**
     * Quick body-vs-terrain check while swinging (center, head, feet)
     */
    ropeBodyCollides(koala) {
        const half = koala.height / 2 - 3;
        return this.terrain.checkCollision(koala.x, koala.y) ||
            this.terrain.checkCollision(koala.x, koala.y - half) ||
            this.terrain.checkCollision(koala.x, koala.y + half);
    },

    /**
     * Let go of the rope (Enter, water, or turn cleanup). The koala keeps its
     * swing velocity — release at the top of a pump to fling yourself. The
     * turn continues in the aiming phase.
     */
    releaseRope() {
        if (!this.ropeState) return;
        const koala = this.ropeState.koala;
        const wasMyAction = this.isMyTurn() && !this.isGameOver;

        this.clearRope();
        this.phase = 'aiming';

        if (wasMyAction && this.networkManager && !this.isPractice) {
            this.networkManager.send({
                type: 'ropeRelease',
                x: koala.x, y: koala.y,
                vx: koala.vx, vy: koala.vy,
                teamIndex: this.currentTeamIndex,
                koalaIndex: this.currentKoalaIndex
            });
        }
    },

    /**
     * Space/click while roped: let go and immediately shoot a new hook
     * toward the crosshair (free — rope ammo is once per turn).
     */
    ropeRefire() {
        const rs = this.ropeState;
        if (!rs) return;
        const koala = rs.koala;
        // fireWeapon's rope branch clears the old rope and replays remotely
        this.weaponManager.selectWeapon('rope');
        this.fireWeapon(koala.aimAngle, 1.0);
    },

    /**
     * Drop all rope state and hand the koala back to normal physics. Fall
     * damage counts from here (WA-style: swinging is safe, the drop is not).
     */
    clearRope() {
        const rs = this.ropeState;
        if (rs && rs.koala) {
            rs.koala.onRope = false;
            rs.koala.onGround = false;
            rs.koala.peakY = rs.koala.y;
        }
        this.ropeState = null;
    },

    /**
     * Remote turn owner let go of their rope
     */
    handleRemoteRopeRelease(data) {
        if (!this.adoptRemoteTurn(data, 'rope release')) return;
        const koala = this.getCurrentKoala();
        if (koala && data.x !== undefined) {
            koala.x = data.x;
            koala.y = data.y;
            koala.vx = data.vx || 0;
            koala.vy = data.vy || 0;
        }
        this.clearRope();
        this.phase = 'aiming';
    },
};
