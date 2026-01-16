/**
 * Menu Manager - Handles UI screens and transitions
 */

import { MapManager } from '../utils/MapManager.js';

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

        // Reset panels
        document.getElementById('join-panel').classList.add('hidden');
        document.getElementById('host-panel').classList.add('hidden');
        document.querySelector('.menu-buttons').classList.remove('hidden');
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

        // Reset ready button
        const btnReady = document.getElementById('btn-ready');
        if (btnReady) {
            btnReady.textContent = 'Ready!';
            btnReady.classList.remove('success');
        }
    }

    /**
     * Add a player to the lobby (alias for addPlayer)
     */
    addPlayerToLobby(player, team) {
        this.addPlayer(player, team);
    }

    /**
     * Add a player to the lobby
     */
    addPlayer(player, team) {
        // Prevent duplicates
        if (this.players.find(p => p.id === player.id)) {
            return;
        }

        this.players.push({ ...player, team, ready: false });

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
     * Update player ready status (alias for setPlayerReady)
     */
    updatePlayerReady(playerId, ready) {
        this.setPlayerReady(playerId, ready);
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
        const playerCount = this.players.length;
        const readyCount = this.players.filter(p => p.ready).length;
        const canStart = playerCount >= 2 && readyCount === playerCount;

        console.log(`🎮 Start button check: ${readyCount}/${playerCount} ready, canStart: ${canStart}`);

        btn.disabled = !canStart;

        // Update button text to show status
        if (playerCount < 2) {
            btn.textContent = 'Waiting for players...';
        } else if (readyCount < playerCount) {
            btn.textContent = `Waiting (${readyCount}/${playerCount} ready)`;
        } else {
            btn.textContent = 'Start Game';
        }
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

        // Track selected map
        let selectedMapId = 'default';

        // Function to render the map list
        const renderMapList = () => {
            // Get fresh map list from storage
            const currentMaps = MapManager.getAllMaps();

            // Update the maps array reference
            maps.length = 0;
            currentMaps.forEach(m => maps.push(m));

            // Clear existing custom maps (keep default)
            const defaultCard = list.querySelector('[data-map-id="default"]');
            list.innerHTML = '';
            if (defaultCard) {
                list.appendChild(defaultCard);
            }

            // Populate custom maps
            currentMaps.forEach((map, index) => {
                const card = document.createElement('div');
                card.className = 'map-card';
                card.dataset.mapId = index;
                card.dataset.mapName = map.name;
                card.innerHTML = `
                    <div class="map-preview" style="background-image: url(${map.terrain})"></div>
                    <span class="map-name">${map.name}</span>
                    <button class="map-delete-btn" data-map-name="${map.name}" title="Delete Map">🗑️</button>
                `;
                list.appendChild(card);
            });
        };

        // Initial render
        renderMapList();

        // Track the map pending deletion
        let pendingDeleteMapName = null;

        // Get the delete confirmation modal elements
        const deleteModal = document.getElementById('delete-confirm-modal');
        const deleteMapNameEl = document.getElementById('delete-map-name');
        const btnDeleteCancel = document.getElementById('btn-delete-cancel');
        const btnDeleteConfirm = document.getElementById('btn-delete-confirm');

        // Show delete confirmation modal
        const showDeleteConfirm = (mapName) => {
            pendingDeleteMapName = mapName;
            deleteMapNameEl.textContent = `"${mapName}"`;
            deleteModal.classList.remove('hidden');
        };

        // Hide delete confirmation modal
        const hideDeleteConfirm = () => {
            deleteModal.classList.add('hidden');
            pendingDeleteMapName = null;
        };

        // Cancel delete button
        btnDeleteCancel.onclick = () => {
            hideDeleteConfirm();
        };

        // Confirm delete button
        btnDeleteConfirm.onclick = () => {
            if (pendingDeleteMapName) {
                MapManager.deleteMap(pendingDeleteMapName);
                renderMapList();
            }
            hideDeleteConfirm();
        };

        // Use event delegation for all clicks on the list
        list.onclick = (e) => {
            // Check if a delete button was clicked
            const deleteBtn = e.target.closest('.map-delete-btn');
            if (deleteBtn) {
                e.stopPropagation();
                e.preventDefault();

                const mapName = deleteBtn.dataset.mapName;
                if (mapName) {
                    showDeleteConfirm(mapName);
                }
                return;
            }

            // Check if a card was clicked (for selection)
            const card = e.target.closest('.map-card');
            if (card) {
                // Deselect all
                list.querySelectorAll('.map-card').forEach(c => c.classList.remove('selected'));
                // Select this one
                card.classList.add('selected');
                selectedMapId = card.dataset.mapId;
            }
        };

        // Button handlers
        document.getElementById('btn-map-select-cancel').onclick = () => {
            modal.classList.add('hidden');
            hideDeleteConfirm(); // Also close delete modal if open
        };

        document.getElementById('btn-map-select-confirm').onclick = () => {
            modal.classList.add('hidden');
            hideDeleteConfirm(); // Also close delete modal if open
            const selectedCard = list.querySelector('.map-card.selected');
            callback(selectedCard ? selectedCard.dataset.mapId : 'default');
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
