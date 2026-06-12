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
    }

    startTurn() {
        this.phase = 'aiming';

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

        // Switch to current team's inventory
        const team = this.game.teams[this.currentTeamIndex];
        if (team && team.weapons) {
            // Swap inventory
            this.game.weaponManager.weapons = team.weapons;

            // Select the team's last used weapon, or default to bazooka
            const lastWeaponId = team.lastSelectedWeapon || 'bazooka';
            if (team.weapons[lastWeaponId] && team.weapons[lastWeaponId].ammo > 0) {
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

        // NETWORK SYNC: Send full state sync at start of turn
        if (this.game.networkManager && !this.game.isPractice && this.game.isMyTurn()) {
            this.game.sendFullStateSync();
        }

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
    }

    processDamage() {
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
        this.game.scheduleDelayedAction(anyDied ? 1000 : 300, () => this.waitForSettle());
    }

    /**
     * Poll until all koalas have settled (or a timeout passes), then next turn
     */
    waitForSettle() {
        if (this.game.isGameOver) return;

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
            console.log('⏰ Time is up!');
            this.endTurn();
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
            // If they are, switch back to 'projectile' phase until they land
            if (this.game.projectiles.length > 0) {
                this.phase = 'projectile';
            } else {
                this.endTurn();
            }
        }
    }
}
