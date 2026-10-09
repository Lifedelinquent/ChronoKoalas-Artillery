/**
 * NetSync - Multiplayer: remote action replay, turn adoption and state sync.
 *
 * Installed onto Game.prototype (see the bottom of Game.js), so every
 * method runs with `this` bound to the Game instance.
 */

import { log } from '../../utils/Logger.js';

export const NetSync = {
    // ==================== MULTIPLAYER NETWORK HANDLERS ====================

    /**
     * Check if current turn belongs to the local player
     */
    isMyTurn() {
        if (this.isPractice || !this.networkManager) {
            // Local game: CPU squads play themselves — blocking isMyTurn here
            // is what locks the human player's input out during a CPU turn.
            // Pure hotseat practice (no CPU teams) is always "my turn".
            return !this.getCurrentTeam()?.isCPU;
        }
        return this.networkManager.isMyTurn(this.currentTeamIndex);
    },

    /**
     * True when THIS client simulates the current koala's input-driven
     * motion (rope swing, blowtorch): the local human's own turn, or a CPU
     * turn in a local game (the AI drives through a virtual control pad).
     */
    hasLocalControl() {
        if (this.isMyTurn()) return true;
        return (this.isPractice || !this.networkManager) && !!this.getCurrentTeam()?.isCPU;
    },

    /**
     * Input source for the current koala: the CPU's virtual pad on a CPU
     * turn, otherwise the human's InputManager. Both expose isHeld(action)
     * and simPointer {x, y, down}.
     */
    getControl() {
        if (this.getCurrentTeam()?.isCPU && this.aiController) return this.aiController.control;
        return this.inputManager;
    },

    /**
     * Validate a remote action and, if our turn indices drifted, adopt the
     * acting player's turn — each client is authoritative about its OWN turn.
     *
     * The old gate ("ignore remote actions while it's my turn") silently
     * dropped legitimate actions whenever the two clients' turn clocks were a
     * moment apart: our timer flips the turn first, the opponent's last-second
     * shot arrives, and the projectile only ever exists on their screen. Now
     * we only reject actions claiming to come from OUR OWN team; a mismatched
     * turn index means we adopt theirs. Messages from old clients without
     * teamIndex fall back to the old rule.
     */
    adoptRemoteTurn(data, label) {
        if (this.isPractice || !this.networkManager) return false;

        if (data.teamIndex === undefined) {
            if (this.isMyTurn()) {
                console.warn(`Blocked remote ${label} during local turn (no teamIndex)`);
                return false;
            }
            return true;
        }
        if (this.networkManager.isMyTeam(data.teamIndex)) {
            console.warn(`Blocked remote ${label} claiming to be our own team`);
            return false;
        }
        if (this.currentTeamIndex !== data.teamIndex) {
            console.warn(`Turn drift on remote ${label}: local team ${this.currentTeamIndex}, acting team ${data.teamIndex} — adopting theirs`);
            this.currentTeamIndex = data.teamIndex;
            const team = this.teams[data.teamIndex];
            if (team && team.weapons) {
                this.weaponManager.weapons = team.weapons;
            }
            this.updateTurnIndicator();
        }
        if (data.koalaIndex !== undefined && this.currentKoalaIndex !== data.koalaIndex) {
            this.currentKoalaIndex = data.koalaIndex;
            const team = this.teams[data.teamIndex];
            if (team) team.currentKoalaIndex = data.koalaIndex;
        }
        return true;
    },

    /**
     * Handle remote player firing a weapon
     */
    handleRemoteFire(data) {
        log.debug('🎯 Remote fire:', data);

        if (!this.adoptRemoteTurn(data, 'fire')) return;

        const koala = this.getCurrentKoala();
        if (!koala) return;

        // Set up the koala's state from remote data
        koala.x = data.x;
        koala.y = data.y;
        koala.aimAngle = data.angle;

        // Fire the weapon
        this.weaponManager.selectWeapon(data.weaponId);

        // Never drop a replayed fire over ammo drift — the shot already
        // happened on the acting client, so refusing it here desyncs the
        // whole match (they have a projectile in flight, we don't)
        const weapon = this.weaponManager.currentWeapon;
        if (weapon && weapon.ammo !== Infinity && weapon.ammo <= 0) {
            console.warn(`Ammo drift: ${data.weaponId} shows 0 here but the opponent fired it — correcting to 1`);
            weapon.ammo = 1;
        }

        // A homing shot carries its target point in the fire message
        if (data.targetX !== undefined && data.targetY !== undefined) {
            this.homingTarget = { x: data.targetX, y: data.targetY };
        }

        this.fireWeapon(data.angle, data.power);
    },

    /**
     * Handle remote player movement
     */
    handleRemoteMove(data) {
        if (!this.adoptRemoteTurn(data, 'move')) return;
        const koala = this.getCurrentKoala();
        if (!koala) return;

        // Update koala position
        koala.x = data.x;
        koala.y = data.y;
        koala.facingLeft = data.facingLeft;
        if (data.blowtorchDigging !== undefined) {
            koala.blowtorchDigging = data.blowtorchDigging;
        }
    },

    /**
     * Handle remote player aiming
     */
    handleRemoteAim(data) {
        if (!this.adoptRemoteTurn(data, 'aim')) return;
        const koala = this.getCurrentKoala();
        if (!koala) return;

        koala.aimAngle = data.angle;
    },

    /**
     * Handle remote targeted weapon (airstrike, teleport)
     */
    handleRemoteTargetWeapon(data) {
        log.debug('🎯 Remote target weapon:', data);

        if (!this.adoptRemoteTurn(data, 'target weapon')) return;

        this.weaponManager.selectWeapon(data.weaponId);
        const weapon = this.weaponManager.currentWeapon;

        if (weapon) {
            // Same ammo-drift guard as handleRemoteFire
            if (weapon.ammo !== Infinity && weapon.ammo <= 0) {
                console.warn(`Ammo drift: ${data.weaponId} shows 0 here but the opponent fired it — correcting to 1`);
                weapon.ammo = 1;
            }
            this.fireTargettedWeapon(weapon, data.targetX, data.targetY);
        }
    },

    /**
     * Handle remote weapon selection
     */
    handleRemoteWeaponSelect(data) {
        log.debug('🔫 Remote weapon select:', data.weaponId);

        if (this.isMyTurn() && !this.isPractice) return;

        // Select the weapon on this client
        this.weaponManager.selectWeapon(data.weaponId);
        this.updateWeaponUI();
    },

    /**
     * Handle remote turn end signal
     */
    handleRemoteTurnEnd(data) {
        log.debug('🔄 Remote turn end:', data);

        if (this.isMyTurn() && !this.isPractice) {
            console.warn('Blocked remote turn end signal during local turn');
            return;
        }

        // A turn-end message only ever means "the active player ended a tool
        // action (blowtorch) early." End the same action locally so this client
        // leaves the tool phase; from there the turn hands over deterministically
        // on BOTH clients (retreat -> settle -> nextTurn), exactly like a normal
        // shot. We must NOT force team/koala indices or call startTurn() here —
        // doing so fought the deterministic handover and handed the active team
        // a second turn whenever this client had already left the tool phase.
        if (this.phase === 'blowtorch') {
            this.endBlowtorch();
        } else if (this.phase === 'drill') {
            this.endDrill();
        }
    },

    // (Obsolete duplicate declarations of handleRemoteStateSync and sendFullStateSync removed)

    /**
     * Send local fire action to network
     */
    sendFireAction(weaponId, angle, power, x, y) {
        if (this.networkManager && !this.isPractice) {
            this.networkManager.sendFire(weaponId, angle, power, x, y);
        }
    },

    /**
     * Send local target weapon action to network
     */
    sendTargetWeaponAction(weaponId, targetX, targetY) {
        if (this.networkManager && !this.isPractice) {
            this.networkManager.sendTargetWeapon(weaponId, targetX, targetY);
        }
    },

    /**
     * Send turn end to network
     */
    sendTurnEnd() {
        if (this.networkManager && !this.isPractice) {
            this.networkManager.sendTurnEnd(this.currentTeamIndex, this.currentKoalaIndex);
        }
    },

    /**
     * Serialize all koala states for sync messages
     */
    serializeKoalas() {
        const out = [];
        for (const team of this.teams) {
            for (const koala of team.koalas) {
                out.push({
                    name: koala.name,
                    x: koala.x,
                    y: koala.y,
                    vx: koala.vx || 0,
                    vy: koala.vy || 0,
                    health: koala.health,
                    isAlive: koala.isAlive,
                    onGround: koala.onGround
                });
            }
        }
        return out;
    },

    /**
     * Apply authoritative koala states from a sync message, playing death
     * effects for anything that died on the other side but not here (and
     * quietly reviving anything we killed by mistake).
     */
    applyKoalaStates(koalas) {
        if (!Array.isArray(koalas)) return;
        for (const kd of koalas) {
            const koala = this.findKoalaByName(kd.name);
            if (!koala) continue;
            koala.x = kd.x;
            koala.y = kd.y;
            koala.vx = kd.vx || 0;
            koala.vy = kd.vy || 0;
            koala.health = kd.health;
            koala.onGround = kd.onGround;
            if (koala.isAlive && !kd.isAlive) {
                // The authority saw this koala die. Above the waterline = it
                // exploded there: vanished body + gravestone; in the water =
                // it drowned (body just sinks).
                koala.die();
                if (koala.y < this.waterLevel) {
                    koala.vanished = true;
                    this.graves.push({ x: koala.x, y: koala.y + koala.height / 2, vy: 0, falling: true, style: koala.team?.style?.grave });
                }
                this.createDeathEffect(koala);
            } else if (!koala.isAlive && kd.isAlive) {
                // Local drift killed it but the authority says it lives
                koala.isAlive = true;
                koala.vanished = false;
            }
        }
        this.updateTeamHealth();
    },

    /**
     * Serialize per-team weapon ammo. Infinity is encoded as -1: the outbound
     * sanitizer strips non-finite numbers, which would otherwise turn every
     * unlimited weapon into 0 ammo on the receiving side.
     */
    serializeAmmo() {
        return this.teams.map(team => {
            const ammo = {};
            for (const [id, w] of Object.entries(team.weapons || {})) {
                ammo[id] = w.ammo === Infinity ? -1 : w.ammo;
            }
            return ammo;
        });
    },

    /**
     * Apply per-team ammo counts from a sync message (-1 = Infinity)
     */
    applyAmmoSync(ammoByTeam) {
        if (!Array.isArray(ammoByTeam)) return;
        ammoByTeam.forEach((ammo, i) => {
            const team = this.teams[i];
            if (!team || !team.weapons || !ammo) return;
            for (const [id, count] of Object.entries(ammo)) {
                if (team.weapons[id]) {
                    team.weapons[id].ammo = count === -1 ? Infinity : count;
                }
            }
        });
        this.updateWeaponUI();
    },

    /**
     * Announce the authoritative opening state of a new turn. Sent by the
     * client that drove the turn transition (see TurnManager.nextTurn); the
     * peer adopts it in handleRemoteTurnStart. This replaces the old
     * every-client-advances-on-its-own-clock model that caused double turns.
     */
    sendTurnStartSync() {
        if (!this.networkManager || this.isPractice) return;
        const tm = this.turnManager;
        this.networkManager.send({
            type: 'turnStart',
            turnCounter: tm.turnCounter,
            currentTeamIndex: this.currentTeamIndex,
            currentKoalaIndex: this.currentKoalaIndex,
            wind: this.wind,
            suddenDeathActive: tm.suddenDeathActive,
            roundNumber: tm.roundNumber,
            lastTeamIndex: tm.lastTeamIndex,
            turnTime: tm.turnTime,
            elapsedGameTime: tm.elapsedGameTime,
            waterLevel: this.waterLevel,
            ammo: this.serializeAmmo(),
            koalas: this.serializeKoalas()
        });
    },

    /**
     * Adopt the new turn announced by the client that ended the previous one
     */
    handleRemoteTurnStart(data) {
        if (this.isPractice || this.isGameOver) return;
        const tm = this.turnManager;

        // Stale or duplicate — e.g. our fallback watchdog already advanced us
        if (data.turnCounter !== undefined && data.turnCounter <= tm.turnCounter) {
            console.warn(`Ignoring stale turnStart #${data.turnCounter} (local turn #${tm.turnCounter})`);
            return;
        }

        log.debug('🔄 Remote turn start #' + data.turnCounter);

        // Leave whatever phase we were parked in
        this.cleanupTurnInputState();
        this.kamikazeState = null;

        // Authoritative state from the turn driver
        this.applyKoalaStates(data.koalas);
        this.applyAmmoSync(data.ammo);
        if (data.elapsedGameTime !== undefined) tm.elapsedGameTime = data.elapsedGameTime;
        if (data.waterLevel !== undefined) this.waterLevel = data.waterLevel;

        // Adopt the new turn, then run our own startTurn so the shared RNG
        // advances symmetrically (wind draw), music/UI update, and the host
        // rolls loot exactly as if we had advanced ourselves
        tm.currentTeamIndex = data.currentTeamIndex;
        tm.currentKoalaIndex = data.currentKoalaIndex;
        const team = this.teams[data.currentTeamIndex];
        if (team) team.currentKoalaIndex = data.currentKoalaIndex;

        tm.startTurn();

        // Belt-and-braces: force anything that could still have drifted
        tm.currentKoalaIndex = data.currentKoalaIndex;
        if (team) team.currentKoalaIndex = data.currentKoalaIndex;
        if (data.wind !== undefined) {
            this.wind = data.wind;
            this.updateWindDisplay();
        }
        if (data.suddenDeathActive && !tm.suddenDeathActive) {
            tm.activateSuddenDeath();
        }
        if (data.roundNumber !== undefined) tm.roundNumber = data.roundNumber;
        if (data.lastTeamIndex !== undefined) tm.lastTeamIndex = data.lastTeamIndex;
        if (data.turnTime !== undefined) {
            tm.turnTime = data.turnTime;
            tm.turnTimer = Math.min(tm.turnTimer, data.turnTime);
        }
        if (data.turnCounter !== undefined) tm.turnCounter = data.turnCounter;
        this.updateTurnIndicator();
    },

    /**
     * The other client's authoritative turn flow ended the game
     */
    handleRemoteGameOver(data) {
        if (this.isGameOver) return;
        log.debug('🏁 Remote game over:', data);
        const winner = (data.winnerTeamIndex >= 0 && this.teams[data.winnerTeamIndex]) || null;
        this.endGame(winner, { fromRemote: true });
    },

    /**
     * Send authoritative full state sync to peers. Used for reconnect
     * recovery — pass includeTerrain to ship a snapshot of the terrain canvas
     * so a rejoining guest gets every crater it missed.
     */
    sendFullStateSync(options = {}) {
        if (!this.networkManager || this.isPractice) return;

        log.debug('🔄 Sending full state sync' + (options.includeTerrain ? ' (with terrain)' : ''));

        const tm = this.turnManager;
        const stateData = {
            type: 'stateSync',
            phase: this.phase,
            turnCounter: tm.turnCounter,
            currentTeamIndex: this.currentTeamIndex,
            currentKoalaIndex: this.currentKoalaIndex,
            wind: this.wind,
            // Sudden-death state — active player is authoritative so guests stay
            // in lockstep on when it triggers, how high the water is, etc.
            suddenDeathActive: tm.suddenDeathActive,
            roundNumber: tm.roundNumber,
            lastTeamIndex: tm.lastTeamIndex,
            turnTime: tm.turnTime,
            elapsedGameTime: tm.elapsedGameTime,
            waterLevel: this.waterLevel,
            ammo: this.serializeAmmo(),
            koalas: this.serializeKoalas(),
            crates: this.lootManager.serializeCrates(),
            hazards: this.serializeHazards()
        };

        if (options.includeTerrain) {
            const canvas = this.terrain.getCanvas ? this.terrain.getCanvas() : this.terrain.canvas;
            if (canvas) {
                stateData.terrain = canvas.toDataURL('image/png');
            }
        }

        // A reconnecting guest / late spectator gets it alone; everyone else
        // is already in sync and would only be jolted by a full overwrite
        if (options.toPeer && this.networkManager.isHost) {
            this.networkManager.sendTo(options.toPeer, stateData);
        } else {
            this.networkManager.send(stateData);
        }
    },

    /**
     * Resting landmines and oil drums, for full state syncs (they used to be
     * missing, so a rejoining guest kept mines that had long exploded).
     */
    serializeHazards() {
        return {
            mines: this.projectiles
                .filter(p => p.type === 'mine' && p.stationary)
                .map(p => ({ x: p.x, y: p.y, isDud: !!p.isDud, dudActivated: !!p.dudActivated })),
            drums: this.oilDrums.map(d => ({ id: d.id, x: d.x, y: d.y, hp: d.hp, effectSeed: d.effectSeed }))
        };
    },

    applyHazards(hazards) {
        if (!hazards) return;
        if (Array.isArray(hazards.mines)) {
            this.projectiles = this.projectiles.filter(p => !(p.type === 'mine' && p.stationary));
            const fixed = () => 0.5; // no shared-RNG draws: values come from the sync
            for (const m of hazards.mines) {
                this.spawnLandmine(m.x, m.y + 5, fixed);
                const mine = this.projectiles[this.projectiles.length - 1];
                mine.x = m.x;
                mine.y = m.y;
                mine.isDud = m.isDud;
                mine.dudActivated = m.dudActivated;
            }
        }
        if (Array.isArray(hazards.drums)) {
            this.oilDrums = hazards.drums.map(d => ({
                id: d.id, x: d.x, y: d.y, hp: d.hp, maxHp: 30,
                falling: false, vy: 0, igniteTimer: 0, detonated: false, effectSeed: d.effectSeed
            }));
        }
    },

    /**
     * Replace the local terrain with a snapshot from the peer (reconnect sync)
     */
    applyTerrainSnapshot(dataUrl) {
        const img = new Image();
        img.onload = () => {
            this.terrain.ctx.clearRect(0, 0, this.terrain.width, this.terrain.height);
            this.terrain.ctx.drawImage(img, 0, 0);
            this.terrain.updateCollisionMask();
            log.debug('🗺️ Terrain snapshot applied (reconnect sync)');
        };
        img.src = dataUrl;
    },

    /**
     * Handle explosion sync from remote player
     * This applies the authoritative damage/knockback values from the Host
     */
    handleRemoteExplosionSync(data) {
        if (this.networkManager && this.networkManager.isHost) {
            console.warn('🛡️ Blocked remote explosion sync (Host is authority)');
            return;
        }

        log.debug('💥 Remote explosion sync:', data);

        // IMPORTANT: Apply terrain damage at the EXACT synced position
        // This ensures both clients have identical terrain
        if (data.explosionX !== undefined && data.explosionY !== undefined && data.explosionRadius > 0) {
            this.terrain.createCrater(data.explosionX, data.explosionY, data.explosionRadius);
            log.debug(`   Terrain crater at (${data.explosionX.toFixed(0)}, ${data.explosionY.toFixed(0)}) radius ${data.explosionRadius}`);
        }

        // Batched craters (fire burning terrain) — apply at exact host positions
        if (Array.isArray(data.craters)) {
            for (const c of data.craters) {
                this.terrain.createCrater(c.x, c.y, c.r);
            }
        }

        // Oil drums the host detonated — replay locally (removal, blast
        // visuals, burning oil). detonateOilDrum is visual-only on a guest;
        // the crater and damage arrive with this same message.
        if (Array.isArray(data.drums)) {
            for (const id of data.drums) {
                const drum = this.oilDrums.find(d => d.id === id);
                if (drum) this.detonateOilDrum(drum);
            }
        }

        // Apply the synced results to each affected koala
        for (const result of data.results) {
            const koala = this.findKoalaByName(result.koalaName);
            if (koala) {
                // Sync health (authoritative from active player). The host
                // ran takeDamage; mirror the hit into our match stats.
                if (result.damage > 0) this.stats?.onDamage(koala, result.damage);
                koala.health = result.newHealth;

                // Sync position and velocity (for knockback)
                koala.x = result.x;
                koala.y = result.y;
                koala.vx = result.vx;
                koala.vy = result.vy;

                // Mirror the host's tumble from the synced launch velocity so
                // the guest sees the same spin (visual only — physics authority
                // stays with the host's vx/vy above).
                const launchSpeed = Math.hypot(koala.vx, koala.vy);
                if (launchSpeed > 60) {
                    koala.spinVel = (koala.vx >= 0 ? 1 : -1) * Math.min(launchSpeed / 45, 18);
                    koala.onGround = false;
                    koala.wasLaunched = true; // guest skips on landing like the host
                }

                // Show the same damage feedback the active player sees
                if (result.damage > 0) {
                    this.createFloatingText(koala.x, koala.y - 40, `-${result.damage}`, '#ff5544');
                }

                // Koalas dropped to 0 HP enter the local death sequence
                // (updateDeathSequences) — no direct die() here, so the
                // guest gets the same panic-and-explode show as the host

                log.debug(`   ${koala.name}: HP=${koala.health}, pos=(${koala.x.toFixed(0)}, ${koala.y.toFixed(0)})`);
            }
        }

        // Update team health display
        this.updateTeamHealth();
    },

    /**
     * Find a koala by name across all teams
     */
    findKoalaByName(name) {
        for (const team of this.teams) {
            for (const koala of team.koalas) {
                if (koala.name === name) {
                    return koala;
                }
            }
        }
        return null;
    },

    /**
     * Handle remote jump action
     */
    handleRemoteJump(data) {
        log.debug('🦘 Remote jump:', data);
        if (!this.adoptRemoteTurn(data, 'jump')) return;
        const koala = this.getCurrentKoala();
        if (koala) {
            koala.x = data.x;
            koala.y = data.y;
            koala.vx = data.vx || 0;
            koala.vy = data.vy;
            koala.onGround = false;
            koala.isJumping = true;
        }
    },

    /**
     * Handle remote high jump / backflip action
     */
    handleRemoteHighJump(data) {
        log.debug('🦘 Remote high jump:', data);
        if (!this.adoptRemoteTurn(data, 'high jump')) return;
        const koala = this.getCurrentKoala();
        if (koala) {
            koala.x = data.x;
            koala.y = data.y;
            koala.vx = data.vx;
            koala.vy = data.vy;
            koala.facingLeft = data.facingLeft;
            koala.onGround = false;
            // Only the double-tap backflip somersaults; a plain high jump
            // (single Backspace) stays upright. Old clients omit `flip` and
            // get the somersault, matching their local animation.
            koala.isBackflipping = data.flip !== false;
            koala.backflipRotation = 0;
        }
    },

    /**
     * Handle full state sync from the authoritative client
     * This is used to correct any drift between clients
     */
    handleRemoteStateSync(data) {
        log.debug('🔄 Remote state sync');

        // Sync all koala positions (with death effects / revive handling)
        this.applyKoalaStates(data.koalas);
        this.applyAmmoSync(data.ammo);
        if (data.crates) {
            this.lootManager.applyCrateSync(data.crates);
        }
        if (data.hazards) {
            this.applyHazards(data.hazards);
        }
        if (data.terrain) {
            this.applyTerrainSnapshot(data.terrain);
        }
        if (data.turnCounter !== undefined) {
            this.turnManager.turnCounter = Math.max(this.turnManager.turnCounter, data.turnCounter);
        }

        // Only sync team/koala index during the aiming phase to prevent the
        // double-turn bug where stateSync overwrites the current turn owner
        // mid-action — except on a full reconnect sync (terrain present),
        // where we adopt everything: our local state is stale by definition.
        const safeToSyncTurn = this.phase === 'aiming' || data.terrain !== undefined;

        if (safeToSyncTurn) {
            if (data.currentTeamIndex !== undefined) {
                this.currentTeamIndex = data.currentTeamIndex;
            }
            if (data.currentKoalaIndex !== undefined) {
                this.currentKoalaIndex = data.currentKoalaIndex;
            }
        }

        // Always sync phase and wind
        if (data.phase) {
            this.phase = data.phase;
        }
        if (data.wind !== undefined) {
            this.wind = data.wind;
            this.updateWindDisplay();
        }

        // Sudden-death state is authoritative from the active player
        if (data.suddenDeathActive !== undefined) {
            this.turnManager.suddenDeathActive = data.suddenDeathActive;
        }
        if (data.roundNumber !== undefined) this.turnManager.roundNumber = data.roundNumber;
        if (data.lastTeamIndex !== undefined) this.turnManager.lastTeamIndex = data.lastTeamIndex;
        if (data.turnTime !== undefined) this.turnManager.turnTime = data.turnTime;
        if (data.elapsedGameTime !== undefined) this.turnManager.elapsedGameTime = data.elapsedGameTime;
        if (data.waterLevel !== undefined) this.waterLevel = data.waterLevel;

        this.updateTeamHealth();
        this.updateTurnIndicator();
    },
};
