/**
 * Network Manager - PeerJS-based P2P multiplayer
 * Uses WebRTC data channels for direct player-to-player communication
 */

import { EventEmitter } from '../utils/EventEmitter.js';

export class NetworkManager extends EventEmitter {
    constructor() {
        super();

        this.peer = null;
        this.connection = null;

        this.roomCode = null;
        this.playerId = null;
        this.isHost = false;
        this.isConnected = false;

        // Connection state
        this.connectionState = 'disconnected'; // disconnected, connecting, connected

        // Queuing and reconnection
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
     * Host a new game - creates a PeerJS peer and waits for connection
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
                    this.emit('hostReady', { roomCode: this.roomCode });
                    resolve(this.roomCode);
                });

                this.peer.on('connection', (conn) => {
                    console.log('🔗 Player connecting...');
                    this.connection = conn;
                    this.setupConnectionHandlers(conn);
                });

                this.peer.on('error', (err) => {
                    console.error('❌ Peer error:', err);
                    this.connectionState = 'disconnected';

                    if (err.type === 'unavailable-id') {
                        // Room code already in use, generate new one
                        this.emit('error', { message: 'Room code in use, try again' });
                    } else if (err.type === 'peer-unavailable') {
                        this.emit('error', { message: 'Could not find that room' });
                    } else {
                        this.emit('error', { message: err.message || 'Connection failed' });
                    }
                    reject(err);
                });

                this.peer.on('disconnected', () => {
                    console.log('⚠️ Disconnected from signaling server');
                    // Try to reconnect
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

    /**
     * Set up connection event handlers
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

            // Send initial handshake
            this.send({
                type: 'handshake',
                isHost: this.isHost,
                playerId: this.playerId
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
            this.handleMessage(data);
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
     * Handle incoming messages
     */
    handleMessage(data) {
        console.log('📨 Received:', data.type);

        switch (data.type) {
            case 'handshake':
                // This is info about the OTHER player who just connected
                // If they say they're host, that means WE are the guest (and vice versa)
                const peerName = data.isHost ? 'Host' : 'Guest';
                const peerTeam = data.isHost ? 'red' : 'blue';
                this.emit('playerJoined', {
                    player: { id: data.playerId, name: peerName },
                    team: peerTeam
                });
                break;

            case 'ready':
                this.emit('playerReady', { playerId: data.playerId, ready: data.ready });
                break;

            case 'gameStart':
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

    /**
     * Send a message to the connected peer
     */
    send(data) {
        // Strip Infinity/NaN before serialization so one blown-up number can't
        // crash BinaryPack and drop the connection mid-game.
        data = this.sanitizeOutbound(data);

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
     * Attempt to reconnect to the game
     */
    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ Max reconnect attempts reached');
            this.emit('reconnectFailed');
            this.emit('error', { message: 'Lost connection to game and could not reconnect.' });
            return;
        }

        if (!this.roomCode) return; // Not currently in a game

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

    /**
     * Send player ready status
     */
    toggleReady() {
        this.isReady = !this.isReady;
        this.send({
            type: 'ready',
            playerId: this.playerId,
            ready: this.isReady
        });
        this.emit('playerReady', { playerId: this.playerId, ready: this.isReady });
        return this.isReady;
    }

    /**
     * Start the game (host only)
     */
    startGame(options = {}) {
        if (!this.isHost) {
            console.warn('Only host can start the game');
            return;
        }

        const gameState = {
            // 1 + ... so the seed can never be 0 (a falsy seed would make both
            // clients silently generate their own random seed — instant desync)
            seed: 1 + Math.floor(Math.random() * 0x7FFFFFFE),
            teams: ['red', 'blue'],
            customMap: options.customMap,
            // Full match-rule scheme (JSON-safe: infinite ammo is stored as
            // -1, never Infinity — BinaryPack rejects non-finite numbers)
            scheme: options.scheme
        };

        // Send start signal to peer
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
    sendFire(weaponId, angle, power, x, y, teamIndex, koalaIndex) {
        this.send({
            type: 'fire',
            weaponId,
            angle,
            power,
            x,
            y,
            teamIndex,
            koalaIndex,
            timestamp: Date.now()
        });
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

        if (this.peer) {
            this.peer.destroy();
            this.peer = null;
        }

        this.isConnected = false;
        this.isHost = false;
        this.roomCode = null;
        this.connectionState = 'disconnected';
    }

    /**
     * Check if we control a specific team
     */
    isMyTeam(teamIndex) {
        // Host controls team 0 (red), Guest controls team 1 (blue)
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
