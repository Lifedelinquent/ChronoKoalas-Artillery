/**
 * Koala Artillery - Main Entry Point
 * Multiplayer turn-based artillery game
 */

import { Game } from './engine/Game.js';
import { MenuManager } from './ui/MenuManager.js';
import { NetworkManager } from './network/NetworkManager.js';
import { MapEditor } from './editor/MapEditor.js';
import { MapManager } from './utils/MapManager.js';

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

    // Initialize managers
    menuManager = new MenuManager();
    networkManager = new NetworkManager();

    // Set up menu event handlers
    setupMenuHandlers();

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

    // Currently selected map for generic start
    window.selectedMap = null;

    // Host Game - Create peer and show room code
    btnHost.addEventListener('click', async () => {
        // Hide menu buttons, show host panel
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
                hostStatus.textContent = 'Waiting for player to join...';
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

    // Network event handlers
    networkManager.on('connected', (data) => {
        console.log('🎮 Connected to peer!', data);

        // Transition to lobby
        menuManager.showLobby(networkManager.roomCode, networkManager.isHost);

        // Add SELF to the lobby first
        const selfTeam = networkManager.isHost ? 'red' : 'blue';
        const selfName = networkManager.isHost ? 'You (Host)' : 'You (Guest)';
        menuManager.addPlayerToLobby(
            { id: networkManager.playerId, name: selfName },
            selfTeam
        );

        // The peer will be added when we receive the handshake message
        // (see playerJoined handler below)

        // Reset UI states
        hostPanel.classList.add('hidden');
        joinPanel.classList.add('hidden');
        menuButtons.classList.remove('hidden');
        btnConnect.disabled = false;
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

    networkManager.on('disconnected', (data) => {
        console.log('🔌 Disconnected:', data?.reason);

        // Show disconnection message if in game
        if (game) {
            alert('Opponent disconnected!');
            game.destroy();
            game = null;
        }
        menuManager.showMenu();
    });

    networkManager.on('playerJoined', (data) => {
        console.log('👤 Player joined:', data);
        menuManager.addPlayerToLobby(data.player, data.team);
    });

    networkManager.on('playerReady', (data) => {
        console.log('✅ Player ready:', data);
        menuManager.updatePlayerReady(data.playerId, data.ready);
    });

    networkManager.on('gameStart', (data) => {
        console.log('🎮 Game starting!', data);
        startGame(false, data.gameState, data.gameState?.customMap);
    });

    // Practice Mode - Start single player
    btnPractice.addEventListener('click', (e) => {
        e.target.blur(); // Remove focus so spacebar doesn't re-trigger
        const maps = MapManager.getAllMaps();
        menuManager.showMapSelection(maps, (mapId) => {
            let customMap = null;
            if (mapId !== 'default') {
                customMap = maps[mapId];
            }
            startGame(true, null, customMap);
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
            customMap: window.selectedMap
        };
        networkManager.startGame(options);
    });

    // Change Map (Lobby)
    const btnChangeMap = document.getElementById('btn-change-map');
    if (btnChangeMap) {
        btnChangeMap.addEventListener('click', () => {
            const maps = MapManager.getAllMaps();
            menuManager.showMapSelection(maps, (mapId) => {
                let map = null;
                let name = 'Default Zoo';
                if (mapId !== 'default') {
                    map = maps[mapId];
                    name = map.name;
                }

                window.selectedMap = map;
                menuManager.updateLobbyMapName(name);

                // Sync with other players
                networkManager.sendMapSelection(map);
            });
        });
    }

    // Rematch
    btnRematch.addEventListener('click', () => {
        if (game) {
            game.reset();
        }
        menuManager.showScreen('game-screen');
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
        const name = data.map ? data.map.name : 'Default Zoo';
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

    networkManager.on('remoteStateSync', (data) => {
        if (game) {
            game.handleRemoteStateSync(data);
        }
    });
}

/**
 * Start the game
 * @param {boolean} isPractice - Single player practice mode
 * @param {Object} networkState - Initial state from network (multiplayer)
 */
function startGame(isPractice = false, networkState = null, customMap = null) {
    const canvas = document.getElementById('game-canvas');

    // Create game instance
    game = new Game(canvas, {
        isPractice,
        networkManager: isPractice ? null : networkManager,
        initialState: networkState,
        customMap: customMap || window.selectedMap
    });

    // Expose game instance globally for debugging/export
    window.game = game;

    // Show game screen
    menuManager.showScreen('game-screen');

    // Start the game
    game.start();

    // Set up mute toggle
    const muteBtn = document.getElementById('mute-toggle');
    if (muteBtn) {
        muteBtn.addEventListener('click', () => {
            const isMuted = game.audioManager.toggleMute();
            muteBtn.textContent = isMuted ? '🔇' : '🔊';
            muteBtn.classList.toggle('muted', isMuted);
            game.audioManager.playClick(); // Play click if just unmuted
        });
    }

    // Game over handler
    game.on('gameOver', (result) => {
        menuManager.showGameOver(result);
    });
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);

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
    const canvas = document.getElementById('game-canvas');

    // Create game instance with custom map option
    game = new Game(canvas, {
        isPractice: true,
        networkManager: null,
        initialState: null,
        customMap: mapData  // Pass the custom map data
    });

    // Expose game instance globally
    window.game = game;

    // Show game screen
    menuManager.showScreen('game-screen');

    // Start the game
    game.start();

    // Set up mute toggle
    const muteBtn = document.getElementById('mute-toggle');
    if (muteBtn) {
        muteBtn.addEventListener('click', () => {
            const isMuted = game.audioManager.toggleMute();
            muteBtn.textContent = isMuted ? '🔇' : '🔊';
            muteBtn.classList.toggle('muted', isMuted);
            game.audioManager.playClick();
        });
    }

    // Game over handler - return to editor
    game.on('gameOver', (result) => {
        // After game over, allow returning to editor
        menuManager.showGameOver(result);
    });
}

/**
 * Save current map to file
 */
function saveMap() {
    if (!mapEditor) return;

    // Use custom naming modal instead of native prompt
    menuManager.showMapNaming((mapName) => {
        const mapData = mapEditor.exportMap(mapName);

        // Save to local storage
        MapManager.saveMap(mapData);

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
