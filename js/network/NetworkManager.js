/**
 * Network Manager - WebSocket/WebRTC multiplayer support
 */

import { EventEmitter } from '../utils/EventEmitter.js';

export class NetworkManager extends EventEmitter {
    constructor() {
        super();

        this.socket = null;
        this.peerConnection = null;
        this.dataChannel = null;

        this.roomCode = null;
        this.playerId = null;
        this.isHost = false;
        this.isReady = false;

        // For demo: use simple WebSocket
        // In production: use WebRTC with signaling server
        this.serverUrl = 'wss://koala-artillery-server.example.com';

        // For local testing without server
        this.useLocalMode = true;
    }

    /**
     * Generate a random room code
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
     * Generate a player ID
     */
    generatePlayerId() {
        return 'player_' + Math.random().toString(36).substr(2, 9);
    }

    /**
     * Host a new game
     */
    async hostGame() {
        this.isHost = true;
        this.playerId = this.generatePlayerId();
        this.roomCode = this.generateRoomCode();

        if (this.useLocalMode) {
            // Local mode - just create room code
            console.log('🎮 Hosting game (local mode):', this.roomCode);

            // Add self as player
            setTimeout(() => {
                this.emit('playerJoined', {
                    player: { id: this.playerId, name: 'Host Player' },
                    team: 'red'
                });
            }, 100);

            return this.roomCode;
        }

        try {
            this.socket = new WebSocket(this.serverUrl);

            await new Promise((resolve, reject) => {
                this.socket.onopen = resolve;
                this.socket.onerror = reject;
            });

            this.setupSocketHandlers();

            // Create room on server
            this.send({
                type: 'createRoom',
                roomCode: this.roomCode,
                playerId: this.playerId
            });

            return this.roomCode;
        } catch (error) {
            console.error('Failed to connect to server:', error);
            return null;
        }
    }

    /**
     * Join an existing game
     */
    async joinGame(roomCode) {
        this.isHost = false;
        this.playerId = this.generatePlayerId();
        this.roomCode = roomCode;

        if (this.useLocalMode) {
            console.log('🎮 Joining game (local mode):', roomCode);

            // Simulate joining
            setTimeout(() => {
                this.emit('playerJoined', {
                    player: { id: this.playerId, name: 'Guest Player' },
                    team: 'blue'
                });
            }, 100);

            return true;
        }

        try {
            this.socket = new WebSocket(this.serverUrl);

            await new Promise((resolve, reject) => {
                this.socket.onopen = resolve;
                this.socket.onerror = reject;
            });

            this.setupSocketHandlers();

            // Join room on server
            this.send({
                type: 'joinRoom',
                roomCode: this.roomCode,
                playerId: this.playerId
            });

            return true;
        } catch (error) {
            console.error('Failed to connect to server:', error);
            return false;
        }
    }

    /**
     * Set up WebSocket event handlers
     */
    setupSocketHandlers() {
        this.socket.onmessage = (event) => {
            const data = JSON.parse(event.data);
            this.handleMessage(data);
        };

        this.socket.onclose = () => {
            console.log('Disconnected from server');
            this.emit('disconnected');
        };

        this.socket.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
    }

    /**
     * Handle incoming message
     */
    handleMessage(data) {
        switch (data.type) {
            case 'playerJoined':
                this.emit('playerJoined', data);
                break;
            case 'playerLeft':
                this.emit('playerLeft', data);
                break;
            case 'playerReady':
                this.emit('playerReady', data);
                break;
            case 'gameStart':
                this.emit('gameStart', data);
                break;
            case 'mapSelected':
                this.emit('mapSelected', data);
                break;
            case 'gameAction':
                this.emit('gameAction', data.action);
                break;
            case 'error':
                console.error('Server error:', data.message);
                break;
        }
    }

    /**
     * Send message to server
     */
    send(data) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(data));
        }
    }

    /**
     * Toggle ready status
     */
    toggleReady() {
        this.isReady = !this.isReady;

        if (this.useLocalMode) {
            this.emit('playerReady', {
                playerId: this.playerId,
                ready: this.isReady
            });
            return;
        }

        this.send({
            type: 'ready',
            playerId: this.playerId,
            ready: this.isReady
        });
    }

    /**
     * Start the game (host only)
     */
    startGame(options = {}) {
        if (!this.isHost) return;

        if (this.useLocalMode) {
            // Generate initial game state
            const gameState = {
                seed: Math.floor(Math.random() * 1000000),
                teams: ['red', 'blue']
            };

            this.emit('gameStart', {
                gameState,
                customMap: options.customMap
            });
            return;
        }

        this.send({
            type: 'startGame',
            roomCode: this.roomCode,
            customMap: options.customMap
        });
    }

    /**
     * Send map selection to other players (host only)
     */
    sendMapSelection(map) {
        if (!this.isHost) return;

        if (this.useLocalMode) {
            this.emit('mapSelected', { map });
            return;
        }

        this.send({
            type: 'mapSelection',
            roomCode: this.roomCode,
            map: map
        });
    }

    /**
     * Send game action
     */
    sendAction(action) {
        if (this.useLocalMode) {
            // In local mode, actions are applied directly
            return;
        }

        this.send({
            type: 'gameAction',
            roomCode: this.roomCode,
            playerId: this.playerId,
            action
        });
    }

    /**
     * Leave the lobby
     */
    leaveLobby() {
        if (this.useLocalMode) {
            this.roomCode = null;
            return;
        }

        this.send({
            type: 'leaveRoom',
            roomCode: this.roomCode,
            playerId: this.playerId
        });

        this.disconnect();
    }

    /**
     * Disconnect from server
     */
    disconnect() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }

        this.roomCode = null;
        this.isHost = false;
        this.isReady = false;
    }
}
