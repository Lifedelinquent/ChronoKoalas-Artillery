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
import * as SP from './singleplayer/SinglePlayer.js';
import { log } from './utils/Logger.js';
import { ReplayUI } from './ui/ReplayUI.js';
import { ReplayStore } from './replay/Replay.js';
import { SettingsUI, ControlsOverlay } from './ui/SettingsUI.js';
import { TeamEditor } from './ui/TeamEditor.js';
import { TouchControls, wantsTouchControls } from './ui/TouchControls.js';
import { ChatUI } from './ui/ChatUI.js';
import { buildTutorial, TutorialDirector } from './singleplayer/Tutorial.js';
import { getActiveStyle, loadTeams } from './utils/TeamStyles.js';
import { getSettings, saveSettings } from './utils/Settings.js';

// Global game instance
let game = null;
let menuManager = null;
let networkManager = null;
let mapEditor = null;

// Single-player context of the running match (null for multiplayer/hotseat).
// Drives rank/mission/training progress handling on game over.
let spContext = null;

// UI modules (created in init)
let replayUI = null;
let settingsUI = null;
let controlsOverlay = null;
let teamEditor = null;
let touchControls = null;
let chatUI = null;
let tutorialDirector = null;

// The replay of the match that just ended (or is being watched)
let lastReplay = null;

/**
 * Initialize the application
 */
async function init() {
    log.debug('🐨 Koala Artillery initializing...');

    // Migrate any maps saved in the old localStorage format → IndexedDB
    await MapManager.migrateFromLocalStorage();

    // Initialize managers
    menuManager = new MenuManager();
    networkManager = new NetworkManager();

    // Set up menu event handlers
    setupMenuHandlers();

    // Single Player menu (WA-style: Training / Missions / Deathmatch / Quick)
    setupSinglePlayerMenu();

    // Set up global audio controls
    setupGlobalAudioControls();

    // Teams, replays, settings, controls, touch, chat
    setupExtraUI();

    // Process logo to remove checkerboard background
    processLogo();

    // Installable / offline single player (PWA)
    registerServiceWorker();

    log.debug('✓ Initialization complete');
}

/**
 * Menu-level UI added in the overhaul: team editor, replay browser,
 * settings, controls overlay, touch controls and multiplayer chat.
 */
function setupExtraUI() {
    replayUI = new ReplayUI({ onWatch: startReplay });
    settingsUI = new SettingsUI();
    controlsOverlay = new ControlsOverlay();
    teamEditor = new TeamEditor();
    touchControls = new TouchControls({ onHelp: () => controlsOverlay.toggle() });
    chatUI = new ChatUI(networkManager);

    networkManager.localStyle = getActiveStyle();

    document.getElementById('btn-teams')?.addEventListener('click', () => teamEditor.open());
    document.getElementById('btn-team-close')?.addEventListener('click', () => {
        // The lobby (and the next match) use whatever team is now active
        networkManager.setLocalStyle(getActiveStyle());
    });
    document.getElementById('btn-replays')?.addEventListener('click', () => replayUI.open());
    document.getElementById('btn-settings')?.addEventListener('click', () => settingsUI.open());
    document.getElementById('btn-howto')?.addEventListener('click', () => controlsOverlay.show());
    document.getElementById('btn-help')?.addEventListener('click', (e) => {
        e.stopPropagation();
        controlsOverlay.toggle();
    });

    // First visit: point new players at the tutorial
    const progress = SP.loadProgress();
    if (!progress.tutorialDone && progress.missionsCompleted.length === 0) {
        document.getElementById('tutorial-nudge')?.classList.remove('hidden');
    }
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // Local development serves straight from disk (a cache-first worker
    // would hand you yesterday's code); add ?sw to test offline mode locally
    const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    if (isLocal && !new URLSearchParams(location.search).has('sw')) {
        navigator.serviceWorker.getRegistrations()
            .then(regs => regs.forEach(r => r.unregister()))
            .catch(() => {});
        return;
    }
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker registration failed:', e));
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
        networkManager.localStyle = getActiveStyle();
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
            networkManager.localStyle = getActiveStyle();
            const spectator = !!document.getElementById('join-spectate')?.checked;
            await networkManager.joinGame(roomCode, { spectator });
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
        // Spectators don't ready up
        btnReady.classList.toggle('hidden', !!me?.spectator);
    }

    // Clicking your colour chip cycles your team colour (= alliance)
    menuManager.onColorCycle = (color) => networkManager.requestColor(color);

    // Network event handlers
    networkManager.on('connected', (data) => {
        log.debug('🎮 Connected to host!', data);

        // Mid-game reconnect: resume the paused game instead of showing the
        // lobby. The guest automatically requests a full state sync (terrain,
        // health, ammo, crates) — see NetworkManager's open handler.
        if (game && !game.isGameOver && data.wasReconnect) {
            log.debug('🔗 Reconnected mid-game — resuming');
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
        log.debug('🔌 Disconnected:', data?.reason);

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
        log.debug('🔌 Player dropped:', data);

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
        log.debug('🔗 Player returned:', data);
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
        log.debug('🏳️ Team forfeited:', data);
        if (game && !game.isGameOver) {
            game.forfeitTeam(data.teamIndex);
            hideConnectionBanner();
            game.isPaused = false;
            game.lastTime = performance.now();
        }
    });

    networkManager.on('gameStart', (data) => {
        log.debug('🎮 Game starting!', data);
        const started = startGame(false, data.gameState, data.gameState?.customMap);
        // A spectator joining mid-game builds the world from the seed, then
        // asks the host for the current state (terrain, health, hazards...)
        if (data.spectate) {
            started.then(() => networkManager.send({ type: 'requestStateSync' }));
        }
    });

    // Host sent everyone back to the lobby after a match
    networkManager.on('returnToLobby', () => {
        if (game) {
            game.destroy();
            game = null;
        }
        afterGameTeardown();
        menuManager.showLobby(networkManager.roomCode, networkManager.isHost);
        renderLobby();
        chatUI.system('Back in the lobby — the host can change the map, scheme or start again.');
    });

    // A guest asked the host for another round
    networkManager.on('rematchRequest', ({ name }) => {
        const note = document.getElementById('rematch-note');
        if (note) {
            note.textContent = `🔁 ${name} wants a rematch!`;
            note.classList.remove('hidden');
        }
        chatUI.system(`${name} wants a rematch.`);
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

        if (game.isReplay) {
            // "Watch again"
            if (lastReplay) startReplay(lastReplay);
        } else if (game.isPractice || !networkManager.isConnected) {
            // Local rematch - reset in place (records a fresh replay)
            game.reset();
            menuManager.showScreen('game-screen');
        } else if (networkManager.isHost) {
            // Multiplayer rematch must go through the host so every client
            // restarts with the same fresh seed (local reset would desync)
            networkManager.startGame({ customMap: window.selectedMap, scheme: window.selectedScheme });
        } else {
            // Guests vote; the host gets a notice and decides
            networkManager.requestRematch();
            btnRematch.disabled = true;
            btnRematch.textContent = 'Rematch requested';
        }
    });

    // Replays from the results screen
    document.getElementById('btn-watch-replay')?.addEventListener('click', () => {
        if (lastReplay) startReplay(lastReplay);
    });
    document.getElementById('btn-save-replay')?.addEventListener('click', () => {
        if (lastReplay) ReplayStore.download(lastReplay);
    });
    document.getElementById('btn-back-lobby')?.addEventListener('click', () => {
        if (networkManager.isHost) networkManager.returnToLobby();
    });



    // Main menu
    btnMainMenu.addEventListener('click', () => {
        if (game) {
            game.destroy();
            game = null;
        }
        afterGameTeardown();
        networkManager.disconnect();
        chatUI.clear();
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
            // A peer only asks for this after a reconnect or when spectating
            // mid-game — include the terrain snapshot so they get every
            // crater they missed, and send it to them alone
            game.sendFullStateSync({ includeTerrain: true, toPeer: data.fromPeer });
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

    networkManager.on('remoteCrateDestroyed', (data) => {
        if (game) {
            game.lootManager.handleRemoteCrateDestroyed(data);
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
 * @param {boolean} isPractice - Local game (single player / hotseat)
 * @param {Object} networkState - Initial state from network (multiplayer)
 * @param {Object} spOptions - Single-player bundle: { teamsConfig, seed, context }
 */
function startGame(isPractice = false, networkState = null, customMap = null, scheme = null, spOptions = null) {
    const canvas = document.getElementById('game-canvas');

    // Destroy any previous game so we don't leak loops and input listeners
    if (game) {
        game.destroy();
        game = null;
    }
    afterGameTeardown();

    // Game scheme (all match rules incl. sudden death): network clients take
    // it from the host's game state, otherwise use the map-screen selection.
    const activeScheme = networkState?.scheme ?? scheme ?? window.selectedScheme;

    spContext = spOptions?.context || null;

    // Create game instance. Single-player modes pass an explicit map (or
    // none — fixed seed instead), so a leftover lobby map must not leak in.
    game = new Game(canvas, {
        isPractice,
        networkManager: isPractice ? null : networkManager,
        initialState: networkState,
        customMap: customMap ?? (spOptions ? null : window.selectedMap),
        scheme: activeScheme,
        teamsConfig: spOptions?.teamsConfig || null,
        teamStyles: spOptions?.teamStyles || null,
        seed: spOptions?.seed,
        replay: spOptions?.replay || null,
        replayMeta: spOptions?.replayMeta || null
    });

    // Expose game instance globally for debugging/export
    window.game = game;

    // Show game screen
    menuManager.showScreen('game-screen');

    // Per-game UI hooks
    const currentGame = game;
    game.inputManager.onHelp = () => controlsOverlay.toggle();
    const multiplayer = !isPractice;
    game.inputManager.onChat = multiplayer ? () => chatUI.openGameInput() : null;
    document.getElementById('game-chat')?.classList.toggle('hidden', !multiplayer);
    touchControls.attach(game);
    if (spOptions?.replay) {
        replayUI.attach(game, { onExit: exitReplay, onRestart: () => startReplay(spOptions.replay) });
    }
    if (spContext?.mode === 'tutorial') {
        tutorialDirector = new TutorialDirector(game, { touch: wantsTouchControls() });
    }

    // First game ever: show the controls once
    if (!spOptions?.replay && !getSettings().seenControls) {
        saveSettings({ seenControls: true });
        controlsOverlay.show();
    }

    // Start the game
    const started = game.start();

    // Game over handler
    game.on('gameOver', (result) => {
        if (game !== currentGame) return;
        tutorialDirector?.destroy();
        tutorialDirector = null;
        menuManager.showGameOver(result);
        showSinglePlayerResult(result);
        handleReplayOnGameOver(currentGame, result);
        updateGameOverButtons(currentGame);
    });

    return started;
}

/** Tear down per-game UI (tutorial coach, replay bar, touch controls). */
function afterGameTeardown() {
    tutorialDirector?.destroy();
    tutorialDirector = null;
    replayUI?.detach();
    touchControls?.detach();
    controlsOverlay?.hide();
}

/**
 * Local matches record themselves (Game.replayRecorder): save the finished
 * replay to the browser and offer watch / download on the results screen.
 */
function handleReplayOnGameOver(finishedGame, result) {
    if (finishedGame.isReplay) {
        lastReplay = finishedGame.options.replay;
        return;
    }
    lastReplay = null;
    if (!finishedGame.replayRecorder) return;
    lastReplay = finishedGame.replayRecorder.build(result);
    ReplayStore.save(lastReplay);
}

function updateGameOverButtons(finishedGame) {
    const isMultiplayer = !finishedGame.isPractice;
    const rematch = document.getElementById('btn-rematch');
    const watch = document.getElementById('btn-watch-replay');
    const save = document.getElementById('btn-save-replay');
    const lobby = document.getElementById('btn-back-lobby');
    const note = document.getElementById('rematch-note');

    note?.classList.add('hidden');
    if (rematch) {
        rematch.disabled = false;
        rematch.textContent = finishedGame.isReplay ? '🎬 Watch Again'
            : (isMultiplayer && !networkManager.isHost ? '🔁 Vote Rematch' : 'Rematch');
        rematch.classList.toggle('hidden', isMultiplayer && networkManager.isSpectator);
    }
    watch?.classList.toggle('hidden', !lastReplay || finishedGame.isReplay);
    save?.classList.toggle('hidden', !lastReplay);
    lobby?.classList.toggle('hidden', !(isMultiplayer && networkManager.isHost));
}

/** Watch a saved replay. */
function startReplay(replay) {
    spContext = null;
    lastReplay = replay;
    startGame(true, null, replay.customMap, replay.scheme, {
        teamsConfig: replay.teamsConfig,
        teamStyles: replay.teamStyles,
        seed: replay.seed,
        replay,
        context: null
    });
}

function exitReplay() {
    if (game) {
        game.destroy();
        game = null;
    }
    afterGameTeardown();
    menuManager.showMenu();
    replayUI.open();
}

/**
 * Game-over extras for single player: update rank/mission/training progress
 * and show the promotion / unlock line under the winner banner.
 */
function showSinglePlayerResult(result) {
    const line = document.getElementById('sp-result-line');
    if (!line) return;

    const outcome = SP.handleGameOver(spContext, result);
    if (!outcome) {
        line.classList.add('hidden');
        return;
    }
    line.textContent = outcome.text;
    line.classList.remove('hidden');

    // showGameOver picks victory music whenever there IS a winner — but a
    // CPU winner means the human lost, so switch to the defeat theme.
    if (!outcome.won) {
        globalAudioManager.playTheme('defeat');
    }
}

/**
 * Single Player modal, modeled on Worms Armageddon's single-player menu:
 * Training (weapon ranges), Missions (fixed-map campaign), Deathmatch
 * (ranked ladder), Quick Game (instant CPU match) and classic Hotseat.
 */
function setupSinglePlayerMenu() {
    const modal = document.getElementById('sp-modal');
    const body = document.getElementById('sp-modal-body');
    const title = document.getElementById('sp-modal-title');
    const btnBack = document.getElementById('btn-sp-back');
    const btnSingle = document.getElementById('btn-single');
    if (!modal || !btnSingle) return;

    let view = 'main';

    const open = () => { modal.classList.remove('hidden'); renderMain(); };
    const close = () => modal.classList.add('hidden');

    btnSingle.addEventListener('click', (e) => {
        e.target.blur(); // Spacebar must not re-trigger the focused button
        open();
    });
    btnBack.addEventListener('click', () => {
        if (view === 'main') close();
        else renderMain();
    });

    /** Start a prepared single-player bundle (optionally with a chosen map/scheme). */
    function startBundle(bundle, customMap = null, schemeOverride = null, title = null) {
        close();
        startGame(true, null, customMap, schemeOverride ?? bundle.scheme ?? null, {
            teamsConfig: bundle.teamsConfig,
            seed: bundle.seed,
            context: bundle.context,
            replayMeta: { title: title || 'Single Player', mode: bundle.context?.mode || 'sp' }
        });
    }

    function makeItem(icon, name, desc, onClick, opts = {}) {
        const el = document.createElement('button');
        el.className = 'sp-item' + (opts.locked ? ' locked' : '') + (opts.done ? ' done' : '');
        el.disabled = !!opts.locked;
        el.innerHTML = `
            <span class="sp-item-icon">${icon}</span>
            <span class="sp-item-text">
                <strong>${name}</strong>
                <small>${desc}</small>
            </span>
            <span class="sp-item-status">${opts.locked ? '🔒' : (opts.done ? '✅' : '')}</span>`;
        if (!opts.locked) el.addEventListener('click', onClick);
        body.appendChild(el);
        return el;
    }

    // ---------------- Main list ----------------
    function renderMain() {
        view = 'main';
        title.textContent = '🐨 Single Player';
        body.innerHTML = '';
        const progress = SP.loadProgress();

        makeItem('🎓', progress.tutorialDone ? 'Tutorial' : 'Tutorial — start here!',
            'Learn to walk, jump, aim, fire, rope and teleport, one step at a time',
            () => startBundle(buildTutorial(), null, null, 'Tutorial'),
            { done: progress.tutorialDone });
        const medals = Object.values(progress.trainingMedals).filter(m => m.medal === 'gold').length;
        makeItem('🎯', 'Training',
            `Weapon ranges — hit every target · ${progress.trainingCompleted.length}/${SP.TRAINING.length} passed · 🥇 ${medals}`,
            renderTraining);
        const stars = Object.values(progress.missionStars).reduce((s, n) => s + n, 0);
        makeItem('🎖️', 'Missions',
            `Campaign · ${progress.missionsCompleted.length}/${SP.MISSIONS.length} complete · ★ ${stars}/${SP.MISSIONS.length * 3}`,
            renderMissions);
        makeItem('💀', 'Deathmatch',
            `Ranked ladder · Current rank: ${SP.RANKS[progress.dmLevel]}`,
            renderDeathmatch);
        makeItem('⚡', 'Quick Game', 'Instant battle against CPU squads', renderQuick);
        makeItem('👥', 'Hotseat', 'Two players share one keyboard (classic practice)', startHotseat);
    }

    // ---------------- Training ----------------
    function renderTraining() {
        view = 'sub';
        title.textContent = '🎯 Training';
        body.innerHTML = '';
        const progress = SP.loadProgress();

        for (const range of SP.TRAINING) {
            const best = progress.trainingMedals[range.id];
            const [gold, silver] = SP.TRAINING_MEDALS[range.id] || [5, 8];
            const medalLine = best
                ? `${SP.MEDAL_ICON[best.medal]} best: ${best.shots} shots`
                : `🥇 ≤${gold} shots · 🥈 ≤${silver}`;
            makeItem(best ? SP.MEDAL_ICON[best.medal] : '🎯', range.name, `${range.desc} · ${medalLine}`,
                () => startBundle(SP.buildTraining(range, getActiveStyle()), null, null, `Training: ${range.name}`),
                { done: progress.trainingCompleted.includes(range.id) });
        }
    }

    // ---------------- Missions ----------------
    /**
     * Campaign map: missions as nodes along a winding trail, with the
     * stars earned on each. Locked nodes unlock in order.
     */
    function renderMissions() {
        view = 'sub';
        title.textContent = '🎖️ Campaign';
        body.innerHTML = '';
        const progress = SP.loadProgress();

        const map = document.createElement('div');
        map.className = 'campaign-map';
        SP.MISSIONS.forEach((mission, i) => {
            const done = progress.missionsCompleted.includes(mission.id);
            const unlocked = i === 0 || progress.missionsCompleted.includes(SP.MISSIONS[i - 1].id);
            const stars = progress.missionStars[mission.id] || 0;
            const node = document.createElement('button');
            node.className = 'campaign-node' + (done ? ' done' : '') + (unlocked ? '' : ' locked') +
                (unlocked && !done ? ' current' : '');
            node.disabled = !unlocked;
            // Snake layout: rows of four, alternating direction
            const row = Math.floor(i / 4);
            const col = row % 2 === 0 ? i % 4 : 3 - (i % 4);
            node.style.gridRow = String(row + 1);
            node.style.gridColumn = String(col + 1);
            node.innerHTML = `<span class="campaign-num">${unlocked ? i + 1 : '🔒'}</span>
                <span class="campaign-name"></span>
                <span class="campaign-stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</span>`;
            node.querySelector('.campaign-name').textContent = mission.name;
            if (unlocked) node.addEventListener('click', () => renderBriefing(mission));
            map.appendChild(node);
        });
        body.appendChild(map);

        const legend = document.createElement('p');
        legend.className = 'sp-briefing-sub';
        legend.textContent = '★ win · ★★ lose no koalas · ★★★ flawless within par turns';
        body.appendChild(legend);
    }

    function renderBriefing(mission) {
        view = 'sub';
        title.textContent = `🎖️ ${mission.name}`;
        const progress = SP.loadProgress();
        const stars = progress.missionStars[mission.id] || 0;
        const par = SP.MISSION_PAR[mission.id];
        body.innerHTML = `
            <p class="sp-briefing"></p>
            <p class="sp-briefing-sub">Objective: eliminate all enemy koalas.
                Par: ${par} turns · Best: ${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</p>`;
        body.querySelector('.sp-briefing').textContent = mission.briefing;
        const btn = document.createElement('button');
        btn.className = 'menu-btn primary';
        btn.textContent = '▶ Start Mission';
        btn.addEventListener('click', () => startBundle(SP.buildMission(mission, getActiveStyle()), null, null, `Mission: ${mission.name}`));
        body.appendChild(btn);
    }

    // ---------------- Deathmatch ----------------
    function renderDeathmatch() {
        view = 'sub';
        title.textContent = '💀 Deathmatch';
        body.innerHTML = '';
        const progress = SP.loadProgress();
        const level = progress.dmLevel;
        const bundle = SP.buildDeathmatch(level, getActiveStyle());
        const enemies = bundle.teamsConfig.filter(t => t.isCPU);

        const info = document.createElement('div');
        info.className = 'sp-dm-info';
        info.innerHTML = `
            <p class="sp-dm-rank">Current rank: <strong>${SP.RANKS[level]}</strong>
                <small>(${level + 1}/${SP.RANKS.length})</small></p>
            <p class="sp-briefing">Win at your rank to be promoted. The higher you climb,
                the smarter, tougher and more numerous the enemy squads become.</p>
            <p class="sp-briefing-sub">Next fight: ${enemies.length} enemy squad${enemies.length > 1 ? 's' : ''} ·
                ${enemies[0].koalaCount} koalas each · ${enemies[0].health} HP · CPU level ${enemies[0].difficulty}</p>`;
        body.appendChild(info);

        const btn = document.createElement('button');
        btn.className = 'menu-btn primary';
        btn.textContent = '⚔️ Fight!';
        btn.addEventListener('click', () => startBundle(bundle, null, null, `Deathmatch: ${SP.RANKS[level]}`));
        body.appendChild(btn);
    }

    // ---------------- Quick Game ----------------
    function renderQuick() {
        view = 'sub';
        title.textContent = '⚡ Quick Game';
        body.innerHTML = `
            <div class="sp-quick-row">
                <label for="sp-quick-difficulty">CPU difficulty</label>
                <select id="sp-quick-difficulty" class="scheme-select">
                    <option value="1">CPU 1 — Pushover</option>
                    <option value="2">CPU 2 — Rookie</option>
                    <option value="3" selected>CPU 3 — Soldier</option>
                    <option value="4">CPU 4 — Veteran</option>
                    <option value="5">CPU 5 — Elite</option>
                </select>
            </div>
            <div class="sp-quick-row">
                <label for="sp-quick-enemies">Enemy squads</label>
                <select id="sp-quick-enemies" class="scheme-select">
                    <option value="1" selected>1 squad (duel)</option>
                    <option value="2">2 squads (free-for-all)</option>
                    <option value="3">3 squads (free-for-all)</option>
                </select>
            </div>`;
        const btn = document.createElement('button');
        btn.className = 'menu-btn primary';
        btn.textContent = '🗺️ Choose Map & Fight';
        btn.addEventListener('click', async () => {
            const difficulty = parseInt(document.getElementById('sp-quick-difficulty').value, 10);
            const enemyCount = parseInt(document.getElementById('sp-quick-enemies').value, 10);
            const bundle = SP.buildQuickGame(difficulty, enemyCount, getActiveStyle());

            close();
            const maps = await MapManager.getAllMaps();
            menuManager.showMapSelection(maps, (mapId, scheme) => {
                const customMap = mapId !== 'default' ? maps[mapId] : null;
                startBundle(bundle, customMap, scheme, `Quick Game vs CPU ${difficulty}`);
            });
        });
        body.appendChild(btn);
    }

    // ---------------- Hotseat (the old Practice mode) ----------------
    // Each side picks one of the saved teams (or the classic default)
    function startHotseat() {
        view = 'sub';
        title.textContent = '👥 Hotseat';
        const { teams, active } = loadTeams();
        const options = (selected) => ['<option value="">Classic colours</option>',
            ...teams.map(t => `<option value="${t.id}"${t.id === selected ? ' selected' : ''}></option>`)].join('');
        body.innerHTML = `
            <div class="sp-quick-row"><label for="hs-p1">🔴 Player 1 team</label>
                <select id="hs-p1" class="scheme-select">${options(active)}</select></div>
            <div class="sp-quick-row"><label for="hs-p2">🔵 Player 2 team</label>
                <select id="hs-p2" class="scheme-select">${options(teams.find(t => t.id !== active)?.id)}</select></div>`;
        // Team names are user text: set via textContent, not markup
        for (const sel of body.querySelectorAll('select')) {
            [...sel.options].slice(1).forEach((o, i) => { o.textContent = teams[i].name; });
        }
        const btn = document.createElement('button');
        btn.className = 'menu-btn primary';
        btn.textContent = '🗺️ Choose Map & Fight';
        btn.addEventListener('click', async () => {
            const pick = (id) => teams.find(t => t.id === document.getElementById(id).value) || null;
            const teamStyles = [pick('hs-p1'), pick('hs-p2')];
            close();
            const maps = await MapManager.getAllMaps();
            menuManager.showMapSelection(maps, (mapId, scheme) => {
                const customMap = mapId !== 'default' ? maps[mapId] : null;
                spContext = null;
                startGame(true, null, customMap, scheme, {
                    teamStyles,
                    replayMeta: { title: 'Hotseat', mode: 'hotseat' }
                });
            });
        });
        body.appendChild(btn);
    }
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

    log.debug('🗺️ Map Editor opened');
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
    log.debug('🗺️ Map Editor closed');
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

    log.debug('🎮 Testing map...');
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

        log.debug('💾 Map saved:', mapName);
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
            log.debug('📂 Map loaded:', mapData.name);
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

            log.debug('🖼️ Image imported as terrain:', file.name);
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

    log.debug('✅ Map exported as', mapName + '.koalamap');
    return mapData;
}

// Expose export function globally
window.exportCurrentGameMap = exportCurrentGameMap;
