/**
 * Menu Manager - Handles UI screens and transitions
 */

export class MenuManager {
    constructor() {
        this.screens = {
            menu: document.getElementById('menu-screen'),
            lobby: document.getElementById('lobby-screen'),
            game: document.getElementById('game-screen'),
            gameover: document.getElementById('gameover-screen'),
            editor: document.getElementById('editor-screen')
        };

        this.currentScreen = 'menu';
        this.players = [];
    }

    /**
     * Show a specific screen
     */
    showScreen(screenId) {
        // Remove .active from all screens
        for (const screen of Object.values(this.screens)) {
            screen.classList.remove('active');
        }

        // Add .active to target screen
        const id = screenId.replace('-screen', '');
        if (this.screens[id]) {
            this.screens[id].classList.add('active');
            this.currentScreen = id;
        }
    }

    /**
     * Show main menu
     */
    showMenu() {
        this.showScreen('menu');

        // Reset join panel
        document.getElementById('join-panel').classList.add('hidden');
        document.getElementById('room-code-input').value = '';
    }

    /**
     * Show lobby screen
     */
    showLobby(roomCode, isHost) {
        this.showScreen('lobby');

        // Update room code display
        document.getElementById('room-code-display').textContent = roomCode;

        // Show/hide host controls
        const hostControls = document.getElementById('host-controls');
        if (hostControls) {
            hostControls.classList.toggle('hidden', !isHost);
        }

        // Clear player lists
        document.getElementById('team-red-list').innerHTML = '';
        document.getElementById('team-blue-list').innerHTML = '';
        this.players = [];
    }

    /**
     * Add a player to the lobby
     */
    addPlayer(player, team) {
        this.players.push({ ...player, team });

        const listId = team === 'red' ? 'team-red-list' : 'team-blue-list';
        const list = document.getElementById(listId);

        const li = document.createElement('li');
        li.id = `player-${player.id}`;
        li.innerHTML = `
            <span class="player-icon">🐨</span>
            <span class="player-name">${player.name}</span>
        `;
        list.appendChild(li);

        this.updateStartButton();
    }

    /**
     * Remove a player from the lobby
     */
    removePlayer(playerId) {
        this.players = this.players.filter(p => p.id !== playerId);

        const li = document.getElementById(`player-${playerId}`);
        if (li) {
            li.remove();
        }

        this.updateStartButton();
    }

    /**
     * Set player ready status
     */
    setPlayerReady(playerId, ready) {
        const player = this.players.find(p => p.id === playerId);
        if (player) {
            player.ready = ready;
        }

        const li = document.getElementById(`player-${playerId}`);
        if (li) {
            li.classList.toggle('ready', ready);
        }

        this.updateStartButton();
    }

    /**
     * Update start button state
     */
    updateStartButton() {
        const btn = document.getElementById('btn-start-game');
        if (!btn) return;

        // Need at least 2 players, all ready
        const canStart = this.players.length >= 2 &&
            this.players.every(p => p.ready);

        btn.disabled = !canStart;
    }

    /**
     * Show game over screen
     */
    showGameOver(result) {
        this.showScreen('gameover');

        const winnerText = document.getElementById('winner-text');
        if (winnerText) {
            if (result.winner) {
                winnerText.textContent = `🏆 ${result.winner.name} Wins!`;
                winnerText.style.color = result.winner.color;
            } else {
                winnerText.textContent = '🤝 Draw!';
                winnerText.style.color = '#f1c40f';
            }
        }

        // Update stats
        const damageEl = document.getElementById('stat-damage');
        const killsEl = document.getElementById('stat-kills');

        if (damageEl) damageEl.textContent = result.stats?.totalDamage || 0;
        if (killsEl) killsEl.textContent = result.stats?.totalKills || 0;
    }
}
