/**
 * CameraSystem - Camera following, framing and centering.
 *
 * Priority each frame: death-cam (a koala self-destructing, then a beat on
 * the blast) > action framing > the followed projectile.
 *
 * Action framing (Settings → auto camera): while shots are in the air, the
 * camera frames EVERYTHING that's moving — every live projectile and any
 * koala being flung — zooming out as far as needed (never below 0.5x) so a
 * cluster bomb, an air strike or a cross-map bazooka stays fully in view,
 * leading a lone fast projectile a little so it doesn't race off-screen.
 * When the action ends it eases back to the player's own zoom. Panning or
 * zooming by hand hands the camera to the player until the next turn.
 *
 * Purely cosmetic: the camera never feeds back into the simulation.
 *
 * Installed onto Game.prototype (see the bottom of Game.js), so every
 * method runs with `this` bound to the Game instance.
 */

import { getSettings } from '../../utils/Settings.js';

const MIN_AUTO_ZOOM = 0.5;
const FRAME_MARGIN = 140;   // world px kept around the framed action
const ZOOM_EASE = 2.5;      // per second

export const CameraSystem = {
    /**
     * Start following a projectile with camera (uses main update loop)
     */
    followProjectile(projectile) {
        this.followingProjectile = projectile;
    },

    stopFollowingProjectile() {
        this.followingProjectile = null;
    },

    /**
     * The player panned/zoomed by hand: stop auto-framing for this turn and
     * remember their zoom as the one to come back to.
     */
    noteManualCamera() {
        this.cameraManualTurn = this.turnManager.turnCounter;
        this.camera.userZoom = this.camera.zoom;
    },

    /**
     * Bounding box of everything worth watching right now, or null.
     * Live projectiles (resting mines/dynamite excluded) and koalas being
     * flung by a hit.
     */
    actionBounds() {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let count = 0;
        const add = (x, y) => {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            count++;
        };

        for (const p of this.projectiles) {
            if (p.stationary || p.isPellet) continue;
            // Ignore shells far above the map; the camera can't go there anyway
            add(p.x, Math.max(0, p.y));
        }
        for (const team of this.teams) {
            for (const k of team.koalas) {
                if (!k.vanished && !k.onGround && k.wasLaunched && Math.hypot(k.vx, k.vy) > 120) {
                    add(k.x, k.y);
                }
            }
        }
        if (count === 0) return null;
        return { minX, minY, maxX, maxY, count };
    },

    /**
     * Update camera position
     */
    updateCamera(dt) {
        const camera = this.camera;
        if (camera.userZoom === undefined) camera.userZoom = camera.zoom;

        // Decay screen shake
        if (camera.shake && camera.shake.time > 0) {
            camera.shake.time -= dt;
        }

        const auto = getSettings().autoCamera !== false &&
            this.cameraManualTurn !== this.turnManager.turnCounter;
        let targetZoom = auto ? camera.userZoom : camera.zoom;

        // Death-cam: cut to the koala working through its self-destruct,
        // then linger briefly on the blast site
        let dyingKoala = null;
        for (const team of this.teams) {
            dyingKoala = team.koalas.find(k => k.isAlive && k.isDying) || null;
            if (dyingKoala) break;
        }

        const action = auto && !dyingKoala && this.deathCamTimer <= 0 ? this.actionBounds() : null;

        if (dyingKoala) {
            this.centerCameraOn(dyingKoala.x, dyingKoala.y);
        } else if (this.deathCamTimer > 0) {
            this.centerCameraOn(this.deathCamX, this.deathCamY);
        } else if (action) {
            let cx = (action.minX + action.maxX) / 2;
            let cy = (action.minY + action.maxY) / 2;

            // Lead a single fast projectile so it doesn't outrun the frame
            const lone = action.count === 1 && this.followingProjectile && !this.followingProjectile.destroyed
                ? this.followingProjectile : null;
            if (lone) {
                cx += lone.vx * 0.22;
                cy += lone.vy * 0.15;
            }

            const w = (action.maxX - action.minX) + FRAME_MARGIN * 2 + (lone ? Math.abs(lone.vx) * 0.44 : 0);
            const h = (action.maxY - action.minY) + FRAME_MARGIN * 2 + (lone ? Math.abs(lone.vy) * 0.3 : 0);
            const fit = Math.min(this.canvas.width / w, this.canvas.height / h);
            targetZoom = Math.max(MIN_AUTO_ZOOM, Math.min(camera.userZoom, fit));
            this.centerCameraOn(cx, cy, targetZoom);
        } else if (this.followingProjectile && !this.followingProjectile.destroyed) {
            this.centerCameraOn(this.followingProjectile.x, this.followingProjectile.y);
        } else if (this.followingProjectile) {
            this.followingProjectile = null;
        }

        // Ease the zoom, keeping the view centred while it changes
        if (Math.abs(targetZoom - camera.zoom) > 0.001) {
            const oldZoom = camera.zoom;
            const centerX = camera.x + this.canvas.width / (2 * oldZoom);
            const centerY = camera.y + this.canvas.height / (2 * oldZoom);
            camera.zoom += (targetZoom - camera.zoom) * Math.min(1, ZOOM_EASE * dt);
            camera.x = centerX - this.canvas.width / (2 * camera.zoom);
            camera.y = centerY - this.canvas.height / (2 * camera.zoom);
            this.inputManager?.updateZoomDisplay?.();
        }

        const smoothing = 5;
        camera.x += (camera.targetX - camera.x) * smoothing * dt;
        camera.y += (camera.targetY - camera.y) * smoothing * dt;

        // Clamp to world bounds (account for zoom)
        const viewWidth = this.canvas.width / camera.zoom;
        const viewHeight = this.canvas.height / camera.zoom;
        camera.x = Math.max(0, Math.min(this.worldWidth - viewWidth, camera.x));
        camera.y = Math.max(0, Math.min(this.worldHeight - viewHeight, camera.y));
    },

    /**
     * Center the camera target on a world position (zoom-aware). `zoom`
     * defaults to the current zoom; pass the zoom being eased toward so the
     * framing lands where it should.
     */
    centerCameraOn(x, y, zoom = this.camera.zoom) {
        this.camera.targetX = x - this.canvas.width / (2 * zoom);
        this.camera.targetY = y - this.canvas.height / (2 * zoom);
    }
};
