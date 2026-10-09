/**
 * TeamStyles - the player's saved team customisations (WA-style team
 * editor): team name, koala names, hat, gravestone, voice pack and victory
 * dance. Stored in localStorage; the active team is what the local player
 * fields in single player, hotseat (player 1) and multiplayer.
 *
 * A style is plain JSON so it can travel in the multiplayer handshake and
 * inside replays. Everything in it is cosmetic except koala names, which
 * multiplayer uses to identify koalas — createTeams de-duplicates them.
 */

const STORAGE_KEY = 'koala_teams';

export const HATS = [
    { id: 'none', label: 'None', icon: '🚫' },
    { id: 'tophat', label: 'Top Hat', icon: '🎩' },
    { id: 'crown', label: 'Crown', icon: '👑' },
    { id: 'helmet', label: 'Army Helmet', icon: '🪖' },
    { id: 'party', label: 'Party Hat', icon: '🎉' },
    { id: 'cowboy', label: 'Akubra', icon: '🤠' },
    { id: 'beanie', label: 'Beanie', icon: '🧶' },
    { id: 'chef', label: 'Chef Hat', icon: '👨‍🍳' },
    { id: 'viking', label: 'Viking', icon: '⚔️' },
    { id: 'bandana', label: 'Bandana', icon: '🥷' }
];

export const GRAVES = [
    { id: 'cross', label: 'Cross' },
    { id: 'stone', label: 'Headstone' },
    { id: 'obelisk', label: 'Obelisk' },
    { id: 'urn', label: 'Urn' },
    { id: 'gumleaf', label: 'Gum Leaf' }
];

export const VOICES = [
    { id: 'aussie', label: 'Aussie Larrikin', rate: 1 },
    { id: 'chipmunk', label: 'Squeaky', rate: 1.45 },
    { id: 'deep', label: 'Big Bloke', rate: 0.72 },
    { id: 'robot', label: 'Robo-Koala', rate: 1.05, robot: true },
    { id: 'silent', label: 'Strong & Silent', rate: 1, silent: true }
];

export const DANCES = [
    { id: 'hop', label: 'Victory Hops' },
    { id: 'spin', label: 'Spin Cycle' },
    { id: 'flip', label: 'Backflips' },
    { id: 'wiggle', label: 'Bum Wiggle' }
];

export function defaultStyle() {
    return {
        id: 'team_default',
        name: 'Koala Commandos',
        koalaNames: ['DelinquentKoala', 'Sleepy Steve', 'Chompy Charlie', 'Gumnut Gary'],
        hat: 'none',
        grave: 'cross',
        voice: 'aussie',
        dance: 'hop'
    };
}

/** Clamp an untrusted style (from storage, network or a replay) to known values. */
export function sanitizeStyle(s) {
    const d = defaultStyle();
    if (!s || typeof s !== 'object') return null;
    const pick = (list, v, fallback) => (list.some(x => x.id === v) ? v : fallback);
    const clean = (str, max) => String(str ?? '').replace(/[<>]/g, '').trim().slice(0, max);
    const names = Array.isArray(s.koalaNames) ? s.koalaNames : [];
    return {
        id: clean(s.id, 40) || 'team_' + Date.now().toString(36),
        name: clean(s.name, 24) || d.name,
        koalaNames: [0, 1, 2, 3].map(i => clean(names[i], 18) || d.koalaNames[i]),
        hat: pick(HATS, s.hat, 'none'),
        grave: pick(GRAVES, s.grave, 'cross'),
        voice: pick(VOICES, s.voice, 'aussie'),
        dance: pick(DANCES, s.dance, 'hop')
    };
}

export function loadTeams() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (raw && Array.isArray(raw.teams) && raw.teams.length) {
            const teams = raw.teams.map(sanitizeStyle).filter(Boolean);
            const active = teams.some(t => t.id === raw.active) ? raw.active : teams[0].id;
            return { teams, active };
        }
    } catch (e) { /* fall through to default */ }
    const d = defaultStyle();
    return { teams: [d], active: d.id };
}

export function saveTeams(data) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
        console.warn('Failed to save teams:', e);
    }
}

/** The style the local player fields by default. */
export function getActiveStyle() {
    const { teams, active } = loadTeams();
    return teams.find(t => t.id === active) || teams[0];
}

export function getTeamStyle(id) {
    return loadTeams().teams.find(t => t.id === id) || null;
}

export function voiceById(id) {
    return VOICES.find(v => v.id === id) || VOICES[0];
}
