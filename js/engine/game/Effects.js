/**
 * Effects - Cosmetic effects: particles, floating text, splashes, screen shake, banners.
 *
 * Installed onto Game.prototype (see the bottom of Game.js), so every
 * method runs with `this` bound to the Game instance.
 */

import { getSettings } from '../../utils/Settings.js';

export const Effects = {
    /**
     * Create explosion visual
     */
    createExplosion(x, y, radius) {
        this.particles.push({
            type: 'explosion',
            x, y, radius,
            maxRadius: radius,
            alpha: 1,
            lifetime: 0.5,
            time: 0
        });
    },

    /**
     * Create explosion particles
     */
    createExplosionParticles(x, y, radius, color = null) {
        const count = Math.floor(radius / 2);
        // Limit particle count for performance
        const particlesToAdd = Math.min(count, this.maxParticles - this.particles.length);
        for (let i = 0; i < particlesToAdd; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 50 + Math.random() * 150;
            this.addParticle({
                type: 'debris',
                x, y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 50,
                size: 2 + Math.random() * 4,
                color: color || (Math.random() > 0.5 ? '#654321' : '#8B4513'),
                lifetime: 1 + Math.random(),
                time: 0
            });
        }
    },

    /**
     * Soul-departing sparkle burst when a koala dies
     */
    createDeathEffect(koala) {
        for (let i = 0; i < 12; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 30 + Math.random() * 60;
            this.addParticle({
                type: 'spark',
                x: koala.x,
                y: koala.y - 10,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 80, // Drift upward
                color: Math.random() > 0.5 ? '#ffd700' : '#ffffff',
                size: 2 + Math.random() * 3,
                lifetime: 1 + Math.random() * 0.5,
                time: 0
            });
        }
    },

    /**
     * Water splash effect (entity or projectile falls into water)
     */
    createSplash(x, waterY) {
        for (let i = 0; i < 14; i++) {
            this.addParticle({
                type: 'splash',
                x: x + (Math.random() - 0.5) * 20,
                y: waterY,
                vx: (Math.random() - 0.5) * 160,
                vy: -120 - Math.random() * 220,
                size: 2 + Math.random() * 3,
                lifetime: 0.8 + Math.random() * 0.4,
                time: 0
            });
        }
    },

    /**
     * Trigger a camera shake (intensity in world px, duration in seconds)
     */
    addScreenShake(intensity, duration = 0.3) {
        if (getSettings().screenShake === false) return;
        // Keep the stronger shake if one is already running
        if (this.camera.shake && this.camera.shake.time > 0 &&
            this.camera.shake.intensity > intensity) {
            return;
        }
        this.camera.shake = { intensity, duration, time: duration };
    },

    /**
     * Add a particle with limit enforcement
     */
    addParticle(particleData) {
        // Remove oldest particles if at limit
        while (this.particles.length >= this.maxParticles) {
            const removed = this.particles.shift();
            if (this.particlePool.length < this.maxPoolSize) {
                this.particlePool.push(removed);
            }
        }

        let p;
        if (this.particlePool.length > 0) {
            p = this.particlePool.pop();
            // Clear all old properties to prevent ghost behaviors (e.g. retained velocities)
            for (const key in p) delete p[key];
            // Copy all new properties to recycled object
            Object.assign(p, particleData);
        } else {
            p = { ...particleData };
        }

        this.particles.push(p);
    },

    /**
     * Create floating text (for damage numbers, healing, etc.)
     */
    /**
     * Flash a big "SUDDEN DEATH" banner over the battlefield. Built and animated
     * entirely in JS (Web Animations API) so it needs no extra HTML/CSS, and
     * auto-removes itself so rematches don't stack banners.
     */
    announceSuddenDeath() {
        const screen = document.getElementById('game-screen');
        if (!screen) return;

        const banner = document.createElement('div');
        banner.textContent = '💀 SUDDEN DEATH 💀';
        banner.style.cssText = [
            'position:absolute',
            'top:38%',
            'left:50%',
            'transform:translate(-50%,-50%)',
            'font-size:64px',
            'font-weight:900',
            'color:#ff3b30',
            'text-shadow:0 0 20px rgba(255,0,0,0.8),0 4px 8px rgba(0,0,0,0.6)',
            'letter-spacing:4px',
            'white-space:nowrap',
            'pointer-events:none',
            'z-index:50'
        ].join(';');
        screen.appendChild(banner);

        banner.animate([
            { opacity: 0, transform: 'translate(-50%,-50%) scale(0.6)' },
            { opacity: 1, transform: 'translate(-50%,-50%) scale(1.15)', offset: 0.2 },
            { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.8 },
            { opacity: 0, transform: 'translate(-50%,-50%) scale(1)' }
        ], { duration: 3000, easing: 'ease-out' });

        setTimeout(() => banner.remove(), 3000);
    },

    createFloatingText(x, y, text, color = '#fff') {
        this.addParticle({
            type: 'floatingText',
            x, y,
            vx: 0,
            vy: -50, // Float upward
            text,
            color,
            lifetime: 1.5,
            time: 0,
            size: 16,
            alpha: 1
        });
    },

    /**
     * Update particles
     */
    updateParticles(dt) {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.time += dt;

            if (p.time >= p.lifetime) {
                const removed = this.particles.splice(i, 1)[0];
                if (this.particlePool.length < this.maxPoolSize) {
                    this.particlePool.push(removed);
                }
                continue;
            }

            if (p.type === 'debris') {
                p.vy += 400 * dt; // gravity
                p.x += p.vx * dt;
                p.y += p.vy * dt;
            } else if (p.type === 'explosion') {
                p.alpha = 1 - (p.time / p.lifetime);
            } else if (p.type === 'floatingText') {
                p.y += p.vy * dt;
                p.vy *= 0.98; // Slow down
            } else if (p.type === 'spark') {
                p.vx *= 0.95;
                p.vy *= 0.95;
                p.vy += 100 * dt; // Light gravity
                p.x += p.vx * dt;
                p.y += p.vy * dt;
            } else if (p.type === 'smoke') {
                p.vx *= 0.97;
                p.vy -= 30 * dt; // Drift upward
                p.x += p.vx * dt;
                p.y += p.vy * dt;
            } else if (p.type === 'splash') {
                p.vy += 500 * dt; // Heavy gravity - water falls back down
                p.x += p.vx * dt;
                p.y += p.vy * dt;
            }
        }
    },

    /**
     * Create teleport visual effect
     */
    createTeleportEffect(x, y) {
        for (let i = 0; i < 10; i++) {
            this.addParticle({
                type: 'smoke',
                x: x,
                y: y,
                vx: (Math.random() - 0.5) * 100,
                vy: (Math.random() - 0.5) * 100,
                lifetime: 1,
                time: 0,
                color: '#3498db',
                size: 5 + Math.random() * 5
            });
        }
    },
};
