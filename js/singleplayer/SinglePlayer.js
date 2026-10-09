/**
 * SinglePlayer - Worms Armageddon-style single player modes.
 *
 * Mirrors WA's single-player menu: Training (weapon ranges against static
 * targets), Missions (scripted scenarios on fixed maps), Deathmatch (a
 * ranked ladder against ever-tougher CPU squads) and Quick Game (instant
 * match against CPUs). Everything here just builds { teamsConfig, scheme,
 * seed } bundles for Game — the CPU brain itself lives in ai/AIController.
 *
 * Progress (deathmatch rank, mission/training completion) persists in
 * localStorage under one key.
 */

import { defaultScheme, sanitizeScheme } from '../utils/GameScheme.js';

const PROGRESS_KEY = 'koala_singleplayer';

/**
 * WA-style rank ladder. Your deathmatch level indexes into this — win at
 * your level and you're promoted to the next rank.
 */
export const RANKS = [
    'Absolute Beginner',
    'Beginner',
    'Below Average',
    'Average',
    'Above Average',
    'Reasonable',
    'Competent',
    'Highly Competent',
    'Veteran',
    'Distinguished',
    'Professional',
    'Elite'
];

const ENEMY_TEAM_NAMES = [
    'Drop Bears', 'Dingo Squad', 'Cane Toads', 'Emu Empire',
    'Cassowary Crew', 'Wombat Warriors', 'Croc Commandos', 'Magpie Menace'
];

const ENEMY_COLORS = ['blue', 'green', 'yellow'];

// ---------------------------------------------------------------------
// Progress persistence
// ---------------------------------------------------------------------

export function loadProgress() {
    try {
        const raw = localStorage.getItem(PROGRESS_KEY);
        const p = raw ? JSON.parse(raw) : {};
        return {
            dmLevel: Math.max(0, Math.min(RANKS.length - 1, p.dmLevel | 0)),
            missionsCompleted: Array.isArray(p.missionsCompleted) ? p.missionsCompleted : [],
            trainingCompleted: Array.isArray(p.trainingCompleted) ? p.trainingCompleted : [],
            // missionId → best star count (1-3)
            missionStars: (p.missionStars && typeof p.missionStars === 'object') ? p.missionStars : {},
            // rangeId → { medal: 'gold'|'silver'|'bronze', shots, time }
            trainingMedals: (p.trainingMedals && typeof p.trainingMedals === 'object') ? p.trainingMedals : {},
            tutorialDone: !!p.tutorialDone
        };
    } catch (e) {
        return {
            dmLevel: 0, missionsCompleted: [], trainingCompleted: [],
            missionStars: {}, trainingMedals: {}, tutorialDone: false
        };
    }
}

export function saveProgress(progress) {
    try {
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    } catch (e) {
        console.warn('Failed to save single player progress:', e);
    }
}

// ---------------------------------------------------------------------
// Scheme helper
// ---------------------------------------------------------------------

/**
 * defaultScheme + field overrides + per-weapon overrides ('*' first,
 * specific ids refine), sanitized. Same pattern as GameScheme's presets.
 */
function makeScheme(name, overrides = {}, weaponOverrides = null) {
    const s = defaultScheme();
    Object.assign(s, overrides);
    s.name = name;
    if (weaponOverrides) {
        if (weaponOverrides['*']) {
            for (const id in s.weapons) {
                Object.assign(s.weapons[id], weaponOverrides['*']);
            }
        }
        for (const id in weaponOverrides) {
            if (id === '*' || !s.weapons[id]) continue;
            Object.assign(s.weapons[id], weaponOverrides[id]);
        }
    }
    return sanitizeScheme(s);
}

function pickEnemyNames(count) {
    const pool = [...ENEMY_TEAM_NAMES];
    const out = [];
    for (let i = 0; i < count; i++) {
        out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    return out;
}

// ---------------------------------------------------------------------
// Quick Game
// ---------------------------------------------------------------------

/**
 * Instant match: you (red) vs 1-3 independent CPU squads at one difficulty.
 * Map + scheme come from the normal selection modal.
 */
export function buildQuickGame(difficulty, enemyCount, style = null) {
    const names = pickEnemyNames(enemyCount);
    const teamsConfig = [
        { name: 'Koala Commandos', color: 'red', isCPU: false, style },
        ...names.map((name, i) => ({
            name,
            color: ENEMY_COLORS[i],
            isCPU: true,
            difficulty
        }))
    ];
    return {
        teamsConfig,
        context: { mode: 'quick', difficulty }
    };
}

// ---------------------------------------------------------------------
// Deathmatch ladder
// ---------------------------------------------------------------------

/**
 * WA deathmatch: fight the ladder at your current rank. Enemies gain
 * numbers, brains and health as you climb. Enemy squads share one alliance
 * (they all want YOU), so the match ends when you or all of them fall.
 */
export function buildDeathmatch(level, style = null) {
    const L = Math.max(0, Math.min(RANKS.length - 1, level));
    const enemyTeams = 1 + Math.floor(L / 4);                       // 1 → 2 → 3 squads
    const difficulty = Math.max(1, Math.min(5, 1 + Math.floor(L / 2)));
    const enemyKoalas = Math.min(2 + Math.floor(L / 3), 5);
    const enemyHealth = 100 + Math.max(0, L - 3) * 15;              // tanks up later

    const names = pickEnemyNames(enemyTeams);
    const teamsConfig = [
        { name: 'Koala Commandos', color: 'red', isCPU: false, koalaCount: 4, health: 100, style },
        ...names.map((name, i) => ({
            name,
            color: ENEMY_COLORS[i],
            alliance: 'cpu',
            isCPU: true,
            difficulty,
            koalaCount: enemyKoalas,
            health: enemyHealth
        }))
    ];

    const scheme = makeScheme('Deathmatch', {
        turnTime: 30,
        suddenDeathTime: 300,
        crateDropChance: 0.33,
        mineCount: Math.min(4 + L, 12),
        oilDrumCount: Math.min(3 + Math.floor(L / 2), 8),
        windStrength: Math.min(0.5 + L * 0.15, 1.5)
    });

    return {
        teamsConfig,
        scheme,
        context: { mode: 'deathmatch', level: L }
    };
}

// ---------------------------------------------------------------------
// Missions
// ---------------------------------------------------------------------

/**
 * Scripted scenarios on fixed seeds (same map every attempt, WA-style).
 * Unlocked in order; objective is always "eliminate all enemies" but the
 * setups force different play (limited arsenal, minefields, artillery...).
 *
 * Stars: ★ win · ★★ win without losing a koala · ★★★ ...and within the
 * mission's par turn count (your turns).
 */
export const MISSIONS = [
    {
        id: 'm1',
        name: 'First Blood',
        briefing: 'Basic training is over. Two rookie Drop Bears hold the far hill — introduce them to your bazooka. Watch the wind!',
        seed: 8801,
        player: { koalaCount: 2 },
        enemies: [{ name: 'Rookie Drop Bears', color: 'blue', difficulty: 1, koalaCount: 2, health: 60 }],
        scheme: ['Mission: First Blood', {
            turnTime: 45, windStrength: 0.75, suddenDeathTime: -1,
            mineCount: 0, oilDrumCount: 0, crateDropChance: 0
        }, { '*': { ammo: 0 }, bazooka: { ammo: -1 } }]
    },
    {
        id: 'm2',
        name: 'Grenadier School',
        briefing: 'The Dingo Squad is dug in behind cover where rockets cannot reach. Loft grenades over the top — mind the fuse.',
        seed: 4172,
        player: { koalaCount: 3 },
        enemies: [{ name: 'Dingo Squad', color: 'green', difficulty: 2, koalaCount: 3, health: 75 }],
        scheme: ['Mission: Grenadier School', {
            turnTime: 45, windStrength: 0, suddenDeathTime: -1,
            mineCount: 0, oilDrumCount: 0, crateDropChance: 0
        }, { '*': { ammo: 0 }, grenade: { ammo: -1 }, cluster: { ammo: 3 } }]
    },
    {
        id: 'm3',
        name: 'Minefield Waltz',
        briefing: 'The Cane Toads seeded the whole valley with mines. Every step is a gamble — let your guns do the walking.',
        seed: 9314,
        player: { koalaCount: 3 },
        enemies: [{ name: 'Cane Toads', color: 'yellow', difficulty: 2, koalaCount: 3, health: 100 }],
        scheme: ['Mission: Minefield Waltz', {
            turnTime: 40, windStrength: 1, suddenDeathTime: -1,
            mineCount: 20, mineDudChance: 0.1, oilDrumCount: 8, crateDropChance: 0.2
        }, {
            '*': { ammo: 0 }, bazooka: { ammo: -1 }, grenade: { ammo: -1 },
            shotgun: { ammo: -1 }, handgun: { ammo: -1 }
        }]
    },
    {
        id: 'm4',
        name: 'Air Superiority',
        briefing: 'No walking, no jumping — this is an artillery duel with the Emu Empire. You have air support; use every strike wisely.',
        seed: 2650,
        player: { koalaCount: 3 },
        enemies: [{ name: 'Emu Empire', color: 'blue', difficulty: 3, koalaCount: 4, health: 100 }],
        scheme: ['Mission: Air Superiority', {
            turnTime: 40, windStrength: 1.25, artilleryMode: true, suddenDeathTime: 420,
            mineCount: 0, oilDrumCount: 4, crateDropChance: 0.25
        }, {
            '*': { ammo: 0 }, bazooka: { ammo: -1 }, mortar: { ammo: 6 },
            airstrike: { ammo: 3 }, napalmstrike: { ammo: 2 }, grenade: { ammo: -1 }
        }]
    },
    {
        id: 'm5',
        name: 'Twin Terrors',
        briefing: 'The Cassowary Crew and the Croc Commandos have formed an alliance to end you. Full arsenal — make every koala count.',
        seed: 7442,
        player: { koalaCount: 4 },
        enemies: [
            { name: 'Cassowary Crew', color: 'green', difficulty: 3, koalaCount: 3, health: 100 },
            { name: 'Croc Commandos', color: 'yellow', difficulty: 4, koalaCount: 3, health: 100 }
        ],
        scheme: ['Mission: Twin Terrors', {
            turnTime: 30, windStrength: 1, suddenDeathTime: 420,
            mineCount: 8, oilDrumCount: 6, crateDropChance: 0.4
        }]
    },
    {
        id: 'm6',
        name: 'The Elite Guard',
        briefing: 'One squad stands between you and glory: the Wombat Warriors, veterans of a hundred wars, twice your health and thrice your cunning. Good luck, commander.',
        seed: 5137,
        player: { koalaCount: 4 },
        enemies: [{ name: 'Wombat Warriors', color: 'blue', difficulty: 5, koalaCount: 4, health: 150 }],
        scheme: ['Mission: The Elite Guard', {
            turnTime: 30, windStrength: 1.5, suddenDeathTime: 240,
            mineCount: 6, oilDrumCount: 5, crateDropChance: 0.33
        }]
    },
    {
        id: 'm7',
        name: 'Sheep Dip',
        briefing: 'Command says the Magpie Menace are holed up in the hills. Command also says we are out of rockets. We do, however, have sheep. Lots of sheep.',
        seed: 6021,
        player: { koalaCount: 3 },
        enemies: [{ name: 'Magpie Menace', color: 'green', difficulty: 3, koalaCount: 4, health: 80 }],
        scheme: ['Mission: Sheep Dip', {
            turnTime: 40, windStrength: 0.5, suddenDeathTime: -1,
            mineCount: 4, oilDrumCount: 4, crateDropChance: 0.3
        }, { '*': { ammo: 0 }, sheep: { ammo: -1 }, banana: { ammo: 2 }, prod: { ammo: -1 }, rope: { ammo: 3 } }]
    },
    {
        id: 'm8',
        name: 'High Ground',
        briefing: 'The Drop Bears have taken the floating islands and are lobbing shells from on high. Rope up, girder over and take the fight to them.',
        seed: 3388,
        player: { koalaCount: 3 },
        enemies: [{ name: 'Drop Bear Air Wing', color: 'blue', difficulty: 4, koalaCount: 3, health: 100 }],
        scheme: ['Mission: High Ground', {
            turnTime: 45, windStrength: 1, suddenDeathTime: 480,
            mineCount: 2, oilDrumCount: 2, crateDropChance: 0.25
        }, {
            '*': { ammo: 0 }, bazooka: { ammo: -1 }, grenade: { ammo: -1 }, shotgun: { ammo: -1 },
            rope: { ammo: -1 }, girder: { ammo: 6 }, parachute: { ammo: 3 }, firepunch: { ammo: -1 }
        }]
    },
    {
        id: 'm9',
        name: 'Rising Tide',
        briefing: 'The levee broke. Sudden death hits in one minute and the water climbs fast — the Croc Commandos love the water. You do not.',
        seed: 9902,
        player: { koalaCount: 3 },
        enemies: [{ name: 'Croc Commandos', color: 'yellow', difficulty: 4, koalaCount: 3, health: 100 }],
        scheme: ['Mission: Rising Tide', {
            turnTime: 25, windStrength: 1, suddenDeathTime: 60, waterRisePerTurn: 30,
            suddenDeathDecay: 0, mineCount: 3, oilDrumCount: 3, crateDropChance: 0.4
        }]
    },
    {
        id: 'm10',
        name: 'Lone Wolf',
        briefing: 'One koala. Two hundred health. Three squads who want you gone. Every crate is a lifeline — grab them.',
        seed: 1515,
        player: { koalaCount: 1, health: 200 },
        enemies: [
            { name: 'Dingo Squad', color: 'blue', difficulty: 3, koalaCount: 2, health: 60 },
            { name: 'Cane Toads', color: 'green', difficulty: 3, koalaCount: 2, health: 60 },
            { name: 'Emu Empire', color: 'yellow', difficulty: 3, koalaCount: 2, health: 60 }
        ],
        scheme: ['Mission: Lone Wolf', {
            turnTime: 35, windStrength: 1, suddenDeathTime: -1,
            mineCount: 4, oilDrumCount: 6, crateDropChance: 0.7, maxCratesOnMap: 5
        }]
    },
    {
        id: 'm11',
        name: 'Mine Over Matter',
        briefing: 'The Wombat Warriors have mined everything, including, possibly, the mines. Bring your own: you get mine strikes too.',
        seed: 4747,
        player: { koalaCount: 4 },
        enemies: [{ name: 'Wombat Warriors', color: 'blue', difficulty: 4, koalaCount: 4, health: 100 }],
        scheme: ['Mission: Mine Over Matter', {
            turnTime: 35, windStrength: 1.25, suddenDeathTime: 420,
            mineCount: 26, mineDudChance: 0.2, oilDrumCount: 4, crateDropChance: 0.25
        }, {
            '*': { ammo: 0 }, bazooka: { ammo: -1 }, grenade: { ammo: -1 }, mine: { ammo: 4 },
            minestrike: { ammo: 2 }, dynamite: { ammo: 2 }, teleport: { ammo: 2 }, prod: { ammo: -1 }
        }]
    },
    {
        id: 'm12',
        name: 'Armageddon',
        briefing: 'The final battle. The Elite Guard has joined forces with the Croc Commandos. Every weapon in the armoury is unlocked — including the one we do not talk about.',
        seed: 8008,
        player: { koalaCount: 4 },
        enemies: [
            { name: 'The Elite Guard', color: 'blue', difficulty: 5, koalaCount: 3, health: 120 },
            { name: 'Croc Commandos', color: 'green', difficulty: 5, koalaCount: 3, health: 120 }
        ],
        scheme: ['Mission: Armageddon', {
            turnTime: 30, windStrength: 1.5, suddenDeathTime: 360,
            mineCount: 8, oilDrumCount: 6, crateDropChance: 0.4
        }, { armageddon: { ammo: 1, delay: 3 }, banana: { ammo: 1 }, minigun: { ammo: 1 } }]
    }
];

/** Par (your turns) for the third star, by mission. */
export const MISSION_PAR = {
    m1: 4, m2: 5, m3: 6, m4: 7, m5: 9, m6: 9,
    m7: 7, m8: 8, m9: 6, m10: 9, m11: 8, m12: 10
};

export function buildMission(mission, style = null) {
    const teamsConfig = [
        {
            name: 'Koala Commandos', color: 'red', isCPU: false,
            koalaCount: mission.player.koalaCount, health: mission.player.health, style
        },
        ...mission.enemies.map(e => ({
            name: e.name,
            color: e.color,
            alliance: 'cpu',
            isCPU: true,
            difficulty: e.difficulty,
            koalaCount: e.koalaCount,
            health: e.health
        }))
    ];
    return {
        teamsConfig,
        scheme: makeScheme(...mission.scheme),
        seed: mission.seed,
        context: { mode: 'mission', missionId: mission.id }
    };
}

// ---------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------

/**
 * WA-style weapon ranges: one koala, one weapon family, a row of 1 HP
 * living targets that never fight back (passive CPU brain skips its turns).
 * Destroy every target to pass the range.
 */
export const TRAINING = [
    {
        id: 'bazooka',
        name: 'Bazooka Range',
        desc: 'Destroy all 5 targets with rockets. The wind is live — learn to read it.',
        wind: 1.5,
        weapons: { '*': { ammo: 0 }, bazooka: { ammo: -1 } }
    },
    {
        id: 'grenade',
        name: 'Grenade Range',
        desc: 'Fuses, bounces and banks. Destroy all 5 targets with grenades.',
        wind: 0,
        weapons: { '*': { ammo: 0 }, grenade: { ammo: -1 } }
    },
    {
        id: 'guns',
        name: 'Firing Range',
        desc: 'Shotgun, handgun and uzi. Get in position, line them up, destroy all 5 targets.',
        wind: 0,
        weapons: { '*': { ammo: 0 }, shotgun: { ammo: -1 }, handgun: { ammo: -1 }, uzi: { ammo: -1 } }
    },
    {
        id: 'strikes',
        name: 'Air Support Range',
        desc: 'Air strikes, napalm and homing missiles. Read the wind before you call it in.',
        wind: 1.25,
        weapons: { '*': { ammo: 0 }, airstrike: { ammo: -1 }, napalmstrike: { ammo: -1 }, homing: { ammo: -1 } }
    },
    {
        id: 'melee',
        name: 'Close Quarters',
        desc: 'Walk up and hit them. Fire Punch, Dragon Ball, Bat and Prod — mind the ledges.',
        wind: 0,
        weapons: { '*': { ammo: 0 }, firepunch: { ammo: -1 }, dragonball: { ammo: -1 }, bat: { ammo: -1 }, prod: { ammo: -1 }, rope: { ammo: -1 } }
    },
    {
        id: 'advanced',
        name: 'Advanced Range',
        desc: 'The whole arsenal, live mines on the ground. Improvise.',
        wind: 1,
        weapons: { '*': { ammo: -1 } }
    }
];

// Fixed seed per range so every visit uses the same practice map (WA-style)
const TRAINING_SEEDS = { bazooka: 1201, grenade: 1202, guns: 1203, strikes: 1205, melee: 1206, advanced: 1204 };

/** Medal thresholds by shots fired: [gold, silver] (anything else = bronze). */
export const TRAINING_MEDALS = {
    bazooka: [6, 9], grenade: [6, 10], guns: [5, 8], strikes: [4, 7], melee: [6, 10], advanced: [5, 8]
};

export function medalFor(rangeId, shots) {
    const [gold, silver] = TRAINING_MEDALS[rangeId] || [5, 8];
    return shots <= gold ? 'gold' : shots <= silver ? 'silver' : 'bronze';
}

const MEDAL_RANK = { bronze: 1, silver: 2, gold: 3 };
export const MEDAL_ICON = { gold: '🥇', silver: '🥈', bronze: '🥉' };

export function buildTraining(range, style = null) {
    const teamsConfig = [
        { name: 'Trainee', color: 'red', isCPU: false, koalaCount: 1, health: 100, style },
        {
            name: 'Practice Targets', color: 'yellow', alliance: 'cpu',
            isCPU: true, difficulty: 0, koalaCount: 5, health: 1
        }
    ];
    const scheme = makeScheme(`Training: ${range.name}`, {
        turnTime: 90,
        retreatTime: 3,
        windStrength: range.wind,
        suddenDeathTime: -1,
        mineCount: range.id === 'advanced' ? 10 : 0,
        mineDudChance: 0,
        oilDrumCount: range.id === 'advanced' ? 6 : 0,
        crateDropChance: 0,
        maxCratesOnMap: 0
    }, range.weapons);

    return {
        teamsConfig,
        scheme,
        seed: TRAINING_SEEDS[range.id],
        context: { mode: 'training', rangeId: range.id }
    };
}

// ---------------------------------------------------------------------
// Result handling
// ---------------------------------------------------------------------

/**
 * Called from the gameOver handler with the single-player context the match
 * was started with. Updates persisted progress and returns a line of text
 * for the game-over screen (promotion, mission unlock, ...), or null.
 */
export function handleGameOver(context, result) {
    if (!context) return null;

    const winner = result?.winner;
    // The human squad is always red-alliance team 0 in single player
    const playerWon = !!winner && winner.alliance === 'red';
    const progress = loadProgress();
    const me = result?.stats?.teams?.[0];

    switch (context.mode) {
        case 'tutorial':
            if (!playerWon) return { text: 'Not quite! Have another go — the dummies are waiting.', won: false };
            progress.tutorialDone = true;
            saveProgress(progress);
            return { text: '🎓 Tutorial complete! Try Training, then the Missions campaign.', won: true };

        case 'quick':
            return playerWon
                ? { text: '🎉 The CPU never stood a chance.', won: true }
                : { text: '🤖 The machines win this one. Rematch?', won: false };

        case 'deathmatch': {
            if (!playerWon) {
                return {
                    text: `Rank held: ${RANKS[progress.dmLevel]}. The ladder awaits your revenge.`,
                    won: false
                };
            }
            if (context.level >= progress.dmLevel) {
                if (progress.dmLevel < RANKS.length - 1) {
                    progress.dmLevel++;
                    saveProgress(progress);
                    return {
                        text: `🏅 PROMOTION! You are now: ${RANKS[progress.dmLevel]}`,
                        won: true
                    };
                }
                return { text: '👑 You are Elite. There is no one left to beat.', won: true };
            }
            return { text: '🏅 Victory! (No promotion — fight at your current rank to climb.)', won: true };
        }

        case 'mission': {
            if (!playerWon) {
                return { text: '💀 Mission failed. Regroup and try again.', won: false };
            }
            if (!progress.missionsCompleted.includes(context.missionId)) {
                progress.missionsCompleted.push(context.missionId);
            }
            // Stars: win, flawless (no koalas lost), and within par
            let stars = 1;
            const flawless = me && me.deaths === 0;
            if (flawless) stars++;
            if (flawless && (result?.stats?.playerTurns ?? Infinity) <= (MISSION_PAR[context.missionId] ?? 0)) stars++;
            progress.missionStars[context.missionId] = Math.max(stars, progress.missionStars[context.missionId] || 0);
            saveProgress(progress);

            const idx = MISSIONS.findIndex(m => m.id === context.missionId);
            const next = MISSIONS[idx + 1];
            const starText = '★'.repeat(stars) + '☆'.repeat(3 - stars);
            return {
                text: next
                    ? `🎖️ Mission accomplished! ${starText} · Unlocked: "${next.name}"`
                    : `🎖️ Campaign complete! ${starText} Every mission conquered.`,
                won: true
            };
        }

        case 'training': {
            if (!playerWon) {
                return { text: 'Range failed — your own koala went down. Back to basics.', won: false };
            }
            if (!progress.trainingCompleted.includes(context.rangeId)) {
                progress.trainingCompleted.push(context.rangeId);
            }
            const shots = me?.shots ?? 99;
            const medal = medalFor(context.rangeId, shots);
            const prev = progress.trainingMedals[context.rangeId];
            const better = !prev || MEDAL_RANK[medal] > MEDAL_RANK[prev.medal] ||
                (prev.medal === medal && shots < prev.shots);
            if (better) {
                progress.trainingMedals[context.rangeId] = { medal, shots, time: Math.round(result?.stats?.duration || 0) };
            }
            saveProgress(progress);
            const [gold, silver] = TRAINING_MEDALS[context.rangeId] || [5, 8];
            const hint = medal === 'gold' ? '' : ` (${medal === 'silver' ? gold : silver} shots or fewer for ${medal === 'silver' ? 'gold' : 'silver'})`;
            return { text: `${MEDAL_ICON[medal]} Range passed in ${shots} shot${shots === 1 ? '' : 's'}!${hint}`, won: true };
        }
    }
    return null;
}
