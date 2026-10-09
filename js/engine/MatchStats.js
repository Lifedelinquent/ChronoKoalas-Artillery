/**
 * MatchStats - per-team match statistics and end-of-match awards.
 *
 * Fed by small hooks: Koala.takeDamage / Koala.die (via onDamaged/onDied,
 * wired in createTeams), weapon fire (WeaponBehaviors → onShot), crate
 * pickups and network explosion sync. Damage is credited to the explicit
 * attacker of the current impact when there is one (the projectile's
 * shooter), otherwise to the koala whose turn it is — the same way Worms
 * credits fall damage and chain reactions to the player who set them off.
 *
 * Purely observational: nothing here feeds back into the simulation.
 */

export class MatchStats {
    constructor(game) {
        this.game = game;
        this.byTeam = new Map();
        this.attacker = null;
        this.longestHit = null;   // { team, distance, weapon }
        this.biggestTurn = null;  // { team, damage }
        this.turnDamage = 0;
        this.turnTeam = null;
    }

    entry(team) {
        if (!team) return null;
        let e = this.byTeam.get(team);
        if (!e) {
            e = {
                turns: 0, shots: 0, hits: 0, damageDealt: 0, damageTaken: 0, friendlyDamage: 0,
                kills: 0, teamKills: 0, deaths: 0, drowned: 0, crates: 0
            };
            this.byTeam.set(team, e);
        }
        return e;
    }

    /** Who gets credit for damage right now. */
    currentAttacker() {
        return this.attacker || this.game.getCurrentKoala() || null;
    }

    /** Run fn with an explicit attacker (projectile impacts). */
    withAttacker(koala, fn) {
        const prev = this.attacker;
        this.attacker = koala || prev;
        try {
            return fn();
        } finally {
            this.attacker = prev;
        }
    }

    onTurnStart() {
        this.flushTurn();
        this.turnTeam = this.game.getCurrentTeam();
        if (this.turnTeam) this.entry(this.turnTeam).turns++;
        this.turnDamage = 0;
        this.shotHit = false;
    }

    flushTurn() {
        if (this.turnTeam && this.turnDamage > 0 &&
            (!this.biggestTurn || this.turnDamage > this.biggestTurn.damage)) {
            this.biggestTurn = { team: this.turnTeam, damage: this.turnDamage };
        }
    }

    onShot(koala, weapon, projectile) {
        const e = this.entry(koala?.team);
        if (!e) return;
        e.shots++;
        this.shotHit = false;
        if (projectile) {
            projectile.statOrigin = { x: koala.x, y: koala.y };
        }
    }

    onDamage(victim, amount) {
        if (!(amount > 0) || !victim?.team) return;
        const attacker = this.currentAttacker();
        this.entry(victim.team).damageTaken += amount;
        if (!attacker?.team) return;

        victim.lastHitBy = attacker;
        const a = this.entry(attacker.team);
        if (attacker.team.alliance === victim.team.alliance) {
            a.friendlyDamage += amount;
        } else {
            a.damageDealt += amount;
            if (attacker.team === this.turnTeam) this.turnDamage += amount;
            if (!this.shotHit && attacker.team === this.turnTeam) {
                this.shotHit = true;
                a.hits++;
            }
        }
    }

    /** A projectile with a recorded origin hurt an enemy: longest-hit check. */
    onImpactHit(projectile, x, y) {
        if (!projectile?.statOrigin || !projectile.shooter?.team) return;
        const distance = Math.hypot(x - projectile.statOrigin.x, y - projectile.statOrigin.y);
        if (!this.longestHit || distance > this.longestHit.distance) {
            this.longestHit = {
                team: projectile.shooter.team,
                koala: projectile.shooter.name,
                distance,
                weapon: projectile.weapon?.name || 'shot'
            };
        }
    }

    onDeath(victim) {
        if (!victim?.team || victim._statDead) return;
        victim._statDead = true;
        const v = this.entry(victim.team);
        v.deaths++;
        if (victim.y > this.game.waterLevel - 5) v.drowned++;

        const killer = victim.lastHitBy;
        if (killer?.team) {
            const k = this.entry(killer.team);
            if (killer.team.alliance === victim.team.alliance) k.teamKills++;
            else k.kills++;
        }
    }

    onCrate(team) {
        const e = this.entry(team);
        if (e) e.crates++;
    }

    /** Final table + awards. */
    summary() {
        this.flushTurn();
        const teams = this.game.teams.map(team => {
            const e = this.entry(team);
            return {
                name: team.name,
                color: team.color,
                alive: team.isAlive(),
                ...e,
                accuracy: e.shots ? Math.round((e.hits / e.shots) * 100) : 0
            };
        });

        const awards = [];
        const best = (key, min = 1) => {
            const sorted = [...teams].sort((a, b) => b[key] - a[key]);
            return sorted[0] && sorted[0][key] >= min ? sorted[0] : null;
        };
        const add = (icon, title, team, text) => {
            if (team) awards.push({ icon, title, team: team.name || team, color: team.color, text });
        };

        const dmg = best('damageDealt');
        add('💥', 'Demolition Expert', dmg, dmg && `${Math.round(dmg.damageDealt)} damage dealt`);
        const killer = best('kills');
        add('☠️', 'Grim Reaper', killer, killer && `${killer.kills} kill${killer.kills > 1 ? 's' : ''}`);
        if (this.longestHit) {
            const t = this.longestHit.team;
            add('🎯', 'Sharpshooter', t,
                `${this.longestHit.koala}: ${Math.round(this.longestHit.distance)} px ${this.longestHit.weapon} hit`);
        }
        if (this.biggestTurn) {
            add('🔥', 'Turn of the Match', this.biggestTurn.team, `${Math.round(this.biggestTurn.damage)} damage in one turn`);
        }
        const traitor = best('friendlyDamage', 10);
        add('🤦', 'Friendly Fire', traitor, traitor && `${Math.round(traitor.friendlyDamage)} damage to own side`);
        const looter = best('crates', 2);
        add('📦', 'Crate Hoarder', looter, looter && `${looter.crates} crates collected`);
        const swimmer = best('drowned');
        add('🌊', 'Swimming Lessons Needed', swimmer, swimmer && `${swimmer.drowned} koala${swimmer.drowned > 1 ? 's' : ''} drowned`);
        const accurate = [...teams].filter(t => t.shots >= 3).sort((a, b) => b.accuracy - a.accuracy)[0];
        if (accurate && accurate.accuracy >= 50) {
            add('🏹', 'Steady Hands', accurate, `${accurate.accuracy}% of shots hurt an enemy`);
        }

        return {
            teams,
            awards,
            duration: this.game.simTime || 0,
            // Turns taken by team 0 (the human squad in single player)
            playerTurns: teams[0]?.turns ?? 0
        };
    }
}
