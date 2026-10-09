/**
 * Input Manager - keyboard, mouse and touch input.
 *
 * Input runs in two layers:
 *
 *  1. The PHYSICAL layer turns raw events into ACTIONS (via the player's key
 *     bindings, see utils/Settings.js) and world-space pointer positions.
 *     Anything that only changes the UI — the weapon menu, camera panning,
 *     zoom, the controls overlay — is handled right here and never reaches
 *     the simulation.
 *
 *  2. Everything that can change the simulation goes through dispatch() as a
 *     small command ({t:'press', a:'fire'}, {t:'pmove', x, y}, ...). This is
 *     the one door into the game for human input, which is what lets replays
 *     record a match as a list of commands and play it back exactly, and
 *     lets the touch controls drive the game with the same code paths.
 */

import { log } from '../utils/Logger.js';
import { actionsForCode } from '../utils/Settings.js';

export class InputManager {
    // Weapon types that activate instantly (no power charging)
    static INSTANT_FIRE_TYPES = ['melee', 'blowtorch', 'drill', 'kamikaze', 'parachute', 'rope', 'skip', 'surrender', 'armageddon'];

    // Phases where the pointer steers the crosshair (or the blowtorch)
    static POINTER_PHASES = ['aiming', 'firing', 'armed', 'rope', 'blowtorch'];

    // Window (seconds of game time) after takeoff in which a second tap of
    // the jump key converts the jump, exactly like Worms Armageddon's
    // double-tap jumps: Enter,Enter = backward hop, Backspace,Backspace =
    // backflip. Game time, not wall time, so replays reproduce it exactly.
    static JUMP_CONVERT_WINDOW = 0.28;

    constructor(game) {
        this.game = game;

        // Held simulation actions (left/right/aimUp/... → bool). Only ever
        // changed by commands, so a replay rebuilds identical state.
        this.held = {};

        // Simulation pointer: the last world position the player aimed with,
        // plus the primary button. Drives aim and the blowtorch.
        this.simPointer = { x: 0, y: 0, down: false };

        // UI pointer (cursor drawing, camera drag, weapon-bar auto-hide)
        this.mouse = { x: 0, y: 0, down: false, rightDown: false, lastMoveTime: 0 };

        this.isCharging = false;
        this.lockedPower = null; // Power captured when aim is locked (armed phase)
        this.isWeaponMenuOpen = false;

        // Movement settings
        this.moveSpeed = 45; // px/s
        this.aimSpeed = 2;

        // UI hooks set by the app shell (controls overlay, chat box)
        this.onHelp = null;
        this.onChat = null;

        // Bind event handlers
        this.handleKeyDown = this.handleKeyDown.bind(this);
        this.handleKeyUp = this.handleKeyUp.bind(this);
        this.handleMouseMove = this.handleMouseMove.bind(this);
        this.handleMouseDown = this.handleMouseDown.bind(this);
        this.handleMouseUp = this.handleMouseUp.bind(this);
        this.handleWheel = this.handleWheel.bind(this);

        this.windowFocused = true;

        // Headless games (determinism tests) have no DOM to listen to
        if (game.options?.headless) return;

        window.addEventListener('keydown', this.handleKeyDown);
        window.addEventListener('keyup', this.handleKeyUp);
        this.game.canvas.addEventListener('mousemove', this.handleMouseMove);
        this.game.canvas.addEventListener('mousedown', this.handleMouseDown);
        this.game.canvas.addEventListener('mouseup', this.handleMouseUp);
        this.game.canvas.addEventListener('wheel', this.handleWheel);

        // Track window focus to prevent accidental firing
        this.focusTimeout = null;
        this.handleBlur = () => {
            this.windowFocused = false;
            // Keys released while the window is unfocused never send keyup:
            // let go of everything so the koala doesn't walk off forever
            this.releaseAllHeld();
        };
        this.handleFocus = () => {
            // Brief delay before accepting clicks after refocus
            clearTimeout(this.focusTimeout);
            this.focusTimeout = setTimeout(() => {
                this.windowFocused = true;
            }, 200);
        };
        window.addEventListener('blur', this.handleBlur);
        window.addEventListener('focus', this.handleFocus);

        // Weapon selection
        this.setupWeaponSelection();
    }

    // ==================== COMMAND LAYER ====================

    /**
     * The single entry point for simulation input. Records the command for
     * replays, then applies it. Replay playback calls applyCommand directly.
     */
    dispatch(cmd) {
        // Watching a replay: the viewer's own input never reaches the sim
        if (this.game.isReplay) return;
        // During an instant replay only let-go events get through, so a key
        // released while it plays doesn't stay "held" into the next turn
        if (this.game.instantReplay?.isPlaying() && cmd.t !== 'release' && cmd.t !== 'pup') return;
        this.game.replayRecorder?.record(cmd);
        this.applyCommand(cmd);
    }

    applyCommand(cmd) {
        switch (cmd.t) {
            case 'press': this.onActionPress(cmd.a); break;
            case 'release': this.onActionRelease(cmd.a); break;
            case 'pmove': this.onPointerMove(cmd.x, cmd.y); break;
            case 'pdown': this.onPointerDown(cmd.x, cmd.y); break;
            case 'pup': this.onPointerUp(); break;
            case 'rdown': this.onSecondaryDown(); break;
            case 'sel': this.onSelectWeapon(cmd.id); break;
        }
    }

    /** Release every held action (window blur, leaving the game screen). */
    releaseAllHeld() {
        for (const a in this.held) {
            if (this.held[a]) this.dispatch({ t: 'release', a });
        }
        if (this.simPointer.down) this.dispatch({ t: 'pup' });
    }

    isHeld(action) {
        return !!this.held[action];
    }

    canAct() {
        return this.game.isMyTurn() && this.game.phase !== 'countdown';
    }

    onActionPress(action) {
        this.held[action] = true;

        // Block game actions if it's not our turn or during countdown
        if (!this.canAct()) return;

        const game = this.game;

        // Escape: clear a placed homing target so it can be re-placed
        if (action === 'cancel') {
            const weapon = game.weaponManager.currentWeapon;
            if (game.phase === 'aiming' && weapon && weapon.requiresTarget && game.homingTarget) {
                game.clearHomingTarget();
            }
            return;
        }

        // Block input if current koala is dead
        const currentKoala = game.getCurrentKoala();
        if (!currentKoala || !currentKoala.isAlive) return;

        // Blowtorch: holding fire digs toward the pointer (touch screens and
        // keyboard players have no held mouse button)
        if (game.phase === 'blowtorch' && action === 'fire') {
            this.simPointer.down = true;
            return;
        }

        // On the ninja rope: fire re-fires toward the crosshair, jump lets
        // go (swing velocity carries). Left/right/up/down are read as held
        // actions by Game.updateRopeSwing.
        if (game.phase === 'rope') {
            if (action === 'fire') game.ropeRefire();
            else if (action === 'jump') game.releaseRope();
            return;
        }

        // Fuse timer
        if (action.startsWith('timer')) {
            game.weaponManager.setTimer(parseInt(action.slice(5), 10));
            return;
        }

        if (action === 'fire') {
            // If aim is locked (armed), fire confirms the shot
            if (game.phase === 'armed') {
                this.confirmFire();
                return;
            }
            if (game.phase === 'aiming') {
                const weapon = game.weaponManager.currentWeapon;
                if (weapon && InputManager.INSTANT_FIRE_TYPES.includes(weapon.type)) {
                    // Instant activation for melee, tools and utilities
                    game.fireWeapon(currentKoala.aimAngle, 1.0);
                } else if (weapon && weapon.requiresTarget && !game.homingTarget) {
                    // Homing missile can't charge until a target is placed
                    game.createFloatingText(currentKoala.x, currentKoala.y - 40, 'Click to mark a target first!', '#ff6b6b');
                    game.audioManager.playClick();
                } else if (weapon && !weapon.targetted) {
                    // Targetted weapons fire on a pointer press instead
                    this.startCharging();
                }
            }
            return;
        }

        // Jumps work during aiming and retreat
        if (action === 'jump' && (game.phase === 'aiming' || game.phase === 'retreat')) {
            this.jump();
        } else if (action === 'highJump' && (game.phase === 'aiming' || game.phase === 'retreat')) {
            this.highJump();
        }
    }

    onActionRelease(action) {
        this.held[action] = false;

        if (action === 'fire' && this.game.phase === 'blowtorch') {
            this.simPointer.down = false;
        }

        // Release fire to lock in the shot (then press again to fire)
        if (action === 'fire' && this.isCharging) {
            this.lockAim();
        }
    }

    onPointerMove(x, y) {
        this.simPointer.x = x;
        this.simPointer.y = y;

        // Update aim angle (also while roping, so the crosshair shows where
        // a rope re-fire would go)
        const phase = this.game.phase;
        if (phase === 'aiming' || phase === 'firing' || phase === 'armed' || phase === 'rope') {
            this.updateAimFromPointer();
        }
    }

    onPointerDown(x, y) {
        this.simPointer.x = x;
        this.simPointer.y = y;
        this.simPointer.down = true;

        if (!this.canAct()) return;

        const game = this.game;
        const currentKoala = game.getCurrentKoala();
        if (!currentKoala || !currentKoala.isAlive) return;

        // Aim is locked and waiting for confirmation — this click fires
        if (game.phase === 'armed') {
            this.confirmFire();
            return;
        }

        // On the rope: click = re-fire toward the crosshair (same as fire key)
        if (game.phase === 'rope') {
            game.ropeRefire();
            return;
        }

        if (game.phase !== 'aiming') return;

        const weapon = game.weaponManager.currentWeapon;

        // Homing missile: the first click places the target marker; once
        // it's set, clicks charge and fire like any other weapon
        if (weapon && weapon.requiresTarget && !game.homingTarget) {
            game.setHomingTarget(x, y);
            return;
        }

        if (weapon && weapon.targetted) {
            // Airstrike, teleport, girder: fire at the clicked point
            game.fireTargettedWeapon(weapon, x, y);
        } else if (weapon && InputManager.INSTANT_FIRE_TYPES.includes(weapon.type)) {
            game.fireWeapon(currentKoala.aimAngle, 1.0);
        } else {
            this.startCharging();
        }
    }

    onPointerUp() {
        this.simPointer.down = false;

        // Releasing the button locks in the power and shows the committed
        // trajectory; the player clicks again to actually fire.
        if (this.isCharging) {
            this.lockAim();
        }
    }

    /** Right button: cancel a charging/locked shot, or clear a homing marker. */
    onSecondaryDown() {
        if (!this.canAct()) return;
        const game = this.game;
        if (game.phase === 'firing' || game.phase === 'armed') {
            this.cancelCharge();
            return;
        }
        const weapon = game.weaponManager.currentWeapon;
        if (game.phase === 'aiming' && weapon && weapon.requiresTarget && game.homingTarget) {
            game.clearHomingTarget();
        }
    }

    /**
     * Would a right-button press do something to the simulation right now?
     * (Otherwise it belongs to the UI: weapon menu / camera drag.)
     */
    secondaryAffectsSim() {
        if (!this.canAct()) return false;
        const game = this.game;
        if (game.phase === 'firing' || game.phase === 'armed') return true;
        const weapon = game.weaponManager.currentWeapon;
        return game.phase === 'aiming' && !!weapon && !!weapon.requiresTarget && !!game.homingTarget;
    }

    onSelectWeapon(weaponId) {
        // Block weapon selection if not our turn or during countdown
        if (!this.canAct()) return;

        const game = this.game;

        // Clicking the active blowtorch again ends the turn early
        if (game.phase === 'blowtorch' && weaponId === 'blowtorch') {
            log.debug('Ending blowtorch turn early');
            game.endBlowtorch();
            return;
        }

        game.weaponManager.selectWeapon(weaponId);
        game.updateWeaponUI();

        // Save as team's last selected weapon
        const team = game.getCurrentTeam();
        if (team) team.lastSelectedWeapon = weaponId;

        // NETWORK SYNC: Send weapon selection to opponents
        if (game.networkManager && !game.isPractice) {
            game.networkManager.send({ type: 'weaponSelect', weaponId });
        }
    }

    // ==================== PHYSICAL LAYER ====================

    setupWeaponSelection() {
        this.weaponBar = document.getElementById('weapon-bar');
        this.activeWeaponCard = document.getElementById('active-weapon-card');
        this.isWeaponMenuOpen = false;

        if (this.weaponBar) {
            this.handleWeaponClick = (e) => {
                const weaponEl = e.target.closest('.weapon');
                if (weaponEl && !weaponEl.classList.contains('disabled')) {
                    this.selectWeapon(weaponEl.dataset.weapon);
                    this.closeWeaponMenu();
                }
            };
            this.weaponBar.addEventListener('click', this.handleWeaponClick);
        }

        if (this.activeWeaponCard) {
            this.handleCardClick = (e) => {
                e.stopPropagation(); // Prevent document click handler from immediately closing it
                this.toggleWeaponMenu();
            };
            this.activeWeaponCard.addEventListener('click', this.handleCardClick);
        }

        // Click outside handler to close the menu
        this.handleOutsideClick = (e) => {
            if (!this.isWeaponMenuOpen) return;
            if (this.weaponBar && !this.weaponBar.contains(e.target) &&
                this.activeWeaponCard && !this.activeWeaponCard.contains(e.target)) {
                this.closeWeaponMenu();
            }
        };
        document.addEventListener('click', this.handleOutsideClick);
    }

    /** Select a weapon (weapon bar, touch menu, ...). */
    selectWeapon(weaponId) {
        this.dispatch({ t: 'sel', id: weaponId });
    }

    /** True while the player is typing into a text field (chat, names). */
    isTyping(e) {
        const el = e.target;
        return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
            el.tagName === 'SELECT' || el.isContentEditable);
    }

    handleKeyDown(e) {
        if (this.isTyping(e)) return;

        // F3 toggles the performance monitor (always allowed)
        if (e.code === 'F3') {
            window.debugPerformance = !window.debugPerformance;
            log.debug(`🔧 Performance debugging: ${window.debugPerformance ? 'ON' : 'OFF'}`);
            e.preventDefault();
            return;
        }

        const actions = actionsForCode(e.code);
        if (actions.length === 0) return;

        // Keys the browser would otherwise act on (scroll, back, focus move)
        if (['Space', 'Backspace', 'Tab', 'F1', 'ArrowUp', 'ArrowDown'].includes(e.code) ||
            actions.includes('weaponMenu')) {
            e.preventDefault();
        }
        if (e.repeat) return; // held keys auto-repeat; actions are edge-triggered

        for (const action of actions) {
            // ---- UI-only actions ----
            if (action === 'help') {
                this.onHelp?.();
                continue;
            }
            if (action === 'chat') {
                if (this.onChat) {
                    e.preventDefault();
                    this.onChat();
                }
                continue;
            }
            if (action === 'weaponMenu') {
                if (this.canAct()) this.toggleWeaponMenu();
                continue;
            }
            if (action === 'cancel' && this.isWeaponMenuOpen) {
                this.closeWeaponMenu();
                continue;
            }

            this.dispatch({ t: 'press', a: action });
        }
    }

    handleKeyUp(e) {
        if (this.isTyping(e)) return;
        for (const action of actionsForCode(e.code)) {
            if (this.held[action]) this.dispatch({ t: 'release', a: action });
        }
    }

    /** Convert a client (screen) point to world coordinates. */
    screenToWorld(clientX, clientY) {
        const rect = this.game.canvas.getBoundingClientRect();
        return {
            x: (clientX - rect.left) / this.game.camera.zoom + this.game.camera.x,
            y: (clientY - rect.top) / this.game.camera.zoom + this.game.camera.y
        };
    }

    /**
     * Pointer moved to a world position. The UI cursor always follows; the
     * simulation only hears about it while the pointer actually steers
     * something, so replays don't fill up with idle mouse wiggles.
     */
    pointerMoveWorld(x, y) {
        this.mouse.x = x;
        this.mouse.y = y;
        this.mouse.lastMoveTime = performance.now();

        if (this.canAct() && InputManager.POINTER_PHASES.includes(this.game.phase)) {
            this.dispatch({ t: 'pmove', x, y });
        }
    }

    handleMouseMove(e) {
        this.mouse.screenX = e.clientX;
        this.mouse.screenY = e.clientY;
        const p = this.screenToWorld(e.clientX, e.clientY);
        this.pointerMoveWorld(p.x, p.y);

        // Drag camera with right mouse button
        if (this.mouse.rightDown) {
            const dx = e.clientX - this.mouse.rightStartX;
            const dy = e.clientY - this.mouse.rightStartY;
            if (Math.hypot(dx, dy) > 5) {
                this.mouse.rightHasDragged = true;
            }
            this.panCamera(e.movementX, e.movementY);
        }
    }

    handleMouseDown(e) {
        if (e.button === 0) {
            this.mouse.down = true;
            // Ignore clicks right after refocusing window
            if (!this.windowFocused) return;
            const p = this.screenToWorld(e.clientX, e.clientY);
            this.dispatch({ t: 'pdown', x: p.x, y: p.y });
        } else if (e.button === 2) {
            this.mouse.rightDown = true;
            this.mouse.rightStartX = e.clientX;
            this.mouse.rightStartY = e.clientY;
            this.mouse.rightHasDragged = false;
            this.mouse.rightUsedBySim = false;

            if (this.secondaryAffectsSim()) {
                this.mouse.rightUsedBySim = true;
                this.dispatch({ t: 'rdown' });
            }
        }
    }

    handleMouseUp(e) {
        if (e.button === 0) {
            this.mouse.down = false;
            if (this.simPointer.down) this.dispatch({ t: 'pup' });
        } else if (e.button === 2) {
            this.mouse.rightDown = false;
            if (!this.mouse.rightHasDragged && !this.mouse.rightUsedBySim &&
                this.game.isMyTurn() && (this.game.phase === 'aiming' || this.game.phase === 'retreat')) {
                this.toggleWeaponMenu();
            }
            this.mouse.rightUsedBySim = false;
        }
    }

    /** Pan the camera by a screen-space delta (mouse drag / touch drag). */
    panCamera(dxScreen, dyScreen) {
        const camera = this.game.camera;
        camera.targetX -= dxScreen / camera.zoom;
        camera.targetY -= dyScreen / camera.zoom;
        this.game.noteManualCamera?.();
    }

    /**
     * Zoom the camera around a screen point, keeping the world point under
     * it fixed (mouse wheel / pinch).
     */
    zoomAt(screenX, screenY, newZoom) {
        const camera = this.game.camera;
        const oldZoom = camera.zoom;
        camera.zoom = Math.max(0.5, Math.min(2, newZoom));
        if (camera.zoom !== oldZoom) {
            const rect = this.game.canvas.getBoundingClientRect();
            const sx = screenX - rect.left;
            const sy = screenY - rect.top;
            const worldX = sx / oldZoom + camera.x;
            const worldY = sy / oldZoom + camera.y;

            camera.x = worldX - sx / camera.zoom;
            camera.y = worldY - sy / camera.zoom;
            camera.targetX = camera.x;
            camera.targetY = camera.y;
        }
        this.game.noteManualCamera?.();
        this.updateZoomDisplay();
    }

    handleWheel(e) {
        const direction = e.deltaY > 0 ? -1 : 1;
        this.zoomAt(e.clientX, e.clientY, this.game.camera.zoom + direction * 0.1);
        e.preventDefault();
    }

    updateZoomDisplay() {
        const zoomEl = this.game.dom.elements.zoomLevel;
        if (zoomEl) {
            zoomEl.textContent = Math.round(this.game.camera.zoom * 100) + '%';
        }
    }

    // ==================== SIMULATION HELPERS ====================

    /**
     * Aim at the simulation pointer. Always applies the exact angle (no
     * change threshold) so the result depends only on the LAST pointer
     * position — that's what lets a replay coalesce pointer moves per frame.
     */
    updateAimFromPointer() {
        if (!this.canAct()) return;

        const koala = this.game.getCurrentKoala();
        if (!koala) return;

        const dx = this.simPointer.x - koala.x;
        const dy = this.simPointer.y - (koala.y - 10);

        // Face the pointer - ONLY if not manually walking
        if (!this.isHeld('left') && !this.isHeld('right')) {
            koala.facingLeft = dx < 0;
        }

        const newAngle = Math.atan2(dy, dx);
        const changed = Math.abs(newAngle - koala.aimAngle) > 0.01;
        koala.aimAngle = newAngle;

        // NETWORK SYNC: Send aim update to opponents (throttled)
        if (changed && this.game.networkManager && !this.game.isPractice) {
            const now = performance.now();
            if (!this.lastMouseAimSync || now - this.lastMouseAimSync > 66) {
                this.game.networkManager.sendAim(koala.aimAngle,
                    this.game.currentTeamIndex, this.game.currentKoalaIndex);
                this.lastMouseAimSync = now;
            }
        }
    }

    /**
     * Per-frame UI upkeep (weapon menu, cursor)
     */
    update(dt) {
        if (this.game.options?.headless) return;
        this.updateWeaponMenuDOM();

        const canAim = this.game.isMyTurn() &&
            (this.game.phase === 'aiming' || this.game.phase === 'firing' ||
                this.game.phase === 'armed' || this.game.phase === 'rope');
        const desiredCursor = canAim ? 'crosshair' : 'default';
        if (this.game.canvas.style.cursor !== desiredCursor) {
            this.game.canvas.style.cursor = desiredCursor;
        }
    }

    /**
     * Walking and keyboard aiming, called every frame during the phases the
     * koala can move in. Reads held actions only — never raw keys.
     */
    updateAiming(koala, dt) {
        // Block movement if it's not our turn or during countdown
        if (!this.canAct()) return;

        // A dead koala (e.g. one that just drowned) can't be walked around
        if (!koala.isAlive) return;

        let moveDir = 0;
        if (this.isHeld('left')) {
            moveDir = -1;
            koala.facingLeft = true;
        }
        if (this.isHeld('right')) {
            moveDir = 1;
            koala.facingLeft = false;
        }

        // Artillery mode (scheme): koalas may turn to face either way but
        // never walk. Facing was already updated above, so just kill motion.
        if (this.game.scheme?.artilleryMode) {
            moveDir = 0;
        }

        let positionChanged = false;
        if (moveDir !== 0) {
            // Double-check that koala is actually on ground before allowing
            // ground movement (prevents "walking on air" after terrain is destroyed)
            if (koala.onGround) {
                const footY = koala.y + koala.height / 2;
                const stillOnGround = this.game.terrain.checkCollision(koala.x, footY) ||
                    this.game.terrain.checkCollision(koala.x, footY + 1) ||
                    this.game.terrain.checkCollision(koala.x, footY + 2);
                if (!stillOnGround) {
                    koala.onGround = false;
                }
            }

            if (koala.onGround && !koala.isSliding) {
                // Ground movement with terrain following
                // (fast walk crate buff nearly doubles walking speed)
                const fastWalk = this.game.getCurrentTeam()?.buffs?.fastWalk ? 1.8 : 1;
                const step = moveDir * this.moveSpeed * fastWalk * dt;
                const result = this.game.physics.canWalkUp(koala, step);
                if (result.canMove) {
                    koala.x += step;
                    if (result.newY !== koala.y) {
                        koala.y = result.newY;
                    }
                    positionChanged = true;
                }
            } else if (koala.parachuteActive) {
                // Worms-style: jumps and knockback arcs are committed — no
                // mid-air steering. The parachute is the exception: you can
                // drift it left/right while it rides the wind.
                koala.vx += moveDir * 80 * dt;
                koala.vx = Math.max(-90, Math.min(90, koala.vx));
                positionChanged = true;
            }
        }

        // Keyboard aiming - full rotation
        let aimChanged = false;
        if (this.isHeld('aimUp')) {
            koala.aimAngle -= this.aimSpeed * dt;
            aimChanged = true;
        }
        if (this.isHeld('aimDown')) {
            koala.aimAngle += this.aimSpeed * dt;
            aimChanged = true;
        }

        // Normalize angle to -PI to PI range (full rotation)
        while (koala.aimAngle > Math.PI) koala.aimAngle -= 2 * Math.PI;
        while (koala.aimAngle < -Math.PI) koala.aimAngle += 2 * Math.PI;

        // Update facing from aim ONLY when actively aiming with the keyboard.
        // Walking sets facing to the move direction (above), and the pointer
        // sets it when it moves. When idle we leave facing alone.
        if (moveDir === 0 && aimChanged) {
            koala.facingLeft = Math.abs(koala.aimAngle) > Math.PI / 2;
        }

        // Blowtorch movement sync
        if (koala.blowtorchActive && koala.blowtorchDigging) {
            positionChanged = true;
        }

        // NETWORK SYNC: Send position and aim updates to opponents (throttled)
        if (this.game.networkManager && !this.game.isPractice) {
            const now = performance.now();

            // Throttle position updates to 20 times per second (every 50ms)
            if (positionChanged && (!this.lastMoveSync || now - this.lastMoveSync > 50)) {
                this.game.networkManager.sendMove(
                    koala.x,
                    koala.y,
                    koala.facingLeft,
                    koala.blowtorchActive ? this.simPointer.down : undefined,
                    this.game.currentTeamIndex,
                    this.game.currentKoalaIndex
                );
                this.lastMoveSync = now;
            }

            // Throttle aim updates to 15 times per second (every 66ms)
            if (aimChanged && (!this.lastAimSync || now - this.lastAimSync > 66)) {
                this.game.networkManager.sendAim(koala.aimAngle,
                    this.game.currentTeamIndex, this.game.currentKoalaIndex);
                this.lastAimSync = now;
            }
        }
    }

    // ==================== WEAPON MENU (UI) ====================

    toggleWeaponMenu() {
        if (this.game.isReplay) return;
        if (this.game.phase !== 'aiming' && this.game.phase !== 'retreat') return;
        if (!this.game.isMyTurn()) return;

        this.isWeaponMenuOpen = !this.isWeaponMenuOpen;
        this.updateWeaponMenuDOM();
    }

    closeWeaponMenu() {
        if (this.isWeaponMenuOpen) {
            this.isWeaponMenuOpen = false;
            this.updateWeaponMenuDOM();
        }
    }

    updateWeaponMenuDOM() {
        if (!this.weaponBar) return;

        // Auto-close menu if moving
        if (this.isHeld('left') || this.isHeld('right') || this.isHeld('jump') || this.isHeld('highJump')) {
            this.isWeaponMenuOpen = false;
        }

        const isAimingPhase = this.game.phase === 'aiming' || this.game.phase === 'retreat';
        if (this.isWeaponMenuOpen && isAimingPhase && this.game.isMyTurn()) {
            this.weaponBar.classList.add('open');
            this.weaponBar.classList.remove('minimized', 'faded');
        } else {
            this.weaponBar.classList.remove('open');
            this.weaponBar.classList.add('minimized');
            this.isWeaponMenuOpen = false;
        }
    }

    // ==================== CHARGING / FIRING ====================

    startCharging() {
        if (this.game.phase !== 'aiming') return;

        this.isCharging = true;
        this.game.phase = 'firing';
        this.game.weaponManager.startCharge();

        const powerBarContainer = this.game.dom.elements.powerBarContainer;
        if (powerBarContainer) {
            powerBarContainer.classList.remove('hidden');
        }
    }

    /**
     * Lock in the current power and enter the "armed" phase. The trajectory
     * stays on screen and the player can keep fine-tuning the aim before
     * committing with a second press.
     */
    lockAim() {
        if (!this.isCharging) return;
        this.isCharging = false;

        const wm = this.game.weaponManager;
        // Capture the charged power (0-1) before it gets reset anywhere
        this.lockedPower = wm.power / wm.maxPower;
        wm.isCharging = false;

        this.game.phase = 'armed';

        // Premium feedback: a crisp "lock-on" confirmation tone + bar glow
        this.game.audioManager.playAimLock();

        const powerBarContainer = this.game.dom.elements.powerBarContainer;
        if (powerBarContainer) {
            powerBarContainer.classList.remove('hidden');
            powerBarContainer.classList.add('locked');
        }
    }

    /** Commit the locked-in shot and actually fire. */
    confirmFire() {
        if (this.game.phase !== 'armed') return;

        const koala = this.game.getCurrentKoala();
        if (!koala) return;

        const power = (this.lockedPower != null)
            ? this.lockedPower
            : this.game.weaponManager.power / this.game.weaponManager.maxPower;
        this.lockedPower = null;

        log.debug('Firing - angle:', koala.aimAngle.toFixed(2), 'radians,',
            (koala.aimAngle * 180 / Math.PI).toFixed(1), 'degrees, power:', power.toFixed(2));

        this._hidePowerBar();
        this.game.fireWeapon(koala.aimAngle, power);
    }

    /** Cancel a charging or locked shot without firing, returning to aiming. */
    cancelCharge() {
        if (this.game.phase !== 'firing' && this.game.phase !== 'armed') return;

        this.isCharging = false;
        this.lockedPower = null;
        this.game.phase = 'aiming';
        this.game.weaponManager.power = 0;
        this.game.weaponManager.isCharging = false;

        this._hidePowerBar();
        this.game.audioManager.playClick();

        log.debug('🚫 Shot cancelled — re-aim');
    }

    _hidePowerBar() {
        const powerBarContainer = this.game.dom.elements.powerBarContainer;
        const powerFill = this.game.dom.elements.powerFill;
        if (powerBarContainer) {
            powerBarContainer.classList.add('hidden');
            powerBarContainer.classList.remove('locked');
        }
        if (powerFill) powerFill.style.width = '0%';
    }

    // ==================== JUMPS ====================

    /**
     * Forward jump. A second tap shortly after takeoff converts it into a
     * small backward hop (Worms-style double-tap). Jumps are committed
     * ballistic arcs — there is no mid-air steering.
     */
    jump() {
        // Artillery mode (scheme): no jumping
        if (this.game.scheme?.artilleryMode) return;

        const koala = this.game.getCurrentKoala();
        if (!koala) return;

        if (koala.onGround) {
            // Forward jump - a short, snappy arc. Air friction is ~1.0 so the
            // horizontal momentum is preserved through the jump.
            koala.vy = -260;
            koala.vx = koala.facingLeft ? -135 : 135;
            koala.onGround = false;
            koala.isJumping = true;
            koala.jumpType = 'forward';
            koala.jumpStartTime = this.game.simTime;
            this._syncJump(koala, 'jump');
        } else if (koala.jumpType === 'forward' &&
            this.game.simTime - koala.jumpStartTime < InputManager.JUMP_CONVERT_WINDOW) {
            // Double-tap: convert into a small backward hop
            koala.vx = koala.facingLeft ? 100 : -100;
            koala.jumpType = 'backward';
            this._syncJump(koala, 'jump');
        }
    }

    /**
     * High jump straight up. A second tap shortly after takeoff converts it
     * into a backflip — a high backward arc with one somersault.
     */
    highJump() {
        // Artillery mode (scheme): no jumping
        if (this.game.scheme?.artilleryMode) return;

        const koala = this.game.getCurrentKoala();
        if (!koala) return;

        if (koala.onGround) {
            // High jump - straight up, no horizontal drift
            koala.vy = -400;
            koala.vx = 0;
            koala.onGround = false;
            koala.isJumping = true;
            koala.jumpType = 'high';
            koala.jumpStartTime = this.game.simTime;
            this._syncJump(koala, 'highJump', false);
        } else if (koala.jumpType === 'high' &&
            this.game.simTime - koala.jumpStartTime < InputManager.JUMP_CONVERT_WINDOW) {
            // Double-tap: backflip — kick backward and somersault once
            // (see Game.updateKoalaAnimations for the rotation)
            koala.vx = koala.facingLeft ? 165 : -165;
            koala.jumpType = 'backflip';
            koala.isBackflipping = true;
            koala.backflipRotation = 0;
            this._syncJump(koala, 'highJump', true);
        }
    }

    /**
     * NETWORK SYNC: send a jump (or mid-air conversion) to the opponents.
     * `flip` only applies to highJump messages: true = somersault animation.
     */
    _syncJump(koala, type, flip) {
        if (!this.game.networkManager || this.game.isPractice) return;

        const msg = {
            type,
            x: koala.x,
            y: koala.y,
            vx: koala.vx,
            vy: koala.vy,
            teamIndex: this.game.currentTeamIndex,
            koalaIndex: this.game.currentKoalaIndex
        };
        if (type === 'highJump') {
            msg.facingLeft = koala.facingLeft;
            msg.flip = flip;
        }
        this.game.networkManager.send(msg);
    }

    /** Clean up event listeners */
    destroy() {
        if (this.game.options?.headless) return;
        window.removeEventListener('keydown', this.handleKeyDown);
        window.removeEventListener('keyup', this.handleKeyUp);
        window.removeEventListener('blur', this.handleBlur);
        window.removeEventListener('focus', this.handleFocus);
        clearTimeout(this.focusTimeout);
        this.game.canvas.removeEventListener('mousemove', this.handleMouseMove);
        this.game.canvas.removeEventListener('mousedown', this.handleMouseDown);
        this.game.canvas.removeEventListener('mouseup', this.handleMouseUp);
        this.game.canvas.removeEventListener('wheel', this.handleWheel);
        if (this.weaponBar && this.handleWeaponClick) {
            this.weaponBar.removeEventListener('click', this.handleWeaponClick);
        }
        if (this.activeWeaponCard && this.handleCardClick) {
            this.activeWeaponCard.removeEventListener('click', this.handleCardClick);
        }
        if (this.handleOutsideClick) {
            document.removeEventListener('click', this.handleOutsideClick);
        }
    }
}
