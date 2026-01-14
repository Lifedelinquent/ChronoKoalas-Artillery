/**
 * Audio Manager - Procedural sound effects using Web Audio API
 */

export class AudioManager {
    constructor() {
        this.audioContext = null;
        this.masterGain = null;
        this.isMuted = false;
        this.volume = 0.5;
        this.isInitialized = false;

        // Background Music
        this.music = null;
        this.musicVolume = 0.05; // Lowered to 5% as 20% was reported too loud
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
            this.masterGain.gain.value = this.volume;
            this.isInitialized = true;
            console.log('🔊 Audio system initialized');

            // Initialize background music
            this.initMusic();
        } catch (e) {
            console.warn('Audio not supported:', e);
        }
    }

    /**
     * Initialize background music
     */
    initMusic() {
        if (this.music) return;

        this.music = new Audio('01. Worms - Armageddon - Original Mix.mp3');
        this.music.loop = true;
        this.music.volume = this.musicVolume;

        // Start playing when initialized (browsers require user interaction first,
        // which will have happened for init() to be called)
        this.playMusic();
    }

    /**
     * Play/Resume music
     */
    playMusic() {
        if (this.music && this.music.paused) {
            this.music.play().catch(e => console.warn('Music playback failed:', e));
        }
    }

    /**
     * Stop/Pause music
     */
    stopMusic() {
        if (this.music) {
            this.music.pause();
        }
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
     * Set master volume (0-1)
     */
    setVolume(vol) {
        this.volume = Math.max(0, Math.min(1, vol));
        if (this.masterGain) {
            this.masterGain.gain.value = this.isMuted ? 0 : this.volume;
        }
        // Sync music volume too (optional, but keeps it proportional)
        if (this.music) {
            this.music.volume = this.isMuted ? 0 : this.musicVolume * (this.volume / 0.5);
        }
    }

    /**
     * Toggle mute
     */
    toggleMute() {
        this.isMuted = !this.isMuted;
        if (this.masterGain) {
            this.masterGain.gain.value = this.isMuted ? 0 : this.volume;
        }
        if (this.music) {
            this.music.volume = this.isMuted ? 0 : this.musicVolume;
        }
        return this.isMuted;
    }

    // ==================== SOUND GENERATORS ====================

    /**
     * Play weapon fire sound
     */
    playFire(weaponType = 'bazooka') {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

        const ctx = this.audioContext;
        const now = ctx.currentTime;

        switch (weaponType) {
            case 'bazooka':
                this._playRocketLaunch(now);
                break;
            case 'grenade':
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
                this._playAirstrikeCall(now);
                break;
            case 'bat':
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
        gain.connect(this.masterGain);
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
        oscGain.connect(this.masterGain);
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
        gain.connect(this.masterGain);
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
            gain2.connect(this.masterGain);
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
        gain.connect(this.masterGain);
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
        gain.connect(this.masterGain);
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
        oscGain.connect(this.masterGain);
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
        gain.connect(this.masterGain);
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
        gain.connect(this.masterGain);
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
        gain.connect(this.masterGain);
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
        gain.connect(this.masterGain);
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
        oscGain.connect(this.masterGain);
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
        noiseGain.connect(this.masterGain);
        noise.start(now);
        noise.stop(now + duration * 0.7);
    }

    /**
     * Play bounce sound
     */
    playBounce() {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

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
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 0.08);
    }

    /**
     * Play damage sound
     */
    playDamage() {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

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
        gain.connect(this.masterGain);
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
            gain2.connect(this.masterGain);
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
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 0.6);
    }

    /**
     * Play turn start chime
     */
    playTurnStart() {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

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
            gain.connect(this.masterGain);
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

        const ctx = this.audioContext;
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = 1000;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);

        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 0.05);
    }

    /**
     * Play victory fanfare
     */
    playVictory() {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

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
            gain.connect(this.masterGain);
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
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 0.8);
    }

    /**
     * Play UI click
     */
    playClick() {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

        const ctx = this.audioContext;
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 600;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.04);

        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 0.04);
    }

    /**
     * Play missile drop sound (for airstrike)
     */
    playMissileDrop() {
        if (!this.isInitialized || this.isMuted) return;
        this.resume();

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
        gain.connect(this.masterGain);
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
        noiseGain.connect(this.masterGain);
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
