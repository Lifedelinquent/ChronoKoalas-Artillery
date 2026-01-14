/**
 * Koala Artillery - Main Entry Point
 * Multiplayer turn-based artillery game
 */

import { Game } from './engine/Game.js';
import { MenuManager } from './ui/MenuManager.js';
import { NetworkManager } from './network/NetworkManager.js';
import { MapEditor } from './editor/MapEditor.js';

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

    // Host Game
    btnHost.addEventListener('click', async () => {
        const roomCode = await networkManager.hostGame();
        if (roomCode) {
            menuManager.showLobby(roomCode, true);
        }
    });

    // Join Game - Show input panel
    btnJoin.addEventListener('click', () => {
        joinPanel.classList.toggle('hidden');
    });

    // Connect to room
    btnConnect.addEventListener('click', async () => {
        const roomCode = document.getElementById('room-code-input').value.toUpperCase();
        if (roomCode.length >= 4) {
            const success = await networkManager.joinGame(roomCode);
            if (success) {
                menuManager.showLobby(roomCode, false);
            }
        }
    });

    // Practice Mode - Start single player
    btnPractice.addEventListener('click', (e) => {
        e.target.blur(); // Remove focus so spacebar doesn't re-trigger
        startGame(true);
    });

    // Ready toggle
    btnReady.addEventListener('click', () => {
        networkManager.toggleReady();
    });

    // Leave lobby
    btnLeave.addEventListener('click', () => {
        networkManager.leaveLobby();
        menuManager.showMenu();
    });

    // Start game (host only)
    btnStartGame.addEventListener('click', () => {
        networkManager.startGame();
    });

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

    // Network event handlers
    networkManager.on('playerJoined', (data) => {
        menuManager.addPlayer(data.player, data.team);
    });

    networkManager.on('playerLeft', (data) => {
        menuManager.removePlayer(data.playerId);
    });

    networkManager.on('playerReady', (data) => {
        menuManager.setPlayerReady(data.playerId, data.ready);
    });

    networkManager.on('gameStart', (data) => {
        startGame(false, data.gameState);
    });

    networkManager.on('gameAction', (data) => {
        if (game) {
            game.handleNetworkAction(data);
        }
    });
}

/**
 * Start the game
 * @param {boolean} isPractice - Single player practice mode
 * @param {Object} networkState - Initial state from network (multiplayer)
 */
function startGame(isPractice = false, networkState = null) {
    const canvas = document.getElementById('game-canvas');

    // Create game instance
    game = new Game(canvas, {
        isPractice,
        networkManager: isPractice ? null : networkManager,
        initialState: networkState
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

    const mapName = prompt('Enter map name:', 'My Custom Map');
    if (!mapName) return;

    const mapData = mapEditor.exportMap(mapName);
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
