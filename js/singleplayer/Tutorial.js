/**
 * Tutorial - an interactive first lesson. One koala, a row of 1 HP target
 * dummies that never fight back, and a step-by-step coach panel that waits
 * for the player to actually do each thing (walk, jump, aim, open the
 * weapons, fire, rope, teleport) before moving on. Finish by clearing the
 * range.
 *
 * Key names in the prompts come from the player's current bindings.
 */

import { defaultScheme, sanitizeScheme } from '../utils/GameScheme.js';
import { bindingLabel } from '../utils/Settings.js';

export function buildTutorial() {
    const s = defaultScheme();
    Object.assign(s, {
        name: 'Tutorial',
        turnTime: 120,
        retreatTime: 3,
        windStrength: 0.4,
        suddenDeathTime: -1,
        mineCount: 0,
        oilDrumCount: 2,
        crateDropChance: 0,
        maxCratesOnMap: 0
    });
    for (const id in s.weapons) s.weapons[id].ammo = 0;
    for (const id of ['bazooka', 'grenade', 'shotgun', 'rope', 'teleport', 'skip']) {
        if (s.weapons[id]) s.weapons[id].ammo = -1;
    }
    return {
        teamsConfig: [
            { name: 'Recruit', color: 'red', isCPU: false, koalaCount: 1, health: 100 },
            { name: 'Target Dummies', color: 'yellow', alliance: 'cpu', isCPU: true, difficulty: 0, koalaCount: 4, health: 1 }
        ],
        scheme: sanitizeScheme(s),
        seed: 1337,
        context: { mode: 'tutorial' }
    };
}

/** Steps: text (may use key labels) + a check run against live state. */
function steps() {
    const k = (a) => `<kbd>${bindingLabel(a)}</kbd>`;
    return [
        {
            title: 'Walking',
            text: `Walk left and right with ${k('left')} and ${k('right')}.`,
            touch: 'Hold the ◀ ▶ buttons to walk.',
            check: (s) => s.walked > 40
        },
        {
            title: 'Jumping',
            text: `Press ${k('jump')} to jump forward. Press it twice quickly for a little back hop.`,
            touch: 'Tap ⤴ to jump (twice quickly = back hop).',
            check: (s) => s.jumped
        },
        {
            title: 'High jump & backflip',
            text: `${k('highJump')} jumps straight up. Tap it twice quickly for a backflip.`,
            touch: 'Tap ⤒ for a high jump (twice quickly = backflip).',
            check: (s) => s.highJumped
        },
        {
            title: 'Aiming',
            text: `Move the mouse to aim (or use ${k('aimUp')} / ${k('aimDown')}). The crosshair shows where you're pointing.`,
            touch: 'Tap the battlefield to aim at that spot, or use ▲ ▼.',
            check: (s) => s.aimed
        },
        {
            title: 'The weapon menu',
            text: `Open your arsenal with ${k('weaponMenu')} or a right-click.`,
            touch: 'Tap 🎒 to open your arsenal.',
            check: (s) => s.menuOpened
        },
        {
            title: 'Firing the bazooka',
            text: `Pick the <b>Bazooka</b>. Hold ${k('fire')} (or the left mouse button) to charge, release to lock the power, then press again to fire. Rockets drift with the wind — check the wind meter!`,
            touch: 'Pick the Bazooka. Hold FIRE to charge, release to lock, tap FIRE again to shoot.',
            check: (s) => s.fired.has('bazooka')
        },
        {
            title: 'Grenades',
            text: `Grenades bounce and explode after their fuse. Set it with ${k('timer1')}–${k('timer5')}, then throw one.`,
            touch: 'Pick the Grenade, set the fuse with ⏱, then throw it.',
            check: (s) => s.fired.has('grenade')
        },
        {
            title: 'Ninja rope',
            text: `Pick the <b>Ninja Rope</b> and fire it at the terrain above you. Swing with ${k('left')} ${k('right')}, climb with ${k('aimUp')} ${k('aimDown')}, let go with ${k('jump')}.`,
            touch: 'Pick the Ninja Rope and fire it at the terrain above you. ◀ ▶ swing, ▲ ▼ climb, ⤴ lets go.',
            check: (s) => s.roped
        },
        {
            title: 'Teleport',
            text: 'Pick <b>Teleport</b> and click anywhere on the map to beam there. (It uses up your turn.)',
            touch: 'Pick Teleport and tap anywhere on the map.',
            check: (s) => s.fired.has('teleport')
        },
        {
            title: 'Clear the range',
            text: `Destroy every target dummy to finish. Use anything you like — and press ${k('help')} any time to see the controls.`,
            touch: 'Destroy every target dummy to finish. Tap ? for the controls.',
            check: () => false
        }
    ];
}

/**
 * Drives the coach panel for a running tutorial game.
 */
export class TutorialDirector {
    constructor(game, { touch = false } = {}) {
        this.game = game;
        this.touch = touch;
        this.steps = steps();
        this.index = 0;
        this.state = {
            walked: 0, jumped: false, highJumped: false, aimed: false,
            menuOpened: false, roped: false, fired: new Set()
        };

        this.panel = document.getElementById('tutorial-panel');
        this.offFire = game.on('weaponFired', ({ weapon }) => this.state.fired.add(weapon.id));
        this.offRope = game.on('ropeAttached', () => { this.state.roped = true; });
        this.timer = setInterval(() => this.tick(), 120);
        this.render();
    }

    tick() {
        const g = this.game;
        const s = this.state;
        const me = g.teams[0]?.koalas[0];
        if (!me || g.isGameOver) return;

        if (this.lastX !== undefined && me.onGround) s.walked += Math.abs(me.x - this.lastX);
        this.lastX = me.x;
        if (me.jumpType === 'forward' || me.jumpType === 'backward') s.jumped = true;
        if (me.jumpType === 'high' || me.jumpType === 'backflip') s.highJumped = true;
        if (this.aim0 === undefined) this.aim0 = me.aimAngle;
        if (Math.abs(me.aimAngle - this.aim0) > 0.6) s.aimed = true;
        if (g.inputManager.isWeaponMenuOpen) s.menuOpened = true;

        let advanced = false;
        while (this.index < this.steps.length - 1 && this.steps[this.index].check(s)) {
            this.index++;
            advanced = true;
        }
        if (advanced) {
            g.audioManager.playPowerup?.();
            this.render(true);
        }
    }

    render(flash = false) {
        if (!this.panel) return;
        const step = this.steps[this.index];
        const total = this.steps.length;
        this.panel.innerHTML = `
            <div class="tutorial-progress">Lesson ${this.index + 1} / ${total}</div>
            <h3>${step.title}</h3>
            <p>${this.touch ? step.touch : step.text}</p>
            <div class="tutorial-dots">${this.steps.map((_, i) =>
                `<span class="${i < this.index ? 'done' : i === this.index ? 'now' : ''}"></span>`).join('')}</div>`;
        this.panel.classList.remove('hidden');
        if (flash) {
            this.panel.classList.remove('flash');
            void this.panel.offsetWidth;
            this.panel.classList.add('flash');
        }
    }

    destroy() {
        clearInterval(this.timer);
        this.offFire?.();
        this.offRope?.();
        this.panel?.classList.add('hidden');
    }
}
