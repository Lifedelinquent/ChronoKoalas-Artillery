/**
 * Koala Artillery - Main Entry Point
 * Multiplayer turn-based artillery game
 */

import { Game } from './engine/Game.js';
import { MenuManager } from './ui/MenuManager.js';
import { NetworkManager } from './network/NetworkManager.js';
import { MapEditor } from './editor/MapEditor.js';
import { MapManager } from './utils/MapManager.js';
import { globalAudioManager } from './engine/AudioManager.js';

// Global game instance
let game = null;
let menuManager = null;
let networkManager = null;
let mapEditor = null;

/**
 * Initialize the application
 */
async function init() {
    console.log('🐨 Koala Artillery initializing...');

    // Migrate any maps saved in the old localStorage format → IndexedDB
    await MapManager.migrateFromLocalStorage();

    // Initialize managers
    menuManager = new MenuManager();
    networkManager = new NetworkManager();

    // Set up menu event handlers
    setupMenuHandlers();

    // Set up global audio controls
    setupGlobalAudioControls();

    // Process logo to remove checkerboard background
    processLogo();

    console.log('✓ Initialization complete');
}

/**
 * Process the logo to remove fake checkerboard background
 */
function processLogo() {
    const img = document.querySelector('.game-logo');
    if (!img) return;

    // We need to wait for the image to load
    if (img.complete) {
        cleanImage(img);
    } else {
        img.onload = () => cleanImage(img);
    }
}

/**
 * Clean checkerboard background from image
 */
function cleanImage(img) {
    // Prevent double processing
    if (img.dataset.processed) return;

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');

    ctx.drawImage(img, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // Sample checkerboard colors
    // Top-left pixel
    const bg1 = { r: data[0], g: data[1], b: data[2] };

    // Pixel offset by a bit (likely the other square of checkerboard)
    // Try diagonal offset of 20px
    const idx2 = (20 * canvas.width + 20) * 4;
    const bg2 = { r: data[idx2], g: data[idx2 + 1], b: data[idx2 + 2] };

    const tolerance = 60; // Generous tolerance

    // Helper: color match
    const matches = (r, g, b, bg) => {
        return Math.abs(r - bg.r) < tolerance &&
            Math.abs(g - bg.g) < tolerance &&
            Math.abs(b - bg.b) < tolerance;
    };

    // Flood fill from corners
    const w = canvas.width;
    const h = canvas.height;
    const visited = new Uint8Array(w * h);
    const queue = [];

    const add = (x, y) => {
        if (x >= 0 && x < w && y >= 0 && y < h) queue.push(y * w + x);
    };

    // Start from all 4 corners
    add(0, 0); add(w - 1, 0); add(0, h - 1); add(w - 1, h - 1);

    while (queue.length > 0) {
        const idx = queue.pop();
        if (visited[idx]) continue;
        visited[idx] = 1;

        const i = idx * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        // If this pixel matches EITHER of the checkerboard colors
        if (matches(r, g, b, bg1) || matches(r, g, b, bg2)) {
            data[i + 3] = 0; // Erase

            // Expand
            const x = idx % w;
            const y = Math.floor(idx / w);
            add(x + 1, y); add(x - 1, y); add(x, y + 1); add(x, y - 1);
        }
    }

    ctx.putImageData(imageData, 0, 0);
    img.src = canvas.toDataURL();
    img.dataset.processed = "true";
}

/**
 * Set up menu button handlers
 */
function setupMenuHandlers() {
    const btnHost = document.getElementById('btn-host');
    const btnJoin = document.getElementById('btn-join');
    const btnPractice = document.getElementById('btn-practice');
    const btnConnect = document.getElementById('btn-connect');
    const btnReady = document.getElementById('btn-ready');
    const btnLeave = document.getElementById('btn-leave');
    const btnStartGame = document.getElementById('btn-start-game');
    const btnRematch = document.getElementById('btn-rematch');
    const btnMainMenu = document.getElementById('btn-main-menu');
    const joinPanel = document.getElementById('join-panel');
    const hostPanel = document.getElementById('host-panel');
    const menuButtons = document.querySelector('.menu-buttons');

    // Currently selected map + game scheme for generic start
    window.selectedMap = null;
    window.selectedScheme = null;

    // Host Game - create the room, then sit in the lobby while up to 3
    // guests join (the room code is shown in the lobby header)
    btnHost.addEventListener('click', async () => {
        // Hide menu buttons, show host panel while the room is created
        menuButtons.classList.add('hidden');
        hostPanel.classList.remove('hidden');
        joinPanel.classList.add('hidden');

        const hostStatus = document.getElementById('host-status');
        const hostRoomCode = document.getElementById('host-room-code');

        hostStatus.textContent = 'Creating room...';
        hostStatus.className = 'connection-status connecting';

        try {
            const roomCode = await networkManager.hostGame();
            if (roomCode) {
                hostRoomCode.textContent = roomCode;
                // Straight to the lobby — guests appear as they connect
                hostPanel.classList.add('hidden');
                menuButtons.classList.remove('hidden');
                menuManager.showLobby(roomCode, true);
                renderLobby();
            }
        } catch (error) {
            hostStatus.textContent = 'Failed to create room. Try again.';
            hostStatus.className = 'connection-status error';
        }
    });

    // Copy room code button
    const btnCopyCode = document.getElementById('btn-copy-code');
    if (btnCopyCode) {
        btnCopyCode.addEventListener('click', () => {
            const code = document.getElementById('host-room-code').textContent;
            navigator.clipboard.writeText(code).then(() => {
                btnCopyCode.textContent = '✓';
                btnCopyCode.classList.add('copied');
                setTimeout(() => {
                    btnCopyCode.textContent = '📋';
                    btnCopyCode.classList.remove('copied');
                }, 2000);
            });
        });
    }

    // Cancel hosting
    const btnCancelHost = document.getElementById('btn-cancel-host');
    if (btnCancelHost) {
        btnCancelHost.addEventListener('click', () => {
            networkManager.cancel();
            hostPanel.classList.add('hidden');
            menuButtons.classList.remove('hidden');
        });
    }

    // Join Game - Show input panel
    btnJoin.addEventListener('click', () => {
        menuButtons.classList.add('hidden');
        joinPanel.classList.remove('hidden');
        hostPanel.classList.add('hidden');

        document.getElementById('join-status').textContent = '';
        document.getElementById('room-code-input').value = '';
        document.getElementById('room-code-input').focus();
    });

    // Cancel joining
    const btnCancelJoin = document.getElementById('btn-cancel-join');
    if (btnCancelJoin) {
        btnCancelJoin.addEventListener('click', () => {
            networkManager.cancel();
            joinPanel.classList.add('hidden');
            menuButtons.classList.remove('hidden');
        });
    }

    // Connect to room
    btnConnect.addEventListener('click', async () => {
        const roomCode = document.getElementById('room-code-input').value.toUpperCase().trim();
        const joinStatus = document.getElementById('join-status');
        const btnCancelJoinEl = document.getElementById('btn-cancel-join');

        if (roomCode.length < 4) {
            joinStatus.textContent = 'Enter a valid room code';
            joinStatus.className = 'connection-status error';
            return;
        }

        joinStatus.textContent = 'Connecting...';
        joinStatus.className = 'connection-status connecting';
        btnConnect.disabled = true;
        btnCancelJoinEl.classList.remove('hidden');

        try {
            await networkManager.joinGame(roomCode);
            // Connection handling is done via events
        } catch (error) {
            joinStatus.textContent = 'Failed to connect. Check the code!';
            joinStatus.className = 'connection-status error';
            btnConnect.disabled = false;
        }
    });

    // Render the lobby from the current authoritative roster
    function renderLobby() {
        menuManager.renderLobbyRoster(
            networkManager.roster,
            networkManager.mySlot,
            networkManager.isHost
        );
        // Keep the ready button label in sync with our roster entry
        const me = networkManager.roster.find(r => r.slot === networkManager.mySlot);
        if (me) {
            btnReady.textContent = me.ready ? 'Not Ready' : 'Ready!';
            btnReady.classList.toggle('success', me.ready);
        }
    }

    // Clicking your colour chip cycles your team colour (= alliance)
    menuManager.onColorCycle = (color) => networkManager.requestColor(color);

    // Network event handlers
    networkManager.on('connected', (data) => {
        console.log('🎮 Connected to host!', data);

        // Mid-game reconnect: resume the paused game instead of showing the
        // lobby. The guest automatically requests a full state sync (terrain,
        // health, ammo, crates) — see NetworkManager's open handler.
        if (game && !game.isGameOver && data.wasReconnect) {
            console.log('🔗 Reconnected mid-game — resuming');
            hideConnectionBanner();
            game.isPaused = false;
            game.lastTime = performance.now();
            return;
        }
        // Fresh guest connection: the lobby appears when 'welcome' arrives
        // with our slot assignment and the current roster.
    });

    // Guest: the host accepted us and told us our seat
    networkManager.on('welcome', (data) => {
        // Mid-game reconnect welcome: stay in the game, don't pop the lobby
        if (data.midGame && game && !game.isGameOver) return;

        menuManager.showLobby(networkManager.roomCode, false);
        renderLobby();

        // Reset UI states
        hostPanel.classList.add('hidden');
        joinPanel.classList.add('hidden');
        menuButtons.classList.remove('hidden');
        btnConnect.disabled = false;
    });

    // Roster changed (join/leave/colour/ready) — rerender if we're in the lobby
    networkManager.on('lobbyUpdate', () => {
        if (menuManager.currentScreen === 'lobby') {
            renderLobby();
        }
    });

    networkManager.on('error', (data) => {
        console.error('Network error:', data.message);

        const hostStatus = document.getElementById('host-status');
        const joinStatus = document.getElementById('join-status');

        if (networkManager.isHost && hostStatus) {
            hostStatus.textContent = data.message;
            hostStatus.className = 'connection-status error';
        } else if (joinStatus) {
            joinStatus.textContent = data.message;
            joinStatus.className = 'connection-status error';
        }

        btnConnect.disabled = false;
    });

    // Guest lost ITS connection to the host
    networkManager.on('disconnected', (data) => {
        console.log('🔌 Disconnected:', data?.reason);

        // Mid-game drop: don't kill the game — NetworkManager is already
        // retrying with backoff. Pause and wait; 'connected' resumes us and
        // 'reconnectFailed' tears down for real.
        if (game && !game.isGameOver && networkManager.roomCode) {
            game.isPaused = true;
            showConnectionBanner('⚠️ Connection lost — reconnecting…');
            return;
        }

        if (game) {
            alert('Connection to the game was lost!');
            game.destroy();
            game = null;
        }
        menuManager.showMenu();
    });

    networkManager.on('reconnectFailed', () => {
        hideConnectionBanner();
        if (game) {
            alert('Lost connection to the game.');
            game.destroy();
            game = null;
        }
        menuManager.showMenu();
    });

    // ---- Another player dropped mid-game (host detects, everyone is told) ----
    // The game pauses for everyone. If they don't come back in time, the host
    // forfeits their squad and play resumes without them.
    const FORFEIT_TIMEOUT_MS = 45000;
    const forfeitTimers = new Map(); // slot -> timeout id (host only)

    function hostForfeitDroppedPlayer(slot) {
        forfeitTimers.delete(slot);
        if (!game || game.isGameOver || !networkManager.isHost) return;

        const teamIndex = networkManager.gamePlayers
            ? networkManager.gamePlayers.findIndex(p => p.slot === slot)
            : -1;
        if (teamIndex < 0) return;

        console.warn(`⏱️ Player in slot ${slot} never returned — forfeiting team ${teamIndex}`);
        networkManager.send({ type: 'teamForfeit', teamIndex });
        game.forfeitTeam(teamIndex);

        hideConnectionBanner();
        game.isPaused = false;
        game.lastTime = performance.now();

        // Only one colour left? Host ends the game (broadcasts gameOver).
        const alive = game.teams.filter(t => t.isAlive());
        if (game.countAliveAlliances(alive) <= 1) {
            game.endGame(alive[0] || null);
            return;
        }

        // If it was the dropped player's turn, the host drives the handover
        if (game.currentTeamIndex === teamIndex) {
            game.turnManager.localFallback = true;
            game.turnManager.processDamage();
        }
    }

    networkManager.on('playerDropped', (data) => {
        console.log('🔌 Player dropped:', data);

        if (game && !game.isGameOver) {
            game.isPaused = true;
            showConnectionBanner(`⚠️ ${data.name || 'A player'} disconnected — waiting for them to return…`);
            if (networkManager.isHost) {
                forfeitTimers.set(data.slot, setTimeout(() => hostForfeitDroppedPlayer(data.slot), FORFEIT_TIMEOUT_MS));
            }
        }
        // In the lobby the host already removed them from the roster and
        // broadcast a lobbyUpdate — nothing more to do here.
    });

    networkManager.on('playerReturned', (data) => {
        console.log('🔗 Player returned:', data);
        if (networkManager.isHost && forfeitTimers.has(data.slot)) {
            clearTimeout(forfeitTimers.get(data.slot));
            forfeitTimers.delete(data.slot);
        }
        if (game && !game.isGameOver) {
            hideConnectionBanner();
            game.isPaused = false;
            game.lastTime = performance.now();
        }
    });

    networkManager.on('remoteTeamForfeit', (data) => {
        console.log('🏳️ Team forfeited:', data);
        if (game && !game.isGameOver) {
            game.forfeitTeam(data.teamIndex);
            hideConnectionBanner();
            game.isPaused = false;
            game.lastTime = performance.now();
        }
    });

    networkManager.on('gameStart', (data) => {
        console.log('🎮 Game starting!', data);
        startGame(false, data.gameState, data.gameState?.customMap);
    });

    // Practice Mode - Start single player
    btnPractice.addEventListener('click', async (e) => {
        e.target.blur(); // Remove focus so spacebar doesn't re-trigger
        const maps = await MapManager.getAllMaps();
        menuManager.showMapSelection(maps, (mapId, scheme) => {
            let customMap = null;
            if (mapId !== 'default') {
                customMap = maps[mapId];
            }
            startGame(true, null, customMap, scheme);
        });
    });

    // Ready toggle
    btnReady.addEventListener('click', () => {
        const isReady = networkManager.toggleReady();
        btnReady.textContent = isReady ? 'Not Ready' : 'Ready!';
        btnReady.classList.toggle('success', !isReady);
    });

    // Leave lobby
    btnLeave.addEventListener('click', () => {
        networkManager.disconnect();
        menuManager.showMenu();
    });

    // Start game (host only)
    btnStartGame.addEventListener('click', () => {
        const options = {
            isPractice: false,
            customMap: window.selectedMap,
            scheme: window.selectedScheme
        };
        networkManager.startGame(options);
    });

    // Change Map & Scheme (Lobby)
    const btnChangeMap = document.getElementById('btn-change-map');
    if (btnChangeMap) {
        btnChangeMap.addEventListener('click', async () => {
            const maps = await MapManager.getAllMaps();
            menuManager.showMapSelection(maps, (mapId, scheme) => {
                let map = null;
                let name = 'Random Map';
                if (mapId !== 'default') {
                    map = maps[mapId];
                    name = map.name;
                }

                window.selectedMap = map;
                window.selectedScheme = scheme;
                menuManager.updateLobbyMapName(name);
                menuManager.updateLobbySchemeName(scheme?.name || 'Classic');

                // Sync with other players
                networkManager.sendMapSelection(map, scheme);
            });
        });
    }

    // Rematch
    btnRematch.addEventListener('click', () => {
        if (!game) return;

        if (game.isPractice || !networkManager.isConnected) {
            // Local rematch - reset in place
            game.reset();
            menuManager.showScreen('game-screen');
        } else if (networkManager.isHost) {
            // Multiplayer rematch must go through the host so both clients
            // restart with the same fresh seed (local reset would desync)
            networkManager.startGame({ customMap: window.selectedMap, scheme: window.selectedScheme });
        } else {
            alert('Only the host can start a rematch.');
        }
    });



    // Main menu
    btnMainMenu.addEventListener('click', () => {
        if (game) {
            game.destroy();
            game = null;
        }
        networkManager.disconnect();
        menuManager.showMenu();
    });

    // Map Editor Button
    const btnEditor = document.getElementById('btn-editor');
    if (btnEditor) {
        btnEditor.addEventListener('click', () => {
            openMapEditor();
        });
    }

    // Editor Back Button
    const btnEditorBack = document.getElementById('btn-editor-back');
    if (btnEditorBack) {
        btnEditorBack.addEventListener('click', () => {
            closeMapEditor();
        });
    }

    // Editor Save Button
    const btnEditorSave = document.getElementById('btn-editor-save');
    if (btnEditorSave) {
        btnEditorSave.addEventListener('click', () => {
            saveMap();
        });
    }

    // Editor Load Button
    const btnEditorLoad = document.getElementById('btn-editor-load');
    if (btnEditorLoad) {
        btnEditorLoad.addEventListener('click', () => {
            loadMap();
        });
    }

    // Editor Test Play Button
    const btnEditorTest = document.getElementById('btn-editor-test');
    if (btnEditorTest) {
        btnEditorTest.addEventListener('click', () => {
            testPlayMap();
        });
    }

    // Editor Import Image Button
    const btnEditorImport = document.getElementById('btn-editor-import');
    if (btnEditorImport) {
        btnEditorImport.addEventListener('click', () => {
            importImageToMap();
        });
    }

    networkManager.on('mapSelected', (data) => {
        window.selectedMap = data.map;
        if (data.scheme) {
            window.selectedScheme = data.scheme;
            menuManager.updateLobbySchemeName(data.scheme.name || 'Classic');
        }
        const name = data.map ? data.map.name : 'Random Map';
        menuManager.updateLobbyMapName(name);
    });

    // Remote game actions (for multiplayer synchronization)
    networkManager.on('remoteFire', (data) => {
        if (game) {
            game.handleRemoteFire(data);
        }
    });

    networkManager.on('remoteMove', (data) => {
        if (game) {
            game.handleRemoteMove(data);
        }
    });

    networkManager.on('remoteAim', (data) => {
        if (game) {
            game.handleRemoteAim(data);
        }
    });

    networkManager.on('remoteTargetWeapon', (data) => {
        if (game) {
            game.handleRemoteTargetWeapon(data);
        }
    });

    networkManager.on('remoteTurnEnd', (data) => {
        if (game) {
            game.handleRemoteTurnEnd(data);
        }
    });

    networkManager.on('remoteExplosionSync', (data) => {
        if (game) {
            game.handleRemoteExplosionSync(data);
        }
    });

    networkManager.on('remoteWeaponSelect', (data) => {
        if (game) {
            game.handleRemoteWeaponSelect(data);
        }
    });

    networkManager.on('remoteJump', (data) => {
        if (game) {
            game.handleRemoteJump(data);
        }
    });

    networkManager.on('remoteHighJump', (data) => {
        if (game) {
            game.handleRemoteHighJump(data);
        }
    });

    networkManager.on('remoteRopeRelease', (data) => {
        if (game) {
            game.handleRemoteRopeRelease(data);
        }
    });

    networkManager.on('remoteStateSync', (data) => {
        if (game) {
            game.handleRemoteStateSync(data);
        }
    });

    networkManager.on('remoteRequestStateSync', (data) => {
        if (game && game.sendFullStateSync) {
            // A peer only asks for this after a reconnect — include the
            // terrain snapshot so they get every crater they missed
            game.sendFullStateSync({ includeTerrain: true });
        }
    });

    networkManager.on('remoteCrateSpawn', (data) => {
        if (game) {
            game.lootManager.handleRemoteCrateSpawn(data);
        }
    });

    networkManager.on('remoteCrateCollected', (data) => {
        if (game) {
            game.lootManager.handleRemoteCrateCollected(data);
        }
    });

    networkManager.on('remoteTurnStart', (data) => {
        if (game) {
            game.handleRemoteTurnStart(data);
        }
    });

    networkManager.on('remoteGameOver', (data) => {
        if (game) {
            game.handleRemoteGameOver(data);
        }
    });
}

/**
 * Small fixed banner for connection status during mid-game reconnects
 */
function showConnectionBanner(text) {
    let el = document.getElementById('connection-banner');
    if (!el) {
        el = document.createElement('div');
        el.id = 'connection-banner';
        el.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);' +
            'background:rgba(20,20,30,0.92);color:#ffd35a;padding:10px 22px;border-radius:8px;' +
            'font-weight:700;z-index:1000;pointer-events:none;';
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.display = 'block';
}

function hideConnectionBanner() {
    const el = document.getElementById('connection-banner');
    if (el) el.style.display = 'none';
}

/**
 * Start the game
 * @param {boolean} isPractice - Single player practice mode
 * @param {Object} networkState - Initial state from network (multiplayer)
 */
function startGame(isPractice = false, networkState = null, customMap = null, scheme = null) {
    const canvas = document.getElementById('game-canvas');

    // Destroy any previous game so we don't leak loops and input listeners
    if (game) {
        game.destroy();
        game = null;
    }

    // Game scheme (all match rules incl. sudden death): network clients take
    // it from the host's game state, otherwise use the map-screen selection.
    const activeScheme = networkState?.scheme ?? scheme ?? window.selectedScheme;

    // Create game instance
    game = new Game(canvas, {
        isPractice,
        networkManager: isPractice ? null : networkManager,
        initialState: networkState,
        customMap: customMap || window.selectedMap,
        scheme: activeScheme
    });

    // Expose game instance globally for debugging/export
    window.game = game;

    // Show game screen
    menuManager.showScreen('game-screen');

    // Start the game
    game.start();

    // Game over handler
    game.on('gameOver', (result) => {
        menuManager.showGameOver(result);
    });
}

/**
 * Set up global audio controls
 */
function setupGlobalAudioControls() {
    const muteBtn = document.getElementById('global-mute-toggle');
    const mixerBtn = document.getElementById('sound-mixer-toggle');
    const panel = document.getElementById('sound-mixer-panel');

    const updateMuteBtn = () => {
        if (!muteBtn) return;
        const muted = globalAudioManager.isMuted;
        muteBtn.textContent = muted ? '🔇' : '🔊';
        muteBtn.classList.toggle('muted', muted);
    };

    // Reflect persisted mute state on load
    updateMuteBtn();

    if (muteBtn) {
        muteBtn.addEventListener('click', () => {
            const isMuted = globalAudioManager.toggleMute();
            updateMuteBtn();
            // Play click if just unmuted
            if (!isMuted) {
                globalAudioManager.playClick();
            }
        });
    }

    if (mixerBtn && panel) {
        mixerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            panel.classList.toggle('hidden');
        });
        // Clicks inside the panel shouldn't close it; clicks anywhere else do
        panel.addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('click', () => panel.classList.add('hidden'));
    }

    for (const slider of document.querySelectorAll('.mixer-slider')) {
        const channel = slider.dataset.channel;
        const valueLabel = panel?.querySelector(`.mixer-value[data-channel="${channel}"]`);

        // Initialize from persisted settings
        slider.value = globalAudioManager.volumes[channel];
        if (valueLabel) {
            valueLabel.textContent = `${Math.round(globalAudioManager.volumes[channel] * 100)}%`;
        }

        slider.addEventListener('input', (e) => {
            const vol = parseFloat(e.target.value);
            globalAudioManager.setCategoryVolume(channel, vol);
            if (valueLabel) {
                valueLabel.textContent = `${Math.round(vol * 100)}%`;
            }
            // Sliding master up while muted auto-unmutes
            if (channel === 'master' && vol > 0 && globalAudioManager.isMuted) {
                globalAudioManager.toggleMute();
                updateMuteBtn();
            }
        });

        // Audible preview on release (music/ambient demo themselves live)
        slider.addEventListener('change', () => {
            if (globalAudioManager.isMuted) return;
            if (channel === 'voice') {
                globalAudioManager.playVoice('gday');
            } else if (channel === 'sfx' || channel === 'master') {
                globalAudioManager.playClick();
            }
        });
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);

// Add global interaction listener to unlock audio on first click
const unlockAudio = () => {
    if (!globalAudioManager.isInitialized) {
        globalAudioManager.init();

        // If music was queued but blocked by autoplay policy, attempt to play it now
        // Force the menu theme if we are on the menu
        if (menuManager && (menuManager.currentScreen === 'menu' || menuManager.currentScreen === 'lobby')) {
            globalAudioManager.playTheme('menu');
        } else if (globalAudioManager.music && globalAudioManager.music.paused) {
            globalAudioManager.playMusic();
        }

        // Remove the listener once unlocked
        document.removeEventListener('click', unlockAudio);
        document.removeEventListener('keydown', unlockAudio);
    }
};

document.addEventListener('click', unlockAudio);
document.addEventListener('keydown', unlockAudio);

// Handle window resize
window.addEventListener('resize', () => {
    if (game) {
        game.handleResize();
    }
});

// Prevent context menu on canvas
document.addEventListener('contextmenu', (e) => {
    if (e.target.id === 'game-canvas' || e.target.id === 'editor-canvas') {
        e.preventDefault();
    }
});

/**
 * Open the Map Editor
 */
function openMapEditor() {
    const canvas = document.getElementById('editor-canvas');

    // Create editor instance if needed
    if (!mapEditor) {
        mapEditor = new MapEditor(canvas);
    }

    // Show editor screen
    menuManager.showScreen('editor-screen');

    // Initialize editor
    mapEditor.init();

    console.log('🗺️ Map Editor opened');
}

/**
 * Close the Map Editor and return to menu
 */
function closeMapEditor() {
    if (mapEditor) {
        mapEditor.destroy();
        mapEditor = null;
    }

    menuManager.showMenu();
    console.log('🗺️ Map Editor closed');
}

/**
 * Test play the current map from the editor
 */
function testPlayMap() {
    if (!mapEditor) {
        console.error('No map editor instance');
        return;
    }

    // Export current map data
    const mapData = mapEditor.exportMap('Test Map');

    // Store the custom map data globally for the game to use
    window.customMapData = mapData;

    // Close editor (but don't destroy mapEditor so we can return to it)
    const editorScreen = document.getElementById('editor-screen');
    if (editorScreen) {
        editorScreen.classList.remove('active');
    }

    // Stop editor render loop
    if (mapEditor.animationId) {
        cancelAnimationFrame(mapEditor.animationId);
        mapEditor.animationId = null;
    }

    // Start a game with the custom map
    startGameWithCustomMap(mapData);

    console.log('🎮 Testing map...');
}

/**
 * Start a game with a custom map from the editor
 */
function startGameWithCustomMap(mapData) {
    startGame(true, null, mapData);
}

/**
 * Save current map to file
 */
function saveMap() {
    if (!mapEditor) return;

    // Use custom naming modal instead of native prompt
    menuManager.showMapNaming(async (mapName) => {
        const mapData = mapEditor.exportMap(mapName);

        // Save to IndexedDB
        try {
            await MapManager.saveMap(mapData);
        } catch (e) {
            // saveMap already alerts the user; just bail out
            return;
        }

        const json = JSON.stringify(mapData, null, 2);

        // Create download link
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${mapName.replace(/[^a-z0-9]/gi, '_')}.koalamap`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log('💾 Map saved:', mapName);
    });
}

/**
 * Load map from file
 */
function loadMap() {
    if (!mapEditor) return;

    // Create file input
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.koalamap,.json';

    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const mapData = JSON.parse(text);
            await mapEditor.importMap(mapData);
            console.log('📂 Map loaded:', mapData.name);
        } catch (err) {
            console.error('Failed to load map:', err);
            alert('Failed to load map file. Make sure it\'s a valid .koalamap file.');
        }
    };

    input.click();
}

/**
 * Import a PNG/image file and convert it to map terrain
 */
function importImageToMap() {
    if (!mapEditor) {
        console.error('No map editor instance');
        return;
    }

    // Create file input for image
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/jpg,image/gif,image/webp';

    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            // Load image
            const img = await loadImageFromFile(file);

            // Import to map editor
            await mapEditor.importImage(img);

            console.log('🖼️ Image imported as terrain:', file.name);
        } catch (err) {
            console.error('Failed to import image:', err);
            alert('Failed to import image. Make sure it\'s a valid image file (PNG, JPG, etc).');
        }
    };

    input.click();
}

/**
 * Load an image from a file
 */
function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Failed to load image'));
            img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
    });
}


/**
 * Export the current game's terrain as a .koalamap file
 * Can be called from browser console: exportCurrentGameMap()
 */
function exportCurrentGameMap(mapName = 'Current Map') {
    if (!game || !game.terrain) {
        console.error('❌ No game running! Start a game first.');
        alert('Start a game first to export the terrain.');
        return;
    }

    const terrain = game.terrain;
    const terrainCanvas = terrain.getCanvas ? terrain.getCanvas() : terrain.canvas;

    if (!terrainCanvas) {
        console.error('❌ Could not get terrain canvas!');
        return;
    }

    // Create map data in the same format as MapEditor
    const mapData = {
        name: mapName,
        version: 1,
        width: terrain.width,
        height: terrain.height,
        terrain: terrainCanvas.toDataURL('image/png'),
        objects: [], // Game objects are baked into terrain
        spawns: {
            team1: [],
            team2: []
        }
    };

    // Convert to JSON
    const json = JSON.stringify(mapData, null, 2);

    // Create download link
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${mapName.replace(/[^a-z0-9]/gi, '_')}.koalamap`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log('✅ Map exported as', mapName + '.koalamap');
    return mapData;
}

// Expose export function globally
window.exportCurrentGameMap = exportCurrentGameMap;
