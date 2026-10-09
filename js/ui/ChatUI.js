/**
 * ChatUI - multiplayer chat in the lobby and in game.
 *
 * Lobby: an always-visible log + input under the roster.
 * In game: recent lines fade out in the corner; the chat key (T) opens an
 * input line, Enter sends, Escape closes. Text is always rendered with
 * textContent — chat comes from other players and is never trusted as HTML.
 */

import { TEAM_COLORS } from '../utils/TeamColors.js';

const MAX_LINES = 60;
const GAME_LINE_SECONDS = 9;

export class ChatUI {
    constructor(networkManager) {
        this.net = networkManager;
        this.lobbyLog = document.getElementById('lobby-chat-log');
        this.lobbyInput = document.getElementById('lobby-chat-input');
        this.gameLog = document.getElementById('game-chat-log');
        this.gameInput = document.getElementById('game-chat-input');

        networkManager.on('chatMessage', (msg) => this.add(msg));

        this.lobbyInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.sendFrom(this.lobbyInput);
        });
        this.gameInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.sendFrom(this.gameInput);
                this.closeGameInput();
            } else if (e.key === 'Escape') {
                this.closeGameInput();
            }
            e.stopPropagation();
        });
        this.gameInput?.addEventListener('blur', () => this.closeGameInput());
    }

    sendFrom(input) {
        const text = input.value.trim();
        input.value = '';
        if (!text || !this.net.isConnected && !this.net.isHost) return;
        const msg = this.net.sendChat(text);
        this.add(msg);
    }

    /** System notice (joins, leaves, rematch requests). */
    system(text) {
        this.add({ system: true, message: text });
    }

    add(msg) {
        for (const log of [this.lobbyLog, this.gameLog]) {
            if (!log) continue;
            const line = document.createElement('div');
            line.className = 'chat-line' + (msg.system ? ' system' : '');
            if (!msg.system) {
                const name = document.createElement('strong');
                name.textContent = (msg.spectator ? '👀 ' : '') + (msg.name || 'Player') + ': ';
                if (msg.color) name.style.color = TEAM_COLORS[msg.color] || msg.color;
                line.appendChild(name);
            }
            line.appendChild(document.createTextNode(String(msg.message || '').slice(0, 200)));
            log.appendChild(line);
            while (log.children.length > MAX_LINES) log.firstChild.remove();
            log.scrollTop = log.scrollHeight;

            if (log === this.gameLog) {
                setTimeout(() => line.classList.add('fade'), GAME_LINE_SECONDS * 1000);
            }
        }
    }

    /** In-game: open the input line (chat key). */
    openGameInput() {
        if (!this.gameInput || !this.net.roomCode) return;
        this.gameInput.parentElement.classList.add('typing');
        this.gameInput.classList.remove('hidden');
        this.gameInput.focus();
    }

    closeGameInput() {
        if (!this.gameInput) return;
        this.gameInput.classList.add('hidden');
        this.gameInput.parentElement.classList.remove('typing');
        this.gameInput.blur();
    }

    clear() {
        if (this.lobbyLog) this.lobbyLog.innerHTML = '';
        if (this.gameLog) this.gameLog.innerHTML = '';
    }
}
