/**
 * DeathSystem - WA-style deaths: panic, self-destruct, death-cam and gravestones.
 *
 * Installed onto Game.prototype (see the bottom of Game.js), so every
 * method runs with `this` bound to the Game instance.
 */

export const DeathSystem = {
    // ==================== WA-STYLE DEATHS & GRAVES ====================

    /** True while a self-destruct is playing out (or its blast lingers). */
    deathHoldActive() {
        return this.deathCamTimer > 0 ||
            this.teams.some(t => t.koalas.some(k => k.isAlive && k.isDying));
    },

    /**
     * A koala at 0 HP panics for a beat, then self-destructs with a real
     * blast that can chain into neighbours, mines and drums (WA-style).
     * Detection runs on EVERY client from its own synced health values;
     * the blast damage itself stays host-authoritative inside
     * handleProjectileImpact. Drowned/ring-out koalas die elsewhere
     * (Physics) without ever entering this sequence.
     */
    updateDeathSequences(dt) {
        // One self-destruct at a time so the death-cam can show each in
        // sequence (team/koala order is deterministic, so both network
        // clients stagger multi-kills identically).
        let anyoneDying = this.teams.some(t => t.koalas.some(k => k.isAlive && k.isDying));
        for (const team of this.teams) {
            for (const koala of team.koalas) {
                if (!koala.isAlive) continue;

                if (koala.isDying) {
                    koala.dyingTimer -= dt;
                    if (koala.dyingTimer <= 0) this.explodeKoala(koala);
                } else if (!anyoneDying && koala.health <= 0) {
                    koala.isDying = true;
                    koala.dyingTimer = 0.9;
                    anyoneDying = true;
                    this.audioManager.playTimerTick();
                    this.audioManager.playVoice('ouch', 0.8, koala.team.style?.voice);
                }
            }
        }
    },

    explodeKoala(koala) {
        koala.die();
        koala.vanished = true;
        // Hold the camera on the blast for a beat before cutting back
        this.deathCamX = koala.x;
        this.deathCamY = koala.y;
        this.deathCamTimer = 0.8;
        this.audioManager.playDeath();
        this.createDeathEffect(koala);
        this.graves.push({ x: koala.x, y: koala.y + koala.height / 2, vy: 0, falling: true, style: koala.team?.style?.grave });
        this.updateTeamHealth();

        // The farewell blast goes through the standard impact pipeline, so
        // craters, chain damage, mine flinging and network sync all apply
        const blastWeapon = this.weaponManager.getSubMunition('deathBlast');
        if (blastWeapon) {
            this.handleProjectileImpact({
                x: koala.x,
                y: koala.y,
                weapon: blastWeapon,
                shooter: koala
            });
        }
    },

    /**
     * Gravestones fall when the ground under them is blown away and sink
     * with a splash if they end up in the water. Cosmetic only.
     */
    updateGraves(dt) {
        if (this.graves.length === 0) return;
        for (let i = this.graves.length - 1; i >= 0; i--) {
            const g = this.graves[i];

            if (!g.falling &&
                !this.terrain.checkCollision(g.x, g.y + 2) &&
                !this.terrain.checkCollision(g.x, g.y + 6)) {
                g.falling = true;
                g.vy = 0;
            }

            if (g.falling) {
                g.vy += 800 * dt;
                const targetY = g.y + g.vy * dt;
                let y = g.y;
                let landed = false;
                while (y < targetY) {
                    y = Math.min(y + 2, targetY);
                    if (this.terrain.checkCollision(g.x, y + 2)) {
                        landed = true;
                        break;
                    }
                }
                g.y = y;
                if (landed) {
                    g.falling = false;
                    g.vy = 0;
                }

                if (g.y > this.waterLevel + 10) {
                    this.createSplash(g.x, this.waterLevel);
                    this.graves.splice(i, 1);
                }
            }
        }
    },
};
