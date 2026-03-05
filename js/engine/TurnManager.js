import { EventEmitter } from '../utils/EventEmitter.js';

export class TurnManager extends EventEmitter {
    constructor(game) {
        super();
        this.game = game;

        this.currentTeamIndex = 0;
        this.currentKoalaIndex = 0;

        this.turnTime = 30;
        this.turnTimer = this.turnTime;

        this.phase = 'waiting'; // waiting, aiming, firing, projectile, retreat, damage, nextTurn
        this.countdownTimer = 0;

        this.retreatTime = 5;
        this.retreatTimer = 0;

        // Grace period after firing
        this.projectileGraceTimer = 0;
    }

    reset() {
        this.currentTeamIndex = 0;
        this.currentKoalaIndex = 0;
        this.turnTimer = this.turnTime;
        this.phase = 'waiting';
        this.countdownTimer = 0;
        this.retreatTimer = 0;
        this.projectileGraceTimer = 0;
    }

    startTurn() {
        this.phase = 'aiming';
        this.turnTimer = this.turnTime;
        this.game.randomizeWind();
        this.game.shotgunShotsRemaining = 0; // Reset multi-shot counter

        // Update timer display
        const timerEl = document.getElementById('turn-timer');
        if (timerEl) {
            timerEl.textContent = Math.ceil(this.turnTimer);
            timerEl.classList.remove('low-time', 'retreat-mode');
        }

        // Play turn start sound
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
        this.phase = 'damage';
        this.processDamage();
    }

    nextTurn() {
        this.nextTeam();
        this.selectNextKoala();
        this.startTurn();
    }

    processDamage() {
        let anyDied = false;
        for (const team of this.game.teams) {
            for (const koala of team.koalas) {
                if (koala.health <= 0 && koala.isAlive) {
                    koala.die();
                    this.game.audioManager.playDeath();
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

        this.game.scheduleDelayedAction(anyDied ? 1000 : 300, () => {
            this.applyFallDamage();
            this.nextTurn();
        });
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
        const timerEl = document.getElementById('turn-timer');
        if (timerEl) {
            timerEl.textContent = Math.ceil(this.turnTimer);

            if (this.turnTimer <= 5 && !timerEl.classList.contains('low-time')) {
                timerEl.classList.add('low-time');
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
        const timerEl = document.getElementById('turn-timer');
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
        const timerEl = document.getElementById('turn-timer');
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
