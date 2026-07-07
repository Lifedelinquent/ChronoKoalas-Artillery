/**
 * Generate game audio assets with the ElevenLabs API.
 *
 * Usage (PowerShell):
 *   $env:ELEVENLABS_API_KEY = "sk_..."; node tools/generate-audio.js
 * Usage (bash):
 *   ELEVENLABS_API_KEY=sk_... node tools/generate-audio.js
 *
 * Already-existing output files are skipped, so the script is safe to re-run
 * after a partial failure or to regenerate a single sound (delete the file
 * you want redone and re-run).
 *
 * Note: the dedicated Music API needs a paid ElevenLabs plan; on free tier
 * music themes are generated through the sound-effects endpoint as short
 * loopable tracks (max 22 s).
 */

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ELEVENLABS_API_KEY;
if (!API_KEY) {
    console.error('ELEVENLABS_API_KEY environment variable is not set.');
    process.exit(1);
}

const BASE = 'https://api.elevenlabs.io/v1';
const OUT_ROOT = path.join(__dirname, '..', 'assets', 'audio');

// Charlie — energetic young Australian male. The obvious koala.
const KOALA_VOICE_ID = 'IKne3meq5aSn9XLyUdCD';

// ==================== MANIFEST ====================

/** Koala voice lines (text-to-speech). Cheap: ~1 credit per character. */
const VOICE_LINES = [
    ['gday',     'G\'day mate!'],
    ['fire',     'Fire in the hole!'],
    ['incoming', 'Incoming!!'],
    ['ouch',     'Oof!'],
    ['crikey',   'Crikey!'],
    ['angry',    'Oi!! You\'ll pay for that!'],
    ['laugh',    'Ha ha ha ha ha!'],
    ['death',    'Aaaaaargh!'],
    ['victory',  'Too easy, mate!'],
    ['defeat',   'Hooroo...'],
    ['taunt',    'You call that a shot?'],
    ['beauty',   'Beauty!'],
];

/** Weapon / world sound effects: [name, prompt, durationSeconds] */
const SFX = [
    // Weapon fire
    ['fire_bazooka',   'shoulder-fired rocket launcher firing, powerful whoosh ignition, punchy, cartoon video game sound effect', 1.5],
    ['fire_throw',     'quick grenade throw, short air whoosh swish, video game sound effect', 0.8],
    ['fire_shotgun',   'pump action shotgun blast followed by pump rack, punchy, video game sound effect', 1.2],
    ['fire_handgun',   'single pistol gunshot, sharp crack, video game sound effect', 0.7],
    ['fire_uzi',       'rapid submachine gun burst fire, video game sound effect', 1.3],
    ['fire_minigun',   'minigun spinning up then sustained very rapid gunfire, video game sound effect', 2.5],
    ['fire_longbow',   'bow string twang release and arrow flying whoosh, video game sound effect', 1.0],
    ['fire_fuse',      'hissing dynamite fuse burning with crackling sparks, video game sound effect', 1.5],
    ['fire_holy',      'short angelic choir hallelujah sting, heavenly, comedic, video game sound effect', 2.0],
    ['fire_airstrike', 'military radio confirmation beep then fighter jet flying past overhead, video game sound effect', 2.5],
    ['fire_melee',     'baseball bat swing whoosh ending in a solid cartoon whack impact, video game sound effect', 0.8],
    ['fire_teleport',  'sci-fi teleport zap, rising warble shimmer, video game sound effect', 1.2],
    ['fire_flame',     'blowtorch igniting with a click then steady flame jet, video game sound effect', 1.5],
    ['fire_drill',     'pneumatic jackhammer drilling into rock, short burst, video game sound effect', 1.5],
    ['rope_fire',      'grappling hook launching with rope whip whoosh, video game sound effect', 0.8],
    ['parachute_open', 'parachute cloth popping open and fluttering, video game sound effect', 1.0],
    // Explosions & impacts
    ['explosion_small',  'small punchy cartoon explosion, video game sound effect', 1.2],
    ['explosion_medium', 'medium explosion with debris falling, punchy, video game sound effect', 1.8],
    ['explosion_large',  'huge deep rumbling explosion with falling debris, cinematic boom, video game sound effect', 2.8],
    ['bounce',        'soft cartoon rubber ball bounce thud, video game sound effect', 0.5],
    ['splash',        'heavy object plunging into deep water, big splash, video game sound effect', 1.2],
    ['damage_hit',    'cartoon punch impact thwack, video game sound effect', 0.6],
    ['mine_beep',     'electronic landmine arming, two urgent high beeps, video game sound effect', 0.8],
    ['sheep_baa',     'cartoon sheep bleating baa loudly, funny, video game sound effect', 1.0],
    // UI / game flow
    ['powerup',      'bright ascending pickup chime sparkle, cheerful, video game sound effect', 1.0],
    ['crate_drop',   'wooden supply crate landing on grass with a thump and creak, video game sound effect', 1.5],
    ['turn_start',   'cheerful short two-note notification chime, friendly, video game sound effect', 1.0],
    ['timer_tick',   'single urgent clock tick beep, video game sound effect', 0.5],
    ['click',        'clean UI button click, subtle, video game sound effect', 0.5],
    ['aim_lock',     'target lock-on confirmation, quick rising double beep, video game sound effect', 0.5],
    ['missile_drop', 'falling bomb whistle descending in pitch, cartoon, video game sound effect', 1.5],
];

/** Ambient loops per map theme: [name, prompt, durationSeconds] */
const AMBIENT = [
    ['ambient_grassland', 'peaceful australian eucalyptus forest ambience, birds chirping, distant kookaburra call, gentle breeze in leaves, seamless loop', 18],
    ['ambient_desert',    'desert canyon wind ambience, dry gusting wind, faint sand hiss, sparse and arid, seamless loop', 18],
    ['ambient_tundra',    'arctic tundra ambience, cold howling icy wind, snow blowing, desolate, seamless loop', 18],
    ['ambient_volcanic',  'volcanic ambience, low lava rumble, bubbling magma pops, distant deep eruptions, ominous, seamless loop', 18],
];

/** Music loops/jingles (sound-effects endpoint; Music API needs a paid plan) */
const MUSIC = [
    ['music_menu',        'cheerful playful ukulele and marimba video game menu theme music, upbeat, bouncy, seamless loop', 20],
    ['music_battle',      'playful military march video game battle theme music, snare drums and brass, adventurous, cartoonish, energetic, seamless loop', 22],
    ['music_suddendeath', 'tense urgent video game battle music, fast pulsing drums and low staccato strings, danger, seamless loop', 20],
    ['music_victory',     'triumphant victory fanfare, brass and timpani, short celebratory jingle', 8],
    ['music_defeat',      'sad comedic defeat jingle, wah wah sad trombone, short', 8],
];

// ==================== HELPERS ====================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function apiPost(url, body, attempt = 1) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());

    const text = await res.text();
    // Back off and retry on rate limit / transient server errors
    if ((res.status === 429 || res.status >= 500) && attempt <= 4) {
        const wait = attempt * 5000;
        console.log(`    HTTP ${res.status}, retrying in ${wait / 1000}s...`);
        await sleep(wait);
        return apiPost(url, body, attempt + 1);
    }
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
}

async function generateSfx(name, prompt, duration, outDir, loop) {
    const file = path.join(outDir, `${name}.mp3`);
    if (fs.existsSync(file)) { console.log(`  ${name} — exists, skipping`); return true; }
    try {
        const body = { text: prompt, duration_seconds: duration, prompt_influence: 0.4 };
        if (loop) body.loop = true;
        let buf;
        try {
            buf = await apiPost(`${BASE}/sound-generation`, body);
        } catch (e) {
            // Older API rejects the loop flag — retry without it
            if (loop && String(e.message).includes('422')) {
                delete body.loop;
                buf = await apiPost(`${BASE}/sound-generation`, body);
            } else throw e;
        }
        fs.writeFileSync(file, buf);
        console.log(`  ${name} — OK (${(buf.length / 1024).toFixed(0)} KB)`);
        return true;
    } catch (e) {
        console.error(`  ${name} — FAILED: ${e.message}`);
        return false;
    }
}

async function generateVoice(name, text, outDir) {
    const file = path.join(outDir, `voice_${name}.mp3`);
    if (fs.existsSync(file)) { console.log(`  voice_${name} — exists, skipping`); return true; }
    try {
        const buf = await apiPost(`${BASE}/text-to-speech/${KOALA_VOICE_ID}?output_format=mp3_44100_128`, {
            text,
            model_id: 'eleven_multilingual_v2',
            // Low stability + high style: exaggerated, cartoonish delivery
            voice_settings: { stability: 0.3, similarity_boost: 0.8, style: 0.6 },
        });
        fs.writeFileSync(file, buf);
        console.log(`  voice_${name} — OK (${(buf.length / 1024).toFixed(0)} KB)`);
        return true;
    } catch (e) {
        console.error(`  voice_${name} — FAILED: ${e.message}`);
        return false;
    }
}

async function creditsUsed() {
    try {
        const res = await fetch(`${BASE}/user/subscription`, { headers: { 'xi-api-key': API_KEY } });
        const j = await res.json();
        return `${j.character_count}/${j.character_limit}`;
    } catch { return 'unknown'; }
}

// ==================== MAIN ====================

(async () => {
    const dirs = {
        sfx: path.join(OUT_ROOT, 'sfx'),
        voice: path.join(OUT_ROOT, 'voice'),
        ambient: path.join(OUT_ROOT, 'ambient'),
        music: path.join(OUT_ROOT, 'music'),
    };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

    let ok = 0, failed = 0;
    const track = r => (r ? ok++ : failed++);

    console.log('\n=== Phase 1: koala voice lines (TTS) ===');
    for (const [name, text] of VOICE_LINES) {
        track(await generateVoice(name, text, dirs.voice));
        await sleep(600);
    }
    console.log(`Credits used: ${await creditsUsed()}`);

    console.log('\n=== Phase 2: weapon & world SFX ===');
    for (const [name, prompt, dur] of SFX) {
        track(await generateSfx(name, prompt, dur, dirs.sfx, false));
        await sleep(600);
    }
    console.log(`Credits used: ${await creditsUsed()}`);

    console.log('\n=== Phase 3: map ambient loops ===');
    for (const [name, prompt, dur] of AMBIENT) {
        track(await generateSfx(name, prompt, dur, dirs.ambient, true));
        await sleep(600);
    }
    console.log(`Credits used: ${await creditsUsed()}`);

    console.log('\n=== Phase 4: music themes (SFX endpoint loops) ===');
    for (const [name, prompt, dur] of MUSIC) {
        track(await generateSfx(name, prompt, dur, dirs.music, dur >= 15));
        await sleep(600);
    }
    console.log(`Credits used: ${await creditsUsed()}`);

    console.log(`\nDone. ${ok} generated/skipped OK, ${failed} failed.`);
    if (failed > 0) process.exit(2);
})();
