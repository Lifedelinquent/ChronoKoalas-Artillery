/**
 * WeaponBehaviors - what each weapon TYPE does when used, in one place.
 *
 * Weapon definitions (WeaponManager.createWeapons) hold the numbers; this
 * table holds the behaviour. Game.fireWeapon / fireTargettedWeapon and the
 * projectile loop look up the weapon's `type` here, so adding or tuning a
 * weapon type is a change to one entry instead of edits scattered through
 * the engine.
 *
 * Hooks (all optional; `game` is the Game instance):
 *
 *   fire(game, koala, weapon, angle, power)
 *       Use the weapon. Return false to refuse (no ammo spent, nothing sent
 *       to remote players). May return { targetX, targetY } to ride along
 *       in the network fire message (homing missile).
 *   target(game, koala, weapon, x, y)
 *       Targetted weapons (clicked on the map). Return false to refuse.
 *   beforeMove(game, projectile, dt)
 *       Per frame while one of this type's projectiles flies, before physics
 *       moves it (steering, walking).
 *   afterMove(game, projectile, dt)
 *       Per frame after physics moved it (trails and other cosmetics).
 *
 * Flags:
 *   selfAmmo: the hook manages ammo itself (default: one per use)
 *
 * Every hook runs on EVERY client in multiplayer (local use, and the remote
 * replay via handleRemoteFire), so any randomness must come from the shared
 * seeded stream at fire time or a sub-RNG — see the RNG invariants in
 * Game.makeSubRandom.
 */

import { log } from '../utils/Logger.js';

/** Turn-counter guarded delayed processDamage (never ends a newer turn). */
function endTurnAfter(game, ms) {
    game.phase = 'damage';
    const turn = game.turnManager.turnCounter;
    game.scheduleDelayedAction(ms, () => {
        if (game.turnManager.turnCounter === turn) game.processDamage();
    });
}

/** Smoke trail puffs behind rockets and missiles (cosmetic). */
function smokeTrail(game, proj, dt) {
    if (game.particles.length >= game.maxParticles - 10) return;
    proj.trailAccum = (proj.trailAccum || 0) + dt;
    if (proj.trailAccum <= 0.03) return;
    proj.trailAccum = 0;
    game.addParticle({
        type: 'smoke',
        x: proj.x - Math.cos(proj.rotation) * 14,
        y: proj.y - Math.sin(proj.rotation) * 14,
        vx: (Math.random() - 0.5) * 20,
        vy: (Math.random() - 0.5) * 20,
        lifetime: 0.6,
        time: 0,
        color: '#bbb',
        size: 3 + Math.random() * 2
    });
}

/**
 * The plain projectile launcher (bazooka, grenades, mortar, longbow,
 * dynamite, mines, sheep, ...): spawn one projectile along the aim.
 */
const launchProjectile = {
    fire(game, koala, weapon, angle, power) {
        // Firing anything but the shotgun ends a pending shotgun pair
        game.shotgunShotsRemaining = 0;

        // Spawn projectile away from koala in the firing direction so it
        // doesn't immediately hit the shooter
        const spawnOffset = 30;
        const spawnX = koala.x + Math.cos(angle) * spawnOffset;
        const spawnY = (koala.y - 10) + Math.sin(angle) * spawnOffset;

        const projectile = game.weaponManager.createProjectile(spawnX, spawnY, angle, power);
        if (!projectile) {
            console.error('Failed to create projectile');
            return false;
        }

        game.phase = 'projectile';
        game.projectileGraceTimer = 0.1; // grace period before the phase transition check

        // Track the shooter so we don't damage them with their own projectile
        projectile.shooter = koala;

        // Homing missile: flies straight for the boost phase, then locks onto
        // the pre-placed target marker (which now travels with the projectile)
        if (weapon.homing && game.homingTarget) {
            projectile.homingTarget = { x: game.homingTarget.x, y: game.homingTarget.y };
            projectile.homingDelay = 0.5; // straight flight before lock-on
            projectile.homingFuel = 5;    // seconds of steering before it goes ballistic
            game.homingTarget = null;
        }

        // Sheep walks in the direction it was thrown
        if (weapon.isWalker) {
            projectile.walkDir = Math.cos(angle) >= 0 ? 1 : -1;
            projectile.walkSpeed = weapon.walkSpeed || 140;
        }

        game.projectiles.push(projectile);
        game.stats?.onShot(koala, weapon, projectile);
        log.debug('Projectile created at:', spawnX.toFixed(0), spawnY.toFixed(0), 'shooter:', koala.name);

        if (weapon.type === 'dynamite') {
            // Dynamite is placed, not thrown: start retreating immediately
            game.startRetreat();
        } else {
            game.followProjectile(projectile);
        }

        // A homing shot carries its target so the remote replay steers to
        // the same point
        if (projectile.homingTarget) {
            return { targetX: projectile.homingTarget.x, targetY: projectile.homingTarget.y };
        }
    }
};

const rocket = { ...launchProjectile, afterMove: smokeTrail };

export const WEAPON_BEHAVIORS = {
    // ---------------- Launched projectiles ----------------
    bazooka: rocket,
    homing: {
        ...launchProjectile,
        // Flies ballistic for the boost phase, then the engine ignites and
        // steers toward the locked target (WA-style)
        beforeMove(game, proj, dt) {
            if (!proj.homingTarget || proj.stationary) return;
            proj.homingDelay -= dt;
            if (proj.homingDelay > 0 || proj.homingFuel <= 0) return;

            proj.homingFuel -= dt;
            const hx = proj.homingTarget.x - proj.x;
            const hy = proj.homingTarget.y - proj.y;
            const hd = Math.hypot(hx, hy) || 1;
            if (hd < 30) {
                // Reached the marker - cut the engine and fly through,
                // otherwise an in-air target makes it hover forever
                proj.homingFuel = 0;
            } else {
                // Engine burning: gravity off, velocity blends toward the target
                proj.gravityMultiplier = 0;
                const cruiseSpeed = 750;
                const blend = Math.min(1, 6 * dt);
                proj.vx += ((hx / hd) * cruiseSpeed - proj.vx) * blend;
                proj.vy += ((hy / hd) * cruiseSpeed - proj.vy) * blend;
            }
            // Out of fuel (or flew past the marker): back to ballistic
            if (proj.homingFuel <= 0) {
                proj.gravityMultiplier = proj.weapon?.gravity ?? 1;
            }
        },
        afterMove: smokeTrail
    },
    sheep: {
        ...launchProjectile,
        // Trots along the ground in its throw direction, hops over walls,
        // never settles down for long
        beforeMove(game, proj) {
            if (proj.isWalker) game.updateWalker(proj);
        }
    },
    meteor: { afterMove: smokeTrail },
    airstrike: {
        afterMove: smokeTrail,
        target(game, koala, weapon, x, y) {
            game.executeAirstrike(x, y, weapon);
        }
    },

    // ---------------- Shotgun: two shots per turn ----------------
    shotgun: {
        selfAmmo: true,
        fire(game, koala, weapon, angle) {
            // First shot of the pair spends the ammo and arms the second
            if (game.shotgunShotsRemaining === 0) {
                game.shotgunShotsRemaining = weapon.shotsPerTurn || 2;
                if (weapon.ammo !== Infinity) {
                    weapon.ammo--;
                    game.updateWeaponUI();
                }
            }

            game.phase = 'projectile';
            game.projectileGraceTimer = 0.1;
            game.shotgunShotsRemaining--;

            const spawnOffset = 30;
            const spawnX = koala.x + Math.cos(angle) * spawnOffset;
            const spawnY = (koala.y - 10) + Math.sin(angle) * spawnOffset;

            // Pellets fan out across the spread angle
            const pelletCount = weapon.pelletCount || 6;
            const spreadAngle = weapon.spreadAngle || 0.25;
            for (let i = 0; i < pelletCount; i++) {
                const spreadOffset = (i - (pelletCount - 1) / 2) * (spreadAngle / (pelletCount - 1));
                const projectile = game.weaponManager.createProjectile(spawnX, spawnY, angle + spreadOffset, 1.0);
                if (projectile) {
                    projectile.shooter = koala;
                    projectile.isPellet = true;
                    projectile.maxRange = weapon.maxRange || 200;
                    projectile.startX = spawnX;
                    projectile.startY = spawnY;
                    game.projectiles.push(projectile);
                }
            }
            game.stats?.onShot(koala, weapon, null);
            log.debug(`🔫 Shotgun blast! ${pelletCount} pellets, ${game.shotgunShotsRemaining} shots remaining`);
        }
    },

    // ---------------- Burst guns (handgun / uzi / minigun) ----------------
    gunburst: {
        fire(game, koala, weapon, angle) {
            game.fireBurstGun(koala, weapon, angle);
            game.stats?.onShot(koala, weapon, null);
        }
    },

    // ---------------- Melee ----------------
    melee: {
        fire(game, koala, weapon, angle) {
            game.handleMeleeSwing(koala, weapon, angle);
            game.stats?.onShot(koala, weapon, null);

            // No projectile, but the swing still ends the turn phase once the
            // animation is done (turn-counter guard: never fire into a turn
            // that started since)
            game.phase = 'projectile';
            const swingTurn = game.turnManager.turnCounter;
            game.scheduleDelayedAction(500, () => {
                if (game.turnManager.turnCounter === swingTurn && game.projectiles.length === 0) {
                    game.startRetreat();
                }
            });
        }
    },
    kamikaze: {
        fire(game, koala, weapon, angle) {
            game.startKamikaze(koala, weapon, angle);
            game.stats?.onShot(koala, weapon, null);
        }
    },

    // ---------------- Tools ----------------
    blowtorch: {
        fire(game, koala, weapon) {
            game.activateBlowtorch(koala, weapon);
        }
    },
    drill: {
        fire(game, koala, weapon) {
            game.activateDrill(koala, weapon);
        }
    },
    parachute: {
        // Deploys for the rest of the turn; doesn't end it
        fire(game, koala) {
            if (koala.parachuteActive) return false; // already deployed
            koala.parachuteActive = true;
            game.createFloatingText(koala.x, koala.y - 40, 'Parachute ready!', '#7ec8ff');
        }
    },
    rope: {
        // WA-style swinging (see RopeSystem). Firing the hook never ends the
        // turn; ammo is consumed once per turn, so re-shots while swinging or
        // falling in the same turn are free.
        selfAmmo: true,
        fire(game, koala, weapon, angle) {
            // Artillery mode forbids all movement, rope included (same check
            // on every client, so a blocked fire is never sent or replayed)
            if (game.scheme?.artilleryMode) {
                game.audioManager.playClick();
                return false;
            }

            // Re-fire while already roped: let go first, then shoot again
            if (game.ropeState) game.clearRope();

            const firstRopeThisTurn = game.ropeAmmoTurn !== game.turnManager.turnCounter;
            if (firstRopeThisTurn && weapon.ammo !== Infinity) {
                weapon.ammo--;
                game.updateWeaponUI();
            }
            game.ropeAmmoTurn = game.turnManager.turnCounter;

            game.startRope(koala, weapon, angle);
        }
    },
    teleport: {
        target(game, koala, weapon, x, y) {
            return game.executeTeleport(koala, x, y) !== false;
        }
    },
    girder: {
        target(game, koala, weapon, x, y) {
            return game.placeGirder(x, y);
        }
    },

    // ---------------- Strikes ----------------
    armageddon: {
        fire(game, koala, weapon) {
            game.executeArmageddon(weapon);
        }
    },

    // ---------------- Turn management ----------------
    skip: {
        fire(game) {
            log.debug('⏭️ Turn skipped');
            endTurnAfter(game, 300);
        }
    },
    surrender: {
        // With more than two sides the match keeps going: the surrendering
        // squad dies and play moves on; the normal alliance win check ends
        // the game when only one colour is left. Replayed on every client,
        // so it's symmetric.
        fire(game) {
            log.debug('🏳️ Surrender!');
            game.forfeitTeam(game.currentTeamIndex);
            endTurnAfter(game, 600);
        }
    }
};

/** Behaviour for a weapon type; unknown types launch a plain projectile. */
export function getWeaponBehavior(type) {
    return WEAPON_BEHAVIORS[type] || launchProjectile;
}
