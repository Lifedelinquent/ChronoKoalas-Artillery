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
 * This class is only the TRANSPORT and the lobby. How a running match stays
 * in sync lives in LockstepSession.js: every client simulates the whole
 * game and only the turn owner's input commands travel, as { type: 'ls' }
 * messages that this class hands straight to the session.
 *
 * Spectators join with `spectator: true` in their handshake. They get a
 * roster entry (slot 100+) but no team, don't count toward the 4 players,
 * and may join mid-game. Anyone arriving mid-game — a spectator or a player
 * reconnecting — is sent the match setup plus the command log so far and
 * rebuilds the match by replaying it.
 *
 * Every connection carries a heartbeat (ping/pong). WebRTC can take half a
 * minute to notice a dead link, and often never fires 'close' at all; the
 * heartbeat turns a silent peer into a proper disconnect within seconds.
 */

import { EventEmitter } from '../utils/EventEmitter.js';
import { TEAM_COLOR_ORDER } from '../utils/TeamColors.js';
import { log } from '../utils/Logger.js';

export const MAX_PLAYERS = 4;
export const MAX_SPECTATORS = 6;
const SPECTATOR_SLOT_BASE = 100;

// Guest messages the host forwards verbatim to the other guests. (Match
// traffic is relayed by the LockstepSession, which validates it first.)
const RELAY_TYPES = new Set(['chat']);

// Heartbeat: ping every connection this often; a connection that has been
// completely silent for PEER_TIMEOUT_MS is treated as dead.
const PING_INTERVAL_MS = 2000;
const PEER_TIMEOUT_MS = 12000;

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

        // Lobby roster: [{ slot, name, color, ready, connected, peerId,
        // style, spectator }]. The host mutates it; guests hold the copy
        // from the last lobbyUpdate.
        this.roster = [];
        this.mySlot = null;
        this.isReady = false;

        // Local player's team customisation (sent in the handshake) and
        // whether we joined to watch rather than play
        this.localStyle = null;
        this.isSpectator = false;

        // Host: the last gameStart payload, for spectators joining mid-game
        this.lastGameState = null;

        // Team ownership for the running match: gameState.players in team
        // order, captured at gameStart. teams[i] is driven by gamePlayers[i].
        this.gamePlayers = null;
        this.gameInProgress = false;

        // Connection state
        this.connectionState = 'disconnected'; // disconnected, connecting, connected

        // Queuing and reconnection (guest side)
        this.outboundQueue = [];
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 6;

        // Heartbeat state: last time anything arrived per connection, and
        // the measured round trip (ms) — to the host on a guest, the worst
        // guest on the host
        this.lastSeen = new Map();
        this.rttByPeer = new Map();
        this.rtt = null;
        this.heartbeatId = null;
        this.reconnectTimer = null;
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

        log.debug('🎮 Hosting game with code:', this.roomCode);

        return new Promise((resolve, reject) => {
            try {
                // Create peer with our room code as the ID
                this.peer = new Peer(this.roomCode, {
                    debug: 1 // Minimal logging
                });

                this.peer.on('open', (id) => {
                    log.debug('✅ Peer created with ID:', id);
                    this.playerId = id;
                    this.mySlot = 0;
                    this.roster = [{
                        slot: 0,
                        name: this.getLocalName() || 'Player 1',
                        color: TEAM_COLOR_ORDER[0],
                        ready: false,
                        connected: true,
                        peerId: id,
                        style: this.localStyle,
                        spectator: false
                    }];
                    this.startHeartbeat();
                    this.emit('hostReady', { roomCode: this.roomCode });
                    this.emit('lobbyUpdate', { roster: this.publicRoster() });
                    resolve(this.roomCode);
                });

                this.peer.on('connection', (conn) => {
                    log.debug('🔗 Player connecting:', conn.peer);
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
                    log.debug('⚠️ Disconnected from signaling server');
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
    async joinGame(roomCode, { spectator = false } = {}) {
        this.isHost = false;
        this.isSpectator = !!spectator;
        this.roomCode = roomCode.toUpperCase();
        this.connectionState = 'connecting';

        log.debug('🔗 Joining game:', this.roomCode);

        return new Promise((resolve, reject) => {
            try {
                // Create our own peer first
                this.peer = new Peer({
                    debug: 1
                });

                let joined = false;
                this.peer.on('open', (id) => {
                    log.debug('✅ Our peer ID:', id);
                    this.playerId = id;

                    // The signalling server re-opens after a blip too: only
                    // the first open starts the join
                    if (joined) return;
                    joined = true;

                    // Now connect to the host
                    log.debug('📡 Connecting to host:', this.roomCode);
                    this.connection = this.peer.connect(this.roomCode, {
                        reliable: true
                    });

                    this.setupConnectionHandlers(this.connection);
                    this.startHeartbeat();

                    // Set a timeout for connection
                    const timeout = setTimeout(() => {
                        if (!this.isConnected) {
                            this.emit('error', { message: 'Connection timed out' });
                            reject(new Error('Connection timed out'));
                        }
                    }, 15000);

                    this.connection.on('open', () => {
                        clearTimeout(timeout);
                    });
                });

                // Lost the signalling server (not the game link): get back on
                // it so a later reconnect to the host can be brokered
                this.peer.on('disconnected', () => {
                    if (this.peer && !this.peer.destroyed) {
                        try { this.peer.reconnect(); } catch (e) { /* retried on next drop */ }
                    }
                });

                this.peer.on('error', (err) => {
                    console.error('❌ Peer error:', err);

                    // Mid-match these are reconnect attempts failing (the
                    // host is briefly unreachable): keep retrying quietly
                    if (this.gameInProgress || this.reconnectAttempts > 0) {
                        if (err.type === 'peer-unavailable') this.attemptReconnect();
                        return;
                    }

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
            log.debug('✅ Data channel open (guest):', conn.peer);
            this.lastSeen.set(conn, performance.now());
            // Roster placement happens on handshake
        });

        conn.on('data', (data) => {
            this.lastSeen.set(conn, performance.now());
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
            // The seat is free to reclaim if we saw its player drop — or if
            // this IS that player on a fresh channel (a guest often notices
            // a dead link before we do, and keeps its peer id)
            if (entry && (!entry.connected || entry.peerId === conn.peer)) {
                log.debug(`🔗 Guest reclaiming slot ${entry.slot}`);
                // Retire the channel still registered for that seat
                const old = entry.peerId ? this.connections.get(entry.peerId) : null;
                if (entry.peerId) this.connections.delete(entry.peerId);
                if (old && old !== conn) {
                    this.lastSeen.delete(old);
                    try { old.close(); } catch (e) { /* already gone */ }
                }
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
                    // They rebuild the match from the log (see sendResume)
                    this.emit('needResume', { peerId: conn.peer, spectate: false });
                }
                return;
            }
            // Fall through: unknown/occupied slot — treat as a fresh join
        }

        if (data.spectator) {
            this.addSpectator(data, conn);
            return;
        }

        if (this.gameInProgress) {
            this.rejectGuest(conn, 'Game already in progress — join as a spectator to watch');
            return;
        }
        if (this.roster.filter(r => !r.spectator).length >= MAX_PLAYERS) {
            this.rejectGuest(conn, 'Room is full (4 players max) — join as a spectator to watch');
            return;
        }

        // Lowest free player slot 1-3 (slots stay stable when someone leaves)
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
            peerId: conn.peer,
            style: data.style && typeof data.style === 'object' ? data.style : null,
            spectator: false
        };
        this.roster.push(entry);
        this.roster.sort((a, b) => a.slot - b.slot);
        this.connections.set(conn.peer, conn);
        this.refreshConnectedFlag();

        log.debug(`👤 ${entry.name} joined as slot ${slot} (${color})`);

        this.sendToConn(conn, {
            type: 'welcome',
            slot,
            roster: this.publicRoster()
        });
        this.broadcastLobby();
    }

    /**
     * Seat a spectator (lobby or mid-game). Mid-game they also get the match
     * setup so they can build the world, then request a state sync.
     */
    addSpectator(data, conn) {
        const spectators = this.roster.filter(r => r.spectator);
        if (spectators.length >= MAX_SPECTATORS) {
            this.rejectGuest(conn, 'Too many spectators in this room');
            return;
        }
        let slot = SPECTATOR_SLOT_BASE;
        while (this.roster.some(r => r.slot === slot)) slot++;

        const entry = {
            slot,
            name: (typeof data.name === 'string' && data.name.trim()) ? data.name.trim().slice(0, 20) : `Spectator ${slot - SPECTATOR_SLOT_BASE + 1}`,
            color: null,
            ready: true,
            connected: true,
            peerId: conn.peer,
            style: null,
            spectator: true
        };
        this.roster.push(entry);
        this.roster.sort((a, b) => a.slot - b.slot);
        this.connections.set(conn.peer, conn);
        this.refreshConnectedFlag();
        log.debug(`👀 ${entry.name} is spectating (slot ${slot})`);

        this.sendToConn(conn, {
            type: 'welcome',
            slot,
            roster: this.publicRoster(),
            spectator: true,
            midGame: this.gameInProgress
        });
        this.broadcastLobby();

        if (this.gameInProgress && this.lastGameState) {
            this.emit('needResume', { peerId: conn.peer, spectate: true });
        }
    }

    /**
     * Host: send a late joiner (reconnecting player or mid-game spectator)
     * the match setup and everything that has happened in it so far.
     * `resume` comes from LockstepSession.resumeData().
     */
    sendResume(peerId, resume, { spectate = false } = {}) {
        if (!this.isHost || !this.lastGameState) return;
        this.sendTo(peerId, {
            type: 'gameStart',
            gameState: this.lastGameState,
            spectate,
            resume
        });
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
        this.lastSeen.delete(conn);
        // A stale channel closing after its guest already reconnected on a
        // new one (same peer id) is not a departure
        const current = this.connections.get(conn.peer);
        if (current && current !== conn) return;

        const entry = this.roster.find(r => r.peerId === conn.peer);
        this.connections.delete(conn.peer);
        this.rttByPeer.delete(conn.peer);

        if (!entry || !entry.connected || entry.peerId !== conn.peer) {
            // Never handshook, or already superseded by a reconnect
            this.refreshConnectedFlag();
            return;
        }

        entry.connected = false;
        entry.ready = false;
        this.refreshConnectedFlag();
        log.debug(`🔌 ${entry.name} (slot ${entry.slot}) disconnected`);

        // Spectators just leave — nobody waits for them
        if (entry.spectator) {
            this.roster = this.roster.filter(r => r !== entry);
            this.broadcastLobby();
            return;
        }

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
        return this.roster.map(({ slot, name, color, ready, connected, style, spectator }) =>
            ({ slot, name, color, ready, connected, style: style || null, spectator: !!spectator }));
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
            if (conn !== this.connection) return; // superseded by a newer attempt
            log.debug('✅ Data channel open!');
            this.lastSeen.set(conn, performance.now());
            // Capture BEFORE resetting: this is how we know the channel came
            // back from a reconnect (the host then sends us the match again)
            const wasReconnect = this.reconnectAttempts > 0;
            this.reconnectTimer = null;
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
                reclaimSlot: wasReconnect ? this.mySlot : undefined,
                style: this.localStyle,
                spectator: this.isSpectator
            });

            // Flush offline queue if any (lobby/chat messages only — match
            // traffic is never queued, see send())
            if (this.outboundQueue.length > 0) {
                log.debug(`📤 Flushing ${this.outboundQueue.length} queued messages...`);
                while (this.outboundQueue.length > 0) {
                    const data = this.outboundQueue.shift();
                    conn.send(data);
                }
            }
        });

        conn.on('data', (data) => {
            if (conn !== this.connection) return;
            this.lastSeen.set(conn, performance.now());
            this.handleMessage(data, null);
        });

        conn.on('close', () => this.handleHostLinkLost(conn, 'Connection closed'));

        conn.on('error', (err) => {
            console.error('Connection error:', err);
            if (conn !== this.connection) return;
            // Mid-match a broken channel is a disconnect, not a lobby error
            if (this.gameInProgress) this.handleHostLinkLost(conn, 'Connection error');
            else this.emit('error', { message: err.message });
        });
    }

    /**
     * Guest: our channel to the host is gone (closed, errored, or silent
     * past the heartbeat timeout). Tell the app and start reconnecting.
     */
    handleHostLinkLost(conn, reason) {
        if (conn !== this.connection) return; // an old channel we already replaced
        if (!this.isConnected && this.reconnectAttempts > 0) return; // already handling it
        log.debug('🔌 Lost the host link:', reason);
        this.lastSeen.delete(conn);
        const wasConnected = this.isConnected;
        this.isConnected = false;
        this.connectionState = 'disconnected';
        this.rtt = null;
        if (wasConnected) this.emit('disconnected', { reason });
        this.attemptReconnect();
    }

    // ==================== HEARTBEAT ====================

    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatId = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
    }

    stopHeartbeat() {
        if (this.heartbeatId) clearInterval(this.heartbeatId);
        this.heartbeatId = null;
    }

    heartbeat() {
        const now = performance.now();
        const ping = { type: 'ping', t: now };

        if (this.isHost) {
            for (const conn of [...this.connections.values()]) {
                if (!conn.open) continue;
                if (now - (this.lastSeen.get(conn) ?? now) > PEER_TIMEOUT_MS) {
                    console.warn('💔 Guest went silent — dropping', conn.peer);
                    try { conn.close(); } catch (e) { /* already gone */ }
                    this.handleGuestGone(conn);
                    continue;
                }
                try { conn.send(ping); } catch (e) { /* closing */ }
            }
            return;
        }

        const conn = this.connection;
        if (!conn || !conn.open || !this.isConnected) return;
        if (now - (this.lastSeen.get(conn) ?? now) > PEER_TIMEOUT_MS) {
            console.warn('💔 Host went silent — reconnecting');
            this.handleHostLinkLost(conn, 'Host stopped responding');
            try { conn.close(); } catch (e) { /* already gone */ }
            return;
        }
        try { conn.send(ping); } catch (e) { /* closing */ }
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

        // Hot path: match traffic goes straight to the lockstep session
        if (data.type === 'ls') {
            this.emit('lockstep', { msg: data, fromPeer: sourceConn?.peer || null });
            return;
        }
        if (data.type === 'ping') {
            const reply = { type: 'pong', t: data.t };
            if (sourceConn) this.sendToConn(sourceConn, reply);
            else if (this.connection?.open) this.connection.send(reply);
            return;
        }
        if (data.type === 'pong') {
            const rtt = Math.max(0, performance.now() - data.t);
            if (sourceConn) {
                this.rttByPeer.set(sourceConn.peer, rtt);
                this.rtt = Math.max(...this.rttByPeer.values());
            } else {
                this.rtt = rtt;
            }
            return;
        }

        log.debug('📨 Received:', data.type);

        // Host: forward chat to the other guests
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

            case 'rematchRequest':
                // A guest wants another round; only the host can start it
                if (this.isHost && sourceConn) {
                    const entry = this.roster.find(r => r.peerId === sourceConn.peer);
                    this.emit('rematchRequest', { name: entry?.name || 'A player' });
                }
                break;

            case 'returnToLobby':
                this.gameInProgress = false;
                this.gamePlayers = null;
                this.isReady = false;
                this.emit('returnToLobby', data);
                break;

            // ---- Lobby state (guests receive) ----
            case 'welcome':
                this.mySlot = data.slot;
                this.isSpectator = !!data.spectator;
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

            case 'requestResume':
                // A guest whose match stream broke asks for the match again
                if (this.isHost && sourceConn && this.gameInProgress) {
                    const entry = this.roster.find(r => r.peerId === sourceConn.peer);
                    this.emit('needResume', { peerId: sourceConn.peer, spectate: !!entry?.spectator });
                }
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

    /** Host: send to one guest by peer id. */
    sendTo(peerId, data) {
        if (!this.isHost) return this.send(data);
        return this.sendToConn(this.connections.get(peerId), data);
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
     * all guests; a guest sends to the host.
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
            // No queueing on the host: a returning guest is sent the whole
            // match again, which supersedes anything it missed.
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
            // Match traffic is never queued: after a reconnect we rebuild
            // the match from the host's log, and frames produced while cut
            // off don't exist as far as anyone else is concerned.
            if (data.type === 'ls' || data.type === 'ping' || data.type === 'pong') {
                return false;
            }
            log.debug('⚠️ Not connected - queueing message:', data.type);
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
        if (this.isHost) return;       // the host IS the room: guests come back to it
        if (!this.roomCode) return;    // not in a room (or we were turned away)
        if (this.reconnectTimer) return; // an attempt is already scheduled

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ Max reconnect attempts reached');
            this.emit('reconnectFailed');
            this.emit('error', { message: 'Lost connection to game and could not reconnect.' });
            return;
        }

        this.reconnectAttempts++;
        const attempt = this.reconnectAttempts;
        const delay = Math.min(500 * Math.pow(2, attempt - 1), 8000); // backoff, max 8s

        log.debug(`🔄 Reconnecting (attempt ${attempt}/${this.maxReconnectAttempts}) in ${delay}ms...`);
        this.connectionState = 'connecting';

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.peer || this.peer.destroyed || !this.roomCode) return;

            const connectToHost = () => {
                if (!this.peer || this.peer.destroyed || this.isConnected) return;
                log.debug('📡 Reconnecting to host:', this.roomCode);
                const old = this.connection;
                this.connection = this.peer.connect(this.roomCode, { reliable: true });
                this.setupConnectionHandlers(this.connection);
                try { old?.close(); } catch (e) { /* already gone */ }

                // This attempt gets a few seconds to open, then the next one
                const conn = this.connection;
                setTimeout(() => {
                    if (this.connection === conn && !this.isConnected && attempt === this.reconnectAttempts) {
                        this.attemptReconnect();
                    }
                }, 6000);
            };

            if (this.peer.disconnected) {
                // Signalling server link is down too: restore it first
                this.peer.once('open', connectToHost);
                try { this.peer.reconnect(); } catch (e) { /* retried below */ }
                setTimeout(() => {
                    if (!this.isConnected && attempt === this.reconnectAttempts && this.connection && !this.connection.open) {
                        this.attemptReconnect();
                    }
                }, 6000);
            } else {
                connectToHost();
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
            return false;
        }

        const players = this.roster
            .filter(r => r.connected && !r.spectator)
            .map(({ slot, name, color, style }) => ({ slot, name, color, style: style || null }));

        if (players.length < 2) {
            console.warn('Need at least 2 connected players to start');
            return false;
        }
        if (new Set(players.map(p => p.color)).size < 2) {
            console.warn('Need at least 2 different team colours to start');
            return false;
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
        this.lastGameState = gameState;

        // Send start signal to all guests
        this.send({
            type: 'gameStart',
            gameState
        });

        // Also trigger locally
        this.emit('gameStart', { gameState });
        return true;
    }

    /**
     * Host: everyone back to the lobby (to change map/scheme/teams). Players
     * who dropped during the match are cleared out; ready flags reset.
     */
    returnToLobby() {
        if (!this.isHost) return;
        this.gameInProgress = false;
        this.gamePlayers = null;
        this.lastGameState = null;
        this.isReady = false;
        this.roster = this.roster.filter(r => r.connected);
        for (const r of this.roster) r.ready = !!r.spectator;
        this.send({ type: 'returnToLobby' });
        this.emit('returnToLobby', {});
        this.broadcastLobby();
    }

    /** Guest: ask the host for another round. */
    requestRematch() {
        if (this.isHost) return;
        this.send({ type: 'rematchRequest' });
    }

    /** Update our team customisation (lobby). */
    setLocalStyle(style) {
        this.localStyle = style;
        if (this.isHost) {
            const me = this.roster.find(r => r.slot === this.mySlot);
            if (me) {
                me.style = style;
                this.broadcastLobby();
            }
        }
    }

    /**
     * Send map + scheme selection (host only)
     */
    sendMapSelection(map, scheme) {
        if (!this.isHost) return;
        this.send({ type: 'mapSelected', map, scheme });
        this.emit('mapSelected', { map, scheme });
    }

    // ==================== CHAT ====================

    /**
     * Send chat message
     */
    sendChat(message) {
        const me = this.roster.find(r => r.slot === this.mySlot);
        const msg = {
            type: 'chat',
            message: String(message).slice(0, 200),
            name: me?.name || this.getLocalName() || 'Player',
            color: me?.color || null,
            spectator: !!me?.spectator,
            timestamp: Date.now()
        };
        this.send(msg);
        return msg;
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
        this.stopHeartbeat();
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.lastSeen.clear();
        this.rttByPeer.clear();
        this.rtt = null;

        if (this.connection) {
            const conn = this.connection;
            this.connection = null; // first, so its 'close' is ignored
            try { conn.close(); } catch (e) { /* already gone */ }
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
        this.isSpectator = false;
        this.gamePlayers = null;
        this.gameInProgress = false;
        this.lastGameState = null;
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

}
