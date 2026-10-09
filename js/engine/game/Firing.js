/**
 * Firing - Firing entry points (fireWeapon / fireTargettedWeapon).
 *
 * These do the checks every weapon shares (ammo, scheme unlock delay,
 * homing target), then hand over to the weapon type's behaviour in
 * weapons/WeaponBehaviors.js, and finally spend ammo and replay the shot on
 * remote clients.
 *
 * Installed onto Game.prototype (see the bottom of Game.js), so every
 * method runs with `this` bound to the Game instance.
 */

import { log } from '../../utils/Logger.js';
import { getWeaponBehavior } from '../../weapons/WeaponBehaviors.js';

export const Firing = {
    /**
     * Fire the current weapon along `angle` with `power` (0-1)
     */
    fireWeapon(angle, power) {
        const koala = this.getCurrentKoala();
        const weapon = this.weaponManager.currentWeapon;

        if (!koala || !weapon) {
            console.error('Cannot fire: no koala or weapon selected');
            return;
        }

        // Check ammo
        if (weapon.ammo <= 0) {
            log.debug('Out of ammo for', weapon.name);
            this.audioManager.playClick(); // Play click sound to indicate empty
            return;
        }

        // Scheme unlock delay. Only enforced for the local player — a remote
        // fire already happened on the acting client, and refusing the replay
        // here would desync the match (mirrors the ammo-drift guard).
        if (!this.isWeaponAvailable(weapon) && (this.isPractice || this.isMyTurn())) {
            log.debug(`${weapon.name} locked for ${this.weaponDelayRemaining(weapon)} more round(s)`);
            this.audioManager.playClick();
            return;
        }

        // Homing missile needs its target placed first. Local only — a remote
        // replay always carries the target in the fire message (handleRemoteFire
        // restores it into this.homingTarget before calling us).
        if (weapon.requiresTarget && !this.homingTarget && (this.isPractice || this.isMyTurn())) {
            this.createFloatingText(koala.x, koala.y - 40, 'Click to mark a target first!', '#ff6b6b');
            this.audioManager.playClick();
            return;
        }

        log.debug('Firing weapon:', weapon.name, 'angle:', angle, 'power:', power);

        this.audioManager.playFire(weapon.id);

        // Instant replay starts recording the moment a shot is taken
        this.instantReplay?.onShotFired();

        const behavior = getWeaponBehavior(weapon.type);
        const fire = behavior.fire || getWeaponBehavior('bazooka').fire;
        const result = fire(this, koala, weapon, angle, power);
        if (result === false) return;

        if (!behavior.selfAmmo && weapon.ammo !== Infinity) {
            weapon.ammo--;
            this.updateWeaponUI();
        }

        // UI listeners (tutorial, HUD hints) — never the simulation
        this.emit('weaponFired', { weapon, koala });

        // Replay the shot on remote clients (only if this is our turn)
        if (this.networkManager && !this.isPractice && this.isMyTurn()) {
            this.networkManager.sendFire(
                weapon.id, angle, power, koala.x, koala.y,
                this.currentTeamIndex, this.currentKoalaIndex,
                result?.targetX, result?.targetY
            );
        }
    },

    /**
     * Fire a targetted weapon (airstrike, teleport, girder) at a map point.
     * Returns true if it was used (false: refused, no ammo spent).
     */
    fireTargettedWeapon(weapon, targetX, targetY) {
        const koala = this.getCurrentKoala();
        if (!koala) return false;

        // Check ammo
        if (weapon.ammo <= 0) {
            log.debug('Out of ammo for', weapon.name);
            this.audioManager.playClick();
            return false;
        }

        // Scheme unlock delay (local player only — see fireWeapon)
        if (!this.isWeaponAvailable(weapon) && (this.isPractice || this.isMyTurn())) {
            log.debug(`${weapon.name} locked for ${this.weaponDelayRemaining(weapon)} more round(s)`);
            this.audioManager.playClick();
            return false;
        }

        const behavior = getWeaponBehavior(weapon.type);
        if (!behavior.target) {
            console.warn('Unknown targetted weapon:', weapon.type);
            return false;
        }

        log.debug('Firing targetted weapon:', weapon.name, 'at', targetX, targetY);

        if (!weapon.keepsTurn) this.instantReplay?.onShotFired();

        // Some (teleport, girder) can fail validation, in which case no ammo
        // is spent and no sound plays
        if (behavior.target(this, koala, weapon, targetX, targetY) === false) {
            this.audioManager.playClick();
            return false;
        }

        this.audioManager.playFire(weapon.id);
        if (!weapon.utility) this.stats?.onShot(koala, weapon, null);

        if (weapon.ammo !== Infinity) {
            weapon.ammo--;
            log.debug('Ammo remaining:', weapon.ammo);
            this.updateWeaponUI();
        }
        this.emit('weaponFired', { weapon, koala });

        // Send to network (only if this is our turn)
        if (this.networkManager && !this.isPractice && this.isMyTurn()) {
            this.networkManager.sendTargetWeapon(weapon.id, targetX, targetY, this.currentTeamIndex, this.currentKoalaIndex);
        }
        return true;
    }
};
