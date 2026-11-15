/**
 * StateSync - turn-boundary snapshots of the simulation for multiplayer.
 *
 * Lockstep keeps every client's simulation identical by construction, so in
 * a healthy match these snapshots are only ever HASHED: at the start of each
 * turn every client fingerprints its world and compares it with the host's.
 *
 * If a client ever disagrees (different browser engines can round a sine
 * differently, a bug can slip in), the host's snapshot is applied on the
 * spot, at the very frame it was taken — so a drift is repaired within one
 * turn instead of snowballing for the rest of the match.
 *
 * Everything in a snapshot is a finite number, string or boolean in a fixed
 * layout: that's what makes hashing it meaningful and lets it travel through
 * PeerJS's BinaryPack unchanged.
 */

import { FNV_OFFSET, hashValue } from '../utils/Hash.js';

// -0 and +0 are the same position but different bit patterns, and the wire
// format flattens -0 to +0. Normalise so a repaired client hashes the same.
const n = (v) => (Number.isFinite(v) ? v + 0 : 0);
const b = (v) => (v ? 1 : 0);

/** Snapshot everything that decides how the match unfolds from here. */
export function captureTurnState(game) {
    const tm = game.turnManager;
    const terrain = game.terrain;

    return {
        frame: game.frame,
        simTime: n(game.simTime),
        turn: [
            tm.turnCounter, tm.currentTeamIndex, tm.currentKoalaIndex,
            tm.roundNumber, tm.lastTeamIndex, n(tm.turnTime),
            n(tm.elapsedGameTime), b(tm.suddenDeathActive)
        ],
        env: [n(game.wind), n(game.waterLevel)],
        rng: [game.seededRandom.getState(), game.hostRandom.getState()],
        koalas: game.teams.map(team => team.koalas.map(k => [
            n(k.x), n(k.y), n(k.vx), n(k.vy), n(k.health),
            b(k.isAlive), b(k.onGround), b(k.facingLeft), n(k.aimAngle), b(k.vanished)
        ])),
        teams: game.teams.map(team => {
            const ammo = {};
            for (const id in team.weapons || {}) {
                const a = team.weapons[id].ammo;
                ammo[id] = a === Infinity ? -1 : n(a);
            }
            return {
                koala: team.currentKoalaIndex || 0,
                forfeited: b(team.forfeited),
                weapon: team.lastSelectedWeapon || '',
                buffs: Object.keys(team.buffs || {}).filter(key => team.buffs[key]).sort(),
                ammo
            };
        }),
        crates: game.lootManager.serializeCrates(),
        nextCrateId: game.lootManager.nextCrateId,
        mines: game.projectiles
            .filter(p => p.type === 'mine' && p.stationary)
            .map(p => [n(p.x), n(p.y), b(p.isDud), b(p.dudActivated)]),
        drums: game.oilDrums.map(d => [
            d.id, n(d.x), n(d.y), n(d.hp), d.effectSeed >>> 0,
            n(d.igniteTimer), b(d.falling), n(d.vy)
        ]),
        fires: game.firePatches.map(f => [
            n(f.x), n(f.y), n(f.vx), n(f.vy), b(f.settled),
            n(f.age), n(f.lifetime), n(f.tickTimer), n(f.burnTimer)
        ]),
        terrain: [terrain.baseHash, terrain.opHash, terrain.opCount]
    };
}

export function hashTurnState(state) {
    return hashValue(FNV_OFFSET, state) >>> 0;
}

/** Names of the snapshot sections that differ (for the desync log line). */
export function diffTurnStates(mine, theirs) {
    const out = [];
    for (const key in theirs) {
        if (hashValue(FNV_OFFSET, mine[key]) !== hashValue(FNV_OFFSET, theirs[key])) out.push(key);
    }
    return out;
}

/**
 * Overwrite the local world with the host's snapshot. Must run on the frame
 * boundary the snapshot was taken at (LockstepSession guarantees it).
 * Terrain is not part of this — the session fetches the host's collision
 * mask separately when the terrain hashes differ.
 */
export function applyTurnState(game, state) {
    const tm = game.turnManager;

    // The snapshot is also a point in time (see LockstepSession.adoptHostState)
    game.frame = state.frame;
    game.simTime = state.simTime;

    const [turnCounter, teamIndex, koalaIndex, round, lastTeam, turnTime, elapsed, sudden] = state.turn;
    tm.turnCounter = turnCounter;
    tm.currentTeamIndex = teamIndex;
    tm.currentKoalaIndex = koalaIndex;
    tm.roundNumber = round;
    tm.lastTeamIndex = lastTeam;
    tm.turnTime = turnTime;
    tm.turnTimer = Math.min(tm.turnTimer, turnTime);
    tm.elapsedGameTime = elapsed;
    if (sudden && !tm.suddenDeathActive) tm.activateSuddenDeath();
    tm.suddenDeathActive = !!sudden;

    game.wind = state.env[0];
    game.waterLevel = state.env[1];

    state.koalas.forEach((list, t) => {
        const team = game.teams[t];
        if (!team) return;
        list.forEach((kd, i) => {
            const koala = team.koalas[i];
            if (!koala) return;
            const [x, y, vx, vy, health, alive, onGround, facingLeft, aimAngle, vanished] = kd;
            koala.x = x;
            koala.y = y;
            koala.vx = vx;
            koala.vy = vy;
            koala.health = health;
            koala.onGround = !!onGround;
            koala.facingLeft = !!facingLeft;
            koala.aimAngle = aimAngle;
            koala.peakY = y;
            if (koala.isAlive && !alive) {
                // The host saw this koala die and we did not
                koala.die();
                koala.isDying = false;
                game.createDeathEffect(koala);
            } else if (!koala.isAlive && alive) {
                // We killed it by mistake
                koala.isAlive = true;
                koala.isDying = false;
            }
            koala.vanished = !!vanished;
        });
    });

    state.teams.forEach((td, t) => {
        const team = game.teams[t];
        if (!team) return;
        team.currentKoalaIndex = td.koala;
        team.forfeited = !!td.forfeited;
        team.lastSelectedWeapon = td.weapon || team.lastSelectedWeapon;
        team.buffs = {};
        for (const key of td.buffs) team.buffs[key] = true;
        for (const id in td.ammo) {
            if (team.weapons?.[id]) team.weapons[id].ammo = td.ammo[id] === -1 ? Infinity : td.ammo[id];
        }
    });

    game.lootManager.applyCrateSync(state.crates);
    game.lootManager.nextCrateId = state.nextCrateId;

    // Resting mines: rebuild from the host's list (airborne projectiles are
    // left alone — a turn only starts once everything has landed)
    game.projectiles = game.projectiles.filter(p => !(p.type === 'mine' && p.stationary));
    const fixed = () => 0.5; // no RNG draws: every value comes from the snapshot
    for (const [x, y, isDud, dudActivated] of state.mines) {
        game.spawnLandmine(x, y + 5, fixed);
        const mine = game.projectiles[game.projectiles.length - 1];
        mine.x = x;
        mine.y = y;
        mine.isDud = !!isDud;
        mine.dudActivated = !!dudActivated;
    }

    game.oilDrums = state.drums.map(([id, x, y, hp, effectSeed, igniteTimer, falling, vy]) => ({
        id, x, y, hp, maxHp: 30, effectSeed,
        igniteTimer, falling: !!falling, vy, detonated: false
    }));

    game.firePatches = state.fires.map(([x, y, vx, vy, settled, age, lifetime, tickTimer, burnTimer]) => ({
        x, y, vx, vy, settled: !!settled, age, lifetime, tickTimer, burnTimer, flicker: 0
    }));

    // RNG positions go in LAST: rebuilding crates above draws from the loot
    // stream (a crate's idle-bob phase), which must not count
    game.seededRandom.setState(state.rng[0]);
    game.hostRandom.setState(state.rng[1]);

    // Point the weapon bar at the (possibly corrected) current team
    const team = game.teams[tm.currentTeamIndex];
    if (team?.weapons) {
        game.weaponManager.weapons = team.weapons;
        const id = game.weaponManager.currentWeapon?.id;
        game.weaponManager.selectWeapon(id && team.weapons[id] ? id : 'bazooka');
    }
    game.rebuildSpatialGrid();
    game.updateTeamHealth();
    game.updateWindDisplay();
    game.updateTurnIndicator();
    game.updateWeaponUI();
}
