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
            this.isConnected = true;
            this.connectionState = 'connected';

            this.emit('connected', {
                isHost: this.isHost,
                peerId: conn.peer
            });

            // Send initial handshake
            this.send({
                type: 'handshake',
                isHost: this.isHost,
                playerId: this.playerId
            });
        });

        conn.on('data', (data) => {
            this.handleMessage(data);
        });

        conn.on('close', () => {
            console.log('🔌 Connection closed');
            this.isConnected = false;
            this.connectionState = 'disconnected';
            this.emit('disconnected', { reason: 'Connection closed' });
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

            case 'chat':
                this.emit('chatMessage', data);
                break;

            default:
                console.warn('Unknown message type:', data.type);
        }
    }

    /**
     * Send a message to the connected peer
     */
    send(data) {
        if (this.connection && this.connection.open) {
            this.connection.send(data);
            return true;
        } else {
            console.warn('Cannot send - not connected');
            return false;
        }
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
            seed: Math.floor(Math.random() * 1000000),
            teams: ['red', 'blue'],
            customMap: options.customMap
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
     * Send map selection (host only)
     */
    sendMapSelection(map) {
        if (!this.isHost) return;
        this.send({ type: 'mapSelected', map });
        this.emit('mapSelected', { map });
    }

    /**
     * Send movement update
     */
    sendMove(x, y, facingLeft) {
        this.send({
            type: 'move',
            x,
            y,
            facingLeft,
            timestamp: Date.now()
        });
    }

    /**
     * Send aim update (throttled by caller)
     */
    sendAim(angle) {
        this.send({
            type: 'aim',
            angle,
            timestamp: Date.now()
        });
    }

    /**
     * Send fire action
     */
    sendFire(weaponId, angle, power, x, y) {
        this.send({
            type: 'fire',
            weaponId,
            angle,
            power,
            x,
            y,
            timestamp: Date.now()
        });
    }

    /**
     * Send targeted weapon action (airstrike, teleport)
     */
    sendTargetWeapon(weaponId, targetX, targetY) {
        this.send({
            type: 'targetWeapon',
            weaponId,
            targetX,
            targetY,
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
