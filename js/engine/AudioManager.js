/**
 * Audio Manager - Sample-based sound effects (ElevenLabs-generated assets in
 * assets/audio/) with procedural Web Audio fallbacks for any missing file.
 */

// Generated sample names (assets/audio/sfx/<name>.mp3)
const SFX_SAMPLES = [
    'fire_bazooka', 'fire_throw', 'fire_shotgun', 'fire_handgun', 'fire_uzi',
    'fire_minigun', 'fire_longbow', 'fire_fuse', 'fire_holy', 'fire_airstrike',
    'fire_melee', 'fire_teleport', 'fire_flame', 'fire_drill', 'rope_fire',
    'parachute_open', 'explosion_small', 'explosion_medium', 'explosion_large',
    'bounce', 'splash', 'damage_hit', 'mine_beep', 'sheep_baa', 'powerup',
    'crate_drop', 'turn_start', 'timer_tick', 'click', 'aim_lock', 'missile_drop'
];

// Koala voice lines (assets/audio/voice/voice_<name>.mp3)
const VOICE_SAMPLES = [
    'gday', 'fire', 'incoming', 'ouch', 'crikey', 'angry', 'laugh',
    'death', 'victory', 'defeat', 'taunt', 'beauty'
];

// Weapon id → firing sample
const FIRE_SAMPLE_MAP = {
    bazooka: 'fire_bazooka', homing: 'fire_bazooka', mortar: 'fire_bazooka',
    grenade: 'fire_throw', cluster: 'fire_throw', banana: 'fire_throw', petrol: 'fire_throw',
    sheep: 'sheep_baa', shotgun: 'fire_shotgun', handgun: 'fire_handgun', uzi: 'fire_uzi',
    minigun: 'fire_minigun', longbow: 'fire_longbow', dynamite: 'fire_fuse',
    holygrenade: 'fire_holy',
    airstrike: 'fire_airstrike', napalmstrike: 'fire_airstrike',
    minestrike: 'fire_airstrike', armageddon: 'fire_airstrike',
    bat: 'fire_melee', firepunch: 'fire_melee', dragonball: 'fire_melee',
    prod: 'fire_melee', kamikaze: 'fire_melee',
    teleport: 'fire_teleport', blowtorch: 'fire_flame', drill: 'fire_drill',
    rope: 'rope_fire', parachute: 'parachute_open', mine: 'mine_beep'
};

// localStorage key for persisted mixer settings
const AUDIO_SETTINGS_KEY = 'koala_audio_settings';

// User-facing mixer defaults (0–1 per channel)
const DEFAULT_VOLUMES = {
    master: 0.5,
    music: 0.5,
    ambient: 0.35,
    sfx: 0.8,
    voice: 0.8
};

// Per-channel base trim so a channel at 100% still sits at a sensible level
// relative to the others (music/ambient sources are mastered much hotter
// than the one-shot SFX).
const CHANNEL_TRIM = {
    music: 0.1,
    ambient: 0.4,
    sfx: 1.0,
    voice: 1.0
};

export class AudioManager {
    constructor() {
        this.audioContext = null;
        this.masterGain = null;
        // Per-category buses (created in init): source → bus → masterGain
        this.sfxBus = null;
        this.voiceBus = null;
        this.ambientBus = null;
        this.isMuted = false;
        this.isInitialized = false;

        // Mixer settings (persisted). this.volume mirrors volumes.master for
        // backwards compatibility with existing callers.
        this.volumes = { ...DEFAULT_VOLUMES };
        this._loadSettings();
        this.volume = this.volumes.master;

        // Background Music
        this.music = null;
        this.currentTheme = null;

        // Define audio tracks (ElevenLabs-generated loops; the original
        // tracks remain on disk and playMusic falls back to them on error)
        this.themes = {
            menu: 'assets/audio/music/music_menu.mp3',
            battle: 'assets/audio/music/music_battle.mp3',
            suddenDeath: 'assets/audio/music/music_suddendeath.mp3',
            victory: 'assets/audio/music/music_victory.mp3',
            defeat: 'assets/audio/music/music_defeat.mp3'
        };

        // Track Audio objects
        this.audioElements = {};

        // Decoded generated samples (name → AudioBuffer). Missing entries
        // fall back to the procedural generators below.
        this.samples = {};
        this.samplesLoading = false;
        this._lastSampleTime = {};

        // Looping map ambience — decoded into a crossfaded AudioBuffer and
        // looped sample-accurately via Web Audio (HTMLAudio loop has an
        // audible gap at the MP3 loop point due to encoder padding).
        this.ambient = null;            // { src, fade } while playing
        this._ambientBuffers = {};      // themeId → seamless AudioBuffer (null = missing)
        this._ambientToken = 0;         // invalidates in-flight async loads
    }

    _loadSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(AUDIO_SETTINGS_KEY));
            if (saved && typeof saved === 'object') {
                for (const key of Object.keys(DEFAULT_VOLUMES)) {
                    const v = saved.volumes?.[key];
                    if (typeof v === 'number' && isFinite(v)) {
                        this.volumes[key] = Math.max(0, Math.min(1, v));
                    }
                }
                this.isMuted = !!saved.isMuted;
            }
        } catch { /* corrupt/blocked storage → defaults */ }
    }

    _saveSettings() {
        try {
            localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify({
                volumes: this.volumes,
                isMuted: this.isMuted
            }));
        } catch { /* storage blocked → session-only settings */ }
    }

    /**
     * Initialize audio context (must be called after user interaction)
     */
    init() {
        if (this.isInitialized) return;

        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.masterGain = this.audioContext.createGain();
            this.masterGain.connect(this.audioContext.destination);
            this.masterGain.gain.value = this.isMuted ? 0 : this.volumes.master;

            // Category buses feeding the master gain
            this.sfxBus = this.audioContext.createGain();
            this.voiceBus = this.audioContext.createGain();
            this.ambientBus = this.audioContext.createGain();
            for (const bus of [this.sfxBus, this.voiceBus, this.ambientBus]) {
                bus.connect(this.masterGain);
            }
            this._applyBusVolumes();

            this.isInitialized = true;
            console.log('🔊 Audio system initialized');

            // Initialize background music
            this.initMusic();

            // Load generated SFX/voice samples (async; procedural fallbacks
            // cover anything that hasn't decoded yet or doesn't exist)
            this._loadSamples();
        } catch (e) {
            console.warn('Audio not supported:', e);
        }
    }

    /**
     * Initialize background music
     */
    initMusic() {
        if (this.isInitializedTheme) return;

        // Preload themes
        for (const [key, src] of Object.entries(this.themes)) {
            const audio = new Audio(src);

            // Victory and Defeat shouldn't loop
            if (key !== 'victory' && key !== 'defeat') {
                audio.loop = true;
            }

            audio.volume = this._musicVolume();
            this.audioElements[key] = audio;
        }

        // Fallback original track for battle if custom track fails
        this.audioElements.fallback = new Audio('01. Worms - Armageddon - Original Mix.mp3');
        this.audioElements.fallback.loop = true;
        this.audioElements.fallback.volume = this._musicVolume();

        this.isInitializedTheme = true;
    }

    /**
     * Fetch and decode all generated samples. Failures are silent — the
     * procedural generators keep working for any sample that's missing.
     */
    _loadSamples() {
        if (this.samplesLoading) return;
        this.samplesLoading = true;

        const load = (name, url) => {
            fetch(url)
                .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`)))
                .then(data => this.audioContext.decodeAudioData(data))
                .then(buffer => { this.samples[name] = buffer; })
                .catch(() => { /* missing asset → procedural fallback */ });
        };

        for (const name of SFX_SAMPLES) load(name, `assets/audio/sfx/${name}.mp3`);
        for (const name of VOICE_SAMPLES) load(`voice_${name}`, `assets/audio/voice/voice_${name}.mp3`);
    }

    /**
     * Play a decoded sample through the master gain.
     * Returns the source node, or null if unavailable (caller then falls
     * back to its procedural sound). `throttleMs` skips the play if the
     * same sample was triggered too recently (rapid-fire tools).
     */
    playSample(name, { volume = 1, loop = false, rate = 1, throttleMs = 0, bus = 'sfx' } = {}) {
        if (!this.isInitialized || this.isMuted) return null;
        const buffer = this.samples[name];
        if (!buffer) return null;

        if (throttleMs > 0) {
            const last = this._lastSampleTime[name] || 0;
            if (performance.now() - last < throttleMs) return true; // handled, but skip
            this._lastSampleTime[name] = performance.now();
        }

        this.resume();
        const ctx = this.audioContext;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = loop;
        src.playbackRate.value = rate;

        const gain = ctx.createGain();
        gain.gain.value = volume;
        src.connect(gain);
        gain.connect(bus === 'voice' ? this.voiceBus : this.sfxBus);
        src.start();
        return src;
    }

    /**
     * Play a koala voice line (e.g. 'gday', 'ouch', 'incoming').
     * `chance` < 1 plays it probabilistically — cosmetic only, so plain
     * Math.random() is safe for multiplayer sync.
     */
    playVoice(name, chance = 1) {
        if (chance < 1 && Math.random() > chance) return;
        // Slight pitch variance so repeated barks don't sound identical
        const rate = 0.95 + Math.random() * 0.1;
        this.playSample(`voice_${name}`, { volume: 0.9, rate, throttleMs: 400, bus: 'voice' });
    }

    /**
     * Start the looping ambience for a map theme
     * ('grassland' | 'desert' | 'tundra' | 'volcanic'). No-op if the theme
     * is unknown (custom/editor maps) or the asset is missing.
     *
     * The track is decoded and rebuilt as a crossfaded loop buffer, then
     * looped sample-accurately with an AudioBufferSourceNode. An HTMLAudio
     * element with loop=true can't do this: MP3 encoder padding leaves a
     * silent gap at the loop seam (the audible "blip").
     */
    async playAmbient(themeId) {
        this.stopAmbient();
        if (!themeId || !this.isInitialized) return;

        const token = ++this._ambientToken;

        let buffer = this._ambientBuffers[themeId];
        if (buffer === undefined) {
            try {
                const res = await fetch(`assets/audio/ambient/ambient_${themeId}.mp3`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const decoded = await this.audioContext.decodeAudioData(await res.arrayBuffer());
                buffer = this._makeSeamlessLoop(decoded);
            } catch {
                buffer = null; // missing asset → stay silent
            }
            this._ambientBuffers[themeId] = buffer;
        }

        // A stopAmbient()/playAmbient() may have happened while decoding
        if (!buffer || token !== this._ambientToken) return;

        const ctx = this.audioContext;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;

        // Ease in so the ambience doesn't slam on with the battle start
        const fade = ctx.createGain();
        fade.gain.setValueAtTime(0.0001, ctx.currentTime);
        fade.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 2);

        src.connect(fade);
        fade.connect(this.ambientBus);
        src.start();
        this.ambient = { src, fade };
    }

    /**
     * Stop map ambience (short fade-out to avoid a click)
     */
    stopAmbient() {
        this._ambientToken++;
        if (!this.ambient) return;
        const { src, fade } = this.ambient;
        this.ambient = null;
        try {
            const t = this.audioContext.currentTime;
            fade.gain.cancelScheduledValues(t);
            fade.gain.setValueAtTime(Math.max(fade.gain.value, 0.0001), t);
            fade.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
            src.stop(t + 0.25);
        } catch {
            try { src.stop(); } catch { /* already stopped */ }
        }
    }

    /**
     * Rebuild a decoded buffer as a seamless loop: trim the near-silent
     * encoder padding at both ends, then equal-power crossfade the tail
     * into the head so the loop seam is inaudible.
     */
    _makeSeamlessLoop(buffer, fadeSeconds = 1.5) {
        const ctx = this.audioContext;
        const channels = buffer.numberOfChannels;
        const threshold = 0.003; // below this is encoder padding / room noise floor

        // Find first/last sample above the threshold on any channel
        let start = buffer.length, end = 0;
        for (let c = 0; c < channels; c++) {
            const data = buffer.getChannelData(c);
            let s = 0;
            while (s < data.length && Math.abs(data[s]) < threshold) s++;
            let e = data.length - 1;
            while (e > s && Math.abs(data[e]) < threshold) e--;
            start = Math.min(start, s);
            end = Math.max(end, e + 1);
        }
        if (end - start < ctx.sampleRate) { start = 0; end = buffer.length; } // degenerate → keep as-is

        const trimmed = end - start;
        const fadeLen = Math.min(Math.floor(fadeSeconds * buffer.sampleRate), Math.floor(trimmed / 4));
        const outLen = trimmed - fadeLen;

        const out = ctx.createBuffer(channels, outLen, buffer.sampleRate);
        for (let c = 0; c < channels; c++) {
            const src = buffer.getChannelData(c);
            const dst = out.getChannelData(c);
            // Head region: head fades in while the surplus tail fades out
            for (let i = 0; i < fadeLen; i++) {
                const theta = (i / fadeLen) * Math.PI / 2;
                dst[i] = src[start + i] * Math.sin(theta) +
                         src[start + outLen + i] * Math.cos(theta);
            }
            for (let i = fadeLen; i < outLen; i++) {
                dst[i] = src[start + i];
            }
        }
        return out;
    }

    /**
     * Play a specific music theme
     */
    playTheme(themeName) {
        if (!this.isInitializedTheme) {
            this.initMusic();
        }

        // Map ambience belongs to battle — kill it when returning to menu
        if (themeName === 'menu') {
            this.stopAmbient();
        }

        if (this.currentTheme === themeName) {
            this.playMusic();

            // Ensure timeout is still applied if called again
            if (themeName === 'victory' || themeName === 'defeat') {
                if (this.themeTimeout) clearTimeout(this.themeTimeout);
                this.themeTimeout = setTimeout(() => {
                    if (this.currentTheme === themeName && this.music) {
                        this.music.pause();
                    }
                }, 10000);
            }
            return;
        }

        // Clear any existing theme timeout
        if (this.themeTimeout) {
            clearTimeout(this.themeTimeout);
            this.themeTimeout = null;
        }

        // Pause current music
        if (this.music) {
            this.music.pause();
            // Only reset currentTime to 0 for non-looping/one-shot themes (victory/defeat)
            // or when switching back to menu. This allows battle and suddenDeath themes
            // to resume from where they were paused, preventing track restarts.
            if (this.currentTheme === 'victory' || this.currentTheme === 'defeat' || themeName === 'menu') {
                this.music.currentTime = 0; // Reset
            }
        }

        // Set new music
        this.music = this.audioElements[themeName] || this.audioElements.fallback;
        this.currentTheme = themeName;

        if (this.music) {
            this.music.volume = this._musicVolume();
            this.playMusic();

            // Limit victory and defeat themes to 10 seconds
            if (themeName === 'victory' || themeName === 'defeat') {
                this.themeTimeout = setTimeout(() => {
                    if (this.currentTheme === themeName && this.music) {
                        this.music.pause();
                    }
                }, 10000);
            }
        }
    }

    /**
     * Reset a theme's playback time to 0
     */
    resetTheme(themeName) {
        const audio = this.audioElements[themeName] || this.audioElements.fallback;
        if (audio) {
            audio.currentTime = 0;
        }
    }

    /**
     * Play/Resume music
     */
    playMusic() {
        if (this.music && this.music.paused) {
            this.music.play().catch(e => {
                // If it's a browser layout policy blocking it, wait for interaction
                if (e.name === 'NotAllowedError') {
                    console.log('Audio autoplay prevented. Waiting for user interaction.');
                    return;
                }

                // If the custom theme fails (e.g., file doesn't exist yet),
                // fallback to the original track if it's supposed to be battle/menu music.
                console.warn(`Could not play theme ${this.currentTheme}:`, e);
                if (this.currentTheme === 'battle' || this.currentTheme === 'menu' || this.currentTheme === 'suddenDeath') {
                    console.log('Falling back to original soundtrack for', this.currentTheme);
                    this.music = this.audioElements.fallback;
                    this.music.play().catch(fallbackErr => console.warn('Fallback failed:', fallbackErr));
                }
            });
        }
    }

    /**
     * Stop/Pause music
     */
    stopMusic() {
        if (this.music) {
            this.music.pause();
        }
        this.stopAmbient();
    }

    /**
     * Resume audio context (required after user gesture)
     */
    resume() {
        if (this.audioContext && this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
    }

    /**
     * Effective HTMLAudio volume for music: channel trim × music slider ×
     * master (normalized so master=0.5 is unity, matching the old scale).
     */
    _musicVolume() {
        if (this.isMuted) return 0;
        const v = CHANNEL_TRIM.music * this.volumes.music * (this.volumes.master / 0.5);
        return Math.max(0, Math.min(1, v));
    }

    /** Push music/ambient/sfx/voice slider values onto their outputs */
    _applyBusVolumes() {
        if (this.sfxBus) this.sfxBus.gain.value = CHANNEL_TRIM.sfx * this.volumes.sfx;
        if (this.voiceBus) this.voiceBus.gain.value = CHANNEL_TRIM.voice * this.volumes.voice;
        if (this.ambientBus) this.ambientBus.gain.value = CHANNEL_TRIM.ambient * this.volumes.ambient;
    }

    /** Push current music volume onto every preloaded track */
    _applyMusicVolumes() {
        const vol = this._musicVolume();
        for (const audio of Object.values(this.audioElements)) {
            audio.volume = vol;
        }
    }

    /**
     * Set master volume (0-1)
     */
    setVolume(vol) {
        this.setCategoryVolume('master', vol);
    }

    /**
     * Set one mixer channel: 'master' | 'music' | 'ambient' | 'sfx' | 'voice'
     */
    setCategoryVolume(channel, vol) {
        if (!(channel in this.volumes)) return;
        this.volumes[channel] = Math.max(0, Math.min(1, vol));
        this.volume = this.volumes.master;

        if (this.masterGain) {
            this.masterGain.gain.value = this.isMuted ? 0 : this.volumes.master;
        }
        this._applyBusVolumes();
        this._applyMusicVolumes();
        this._saveSettings();
    }

    /**
     * Toggle mute
     */
    toggleMute() {
        this.isMuted = !this.isMuted;
        if (this.masterGain) {
            this.masterGain.gain.value = this.isMuted ? 0 : this.volumes.master;
        }
        this._applyMusicVolumes();
        this._saveSettings();
        return this.isMuted;
    }

    // ==================== SOUND GENERATORS ====================

    /**
     * Play weapon fire sound
     */
    playFire(weaponType = 'bazooka') {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

        // Koala voice barks on dramatic weapons (cosmetic, local-only RNG)
        if (weaponType === 'airstrike' || weaponType === 'napalmstrike' ||
            weaponType === 'minestrike' || weaponType === 'armageddon') {
            this.playVoice('incoming');
        } else if (['bazooka', 'homing', 'mortar', 'grenade', 'cluster',
                    'banana', 'holygrenade', 'dynamite'].includes(weaponType)) {
            this.playVoice('fire', 0.2);
        }

        // Generated sample first; procedural synth only as fallback.
        // Blowtorch/drill retrigger rapidly while digging, hence the throttle.
        const sample = FIRE_SAMPLE_MAP[weaponType];
        if (sample && this.playSample(sample, { volume: 0.7, throttleMs: 300 })) return;

        const ctx = this.audioContext;
        const now = ctx.currentTime;

        switch (weaponType) {
            case 'bazooka':
            case 'homing':
            case 'mortar':
                this._playRocketLaunch(now);
                break;
            case 'grenade':
            case 'cluster':
            case 'banana':
            case 'petrol':
            case 'sheep':
                this._playThrow(now);
                break;
            case 'shotgun':
                this._playShotgun(now);
                break;
            case 'dynamite':
                this._playFuse(now);
                break;
            case 'holygrenade':
                this._playHolyThrow(now);
                break;
            case 'airstrike':
            case 'napalmstrike':
            case 'minestrike':
            case 'armageddon':
                this._playAirstrikeCall(now);
                break;
            case 'bat':
            case 'firepunch':
            case 'dragonball':
            case 'prod':
            case 'kamikaze':
                this._playBatSwing(now);
                break;
            case 'teleport':
                this._playTeleport(now);
                break;
            default:
                this._playGenericFire(now);
        }
    }

    _playBatSwing(now) {
        const ctx = this.audioContext;

        // "Whoosh" of the bat
        const noise = this._createNoise(0.2);
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(3000, now);
        filter.frequency.exponentialRampToValueAtTime(100, now + 0.15);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.sfxBus);
        noise.start(now);
        noise.stop(now + 0.2);

        // Solid impact "thwack"
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(400, now);
        osc.frequency.exponentialRampToValueAtTime(150, now + 0.08);

        const oscGain = ctx.createGain();
        oscGain.gain.setValueAtTime(0.5, now);
        oscGain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

        osc.connect(oscGain);
        oscGain.connect(this.sfxBus);
        osc.start(now);
        osc.stop(now + 0.1);
    }

    _playAirstrikeCall(now) {
        const ctx = this.audioContext;

        // Radio static/beep for calling in airstrike
        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.setValueAtTime(1000, now + 0.1);
        osc.frequency.setValueAtTime(800, now + 0.2);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.setValueAtTime(0.3, now + 0.1);
        gain.gain.setValueAtTime(0.2, now + 0.2);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);

        osc.connect(gain);
        gain.connect(this.sfxBus);
        osc.start(now);
        osc.stop(now + 0.35);

        // Jet flyby sound (delayed)
        setTimeout(() => {
            const now2 = ctx.currentTime;
            const noise = this._createNoise(0.8);
            const filter = ctx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.setValueAtTime(200, now2);
            filter.frequency.exponentialRampToValueAtTime(2000, now2 + 0.4);
            filter.frequency.exponentialRampToValueAtTime(200, now2 + 0.8);
            filter.Q.value = 1;

            const gain2 = ctx.createGain();
            gain2.gain.setValueAtTime(0.1, now2);
            gain2.gain.linearRampToValueAtTime(0.5, now2 + 0.4);
            gain2.gain.exponentialRampToValueAtTime(0.01, now2 + 0.8);

            noise.connect(filter);
            filter.connect(gain2);
            gain2.connect(this.sfxBus);
            noise.start(now2);
            noise.stop(now2 + 0.8);
        }, 300);
    }

    _playTeleport(now) {
        const ctx = this.audioContext;

        // Zap/warble sound
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(200, now);
        osc.frequency.exponentialRampToValueAtTime(2000, now + 0.15);
        osc.frequency.exponentialRampToValueAtTime(400, now + 0.3);

        const osc2 = ctx.createOscillator();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(300, now);
        osc2.frequency.exponentialRampToValueAtTime(2500, now + 0.15);
        osc2.frequency.exponentialRampToValueAtTime(500, now + 0.3);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);

        osc.connect(gain);
        osc2.connect(gain);
        gain.connect(this.sfxBus);
        osc.start(now);
        osc2.start(now);
        osc.stop(now + 0.3);
        osc2.stop(now + 0.3);
    }

    _playRocketLaunch(now) {
        const ctx = this.audioContext;

        // Whoosh noise
        const noise = this._createNoise(0.3);
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(800, now);
        filter.frequency.exponentialRampToValueAtTime(2000, now + 0.1);
        filter.Q.value = 2;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.4, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.sfxBus);
        noise.start(now);
        noise.stop(now + 0.3);

        // Low boom
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(150, now);
        osc.frequency.exponentialRampToValueAtTime(50, now + 0.15);

        const oscGain = ctx.createGain();
        oscGain.gain.setValueAtTime(0.5, now);
        oscGain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);

        osc.connect(oscGain);
        oscGain.connect(this.sfxBus);
        osc.start(now);
        osc.stop(now + 0.15);
    }

    _playThrow(now) {
        const ctx = this.audioContext;

        // Whoosh
        const noise = this._createNoise(0.15);
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 1000;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.sfxBus);
        noise.start(now);
        noise.stop(now + 0.15);
    }

    _playShotgun(now) {
        const ctx = this.audioContext;

        // Sharp crack
        const noise = this._createNoise(0.1);
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(5000, now);
        filter.frequency.exponentialRampToValueAtTime(200, now + 0.1);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.7, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.sfxBus);
        noise.start(now);
        noise.stop(now + 0.1);
    }

    _playFuse(now) {
        const ctx = this.audioContext;

        // Hiss sound
        const noise = this._createNoise(0.5);
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 4000;
        filter.Q.value = 5;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.15, now);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.sfxBus);
        noise.start(now);
        noise.stop(now + 0.5);
    }

    _playHolyThrow(now) {
        const ctx = this.audioContext;

        // Angelic tone
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 880;

        const osc2 = ctx.createOscillator();
        osc2.type = 'sine';
        osc2.frequency.value = 1320; // Perfect fifth

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);

        osc.connect(gain);
        osc2.connect(gain);
        gain.connect(this.sfxBus);
        osc.start(now);
        osc2.start(now);
        osc.stop(now + 0.4);
        osc2.stop(now + 0.4);

        this._playThrow(now);
    }

    _playGenericFire(now) {
        this._playThrow(now);
    }

    /**
     * Play explosion sound
     */
    playExplosion(size = 'medium') {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

        const vol = size === 'large' ? 0.9 : size === 'small' ? 0.5 : 0.7;
        if (this.playSample(`explosion_${size}`, { volume: vol, throttleMs: 60 })) return;

        const ctx = this.audioContext;
        const now = ctx.currentTime;

        const baseFreq = size === 'large' ? 60 : size === 'small' ? 120 : 80;
        const duration = size === 'large' ? 0.8 : size === 'small' ? 0.3 : 0.5;
        const volume = size === 'large' ? 0.8 : size === 'small' ? 0.4 : 0.6;

        // Low rumble
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(baseFreq, now);
        osc.frequency.exponentialRampToValueAtTime(20, now + duration);

        const oscGain = ctx.createGain();
        oscGain.gain.setValueAtTime(volume, now);
        oscGain.gain.exponentialRampToValueAtTime(0.01, now + duration);

        osc.connect(oscGain);
        oscGain.connect(this.sfxBus);
        osc.start(now);
        osc.stop(now + duration);

        // Noise burst
        const noise = this._createNoise(duration * 0.7);
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(3000, now);
        filter.frequency.exponentialRampToValueAtTime(200, now + duration * 0.7);

        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(volume * 0.6, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.01, now + duration * 0.7);

        noise.connect(filter);
        filter.connect(noiseGain);
        noiseGain.connect(this.sfxBus);
        noise.start(now);
        noise.stop(now + duration * 0.7);
    }

    /**
     * Play bounce sound
     */
    playBounce() {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

        if (this.playSample('bounce', { volume: 0.4, throttleMs: 80 })) return;

        const ctx = this.audioContext;
        const now = ctx.currentTime;

        // Short thud
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(200, now);
        osc.frequency.exponentialRampToValueAtTime(80, now + 0.08);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);

        osc.connect(gain);
        gain.connect(this.sfxBus);
        osc.start(now);
        osc.stop(now + 0.08);
    }

    /**
     * Play damage sound
     */
    playDamage() {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

        // Pained koala bark now and then
        const grunts = ['ouch', 'crikey', 'angry'];
        this.playVoice(grunts[Math.floor(Math.random() * grunts.length)], 0.35);

        if (this.playSample('damage_hit', { volume: 0.6, throttleMs: 100 })) return;

        const ctx = this.audioContext;
        const now = ctx.currentTime;

        // Impact thump
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(300, now);
        osc.frequency.exponentialRampToValueAtTime(100, now + 0.1);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.4, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

        osc.connect(gain);
        gain.connect(this.sfxBus);
        osc.start(now);
        osc.stop(now + 0.1);

        // "Oof" voice-like sound
        setTimeout(() => {
            const now2 = ctx.currentTime;
            const osc2 = ctx.createOscillator();
            osc2.type = 'sawtooth';
            osc2.frequency.setValueAtTime(180, now2);
            osc2.frequency.exponentialRampToValueAtTime(120, now2 + 0.15);

            const filter = ctx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.value = 600;
            filter.Q.value = 3;

            const gain2 = ctx.createGain();
            gain2.gain.setValueAtTime(0.15, now2);
            gain2.gain.exponentialRampToValueAtTime(0.01, now2 + 0.15);

            osc2.connect(filter);
            filter.connect(gain2);
            gain2.connect(this.sfxBus);
            osc2.start(now2);
            osc2.stop(now2 + 0.15);
        }, 50);
    }

    /**
     * Play death sound
     */
    playDeath() {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

        this.playVoice('death');

        const ctx = this.audioContext;
        const now = ctx.currentTime;

        // Falling whistle
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(100, now + 0.6);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.6);

        osc.connect(gain);
        gain.connect(this.sfxBus);
        osc.start(now);
        osc.stop(now + 0.6);
    }

    /**
     * Play turn start chime
     */
    playTurnStart() {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

        // Occasional greeting/taunt from the koala taking its turn
        const barks = ['gday', 'taunt', 'laugh', 'beauty'];
        this.playVoice(barks[Math.floor(Math.random() * barks.length)], 0.25);

        if (this.playSample('turn_start', { volume: 0.5 })) return;

        const ctx = this.audioContext;
        const now = ctx.currentTime;

        // Rising two-note chime
        [523.25, 659.25].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = freq;

            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0, now + i * 0.12);
            gain.gain.linearRampToValueAtTime(0.25, now + i * 0.12 + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.12 + 0.25);

            osc.connect(gain);
            gain.connect(this.sfxBus);
            osc.start(now + i * 0.12);
            osc.stop(now + i * 0.12 + 0.25);
        });
    }

    /**
     * Play timer tick (for last 5 seconds)
     */
    playTimerTick() {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

        if (this.playSample('timer_tick', { volume: 0.35, throttleMs: 150 })) return;

        const ctx = this.audioContext;
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = 1000;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);

        osc.connect(gain);
        gain.connect(this.sfxBus);
        osc.start(now);
        osc.stop(now + 0.05);
    }

    /**
     * Play victory fanfare
     */
    playVictory() {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

        this.playVoice('victory');

        const ctx = this.audioContext;
        const now = ctx.currentTime;

        // Victory melody: C-E-G-C (octave up)
        const notes = [523.25, 659.25, 783.99, 1046.50];
        notes.forEach((freq, i) => {
            const osc = ctx.createOscillator();
            osc.type = 'triangle';
            osc.frequency.value = freq;

            const gain = ctx.createGain();
            const start = now + i * 0.15;
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(0.35, start + 0.03);
            gain.gain.setValueAtTime(0.35, start + 0.12);
            gain.gain.exponentialRampToValueAtTime(0.01, start + 0.4);

            osc.connect(gain);
            gain.connect(this.sfxBus);
            osc.start(start);
            osc.stop(start + 0.4);
        });
    }

    /**
     * Play defeat sound
     */
    playDefeat() {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

        this.playVoice('defeat');

        const ctx = this.audioContext;
        const now = ctx.currentTime;

        // Sad descending tone
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(400, now);
        osc.frequency.exponentialRampToValueAtTime(150, now + 0.8);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.35, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.8);

        osc.connect(gain);
        gain.connect(this.sfxBus);
        osc.start(now);
        osc.stop(now + 0.8);
    }

    /**
     * Play UI click
     */
    playClick() {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

        if (this.playSample('click', { volume: 0.4, throttleMs: 50 })) return;

        const ctx = this.audioContext;
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 600;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.04);

        osc.connect(gain);
        gain.connect(this.sfxBus);
        osc.start(now);
        osc.stop(now + 0.04);
    }

    /**
     * Play water splash sound
     */
    playSplash() {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

        if (this.playSample('splash', { volume: 0.6, throttleMs: 100 })) return;

        const ctx = this.audioContext;
        const now = ctx.currentTime;

        // Filtered noise burst - "plunk" into water
        const noise = this._createNoise(0.4);
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1200, now);
        filter.frequency.exponentialRampToValueAtTime(300, now + 0.35);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.35, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.sfxBus);
        noise.start(now);
        noise.stop(now + 0.4);

        // Low "bloop"
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(300, now);
        osc.frequency.exponentialRampToValueAtTime(80, now + 0.2);

        const oscGain = ctx.createGain();
        oscGain.gain.setValueAtTime(0.25, now);
        oscGain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);

        osc.connect(oscGain);
        oscGain.connect(this.sfxBus);
        osc.start(now);
        osc.stop(now + 0.2);
    }

    /**
     * Play crate/powerup pickup chime
     */
    playPowerup() {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

        if (this.playSample('powerup', { volume: 0.5 })) return;

        const ctx = this.audioContext;
        const now = ctx.currentTime;

        // Quick ascending sparkle: C-E-G
        [523.25, 659.25, 783.99].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            osc.type = 'triangle';
            osc.frequency.value = freq;

            const gain = ctx.createGain();
            const start = now + i * 0.07;
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(0.22, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.01, start + 0.2);

            osc.connect(gain);
            gain.connect(this.sfxBus);
            osc.start(start);
            osc.stop(start + 0.2);
        });
    }

    /**
     * Crisp two-tone "lock-on" confirmation played when the aim is locked in.
     */
    playAimLock() {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

        if (this.playSample('aim_lock', { volume: 0.35, throttleMs: 100 })) return;

        const ctx = this.audioContext;
        const now = ctx.currentTime;

        // Two quick rising blips — a satisfying targeting-lock tick
        [880, 1320].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            osc.type = 'square';
            osc.frequency.value = freq;

            const gain = ctx.createGain();
            const start = now + i * 0.05;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.12, start + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.07);

            osc.connect(gain);
            gain.connect(this.sfxBus);
            osc.start(start);
            osc.stop(start + 0.08);
        });
    }

    /**
     * Play missile drop sound (for airstrike)
     */
    playMissileDrop() {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

        if (this.playSample('missile_drop', { volume: 0.5, throttleMs: 200 })) return;

        const ctx = this.audioContext;
        const now = ctx.currentTime;

        // Whistling noise
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.linearRampToValueAtTime(300, now + 0.5);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.2, now + 0.1);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);

        osc.connect(gain);
        gain.connect(this.sfxBus);
        osc.start(now);
        osc.stop(now + 0.5);

        // Wind noise
        const noise = this._createNoise(0.5);
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(1000, now);
        filter.frequency.linearRampToValueAtTime(500, now + 0.5);

        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0.1, now);
        noiseGain.gain.linearRampToValueAtTime(0, now + 0.5);

        noise.connect(filter);
        filter.connect(noiseGain);
        noiseGain.connect(this.sfxBus);
        noise.start(now);
        noise.stop(now + 0.5);
    }

    // ==================== HELPERS ====================

    _createNoise(duration) {
        const ctx = this.audioContext;
        const bufferSize = ctx.sampleRate * duration;
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const output = buffer.getChannelData(0);

        for (let i = 0; i < bufferSize; i++) {
            output[i] = Math.random() * 2 - 1;
        }

        const whiteNoise = ctx.createBufferSource();
        whiteNoise.buffer = buffer;
        return whiteNoise;
    }
}

// Export a singleton instance for global use across Menu and Game
export const globalAudioManager = new AudioManager();
