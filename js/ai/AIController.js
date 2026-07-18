/**
 * AIController - CPU opponents for single player, in the spirit of
 * Worms Armageddon's CPU teams (CPU 1-5).
 *
 * The AI drives a CPU-flagged team through the exact same Game APIs the
 * human player uses (selectWeapon / aimAngle / fireWeapon / canWalkUp), so
 * everything downstream — physics, damage, retreat, turn handover — behaves
 * identically to a human turn. It never touches the network: CPU teams only
 * exist in local (isPractice) games.
 *
 * Aiming works like WA's: the CPU brute-force simulates real trajectories
 * (same gravity/wind constants as Physics) over an angle × power grid and
 * fires the best solution it finds, with an accuracy jitter that shrinks as
 * the difficulty rises. Difficulty 0 is a special "passive" brain used as
 * living targets in Training mode — it just skips every turn.
 */

const GRAVITY = 400;      // matches Physics.gravity
const WIND_ACCEL = 240;   // matches Physics.windAccel (scaled by game.wind)
const SPAWN_OFFSET = 30;  // matches fireWeapon's projectile spawn offset

/**
 * Per-difficulty behaviour profiles (index = difficulty 1..5).
 * angleSteps/powerSteps control search resolution; jitter is the aim error
 * applied to the found solution; acceptErr is how close (px) a predicted
 * impact must land before the CPU stops looking for something better.
 */
const PROFILES = {
    1: {
        thinkTime: 2.2, angleSteps: 12, powerSteps: 4,
        angleJitter: 0.08, powerJitter: 0.10, acceptErr: 120,
        canWalk: false, useAirstrike: false,
        weapons: ['bazooka', 'grenade', 'shotgun']
    },
    2: {
        thinkTime: 1.8, angleSteps: 16, powerSteps: 5,
        angleJitter: 0.05, powerJitter: 0.06, acceptErr: 90,
        canWalk: false, useAirstrike: false,
        weapons: ['bazooka', 'grenade', 'shotgun', 'handgun', 'mortar']
    },
    3: {
        thinkTime: 1.4, angleSteps: 20, powerSteps: 6,
        angleJitter: 0.025, powerJitter: 0.035, acceptErr: 70,
        canWalk: true, useAirstrike: false,
        weapons: ['bazooka', 'grenade', 'shotgun', 'handgun', 'uzi', 'mortar', 'cluster', 'dynamite']
    },
    4: {
        thinkTime: 1.1, angleSteps: 26, powerSteps: 7,
        angleJitter: 0.012, powerJitter: 0.02, acceptErr: 50,
        canWalk: true, useAirstrike: true,
        weapons: ['bazooka', 'grenade', 'shotgun', 'handgun', 'uzi', 'mortar', 'cluster',
            'dynamite', 'petrol', 'holygrenade', 'banana', 'minigun']
    },
    5: {
        thinkTime: 0.8, angleSteps: 32, powerSteps: 8,
        angleJitter: 0.005, powerJitter: 0.008, acceptErr: 35,
        canWalk: true, useAirstrike: true,
        weapons: ['bazooka', 'grenade', 'shotgun', 'handgun', 'uzi', 'mortar', 'cluster',
            'dynamite', 'petrol', 'holygrenade', 'banana', 'minigun', 'sheep']
    }
};

export class AIController {
    constructor(game) {
        this.game = game;

        // Turn-scoped state machine: idle → thinking → walking? → aiming → done
        this.state = 'idle';
        this.stateTimer = 0;
        this.plan = null;          // { weaponId, angle, power, timer?, target, impact }
        this.lastTurnSeen = -1;
        this.replansLeft = 0;
        this.walkDir = 0;
        this.walkTimer = 0;
        this.walkStuckTime = 0;
        this.aimStartAngle = 0;
        this.aimProgress = 0;
    }

    /**
     * Ticked every frame from Game.update. Only acts while the current team
     * is CPU-controlled and the game is in a live turn phase.
     */
    update(dt) {
        const g = this.game;
        if (g.isGameOver || g.isPaused) return;

        const team = g.getCurrentTeam();
        if (!team || !team.isCPU) {
            this.state = 'idle';
            return;
        }

        // New turn for a CPU team → start thinking
        if (g.turnManager.turnCounter !== this.lastTurnSeen && g.phase === 'aiming') {
            this.lastTurnSeen = g.turnManager.turnCounter;
            this.beginTurn(team);
        }

        // Retreat: scoot away from where our shot is landing
        if (g.phase === 'retreat' && this.plan && this.plan.retreatDir) {
            this.walkKoala(g.getCurrentKoala(), this.plan.retreatDir, dt);
            return;
        }

        if (g.phase !== 'aiming' && g.phase !== 'firing') {
            // Our shot is in flight / resolving. If the phase comes back to
            // aiming in the same turn (shotgun second shell), replan quickly.
            if (this.state !== 'idle' && this.state !== 'awaitPhase') return;
        }

        // Shotgun second shot (or any keeps-turn weapon): phase returned to
        // 'aiming' within the same turn after we already fired.
        if (this.state === 'awaitPhase' && g.phase === 'aiming') {
            this.state = 'thinking';
            this.stateTimer = 0.6;
            this.plan = null;
        }

        const koala = g.getCurrentKoala();
        if (!koala || !koala.isAlive) return;

        // Panic button: almost out of time and still no shot fired → skip
        if (g.phase === 'aiming' && g.turnTimer < 1.5 &&
            (this.state === 'thinking' || this.state === 'walking')) {
            this.fireSkip();
            return;
        }

        switch (this.state) {
            case 'thinking':
                this.stateTimer -= dt;
                if (this.stateTimer <= 0) {
                    this.decide(team, koala);
                }
                break;

            case 'walking':
                this.updateWalking(koala, dt);
                break;

            case 'aiming':
                this.updateAimingState(koala, dt);
                break;
        }
    }

    beginTurn(team) {
        const profile = this.profileFor(team);
        this.plan = null;
        this.walkDir = 0;
        this.replansLeft = profile.canWalk ? 1 : 0;
        this.state = 'thinking';
        // Humanized thinking pause (passive dummies react almost instantly)
        this.stateTimer = team.aiDifficulty === 0
            ? 0.4
            : profile.thinkTime * (0.6 + Math.random() * 0.8);
    }

    profileFor(team) {
        const d = Math.max(1, Math.min(5, Math.round(team.aiDifficulty || 1)));
        return PROFILES[d];
    }

    // ------------------------------------------------------------------
    // Decision making
    // ------------------------------------------------------------------

    /**
     * Pick a target and a weapon, and compute a firing solution.
     */
    decide(team, koala) {
        const g = this.game;

        // Passive brain (training dummies): always skip
        if (team.aiDifficulty === 0) {
            this.fireSkip();
            return;
        }

        const profile = this.profileFor(team);
        const targets = this.rankTargets(team, koala);
        if (targets.length === 0) {
            this.fireSkip();
            return;
        }

        let best = null; // { plan, err }
        for (const target of targets.slice(0, 3)) {
            const plan = this.planForTarget(team, koala, target, profile);
            if (plan && (!best || plan.err < best.err)) {
                best = plan;
            }
            if (best && best.err <= profile.acceptErr) break;
        }

        // Nothing decent found: walk closer once (if allowed), else fire the
        // least-bad ballistic solution anyway — a wild bazooka beats sulking.
        if (!best || best.err > profile.acceptErr * 2.5) {
            if (profile.canWalk && this.replansLeft > 0 && !g.scheme?.artilleryMode) {
                this.replansLeft--;
                this.startWalking(koala, targets[0]);
                return;
            }
        }

        if (!best) {
            this.fireSkip();
            return;
        }

        this.executePlan(koala, best);
    }

    /**
     * All living enemy koalas, best target first. Prefers wounded and nearby
     * enemies, with a bit of randomness so the CPU doesn't tunnel-vision.
     */
    rankTargets(team, koala) {
        const out = [];
        for (const t of this.game.teams) {
            if (t.alliance === team.alliance) continue;
            for (const k of t.koalas) {
                if (!k.isAlive) continue;
                const dist = Math.hypot(k.x - koala.x, k.y - koala.y);
                const score = dist * 0.5 + k.health * 2 + Math.random() * 60;
                out.push({ koala: k, dist, score });
            }
        }
        out.sort((a, b) => a.score - b.score);
        return out.map(o => o.koala);
    }

    /**
     * Best available plan against one target, trying (in order): melee,
     * airstrike, direct-fire guns, then the ballistic search.
     * Returns { weaponId, angle, power, timer, err, target, ... } or null.
     */
    planForTarget(team, koala, target, profile) {
        const g = this.game;
        const dx = target.x - koala.x;
        const dy = target.y - koala.y;
        const dist = Math.hypot(dx, dy);
        const angleTo = Math.atan2(dy - 10, dx);

        // ---- Melee: right next to them → whack ----
        if (Math.abs(dx) < 46 && Math.abs(dy) < 45) {
            const meleeId = ['bat', 'firepunch', 'dragonball', 'prod']
                .find(id => this.canUse(team, id));
            if (meleeId) {
                return {
                    weaponId: meleeId, angle: angleTo, power: 1,
                    err: 0, target, retreatDir: dx > 0 ? -1 : 1
                };
            }
        }

        // ---- Airstrike: open sky above the target ----
        if (profile.useAirstrike && Math.random() < 0.35 &&
            this.canUse(team, 'airstrike') && this.skyIsClear(target.x, target.y) &&
            Math.abs(dx) > 150) {
            return {
                weaponId: 'airstrike', targetted: true,
                targetX: target.x, targetY: target.y,
                angle: angleTo, power: 1, err: 0, target
            };
        }

        // ---- Guns: clear line of sight ----
        const gunOrder = dist <= 190 ? ['shotgun', 'uzi', 'handgun', 'minigun']
            : ['handgun', 'uzi', 'minigun'];
        for (const gunId of gunOrder) {
            if (!profile.weapons.includes(gunId) || !this.canUse(team, gunId)) continue;
            const gun = team.weapons[gunId];
            if (dist > (gun.maxRange || 200) * 0.95) continue;
            if (!this.lineOfSightClear(team, koala, target)) break;
            return {
                weaponId: gunId, angle: angleTo, power: 1,
                err: 0, target,
                jitterAngle: profile.angleJitter * 0.6
            };
        }

        // ---- Ballistic search (bazooka / grenade / mortar / cluster ...) ----
        return this.ballisticPlan(team, koala, target, profile);
    }

    /**
     * Grid-search angle × power over the CPU's ballistic arsenal, simulating
     * true trajectories (gravity + wind + terrain). Returns the best plan.
     */
    ballisticPlan(team, koala, target, profile) {
        const g = this.game;

        // Candidate launchers, in rough preference order
        const timedIds = ['grenade', 'cluster', 'banana', 'holygrenade'];
        const contactIds = ['bazooka', 'mortar'];
        const candidates = [];
        for (const id of contactIds) {
            if (profile.weapons.includes(id) && this.canUse(team, id)) {
                candidates.push({ id, timed: false });
            }
        }
        for (const id of timedIds) {
            if (profile.weapons.includes(id) && this.canUse(team, id)) {
                candidates.push({ id, timed: true });
            }
        }
        if (candidates.length === 0) return null;

        // Big-bomb bias: prefer heavy ordnance on clustered/wounded targets
        // occasionally, otherwise lead with the first (bazooka).
        if (candidates.length > 1 && Math.random() < 0.35) {
            candidates.push(candidates.shift());
        }

        let best = null;
        for (const cand of candidates.slice(0, 2)) {
            const weapon = team.weapons[cand.id];
            const timers = cand.timed
                ? (profile.angleSteps >= 20 ? [2, 3, 4] : [3])
                : [null];

            for (const timer of timers) {
                const sol = this.searchSolution(koala, target, weapon, timer, profile);
                if (sol && (!best || sol.err < best.err)) {
                    best = {
                        weaponId: cand.id,
                        angle: sol.angle,
                        power: sol.power,
                        timer,
                        err: sol.err,
                        impact: sol.impact,
                        target,
                        jitterAngle: profile.angleJitter,
                        jitterPower: profile.powerJitter,
                        retreatDir: (target.x > koala.x) ? -1 : 1
                    };
                }
            }
            if (best && best.err <= profile.acceptErr) break;
        }
        return best;
    }

    /**
     * Angle × power grid search for one weapon. Scores each shot by the
     * distance from its predicted impact to the target, with a heavy penalty
     * for shots that land on the shooter or an ally.
     */
    searchSolution(koala, target, weapon, timer, profile) {
        const dir = target.x >= koala.x ? 1 : -1;
        const minElev = -1.45; // steep lob
        const maxElev = 0.9;   // shooting downhill
        const powers = [];
        for (let i = 0; i < profile.powerSteps; i++) {
            powers.push(0.35 + (0.65 * i) / Math.max(1, profile.powerSteps - 1));
        }

        let best = null;
        for (let a = 0; a < profile.angleSteps; a++) {
            const elev = minElev + ((maxElev - minElev) * a) / (profile.angleSteps - 1);
            const angle = dir > 0 ? elev : Math.PI - elev;

            for (const power of powers) {
                const impact = this.simulateShot(koala, weapon, angle, power, timer);
                if (!impact) continue;

                let err = Math.hypot(impact.x - target.x, impact.y - target.y);
                err += this.friendlyFirePenalty(koala, weapon, impact);
                if (impact.water) err += 400;

                if (!best || err < best.err) {
                    best = { angle, power, err, impact };
                }
            }
        }
        return best;
    }

    /**
     * Simulate one shot with the real physics constants. Returns the
     * predicted explosion point { x, y, water? } or null if it left the map.
     * Timed weapons bounce (approximated) until the fuse pops; contact
     * weapons explode on the first terrain/koala hit.
     */
    simulateShot(koala, weapon, angle, power, timer) {
        const g = this.game;
        const speed = (weapon.speed || 0) * Math.max(0.2, power);
        let x = koala.x + Math.cos(angle) * SPAWN_OFFSET;
        let y = (koala.y - 10) + Math.sin(angle) * SPAWN_OFFSET;
        let vx = Math.cos(angle) * speed;
        let vy = Math.sin(angle) * speed;

        const grav = GRAVITY * (weapon.gravity ?? 1);
        const windA = weapon.affectedByWind !== false ? g.wind * WIND_ACCEL : 0;
        const bounciness = weapon.bounciness || 0.5;
        const timed = timer != null;
        const fuse = timed ? timer : Infinity;

        const dt = 1 / 60;
        const maxT = timed ? fuse : 8;
        let t = 0;

        while (t < maxT + dt) {
            const px = x, py = y;
            vy += grav * dt;
            vx += windA * dt;
            x += vx * dt;
            y += vy * dt;
            t += dt;

            if (x < -50 || x > g.worldWidth + 50 || y < -3000) return null;
            if (y >= g.waterLevel) return { x, y: g.waterLevel, water: true };

            if (g.terrain.checkCollision(x, y)) {
                if (!timed) return { x, y }; // contact weapon: boom

                // Timed weapon: approximate the bounce. Decide the surface
                // orientation by probing which axis the previous position
                // was clear on, then reflect with damping.
                const hitVertical = g.terrain.checkCollision(px, y);   // floor/ceiling
                const hitHorizontal = g.terrain.checkCollision(x, py); // wall
                x = px;
                y = py;
                if (hitHorizontal && !hitVertical) {
                    vx = -vx * bounciness;
                    vy *= 0.9;
                } else {
                    vy = -vy * bounciness;
                    vx *= bounciness * 0.9;
                }
                // Nearly at rest: sit still until the fuse pops
                if (Math.hypot(vx, vy) < 30) {
                    return { x, y };
                }
            }
        }
        return { x, y };
    }

    /**
     * Penalty added to a solution whose blast would catch the shooter or an
     * ally. WA CPUs famously still nuke themselves occasionally — the lower
     * difficulties keep a bit of that charm via their aim jitter instead.
     */
    friendlyFirePenalty(shooter, weapon, impact) {
        const radius = (weapon.explosionRadius || 50) + 25;
        let penalty = 0;
        for (const team of this.game.teams) {
            if (team.alliance !== shooter.team.alliance) continue;
            for (const k of team.koalas) {
                if (!k.isAlive) continue;
                const d = Math.hypot(k.x - impact.x, k.y - impact.y);
                if (d < radius) {
                    penalty += (k === shooter ? 1200 : 800) * (1 - d / radius);
                }
            }
        }
        return penalty;
    }

    /**
     * Straight-line check from the koala's gun to the target: blocked by
     * terrain or by an ally standing in the corridor.
     */
    lineOfSightClear(team, koala, target) {
        const g = this.game;
        const x0 = koala.x, y0 = koala.y - 10;
        const dx = target.x - x0, dy = (target.y - 5) - y0;
        const dist = Math.hypot(dx, dy);
        const steps = Math.ceil(dist / 6);

        for (let i = 1; i < steps; i++) {
            const x = x0 + (dx * i) / steps;
            const y = y0 + (dy * i) / steps;
            if (g.terrain.checkCollision(x, y)) return false;

            // An ally in the firing corridor (but not the target itself)
            for (const t of g.teams) {
                if (t.alliance !== team.alliance) continue;
                for (const k of t.koalas) {
                    if (!k.isAlive || k === koala) continue;
                    if (Math.abs(k.x - x) < 16 && Math.abs(k.y - y) < 22) return false;
                }
            }
        }
        return true;
    }

    /**
     * True when nothing solid hangs over the target (airstrike can reach it).
     */
    skyIsClear(tx, ty) {
        for (let y = ty - 40; y > 5; y -= 12) {
            if (this.game.terrain.checkCollision(tx, y)) return false;
        }
        return true;
    }

    canUse(team, weaponId) {
        const w = team.weapons?.[weaponId];
        return !!w && w.ammo > 0 && this.game.isWeaponAvailable(w);
    }

    // ------------------------------------------------------------------
    // Execution
    // ------------------------------------------------------------------

    /**
     * Commit to a plan: select the weapon, then swing the aim toward the
     * solution over a short animation before firing.
     */
    executePlan(koala, plan) {
        const g = this.game;

        // Apply the difficulty's aim error now, so what you see the CPU aim
        // at is what actually gets fired.
        if (plan.jitterAngle) {
            plan.angle += this.gauss() * plan.jitterAngle;
        }
        if (plan.jitterPower) {
            plan.power = Math.max(0.2, Math.min(1, plan.power * (1 + this.gauss() * plan.jitterPower)));
        }

        this.plan = plan;
        g.weaponManager.selectWeapon(plan.weaponId);
        const team = g.getCurrentTeam();
        if (team) team.lastSelectedWeapon = plan.weaponId;
        if (plan.timer != null) g.weaponManager.setTimer(plan.timer);
        g.updateWeaponUI();

        koala.facingLeft = Math.cos(plan.angle) < 0;

        this.aimStartAngle = koala.aimAngle;
        this.aimProgress = 0;
        this.state = 'aiming';
    }

    /**
     * Ease the crosshair from the current angle to the planned one, hold a
     * beat, then fire. Targetted weapons (airstrike) skip the aim swing.
     */
    updateAimingState(koala, dt) {
        const g = this.game;
        const plan = this.plan;
        if (!plan) { this.state = 'idle'; return; }

        if (plan.targetted) {
            const weapon = g.weaponManager.currentWeapon;
            this.state = 'awaitPhase';
            g.fireTargettedWeapon(weapon, plan.targetX, plan.targetY);
            return;
        }

        this.aimProgress = Math.min(1, this.aimProgress + dt / 0.7);
        // Shortest-path interpolation between angles
        let delta = plan.angle - this.aimStartAngle;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        const eased = 1 - Math.pow(1 - this.aimProgress, 3);
        koala.aimAngle = this.aimStartAngle + delta * eased;

        if (this.aimProgress >= 1) {
            koala.aimAngle = plan.angle;
            this.state = 'awaitPhase';
            g.fireWeapon(plan.angle, plan.power);
        }
    }

    fireSkip() {
        const g = this.game;
        g.weaponManager.selectWeapon('skip');
        g.updateWeaponUI();
        this.state = 'awaitPhase';
        g.fireWeapon(0, 1);
    }

    // ------------------------------------------------------------------
    // Walking
    // ------------------------------------------------------------------

    startWalking(koala, target) {
        this.walkDir = target.x > koala.x ? 1 : -1;
        this.walkTimer = 1.2 + Math.random() * 1.3;
        this.walkStuckTime = 0;
        this.state = 'walking';
        koala.facingLeft = this.walkDir < 0;
    }

    updateWalking(koala, dt) {
        this.walkTimer -= dt;

        const moved = this.walkKoala(koala, this.walkDir, dt);
        if (!moved) {
            this.walkStuckTime += dt;
        } else {
            this.walkStuckTime = 0;
        }

        // Stop at cliffs: don't step onto a drop that would hurt
        const g = this.game;
        const aheadX = koala.x + this.walkDir * 14;
        const groundAhead = g.terrain.getGroundBelow(aheadX, koala.y);
        const dropAhead = groundAhead - koala.y;
        const cliff = dropAhead > 110 || groundAhead >= g.waterLevel;

        if (this.walkTimer <= 0 || this.walkStuckTime > 0.4 || cliff) {
            this.state = 'thinking';
            this.stateTimer = 0.35;
        }
    }

    /**
     * Ground walk one step, using the same terrain-following move the
     * player's input path uses. Returns true if the koala actually moved.
     */
    walkKoala(koala, dir, dt) {
        const g = this.game;
        if (!koala || !koala.isAlive || dir === 0) return false;
        if (g.scheme?.artilleryMode) return false;
        if (!koala.onGround || koala.isSliding) return false;

        koala.facingLeft = dir < 0;
        const step = dir * 45 * dt; // InputManager.moveSpeed
        const result = g.physics.canWalkUp(koala, step);
        if (result.canMove) {
            koala.x += step;
            if (result.newY !== koala.y) koala.y = result.newY;
            return true;
        }
        return false;
    }

    /** Cheap normal-ish random in roughly [-1.5, 1.5] */
    gauss() {
        return (Math.random() + Math.random() + Math.random()) - 1.5;
    }
}
