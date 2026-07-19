/**
 * Network Manager - PeerJS-based P2P multiplayer for up to 4 players.
 *
 * Topology: a star. The host's peer ID is the room code; every guest opens a
 * single reliable data channel to the host. Guests never talk to each other —
 * the host relays in-game traffic between them (RELAY_TYPES below).
 *
 * The host also owns the lobby roster: it assigns slots (0 = host, 1-3 =
 * guests in join order), applies colour/ready changes, and broadcasts the
 * full roster after every change ('lobbyUpdate'). A player's colour is their
 * alliance — several players may share one colour to play as a team.
 *
 * In-game authority is unchanged from the 2-player model: the host is the
 * damage/loot authority, and whichever client owns the current turn drives
 * the turn flow ('turnStart' announcements).
 */

import { EventEmitter } from '../utils/EventEmitter.js';
import { TEAM_COLOR_ORDER } from '../utils/TeamColors.js';

export const MAX_PLAYERS = 4;

// In-game messages the host forwards to the other guests, so every client
// sees every action no matter which player produced it. Lobby control
// messages (handshake/setColor/setReady) are handled by the host, not
// relayed; host-authored broadcasts (damage, crates, lobbyUpdate, gameStart)
// never arrive FROM a guest so they don't need to be here.
const RELAY_TYPES = new Set([
    'move', 'aim', 'fire', 'targetWeapon', 'jump', 'highJump', 'ropeRelease',
    'weaponSelect', 'turnEnd', 'turnStart', 'gameOver', 'chat'
]);

export class NetworkManager extends EventEmitter {
    constructor() {
        super();

        this.peer = null;
        this.connection = null;        // guest: the channel to the host
        this.connections = new Map();  // host: peerId -> DataConnection

        this.roomCode = null;
        this.playerId = null;
        this.isHost = false;
        this.isConnected = false;

        // Lobby roster: [{ slot, name, color, ready, connected, peerId }].
        // The host mutates it; guests hold the copy from the last lobbyUpdate.
        this.roster = [];
        this.mySlot = null;
        this.isReady = false;

        // Team ownership for the running match: gameState.players in team
        // order, captured at gameStart. teams[i] is driven by gamePlayers[i].
        this.gamePlayers = null;
        this.gameInProgress = false;

        // Connection state
        this.connectionState = 'disconnected'; // disconnected, connecting, connected

        // Queuing and reconnection (guest side)
        this.outboundQueue = [];
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
    }

    /**
     * Generate a random 6-character room code
     */
    generateRoomCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }
        return code;
    }

    /**
     * Host a new game - creates a PeerJS peer and accepts up to 3 guests
     */
    async hostGame() {
        this.isHost = true;
        this.roomCode = this.generateRoomCode();
        this.connectionState = 'connecting';

        console.log('🎮 Hosting game with code:', this.roomCode);

        return new Promise((resolve, reject) => {
            try {
                // Create peer with our room code as the ID
                this.peer = new Peer(this.roomCode, {
                    debug: 1 // Minimal logging
                });

                this.peer.on('open', (id) => {
                    console.log('✅ Peer created with ID:', id);
                    this.playerId = id;
                    this.mySlot = 0;
                    this.roster = [{
                        slot: 0,
                        name: 'Player 1',
                        color: TEAM_COLOR_ORDER[0],
                        ready: false,
                        connected: true,
                        peerId: id
                    }];
                    this.emit('hostReady', { roomCode: this.roomCode });
                    this.emit('lobbyUpdate', { roster: this.publicRoster() });
                    resolve(this.roomCode);
                });

                this.peer.on('connection', (conn) => {
                    console.log('🔗 Player connecting:', conn.peer);
                    this.setupHostConnection(conn);
                });

                this.peer.on('error', (err) => {
                    console.error('❌ Peer error:', err);

                    if (err.type === 'unavailable-id') {
                        this.connectionState = 'disconnected';
                        this.emit('error', { message: 'Room code in use, try again' });
                        reject(err);
                    } else if (err.type === 'peer-unavailable') {
                        // A stale outgoing connection attempt — not fatal for a host
                        this.emit('error', { message: 'Could not find that room' });
                    } else {
                        this.emit('error', { message: err.message || 'Connection failed' });
                        reject(err);
                    }
                });

                this.peer.on('disconnected', () => {
                    console.log('⚠️ Disconnected from signaling server');
                    // Try to reconnect (existing data channels keep working)
                    if (this.peer && !this.peer.destroyed) {
                        this.peer.reconnect();
                    }
                });

            } catch (error) {
                console.error('Failed to create peer:', error);
                this.connectionState = 'disconnected';
                reject(error);
            }
        });
    }

    /**
     * Join an existing game using a room code
     */
    async joinGame(roomCode) {
        this.isHost = false;
        this.roomCode = roomCode.toUpperCase();
        this.connectionState = 'connecting';

        console.log('🔗 Joining game:', this.roomCode);

        return new Promise((resolve, reject) => {
            try {
                // Create our own peer first
                this.peer = new Peer({
                    debug: 1
                });

                this.peer.on('open', (id) => {
                    console.log('✅ Our peer ID:', id);
                    this.playerId = id;

                    // Now connect to the host
                    console.log('📡 Connecting to host:', this.roomCode);
                    this.connection = this.peer.connect(this.roomCode, {
                        reliable: true
                    });

                    this.setupConnectionHandlers(this.connection);

                    // Set a timeout for connection
                    const timeout = setTimeout(() => {
                        if (!this.isConnected) {
                            this.emit('error', { message: 'Connection timed out' });
                            reject(new Error('Connection timed out'));
                        }
                    }, 10000);

                    this.connection.on('open', () => {
                        clearTimeout(timeout);
                    });
                });

                this.peer.on('error', (err) => {
                    console.error('❌ Peer error:', err);
                    this.connectionState = 'disconnected';

                    if (err.type === 'peer-unavailable') {
                        this.emit('error', { message: 'Room not found. Check the code!' });
                    } else {
                        this.emit('error', { message: err.message || 'Connection failed' });
                    }
                    reject(err);
                });

                // Resolve when we get our peer ID (actual connection handled by setupConnectionHandlers)
                this.peer.on('open', () => {
                    resolve(true);
                });

            } catch (error) {
                console.error('Failed to join game:', error);
                this.connectionState = 'disconnected';
                reject(error);
            }
        });
    }

    // ==================== HOST: GUEST CONNECTIONS ====================

    /**
     * Host-side handlers for an incoming guest connection. The guest isn't
     * placed in the roster until its handshake arrives (it carries the name
     * and, on reconnect, the slot to reclaim).
     */
    setupHostConnection(conn) {
        conn.on('open', () => {
            console.log('✅ Data channel open (guest):', conn.peer);
            // Roster placement happens on handshake
        });

        conn.on('data', (data) => {
            this.handleMessage(data, conn);
        });

        conn.on('close', () => {
            this.handleGuestGone(conn);
        });

        conn.on('error', (err) => {
            console.error('Guest connection error:', conn.peer, err);
        });
    }

    /**
     * Place a guest in the roster (or re-attach a reconnecting one)
     */
    handleGuestHandshake(data, conn) {
        // Reconnect: the guest asks for its old slot back
        if (data.reclaimSlot !== undefined && data.reclaimSlot !== null) {
            const entry = this.roster.find(r => r.slot === data.reclaimSlot);
            if (entry && !entry.connected) {
                console.log(`🔗 Guest reclaiming slot ${entry.slot}`);
                // Drop any dead connection still registered for the old peer id
                if (entry.peerId) this.connections.delete(entry.peerId);
                entry.peerId = conn.peer;
                entry.connected = true;
                this.connections.set(conn.peer, conn);
                this.refreshConnectedFlag();

                this.sendToConn(conn, {
                    type: 'welcome',
                    slot: entry.slot,
                    roster: this.publicRoster(),
                    midGame: this.gameInProgress
                });
                this.broadcastLobby();
                if (this.gameInProgress) {
                    const evt = { slot: entry.slot, name: entry.name };
                    this.broadcastExcept(conn.peer, { type: 'playerReturned', ...evt });
                    this.emit('playerReturned', evt);
                }
                return;
            }
            // Fall through: unknown/occupied slot — treat as a fresh join
        }

        if (this.gameInProgress) {
            this.rejectGuest(conn, 'Game already in progress');
            return;
        }
        if (this.roster.length >= MAX_PLAYERS) {
            this.rejectGuest(conn, 'Room is full (4 players max)');
            return;
        }

        // Lowest free slot 1-3 (slots stay stable when someone leaves)
        let slot = 1;
        while (this.roster.some(r => r.slot === slot)) slot++;

        // First colour nobody has yet, so a 4-player lobby defaults to
        // free-for-all; players regroup into alliances by clicking colours
        const used = new Set(this.roster.map(r => r.color));
        const color = TEAM_COLOR_ORDER.find(c => !used.has(c)) || TEAM_COLOR_ORDER[slot % TEAM_COLOR_ORDER.length];

        const entry = {
            slot,
            name: (typeof data.name === 'string' && data.name.trim()) ? data.name.trim().slice(0, 20) : `Player ${slot + 1}`,
            color,
            ready: false,
            connected: true,
            peerId: conn.peer
        };
        this.roster.push(entry);
        this.roster.sort((a, b) => a.slot - b.slot);
        this.connections.set(conn.peer, conn);
        this.refreshConnectedFlag();

        console.log(`👤 ${entry.name} joined as slot ${slot} (${color})`);

        this.sendToConn(conn, {
            type: 'welcome',
            slot,
            roster: this.publicRoster()
        });
        this.broadcastLobby();
    }

    rejectGuest(conn, message) {
        console.warn('🚫 Rejecting guest:', message);
        this.sendToConn(conn, { type: 'roomFull', message });
        setTimeout(() => { try { conn.close(); } catch (e) { /* already gone */ } }, 500);
    }

    /**
     * A guest's channel closed. In the lobby they simply leave; mid-game we
     * keep their seat so they can reconnect and reclaim it.
     */
    handleGuestGone(conn) {
        const entry = this.roster.find(r => r.peerId === conn.peer);
        this.connections.delete(conn.peer);

        if (!entry || !entry.connected || entry.peerId !== conn.peer) {
            // Never handshook, or already superseded by a reconnect
            this.refreshConnectedFlag();
            return;
        }

        entry.connected = false;
        entry.ready = false;
        this.refreshConnectedFlag();
        console.log(`🔌 ${entry.name} (slot ${entry.slot}) disconnected`);

        if (this.gameInProgress) {
            const evt = { slot: entry.slot, name: entry.name };
            this.broadcast({ type: 'playerDropped', ...evt });
            this.emit('playerDropped', evt);
        } else {
            this.roster = this.roster.filter(r => r !== entry);
            this.broadcastLobby();
        }
    }

    refreshConnectedFlag() {
        if (this.isHost) {
            this.isConnected = [...this.connections.values()].some(c => c.open);
            this.connectionState = this.isConnected ? 'connected' : (this.roster.length ? 'connecting' : 'disconnected');
        }
    }

    /**
     * Roster without host-internal fields, safe to broadcast
     */
    publicRoster() {
        return this.roster.map(({ slot, name, color, ready, connected }) =>
            ({ slot, name, color, ready, connected }));
    }

    broadcastLobby() {
        const payload = { type: 'lobbyUpdate', roster: this.publicRoster() };
        this.broadcast(payload);
        this.emit('lobbyUpdate', { roster: payload.roster });
    }

    // ==================== GUEST: HOST CONNECTION ====================

    /**
     * Set up connection event handlers (guest side: our channel to the host)
     */
    setupConnectionHandlers(conn) {
        conn.on('open', () => {
            console.log('✅ Data channel open!');
            // Capture BEFORE resetting: this is how we know the channel came
            // back from a reconnect (and therefore needs a full state sync)
            const wasReconnect = this.reconnectAttempts > 0;
            this.isConnected = true;
            this.connectionState = 'connected';
            this.reconnectAttempts = 0; // Reset attempts on successful connection

            this.emit('connected', {
                isHost: this.isHost,
                peerId: conn.peer,
                wasReconnect
            });

            // Introduce ourselves. On reconnect, ask for our old seat back.
            this.send({
                type: 'handshake',
                name: this.getLocalName(),
                reclaimSlot: wasReconnect ? this.mySlot : undefined
            });

            // Flush offline queue if any
            if (this.outboundQueue.length > 0) {
                console.log(`📤 Flushing ${this.outboundQueue.length} queued messages...`);
                while (this.outboundQueue.length > 0) {
                    const data = this.outboundQueue.shift();
                    conn.send(data);
                }
            }

            // If we are a guest that just reconnected, request state sync
            // (terrain, health, ammo, crates — we missed everything while away)
            if (!this.isHost && wasReconnect) {
                this.send({ type: 'requestStateSync' });
            }
        });

        conn.on('data', (data) => {
            this.handleMessage(data, null);
        });

        conn.on('close', () => {
            console.log('🔌 Connection closed');
            this.isConnected = false;
            this.connectionState = 'disconnected';
            this.emit('disconnected', { reason: 'Connection closed' });
            this.attemptReconnect();
        });

        conn.on('error', (err) => {
            console.error('Connection error:', err);
            this.emit('error', { message: err.message });
        });
    }

    /**
     * Display name for the local player (persisted so it survives sessions)
     */
    getLocalName() {
        try {
            const stored = localStorage.getItem('koalaPlayerName');
            if (stored && stored.trim()) return stored.trim().slice(0, 20);
        } catch (e) { /* storage unavailable */ }
        return null;
    }

    // ==================== MESSAGES ====================

    /**
     * Handle incoming messages. sourceConn is set on the host (which guest
     * channel the message came in on) and null on guests.
     */
    handleMessage(data, sourceConn) {
        if (!data || typeof data !== 'object') return;
        console.log('📨 Received:', data.type);

        // Host: forward guest-originated game traffic to the other guests
        if (this.isHost && sourceConn && RELAY_TYPES.has(data.type)) {
            this.broadcastExcept(sourceConn.peer, data);
        }

        switch (data.type) {
            // ---- Lobby control (host handles) ----
            case 'handshake':
                if (this.isHost && sourceConn) {
                    this.handleGuestHandshake(data, sourceConn);
                }
                break;

            case 'setColor':
                if (this.isHost && sourceConn) {
                    const entry = this.roster.find(r => r.peerId === sourceConn.peer);
                    if (entry && TEAM_COLOR_ORDER.includes(data.color)) {
                        entry.color = data.color;
                        this.broadcastLobby();
                    }
                }
                break;

            case 'setReady':
                if (this.isHost && sourceConn) {
                    const entry = this.roster.find(r => r.peerId === sourceConn.peer);
                    if (entry) {
                        entry.ready = !!data.ready;
                        this.broadcastLobby();
                    }
                }
                break;

            // ---- Lobby state (guests receive) ----
            case 'welcome':
                this.mySlot = data.slot;
                this.roster = data.roster || [];
                this.emit('welcome', data);
                this.emit('lobbyUpdate', { roster: this.roster });
                break;

            case 'lobbyUpdate': {
                this.roster = data.roster || [];
                // Track our own ready flag from the authoritative roster
                const me = this.roster.find(r => r.slot === this.mySlot);
                if (me) this.isReady = me.ready;
                this.emit('lobbyUpdate', { roster: this.roster });
                break;
            }

            case 'roomFull':
                // Stop the auto-reconnect from hammering a room that turned us away
                this.roomCode = null;
                this.emit('error', { message: data.message || 'Room is full' });
                break;

            case 'playerDropped':
                this.markRosterConnected(data.slot, false);
                this.emit('playerDropped', data);
                break;

            case 'playerReturned':
                this.markRosterConnected(data.slot, true);
                this.emit('playerReturned', data);
                break;

            case 'teamForfeit':
                this.emit('remoteTeamForfeit', data);
                break;

            // ---- Game flow ----
            case 'gameStart':
                this.gamePlayers = data.gameState?.players || null;
                this.gameInProgress = true;
                this.emit('gameStart', data);
                break;

            case 'mapSelected':
                this.emit('mapSelected', data);
                break;

            case 'move':
                this.emit('remoteMove', data);
                break;

            case 'aim':
                this.emit('remoteAim', data);
                break;

            case 'fire':
                this.emit('remoteFire', data);
                break;

            case 'targetWeapon':
                this.emit('remoteTargetWeapon', data);
                break;

            case 'damage':
                this.emit('remoteDamage', data);
                break;

            case 'turnEnd':
                this.emit('remoteTurnEnd', data);
                break;

            case 'turnStart':
                this.emit('remoteTurnStart', data);
                break;

            case 'gameOver':
                this.emit('remoteGameOver', data);
                break;

            case 'crateCollected':
                this.emit('remoteCrateCollected', data);
                break;

            case 'crateDestroyed':
                this.emit('remoteCrateDestroyed', data);
                break;

            case 'explosionSync':
                this.emit('remoteExplosionSync', data);
                break;

            case 'weaponSelect':
                this.emit('remoteWeaponSelect', data);
                break;

            case 'jump':
                this.emit('remoteJump', data);
                break;

            case 'highJump':
                this.emit('remoteHighJump', data);
                break;

            case 'ropeRelease':
                this.emit('remoteRopeRelease', data);
                break;

            case 'stateSync':
                this.emit('remoteStateSync', data);
                break;

            case 'requestStateSync':
                this.emit('remoteRequestStateSync', data);
                break;

            case 'crateSpawn':
                this.emit('remoteCrateSpawn', data);
                break;

            case 'chat':
                this.emit('chatMessage', data);
                break;

            default:
                console.warn('Unknown message type:', data.type);
        }
    }

    markRosterConnected(slot, connected) {
        const entry = this.roster.find(r => r.slot === slot);
        if (entry) entry.connected = connected;
    }

    // ==================== SENDING ====================

    /**
     * Recursively replace non-finite numbers (Infinity / -Infinity / NaN) with a
     * safe default. PeerJS serializes with BinaryPack, whose integer packer throws
     * "Invalid integer" on Infinity (Math.floor(Infinity) === Infinity, so it is
     * treated as an integer but falls outside every representable range). A single
     * bad number — e.g. a position/velocity blown up by physics — would otherwise
     * throw synchronously inside send() and tear down the whole data channel.
     *
     * We log the offending key path so the upstream physics bug stays findable.
     */
    sanitizeOutbound(value, path = '') {
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) {
                console.warn(`🧹 Sanitized non-finite network value at "${path || '<root>'}":`, value);
                return 0;
            }
            return value;
        }

        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) {
                value[i] = this.sanitizeOutbound(value[i], `${path}[${i}]`);
            }
            return value;
        }

        if (value && typeof value === 'object') {
            for (const key of Object.keys(value)) {
                value[key] = this.sanitizeOutbound(value[key], path ? `${path}.${key}` : key);
            }
            return value;
        }

        return value;
    }

    sendToConn(conn, data) {
        data = this.sanitizeOutbound(data);
        if (conn && conn.open) {
            try {
                conn.send(data);
                return true;
            } catch (err) {
                console.error('❌ Failed to send message:', data && data.type, err);
            }
        }
        return false;
    }

    /**
     * Send a message to everyone we're connected to: the host broadcasts to
     * all guests; a guest sends to the host (which relays when appropriate).
     */
    send(data) {
        // Strip Infinity/NaN before serialization so one blown-up number can't
        // crash BinaryPack and drop the connection mid-game.
        data = this.sanitizeOutbound(data);

        if (this.isHost) {
            let sent = false;
            for (const conn of this.connections.values()) {
                if (!conn.open) continue;
                try {
                    conn.send(data);
                    sent = true;
                } catch (err) {
                    console.error('❌ Failed to send message:', data && data.type, err);
                }
            }
            // No queueing on the host: a returning guest gets a full state
            // sync (terrain included), which supersedes anything it missed.
            return sent;
        }

        if (this.connection && this.connection.open) {
            try {
                this.connection.send(data);
            } catch (err) {
                console.error('❌ Failed to send message:', data && data.type, err);
                return false;
            }
            return true;
        } else {
            // Don't queue high-frequency cosmetic updates: replaying stale
            // move/aim spam after a reconnect teleports things around. Turn
            // structure and damage messages ARE queued so nothing is lost.
            if (data.type === 'move' || data.type === 'aim') {
                return false;
            }
            console.warn('⚠️ Cannot send - not connected. Queueing message:', data.type);
            this.outboundQueue.push(data);
            return false;
        }
    }

    /**
     * Host: send to every guest except one (relay + targeted broadcasts)
     */
    broadcast(data) {
        return this.send(data);
    }

    broadcastExcept(exceptPeerId, data) {
        if (!this.isHost) return;
        data = this.sanitizeOutbound(data);
        for (const [peerId, conn] of this.connections) {
            if (peerId === exceptPeerId || !conn.open) continue;
            try {
                conn.send(data);
            } catch (err) {
                console.error('❌ Failed to relay message:', data && data.type, err);
            }
        }
    }

    // ==================== RECONNECTION ====================

    /**
     * Attempt to reconnect to the game
     */
    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ Max reconnect attempts reached');
            this.emit('reconnectFailed');
            this.emit('error', { message: 'Lost connection to game and could not reconnect.' });
            return;
        }

        if (!this.roomCode) return; // Not currently in a game (or we were turned away)

        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 10000); // Expon backoff max 10s

        console.log(`🔄 Attempting to reconnect (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms...`);
        this.connectionState = 'connecting';

        setTimeout(() => {
            if (this.isHost) {
                // Host just needs to make sure its peer is ready to accept connections
                if (this.peer && this.peer.disconnected && !this.peer.destroyed) {
                    this.peer.reconnect();
                }
            } else {
                // Guest needs to establish a new data channel to the host
                if (this.peer && !this.peer.destroyed) {
                    if (this.peer.disconnected) {
                        this.peer.reconnect();
                    }

                    const connectToHost = () => {
                        console.log('📡 Reconnecting to host:', this.roomCode);
                        this.connection = this.peer.connect(this.roomCode, { reliable: true });
                        this.setupConnectionHandlers(this.connection);
                    };

                    if (this.peer.open) {
                        connectToHost();
                    } else {
                        // Wait for peer to re-establish signaling connection before connecting
                        this.peer.once('open', connectToHost);
                    }
                }
            }
        }, delay);
    }

    // ==================== LOBBY ACTIONS ====================

    /**
     * Toggle the local player's ready flag. The host applies it directly;
     * guests ask the host, which broadcasts the updated roster.
     */
    toggleReady() {
        this.isReady = !this.isReady;
        if (this.isHost) {
            const me = this.roster.find(r => r.slot === this.mySlot);
            if (me) me.ready = this.isReady;
            this.broadcastLobby();
        } else {
            this.send({ type: 'setReady', ready: this.isReady });
        }
        return this.isReady;
    }

    /**
     * Ask for a new team colour for the local player. Any number of players
     * may share a colour — that's how alliances are formed.
     */
    requestColor(color) {
        if (!TEAM_COLOR_ORDER.includes(color)) return;
        if (this.isHost) {
            const me = this.roster.find(r => r.slot === this.mySlot);
            if (me) {
                me.color = color;
                this.broadcastLobby();
            }
        } else {
            this.send({ type: 'setColor', color });
        }
    }

    /**
     * Start the game (host only). Ships the seed, match scheme, and the
     * player list in team order — teams[i] belongs to players[i].
     */
    startGame(options = {}) {
        if (!this.isHost) {
            console.warn('Only host can start the game');
            return;
        }

        const players = this.roster
            .filter(r => r.connected)
            .map(({ slot, name, color }) => ({ slot, name, color }));

        if (players.length < 2) {
            console.warn('Need at least 2 connected players to start');
            return;
        }
        if (new Set(players.map(p => p.color)).size < 2) {
            console.warn('Need at least 2 different team colours to start');
            return;
        }

        const gameState = {
            // 1 + ... so the seed can never be 0 (a falsy seed would make both
            // clients silently generate their own random seed — instant desync)
            seed: 1 + Math.floor(Math.random() * 0x7FFFFFFE),
            players,
            customMap: options.customMap,
            // Full match-rule scheme (JSON-safe: infinite ammo is stored as
            // -1, never Infinity — BinaryPack rejects non-finite numbers)
            scheme: options.scheme
        };

        this.gamePlayers = players;
        this.gameInProgress = true;

        // Send start signal to all guests
        this.send({
            type: 'gameStart',
            gameState
        });

        // Also trigger locally
        this.emit('gameStart', { gameState });
    }

    /**
     * Send map + scheme selection (host only)
     */
    sendMapSelection(map, scheme) {
        if (!this.isHost) return;
        this.send({ type: 'mapSelected', map, scheme });
        this.emit('mapSelected', { map, scheme });
    }

    // ==================== IN-GAME ACTIONS ====================

    /**
     * Send movement update. teamIndex/koalaIndex identify the acting koala so
     * the receiver can apply the update to the right entity even if its own
     * turn indices have momentarily drifted.
     */
    sendMove(x, y, facingLeft, blowtorchDigging, teamIndex, koalaIndex) {
        this.send({
            type: 'move',
            x,
            y,
            facingLeft,
            blowtorchDigging,
            teamIndex,
            koalaIndex,
            timestamp: Date.now()
        });
    }

    /**
     * Send aim update (throttled by caller)
     */
    sendAim(angle, teamIndex, koalaIndex) {
        this.send({
            type: 'aim',
            angle,
            teamIndex,
            koalaIndex,
            timestamp: Date.now()
        });
    }

    /**
     * Send fire action
     */
    sendFire(weaponId, angle, power, x, y, teamIndex, koalaIndex, targetX, targetY) {
        const msg = {
            type: 'fire',
            weaponId,
            angle,
            power,
            x,
            y,
            teamIndex,
            koalaIndex,
            timestamp: Date.now()
        };
        // Homing missile: the pre-placed target travels with the fire message
        if (targetX !== undefined && targetY !== undefined) {
            msg.targetX = targetX;
            msg.targetY = targetY;
        }
        this.send(msg);
    }

    /**
     * Send targeted weapon action (airstrike, teleport)
     */
    sendTargetWeapon(weaponId, targetX, targetY, teamIndex, koalaIndex) {
        this.send({
            type: 'targetWeapon',
            weaponId,
            targetX,
            targetY,
            teamIndex,
            koalaIndex,
            timestamp: Date.now()
        });
    }

    /**
     * Send damage results (host is authority)
     */
    sendDamageResults(damages) {
        this.send({
            type: 'damage',
            damages,
            timestamp: Date.now()
        });
    }

    /**
     * Send turn end signal
     */
    sendTurnEnd(nextTeam, nextKoala) {
        this.send({
            type: 'turnEnd',
            nextTeam,
            nextKoala,
            timestamp: Date.now()
        });
    }

    /**
     * Send chat message
     */
    sendChat(message) {
        this.send({
            type: 'chat',
            message,
            playerId: this.playerId,
            timestamp: Date.now()
        });
    }

    // ==================== LIFECYCLE ====================

    /**
     * Cancel hosting/joining and cleanup
     */
    cancel() {
        this.disconnect();
        this.emit('cancelled');
    }

    /**
     * Disconnect and cleanup
     */
    disconnect() {
        if (this.connection) {
            this.connection.close();
            this.connection = null;
        }

        for (const conn of this.connections.values()) {
            try { conn.close(); } catch (e) { /* already gone */ }
        }
        this.connections.clear();

        if (this.peer) {
            this.peer.destroy();
            this.peer = null;
        }

        this.isConnected = false;
        this.isHost = false;
        this.roomCode = null;
        this.connectionState = 'disconnected';
        this.roster = [];
        this.mySlot = null;
        this.isReady = false;
        this.gamePlayers = null;
        this.gameInProgress = false;
        this.outboundQueue = [];
        this.reconnectAttempts = 0;
    }

    // ==================== TEAM OWNERSHIP ====================

    /**
     * Which player slot drives a given team index in the running match
     */
    getTeamOwnerSlot(teamIndex) {
        if (this.gamePlayers && this.gamePlayers[teamIndex]) {
            return this.gamePlayers[teamIndex].slot;
        }
        // Legacy 2-player fallback: host = team 0, guest = team 1
        return teamIndex === 0 ? 0 : 1;
    }

    /**
     * Check if we control a specific team
     */
    isMyTeam(teamIndex) {
        if (this.gamePlayers && this.gamePlayers[teamIndex]) {
            return this.gamePlayers[teamIndex].slot === this.mySlot;
        }
        // Legacy 2-player fallback
        if (this.isHost) {
            return teamIndex === 0;
        } else {
            return teamIndex === 1;
        }
    }

    /**
     * Check if it's currently our turn
     */
    isMyTurn(currentTeamIndex) {
        return this.isMyTeam(currentTeamIndex);
    }
}
