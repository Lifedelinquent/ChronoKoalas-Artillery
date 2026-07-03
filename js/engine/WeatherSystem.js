/**
 * WeatherSystem - Wind-driven atmospheric particles (WA-style ambience).
 *
 * Each terrain theme gets its own weather: rain over the grasslands, snow on
 * the tundra, drifting ash over volcanic maps and blowing dust in the desert.
 * Everything here is purely cosmetic and LOCAL-ONLY: it deliberately uses
 * Math.random() (never the seeded/synced RNG) so multiplayer stays in sync.
 * The weather *type* still matches between clients because it derives from
 * the terrain theme, which comes from the shared map seed.
 */

const WEATHER_BY_THEME = {
    grassland: 'rain',
    tundra: 'snow',
    volcanic: 'ash',
    desert: 'dust'
};

const PARTICLE_COUNTS = {
    rain: 200,
    snow: 150,
    ash: 90,
    dust: 70
};

export class WeatherSystem {
    constructor(game) {
        this.game = game;
        this.type = 'none';
        this.particles = [];
        this.ripples = []; // Rain splash rings on the water surface
        this.time = 0;
        this._themeId = undefined;
    }

    /**
     * Re-read the terrain theme and rebuild the particle pool if it changed.
     * Called every update so restarts / map regeneration are picked up
     * automatically without any explicit reset hook.
     */
    syncTheme() {
        const themeId = this.game.terrain.theme?.id ?? null;
        if (themeId === this._themeId) return;
        this._themeId = themeId;
        this.type = WEATHER_BY_THEME[themeId] || 'none';
        this.particles = [];
        this.ripples = [];

        const count = PARTICLE_COUNTS[this.type] || 0;
        for (let i = 0; i < count; i++) {
            this.particles.push(this.spawnParticle(true));
        }
    }

    /** Visible world-space rect (camera view + margin) that weather lives in */
    getViewBounds() {
        const cam = this.game.camera;
        const margin = 150;
        const w = this.game.canvas.width / cam.zoom;
        const h = this.game.canvas.height / cam.zoom;
        return {
            left: cam.x - margin,
            right: cam.x + w + margin,
            top: cam.y - margin,
            bottom: cam.y + h + margin,
            width: w + margin * 2
        };
    }

    /**
     * Create one particle. On initial fill (anywhere=true) scatter through the
     * whole view; on respawn, enter from the top / upwind edge so particles
     * keep streaming across the screen.
     */
    spawnParticle(anywhere) {
        const v = this.getViewBounds();
        const r = Math.random;
        const p = {
            x: v.left + r() * v.width,
            y: anywhere ? v.top + r() * (v.bottom - v.top) : v.top,
            phase: r() * Math.PI * 2,
            size: 1,
            vy: 0
        };

        switch (this.type) {
            case 'rain':
                p.vy = 500 + r() * 250;
                p.size = 1 + r();
                break;
            case 'snow':
                p.vy = 35 + r() * 45;
                p.size = 1.5 + r() * 2;
                break;
            case 'ash':
                // Ash floats: some flakes rise on thermals, some sink
                p.vy = -15 + r() * 40;
                p.size = 1.5 + r() * 2;
                p.ember = r() < 0.25; // A few glowing embers among the grey
                if (anywhere === false) {
                    // Respawned ash enters from a random vertical position on
                    // the upwind side rather than the top (it drifts sideways)
                    p.y = v.top + r() * (v.bottom - v.top);
                    p.x = this.game.wind >= 0 ? v.left : v.right;
                }
                break;
            case 'dust':
                p.vy = -5 + r() * 20;
                p.size = 1 + r() * 1.5;
                if (anywhere === false) {
                    p.y = v.top + r() * (v.bottom - v.top);
                    p.x = this.game.wind >= 0 ? v.left : v.right;
                }
                break;
        }
        return p;
    }

    update(dt) {
        this.syncTheme();
        if (this.type === 'none') return;

        this.time += dt;
        const wind = this.game.wind;
        const v = this.getViewBounds();
        const waterY = this.game.waterLevel;
        const terrain = this.game.terrain;

        for (let i = 0; i < this.particles.length; i++) {
            const p = this.particles[i];

            switch (this.type) {
                case 'rain':
                    // Rain streaks slant hard with the wind (WA-style)
                    p.vx = wind * 380;
                    break;
                case 'snow':
                    // Lazy sway + wind drift
                    p.vx = wind * 140 + Math.sin(this.time * 1.5 + p.phase) * 18;
                    break;
                case 'ash':
                    // Swirling drift, mostly sideways with the gale
                    p.vx = wind * 110 + Math.sin(this.time * 0.8 + p.phase) * 25;
                    p.vy += Math.cos(this.time * 0.6 + p.phase) * 12 * dt;
                    break;
                case 'dust':
                    // Near-horizontal wisps racing with the wind
                    p.vx = wind * 260 + Math.sin(this.time * 2 + p.phase) * 30;
                    break;
            }

            p.x += p.vx * dt;
            p.y += p.vy * dt;

            let dead = false;

            // Hit the water: rain kicks up a little ripple ring
            if (p.y >= waterY) {
                if (this.type === 'rain' && this.ripples.length < 40 &&
                    p.x > v.left && p.x < v.right) {
                    this.ripples.push({ x: p.x, time: 0, lifetime: 0.5 });
                }
                dead = true;
            }
            // Falling precipitation dies on terrain contact
            else if ((this.type === 'rain' || this.type === 'snow') &&
                p.y > 0 && terrain.checkCollision(p.x, p.y)) {
                dead = true;
            }
            // Left the view
            else if (p.x < v.left - 50 || p.x > v.right + 50 ||
                p.y < v.top - 100 || p.y > v.bottom) {
                dead = true;
            }

            if (dead) {
                this.particles[i] = this.spawnParticle(false);
            }
        }

        // Age out splash ripples
        for (let i = this.ripples.length - 1; i >= 0; i--) {
            this.ripples[i].time += dt;
            if (this.ripples[i].time >= this.ripples[i].lifetime) {
                this.ripples.splice(i, 1);
            }
        }
    }

    /** Draw in world space (called inside the camera transform) */
    render(ctx) {
        if (this.type === 'none') return;
        const wind = this.game.wind;

        ctx.save();

        switch (this.type) {
            case 'rain': {
                ctx.strokeStyle = 'rgba(170, 200, 235, 0.45)';
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                for (const p of this.particles) {
                    // Streak along the velocity vector
                    const len = 0.028;
                    ctx.moveTo(p.x, p.y);
                    ctx.lineTo(p.x - p.vx * len, p.y - p.vy * len);
                }
                ctx.stroke();
                break;
            }
            case 'snow': {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
                for (const p of this.particles) {
                    ctx.globalAlpha = 0.5 + Math.sin(this.time * 2 + p.phase) * 0.25 + 0.25;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                    ctx.fill();
                }
                break;
            }
            case 'ash': {
                for (const p of this.particles) {
                    if (p.ember) {
                        // Flickering glow
                        const flicker = 0.55 + Math.sin(this.time * 8 + p.phase) * 0.35;
                        ctx.globalAlpha = Math.max(0.15, flicker);
                        ctx.fillStyle = '#ff8c42';
                    } else {
                        ctx.globalAlpha = 0.5;
                        ctx.fillStyle = '#9a9a9a';
                    }
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                    ctx.fill();
                }
                break;
            }
            case 'dust': {
                ctx.fillStyle = 'rgba(230, 200, 140, 0.4)';
                for (const p of this.particles) {
                    ctx.globalAlpha = 0.25 + Math.sin(this.time * 3 + p.phase) * 0.15 + 0.15;
                    ctx.beginPath();
                    // Stretched along the wind for a wispy look
                    ctx.ellipse(p.x, p.y, p.size * (2 + Math.abs(wind) * 3), p.size, 0, 0, Math.PI * 2);
                    ctx.fill();
                }
                break;
            }
        }

        // Rain ripples ride on the water surface
        if (this.ripples.length > 0) {
            const waterY = this.game.renderer.renderWaterY ?? this.game.waterLevel;
            ctx.globalAlpha = 1;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.lineWidth = 1;
            for (const rp of this.ripples) {
                const progress = rp.time / rp.lifetime;
                ctx.globalAlpha = (1 - progress) * 0.5;
                ctx.beginPath();
                ctx.ellipse(rp.x, waterY, 2 + progress * 10, (2 + progress * 10) * 0.3, 0, 0, Math.PI * 2);
                ctx.stroke();
            }
        }

        ctx.restore();
    }
}
