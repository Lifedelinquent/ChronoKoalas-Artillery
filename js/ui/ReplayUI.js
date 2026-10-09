/**
 * ReplayUI - the replay browser modal and the playback control bar.
 *
 * The browser lists replays saved in IndexedDB (every finished local match
 * is saved automatically), with watch / download / delete, and can import
 * .koalareplay files. The control bar appears while a replay plays:
 * pause, speed (1x-8x), skip to the next turn, and exit.
 */

import { ReplayStore, validateReplay } from '../replay/Replay.js';

function fmtDuration(frames) {
    const s = Math.round((frames || 0) / 60);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtDate(iso) {
    try {
        return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) {
        return iso || '';
    }
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

export class ReplayUI {
    /**
     * @param {Object} hooks { onWatch(replay) }
     */
    constructor(hooks) {
        this.hooks = hooks;
        this.modal = document.getElementById('replay-modal');
        this.list = document.getElementById('replay-list');
        this.bar = document.getElementById('replay-controls');

        document.getElementById('btn-replay-close')?.addEventListener('click', () => this.close());
        document.getElementById('btn-replay-import')?.addEventListener('click', () => this.importFile());
    }

    async open() {
        this.modal.classList.remove('hidden');
        await this.refresh();
    }

    close() {
        this.modal.classList.add('hidden');
    }

    async refresh() {
        const replays = await ReplayStore.list();
        this.list.innerHTML = '';
        if (replays.length === 0) {
            this.list.appendChild(el('p', 'replay-empty',
                'No replays yet. Every single-player and hotseat match you finish is saved here automatically.'));
            return;
        }

        for (const r of replays) {
            const row = el('div', 'replay-row');

            const info = el('div', 'replay-info');
            const title = el('strong', null, r.title || 'Match');
            info.appendChild(title);
            const teams = el('div', 'replay-teams');
            (r.teams || []).forEach((t, i) => {
                if (i > 0) teams.appendChild(document.createTextNode(' vs '));
                const span = el('span', null, t.name);
                span.style.color = t.color;
                teams.appendChild(span);
            });
            info.appendChild(teams);
            const winner = r.result?.winner ? `🏆 ${r.result.winner.name}` : (r.result ? '🤝 Draw' : 'Unfinished');
            info.appendChild(el('small', null, `${fmtDate(r.createdAt)} · ${fmtDuration(r.frames)} · ${winner}`));
            row.appendChild(info);

            const actions = el('div', 'replay-actions');
            const watch = el('button', 'menu-btn primary small', '▶ Watch');
            watch.addEventListener('click', () => {
                this.close();
                this.hooks.onWatch(r);
            });
            const pin = el('button', 'menu-btn secondary small', r.pinned ? '📌' : '📍');
            pin.title = r.pinned ? 'Pinned (never auto-deleted)' : 'Pin so it is never auto-deleted';
            pin.addEventListener('click', async () => {
                r.pinned = !r.pinned;
                await ReplayStore.save(r);
                this.refresh();
            });
            const dl = el('button', 'menu-btn secondary small', '💾');
            dl.title = 'Download .koalareplay file';
            dl.addEventListener('click', () => ReplayStore.download(r));
            const del = el('button', 'menu-btn danger small', '🗑');
            del.title = 'Delete';
            del.addEventListener('click', async () => {
                if (!confirm(`Delete the replay "${r.title}"?`)) return;
                await ReplayStore.remove(r.id);
                this.refresh();
            });
            actions.append(watch, pin, dl, del);
            row.appendChild(actions);
            this.list.appendChild(row);
        }
    }

    importFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.koalareplay,.json';
        input.onchange = async () => {
            const file = input.files[0];
            if (!file) return;
            try {
                const data = JSON.parse(await file.text());
                const err = validateReplay(data);
                if (err) {
                    alert(err);
                    return;
                }
                await ReplayStore.save(data);
                this.refresh();
            } catch (e) {
                alert('Could not read that replay file.');
            }
        };
        input.click();
    }

    // ------------------------------------------------------ playback bar

    /** Show the control bar for a game that is playing back a replay. */
    attach(game, { onExit, onRestart }) {
        this.detach();
        this.game = game;
        const bar = this.bar;
        bar.classList.remove('hidden');
        bar.innerHTML = '';

        const label = el('span', 'replay-label', '🎬 REPLAY');
        const pause = el('button', 'replay-btn', '⏸');
        pause.title = 'Pause / play (P)';
        const speeds = [1, 2, 4, 8];
        const speedBtn = el('button', 'replay-btn', '1x');
        speedBtn.title = 'Playback speed';
        const skip = el('button', 'replay-btn', '⏭ Turn');
        skip.title = 'Skip to the next turn';
        const progress = el('div', 'replay-progress');
        const fill = el('div', 'replay-progress-fill');
        progress.appendChild(fill);
        const exit = el('button', 'replay-btn danger', '✕ Exit');
        bar.append(label, pause, speedBtn, skip, progress, exit);

        const togglePause = () => {
            game.isPaused = !game.isPaused;
            pause.textContent = game.isPaused ? '▶' : '⏸';
            game.lastTime = performance.now();
        };
        pause.addEventListener('click', togglePause);
        speedBtn.addEventListener('click', () => {
            const next = speeds[(speeds.indexOf(game.timeScale) + 1) % speeds.length];
            game.timeScale = next;
            speedBtn.textContent = next + 'x';
        });
        skip.addEventListener('click', () => this.skipTurn());
        exit.addEventListener('click', () => onExit());

        game.on('replayEnded', () => {
            label.textContent = '🎬 END';
            pause.textContent = '↺ Again';
            pause.title = 'Watch again';
            pause.onclick = () => onRestart?.();
            pause.removeEventListener('click', togglePause);
            fill.style.width = '100%';
        });

        this.keyHandler = (e) => {
            if (e.code === 'KeyP') togglePause();
        };
        window.addEventListener('keydown', this.keyHandler);

        this.progressTimer = setInterval(() => {
            if (game.replayPlayer) {
                fill.style.width = (game.replayPlayer.progress * 100).toFixed(1) + '%';
            }
        }, 250);
    }

    /** Fast-forward the simulation (no rendering) until a new turn starts. */
    skipTurn() {
        const game = this.game;
        if (!game || game.isGameOver) return;
        const turn = game.turnManager.turnCounter;
        const limit = game.frame + 60 * 120;
        while (!game.isGameOver && game.frame < limit && !game.simFrozen() &&
            !(game.turnManager.turnCounter !== turn && game.phase === 'aiming')) {
            game.update(1 / 60);
        }
        game.lastTime = performance.now();
    }

    detach() {
        this.bar?.classList.add('hidden');
        clearInterval(this.progressTimer);
        if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
        this.keyHandler = null;
        this.game = null;
    }
}
