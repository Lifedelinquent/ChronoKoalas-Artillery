import { EventEmitter } from '../utils/EventEmitter.js';
import { globalAudioManager } from './AudioManager.js';

export class TurnManager extends EventEmitter {
    constructor(game) {
        super();
        this.game = game;

        this.currentTeamIndex = 0;
        this.currentKoalaIndex = 0;

        this.defaultTurnTime = 30;
        this.turnTime = this.defaultTurnTime;
        this.turnTimer = this.turnTime;

        this.phase = 'waiting'; // waiting, aiming, firing, projectile, retreat, damage, nextTurn
        this.countdownTimer = 0;

        this.retreatTime = 5;
        this.retreatTimer = 0;

        // Grace period after firing
        this.projectileGraceTimer = 0;

        // Sudden death: once enough game time has elapsed AND every team has had
        // an equal number of turns (a full round just completed), the gloves come
        // off. elapsedGameTime is advanced in fixed steps from Game.update() and
        // the trigger is evaluated in startTurn(), so it stays in sync across
        // networked clients (the active player also confirms it via full state sync).
        this.suddenDeathTime = 180;        // seconds of active play before it can start
        this.suddenDeathHealthCap = 25;    // initial HP cap applied on activation
        this.suddenDeathDecay = 5;         // HP every surviving koala loses each turn
        this.waterRisePerTurn = 12;        // px the water surface climbs each turn
        this.suddenDeathActive = false;
        this.elapsedGameTime = 0;
        this.roundNumber = 1;
        this.lastTeamIndex = -1;

        // Multiplayer turn authority: the client whose turn it is drives the
        // turn's end (timer expiry, settle wait, next-turn advance) and
        // announces the new turn via a 'turnStart' message. The passive client
        // parks and waits instead of racing its own clock — turnCounter
        // dedupes/orders those messages, and the passiveWait watchdog forces a
        // local advance if the message never arrives (opponent hung/vanished).
        this.turnCounter = 0;
        this.passiveWait = 0;
        this.localFallback = false;
    }

    reset() {
        this.currentTeamIndex = 0;
        this.currentKoalaIndex = 0;
        this.turnTime = this.defaultTurnTime;
        this.turnTimer = this.turnTime;
        this.phase = 'waiting';
        this.countdownTimer = 0;
        this.retreatTimer = 0;
        this.projectileGraceTimer = 0;
        this.suddenDeathActive = false;
        this.elapsedGameTime = 0;
        this.roundNumber = 1;
        this.lastTeamIndex = -1;
        this.turnCounter = 0;
        this.passiveWait = 0;
        this.localFallback = false;
    }

    /**
     * True when this client is NOT the owner of the current turn in a
     * multiplayer game. Passive clients don't end turns on their own clock —
     * they follow the turn owner's 'turnStart' announcements.
     */
    isPassiveClient() {
        return !!(this.game.networkManager && !this.game.isPractice && !this.game.isMyTurn());
    }

    startTurn() {
        this.phase = 'aiming';
        this.turnCounter++;
        this.passiveWait = 0;
        this.localFallback = false;

        // Advance the round counter and trigger sudden death if it's time.
        // Done before turnTimer is set so a freshly-activated sudden death can
        // shorten this very turn.
        this.trackRoundProgress();

        this.turnTimer = this.turnTime;
        this.game.randomizeWind();
        this.game.shotgunShotsRemaining = 0; // Reset multi-shot counter

        // Update timer display
        const timerEl = this.game.dom.elements.turnTimer;
        if (timerEl) {
            timerEl.textContent = Math.ceil(this.turnTimer);
            timerEl.classList.remove('low-time', 'retreat-mode');
        }

        // Keep the soundtrack matched to the current game mode. This is the
        // single source of truth for in-game music: battle normally, sudden
        // death once it kicks in.
        const desiredTheme = this.suddenDeathActive ? 'suddenDeath' : 'battle';
        if (globalAudioManager.currentTheme !== desiredTheme) {
            globalAudioManager.playTheme(desiredTheme);
        }
        this.game.audioManager.playTurnStart();

        // Stow any parachutes left deployed from the previous turn
        for (const t of this.game.teams) {
            for (const k of t.koalas) {
                k.parachuteActive = false;
                k.parachuteDeployed = false;
            }
        }

        // Switch to current team's inventory
        const team = this.game.teams[this.currentTeamIndex];
        if (team && team.weapons) {
            // Swap inventory
            this.game.weaponManager.weapons = team.weapons;

            // Select the team's last used weapon, or default to bazooka
            // (must have ammo AND not still be scheme-delay locked)
            const lastWeaponId = team.lastSelectedWeapon || 'bazooka';
            const lastWeapon = team.weapons[lastWeaponId];
            if (lastWeapon && lastWeapon.ammo > 0 && this.game.isWeaponAvailable(lastWeapon)) {
                this.game.weaponManager.selectWeapon(lastWeaponId);
            } else {
                this.game.weaponManager.selectWeapon('bazooka');
            }
        }

        // Find next alive koala
        this.selectNextKoala();

        const koala = this.game.getCurrentKoala();
        if (koala) {
            // Center camera on current koala
            this.game.camera.targetX = koala.x - this.game.canvas.width / 2;
            this.game.camera.targetY = koala.y - this.game.canvas.height / 2;

            // Update UI
            this.game.updateTurnIndicator();
            this.game.updateWeaponUI();
        }

        // (The per-turn state sync now travels in the 'turnStart' message sent
        // by whichever client drove the turn transition — see nextTurn().)

        // Check for loot crate spawn
        if (this.game.isPractice || (this.game.networkManager && this.game.networkManager.isHost)) {
            this.game.lootManager.onTurnStart();
        }
    }

    /**
     * Advance the round counter and flip on sudden death once enough rounds
     * have been played. Runs on every client from startTurn() — both the local
     * and remote turn paths reach startTurn with currentTeamIndex already set —
     * so the count stays identical across the network.
     */
    trackRoundProgress() {
        // A round completes whenever play wraps back to an earlier team slot
        // (e.g. last team -> first team). Dead teams are skipped, but the index
        // only ever decreases on a wrap, so this still holds. When it happens,
        // every team has had the same number of turns this round.
        const roundCompleted = this.currentTeamIndex <= this.lastTeamIndex;
        if (roundCompleted) {
            this.roundNumber++;
        }
        this.lastTeamIndex = this.currentTeamIndex;

        // Start sudden death only at a round boundary (so everyone has had equal
        // turns) once the predetermined amount of game time has elapsed.
        if (!this.suddenDeathActive && roundCompleted &&
            this.elapsedGameTime >= this.suddenDeathTime) {
            this.activateSuddenDeath();
        }
    }

    /**
     * Kick off sudden death: shorter turns, every survivor knocked down to the
     * health cap, music switch (handled by startTurn) and an on-screen banner.
     */
    activateSuddenDeath() {
        this.suddenDeathActive = true;
        console.log(`💀 SUDDEN DEATH! (round ${this.roundNumber}, ${Math.floor(this.elapsedGameTime)}s elapsed)`);

        // Turns get shorter from here on — no more stalling.
        this.turnTime = Math.min(this.turnTime, 20);

        // Knock every surviving koala down to the sudden-death cap. This is
        // deterministic (same koalas, same cap on every client), and the active
        // player's full-state sync later in startTurn confirms the same values.
        for (const team of this.game.teams) {
            for (const koala of team.koalas) {
                if (koala.isAlive && koala.health > this.suddenDeathHealthCap) {
                    koala.health = this.suddenDeathHealthCap;
                }
            }
        }
        this.game.updateTeamHealth();

        this.game.announceSuddenDeath();
    }

    /**
     * Ongoing sudden-death pressure, applied once per turn from processDamage():
     * the water creeps up the map and every surviving koala takes poison damage.
     * Any deaths that result are handled by the normal death sweep that follows
     * in processDamage(), and drowning from the risen water is caught during the
     * settle wait — so this only needs to mutate health and the water level.
     */
    applySuddenDeathEscalation() {
        // Water surface climbs (smaller Y = higher water), down to a floor so a
        // long stalemate never swallows the entire map.
        const waterFloor = this.game.worldHeight * 0.4;
        this.game.waterLevel = Math.max(waterFloor, this.game.waterLevel - this.waterRisePerTurn);

        // Poison: drain a little health from everyone still standing.
        for (const team of this.game.teams) {
            for (const koala of team.koalas) {
                if (koala.isAlive) {
                    koala.health = Math.max(0, koala.health - this.suddenDeathDecay);
                    this.game.createFloatingText(koala.x, koala.y - 40, `-${this.suddenDeathDecay}`, '#9be36b');
                }
            }
        }
        this.game.updateTeamHealth();
    }

    selectNextKoala() {
        const team = this.game.teams[this.currentTeamIndex];

        if (!team || !team.isAlive()) {
            console.warn('selectNextKoala: Team is dead, should have been skipped');
            return;
        }

        let found = false;
        for (let i = 0; i < team.koalas.length; i++) {
            const idx = (team.currentKoalaIndex + i) % team.koalas.length;
            if (team.koalas[idx].isAlive) {
                this.currentKoalaIndex = idx;
                team.currentKoalaIndex = idx;
                found = true;
                console.log(`🐨 Selected ${team.name} koala ${idx}: ${team.koalas[idx].name}`);
                break;
            }
        }

        if (!found) {
            console.error('selectNextKoala: No alive koala found but team.isAlive() was true!');
        }
    }

    nextTeam() {
        const prevTeam = this.currentTeamIndex;

        const finishedTeam = this.game.teams[this.currentTeamIndex];
        if (finishedTeam) {
            finishedTeam.currentKoalaIndex = (this.currentKoalaIndex + 1) % finishedTeam.koalas.length;

            // Crate buffs (double damage / low gravity / fast walk) last
            // until the collecting team's turn is over
            finishedTeam.buffs = {};
        }

        const startTeam = this.currentTeamIndex;
        do {
            this.currentTeamIndex = (this.currentTeamIndex + 1) % this.game.teams.length;
        } while (!this.game.teams[this.currentTeamIndex].isAlive() &&
            this.currentTeamIndex !== startTeam);

        this.currentKoalaIndex = this.game.teams[this.currentTeamIndex].currentKoalaIndex;

        console.log(`🔄 Turn: ${this.game.teams[prevTeam].name} → ${this.game.teams[this.currentTeamIndex].name}`);
    }

    endTurn() {
        // Clear any in-progress charging/blowtorch so the power bar
        // doesn't stay stuck on screen when a turn ends mid-action
        this.game.cleanupTurnInputState();
        this.phase = 'damage';
        this.processDamage();
    }

    nextTurn() {
        this.nextTeam();
        this.startTurn();

        // The client that drove this transition (the previous turn's owner, or
        // the fallback watchdog) is authoritative for the new turn's opening
        // state — announce it so the peer advances in lockstep with corrected
        // health/positions/ammo/wind instead of racing its own clock.
        if (this.game.networkManager && !this.game.isPractice) {
            this.game.sendTurnStartSync();
        }
    }

    processDamage() {
        // PASSIVE CLIENT: park here. The turn owner runs the real
        // damage/settle/next-turn sequence and announces the result via
        // 'turnStart'; ending the turn on our own (skewed) clock is what
        // caused double turns and blocked/duplicated actions.
        if (this.isPassiveClient() && !this.localFallback) {
            return;
        }
        // Sudden death tightens the screws each turn (poison + rising water)
        // before we tally up who died this turn.
        if (this.suddenDeathActive) {
            this.applySuddenDeathEscalation();
        }

        let anyDied = false;
        for (const team of this.game.teams) {
            for (const koala of team.koalas) {
                if (koala.health <= 0 && koala.isAlive) {
                    koala.die();
                    this.game.audioManager.playDeath();
                    this.game.createDeathEffect(koala);
                    anyDied = true;
                }
            }
        }

        this.game.updateTeamHealth();

        const aliveTeams = this.game.teams.filter(t => t.isAlive());
        if (aliveTeams.length <= 1) {
            this.game.endGame(aliveTeams[0] || null);
            return;
        }

        // Wait for knocked-back koalas to actually land before handing over
        // the turn (with a hard timeout), instead of switching mid-flight
        this.settleWaitElapsed = 0;
        this.settleForTurn = this.turnCounter;
        this.game.scheduleDelayedAction(anyDied ? 1000 : 300, () => this.waitForSettle());
    }

    /**
     * Poll until all koalas have settled (or a timeout passes), then next turn
     */
    waitForSettle() {
        if (this.game.isGameOver) return;
        // A newer turn already started (e.g. a turnStart arrived from the
        // peer while this chain was pending) — don't advance a second time
        if (this.settleForTurn !== this.turnCounter) return;

        const waterLevel = this.game.waterLevel;
        const allSettled = this.game.teams.every(team =>
            team.koalas.every(k => !k.isAlive || k.onGround || k.y > waterLevel)
        );

        this.settleWaitElapsed = (this.settleWaitElapsed || 0) + 0.25;

        if (allSettled || this.settleWaitElapsed > 3) {
            this.applyFallDamage();

            // Late fall damage / drowning during settling may have killed someone
            for (const team of this.game.teams) {
                for (const koala of team.koalas) {
                    if (koala.health <= 0 && koala.isAlive) {
                        koala.die();
                        this.game.audioManager.playDeath();
                        this.game.createDeathEffect(koala);
                    }
                }
            }
            this.game.updateTeamHealth();

            const aliveTeams = this.game.teams.filter(t => t.isAlive());
            if (aliveTeams.length <= 1) {
                this.game.endGame(aliveTeams[0] || null);
                return;
            }

            this.nextTurn();
        } else {
            this.game.scheduleDelayedAction(250, () => this.waitForSettle());
        }
    }

    applyFallDamage() {
        for (const team of this.game.teams) {
            for (const koala of team.koalas) {
                // Physics.js now applies fall damage INSTANTLY upon landing.
                // Physics.js also handles ring-out deaths.
                // Therefore, TurnManager only needs to reset the fall tracking variables
                // at the end of the turn to prepare for the next.
                koala.fallDistance = 0;
                koala.maxFallDistance = 0;
                koala.peakY = koala.y;
            }
        }
        // Force one last UI update just in case health changed right at turn end
        this.game.updateTeamHealth();
    }

    updateTurnTimer(dt) {
        if (this.game.isGameOver) return;

        // Count down turn timer
        this.turnTimer -= dt;

        // Update UI
        const timerEl = this.game.dom.elements.turnTimer;
        if (timerEl) {
            timerEl.textContent = Math.ceil(this.turnTimer);

            if (this.turnTimer <= 5 && !timerEl.classList.contains('low-time')) {
                timerEl.classList.add('low-time');
                // Note: this is just the per-turn "last 5 seconds" warning. The visual
                // low-time class plus the per-second beep (Game.playTimerTick) convey it.
                // Do NOT switch the background theme here — doing so flipped the soundtrack
                // between battle and sudden-death on every turn.
            }
        }

        // Time up?
        if (this.turnTimer <= 0) {
            if (this.isPassiveClient()) {
                // Not our turn to end: freeze at zero and let the turn owner
                // call it (their timer may be a moment behind ours). The
                // watchdog forces a local advance if they never do.
                this.turnTimer = 0;
                this.passiveWait += dt;
                if (this.passiveWait > 10) {
                    console.warn('⚠️ Turn owner never ended the turn — forcing local turn end');
                    this.passiveWait = 0;
                    this.localFallback = true;
                    this.endTurn();
                }
                return;
            }
            console.log('⏰ Time is up!');
            this.endTurn();
        }
    }

    /**
     * Watchdog while a passive client is parked in the damage phase waiting
     * for the turn owner's 'turnStart'. Called from Game.update. If the
     * message never comes (owner hung, message lost), advance locally using
     * the old deterministic path so the game can't soft-lock.
     */
    updatePassiveWatchdog(dt) {
        if (!this.isPassiveClient() || this.localFallback) return;
        this.passiveWait += dt;
        if (this.passiveWait > 12) {
            console.warn('⚠️ No turnStart from turn owner — advancing locally (fallback)');
            this.passiveWait = 0;
            this.localFallback = true;
            this.processDamage();
        }
    }

    startRetreat() {
        this.phase = 'retreat';
        this.retreatTimer = this.retreatTime;

        // Update UI
        const timerEl = this.game.dom.elements.turnTimer;
        if (timerEl) {
            timerEl.classList.add('retreat-mode');
            timerEl.textContent = Math.ceil(this.retreatTimer);
        }

        console.log('🏃 Retreat phase started!');
    }

    updateRetreat(dt) {
        if (this.game.isGameOver) return;

        this.retreatTimer -= dt;

        // Update UI
        const timerEl = this.game.dom.elements.turnTimer;
        if (timerEl) {
            timerEl.textContent = Math.ceil(this.retreatTimer);
        }

        // End retreat when time is up
        if (this.retreatTimer <= 0) {
            // Before ending retreat, see if any projectiles are still active
            // If they are, switch back to 'projectile' phase until they land.
            // Use hasBlockingProjectiles (not length) so inert map hazards like
            // resting landmines/duds don't bounce us back and loop retreat.
            if (this.game.hasBlockingProjectiles()) {
                this.phase = 'projectile';
            } else if (this.isPassiveClient() && !this.localFallback) {
                // The turn owner ends its own retreat and announces the next
                // turn — hold here and wait (watchdog recovers if they don't)
                this.retreatTimer = 0;
                this.passiveWait += dt;
                if (this.passiveWait > 8) {
                    console.warn('⚠️ Turn owner never ended retreat — forcing local turn end');
                    this.passiveWait = 0;
                    this.localFallback = true;
                    this.endTurn();
                }
            } else {
                this.endTurn();
            }
        }
    }
}
