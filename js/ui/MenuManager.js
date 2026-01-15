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
            editor: document.getElementById('editor-screen'),
            mapSelect: document.getElementById('map-select-modal'),
            mapName: document.getElementById('map-name-modal')
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

    /**
     * Show map selection modal
     */
    showMapSelection(maps, callback) {
        const modal = this.screens.mapSelect;
        const list = document.getElementById('map-list');
        modal.classList.remove('hidden');

        // Clear existing custom maps (keep default)
        const defaultCard = list.querySelector('[data-map-id="default"]');
        list.innerHTML = '';
        list.appendChild(defaultCard);

        // Populate custom maps
        maps.forEach((map, index) => {
            const card = document.createElement('div');
            card.className = 'map-card';
            card.dataset.mapId = index;
            card.innerHTML = `
                <div class="map-preview" style="background-image: url(${map.terrain})"></div>
                <span class="map-name">${map.name}</span>
            `;
            list.appendChild(card);
        });

        // Selection logic
        let selectedMapId = 'default';
        const cards = list.querySelectorAll('.map-card');
        cards.forEach(card => {
            card.onclick = () => {
                cards.forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                selectedMapId = card.dataset.mapId;
            };
        });

        // Button handlers
        document.getElementById('btn-map-select-cancel').onclick = () => {
            modal.classList.add('hidden');
        };

        document.getElementById('btn-map-select-confirm').onclick = () => {
            modal.classList.add('hidden');
            callback(selectedMapId);
        };
    }

    /**
     * Update current map name in lobby
     */
    updateLobbyMapName(name) {
        const el = document.getElementById('current-map-name');
        if (el) el.textContent = name;
    }

    /**
     * Show map naming modal
     */
    showMapNaming(callback) {
        const modal = this.screens.mapName;
        const input = document.getElementById('map-name-input');
        const btnSave = document.getElementById('btn-map-name-save');
        const btnCancel = document.getElementById('btn-map-name-cancel');

        modal.classList.remove('hidden');
        input.value = '';
        input.focus();

        btnCancel.onclick = () => {
            modal.classList.add('hidden');
        };

        btnSave.onclick = () => {
            const name = input.value.trim() || 'Untitled Map';
            modal.classList.add('hidden');
            callback(name);
        };

        // Enter key to save
        input.onkeypress = (e) => {
            if (e.key === 'Enter') {
                btnSave.click();
            }
        };
    }
}
