/**
 * Input Manager - Handles keyboard, mouse, and touch input
 */

export class InputManager {
    // Weapon types that activate instantly (no power charging)
    static INSTANT_FIRE_TYPES = ['melee', 'blowtorch', 'drill', 'kamikaze', 'parachute', 'skip', 'surrender', 'armageddon'];

    constructor(game) {
        this.game = game;

        // Input state
        this.keys = {};
        this.mouse = { x: 0, y: 0, down: false, rightDown: false, lastMoveTime: 0 };
        this.isCharging = false;
        this.lockedPower = null; // Power captured when aim is locked (armed phase)
        this.lastActivityTime = 0;
        this.isWeaponBarHidden = false;

        // Movement settings
        this.moveSpeed = 45; // px/s - was 12, which felt unresponsively slow
        this.aimSpeed = 2;

        // Bind event handlers
        this.handleKeyDown = this.handleKeyDown.bind(this);
        this.handleKeyUp = this.handleKeyUp.bind(this);
        this.handleMouseMove = this.handleMouseMove.bind(this);
        this.handleMouseDown = this.handleMouseDown.bind(this);
        this.handleMouseUp = this.handleMouseUp.bind(this);
        this.handleWheel = this.handleWheel.bind(this);

        // Add listeners
        window.addEventListener('keydown', this.handleKeyDown);
        window.addEventListener('keyup', this.handleKeyUp);
        this.game.canvas.addEventListener('mousemove', this.handleMouseMove);
        this.game.canvas.addEventListener('mousedown', this.handleMouseDown);
        this.game.canvas.addEventListener('mouseup', this.handleMouseUp);
        this.game.canvas.addEventListener('wheel', this.handleWheel);

        // Track window focus to prevent accidental firing
        this.windowFocused = true;
        this.focusTimeout = null;
        this.handleBlur = () => {
            this.windowFocused = false;
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

    setupWeaponSelection() {
        this.weaponBar = document.getElementById('weapon-bar');
        if (!this.weaponBar) return;

        this.handleWeaponClick = (e) => {
            const weaponEl = e.target.closest('.weapon');
            if (weaponEl && !weaponEl.classList.contains('disabled')) {
                const weaponId = weaponEl.dataset.weapon;
                this.selectWeapon(weaponId);
            }
        };

        this.weaponBar.addEventListener('click', this.handleWeaponClick);
    }

    /**
     * Select a weapon
     */
    selectWeapon(weaponId) {
        // Block weapon selection if not our turn or during countdown
        if (!this.game.isMyTurn() || this.game.phase === 'countdown') {
            return;
        }

        // Special case: if blowtorch is active and user clicks blowtorch again, end turn early
        if (this.game.phase === 'blowtorch' && weaponId === 'blowtorch') {
            console.log('Ending blowtorch turn early');
            this.game.endBlowtorch();
            return;
        }

        this.game.weaponManager.selectWeapon(weaponId);
        this.game.updateWeaponUI();

        // Save as team's last selected weapon
        const team = this.game.getCurrentTeam();
        if (team) {
            team.lastSelectedWeapon = weaponId;
        }

        // NETWORK SYNC: Send weapon selection to opponent
        if (this.game.networkManager && !this.game.isPractice) {
            this.game.networkManager.send({
                type: 'weaponSelect',
                weaponId
            });
        }
    }

    /**
     * Handle key down
     */
    handleKeyDown(e) {
        this.keys[e.code] = true;

        // F3 to toggle performance debugging (always allowed)
        if (e.code === 'F3') {
            window.debugPerformance = !window.debugPerformance;
            console.log(`🔧 Performance debugging: ${window.debugPerformance ? 'ON' : 'OFF'}`);
            e.preventDefault();
            return;
        }

        // Block game actions if it's not our turn or during countdown
        if (!this.game.isMyTurn() || this.game.phase === 'countdown') {
            return;
        }

        // Block input if current koala is dead
        const currentKoala = this.game.getCurrentKoala();
        if (!currentKoala || !currentKoala.isAlive) {
            return;
        }

        // Number keys for weapon timer
        if (e.code >= 'Digit1' && e.code <= 'Digit5') {
            const timer = parseInt(e.code.replace('Digit', ''));
            this.game.weaponManager.setTimer(timer);
        }

        // Space to fire
        if (e.code === 'Space') {
            e.preventDefault(); // Prevent spacebar from triggering focused buttons

            // If aim is locked (armed), space confirms the shot
            if (this.game.phase === 'armed') {
                this.confirmFire();
                return;
            }

            if (this.game.phase === 'aiming') {
                const weapon = this.game.weaponManager.currentWeapon;
                // Instant activation for melee, tools and utilities
                if (weapon && InputManager.INSTANT_FIRE_TYPES.includes(weapon.type)) {
                    const koala = this.game.getCurrentKoala();
                    this.game.fireWeapon(koala.aimAngle, 1.0);
                } else if (weapon && !weapon.targetted) {
                    // Don't start charging for targetted weapons (use mouse click instead)
                    this.startCharging();
                }
            }
        }

        // Enter to jump (works during aiming and retreat)
        if (e.code === 'Enter') {
            if (this.game.phase === 'aiming' || this.game.phase === 'retreat') {
                this.jump();
            }
        }

        // Backspace for high jump / backflip (works during aiming and retreat)
        if (e.code === 'Backspace') {
            if (this.game.phase === 'aiming' || this.game.phase === 'retreat') {
                this.highJump();
            }
            e.preventDefault();
        }
    }

    /**
     * Handle key up
     */
    handleKeyUp(e) {
        this.keys[e.code] = false;

        // Release space to lock in the shot (then press again to fire)
        if (e.code === 'Space' && this.isCharging) {
            this.lockAim();
        }
    }

    /**
     * Handle mouse move
     */
    handleMouseMove(e) {
        const rect = this.game.canvas.getBoundingClientRect();
        this.mouse.screenX = e.clientX;
        this.mouse.screenY = e.clientY;
        this.mouse.x = (e.clientX - rect.left) / this.game.camera.zoom + this.game.camera.x;
        this.mouse.y = (e.clientY - rect.top) / this.game.camera.zoom + this.game.camera.y;

        // Update aim angle based on mouse position
        if (this.game.phase === 'aiming' || this.game.phase === 'firing' || this.game.phase === 'armed') {
            this.updateAimFromMouse();
        }

        // Track movement for weapon-bar auto-hide
        this.mouse.lastMoveTime = performance.now();

        // Drag camera with right mouse button
        if (this.mouse.rightDown) {
            this.game.camera.targetX -= e.movementX / this.game.camera.zoom;
            this.game.camera.targetY -= e.movementY / this.game.camera.zoom;
        }
    }

    /**
     * Handle mouse down
     */
    handleMouseDown(e) {
        if (e.button === 0) { // Left click
            this.mouse.down = true;

            // Ignore clicks right after refocusing window
            if (!this.windowFocused) return;

            // Block game actions if it's not our turn or during countdown
            if (!this.game.isMyTurn() || this.game.phase === 'countdown') {
                return;
            }

            // Block input if current koala is dead
            const currentKoala = this.game.getCurrentKoala();
            if (!currentKoala || !currentKoala.isAlive) {
                return;
            }

            // Aim is locked and waiting for confirmation — this click fires
            if (this.game.phase === 'armed') {
                this.confirmFire();
                return;
            }

            if (this.game.phase === 'aiming') {
                const weapon = this.game.weaponManager.currentWeapon;

                // Check if this is a targetted weapon (airstrike, teleport)
                if (weapon && weapon.targetted) {
                    // Get click position in world coordinates (zoom-aware)
                    const rect = this.game.canvas.getBoundingClientRect();
                    const worldX = (e.clientX - rect.left) / this.game.camera.zoom + this.game.camera.x;
                    const worldY = (e.clientY - rect.top) / this.game.camera.zoom + this.game.camera.y;

                    // Fire the targetted weapon
                    this.game.fireTargettedWeapon(weapon, worldX, worldY);
                } else if (weapon && InputManager.INSTANT_FIRE_TYPES.includes(weapon.type)) {
                    // Melee/tool/utility weapons activate instantly without charging
                    const koala = this.game.getCurrentKoala();
                    this.game.fireWeapon(koala.aimAngle, 1.0);
                } else {
                    this.startCharging();
                }
            }
        } else if (e.button === 2) { // Right click
            this.mouse.rightDown = true;

            // Cancel a charging or locked-in shot so the player can re-aim
            if ((this.game.phase === 'firing' || this.game.phase === 'armed') && this.game.isMyTurn()) {
                this.cancelCharge();
            }
        }
    }

    /**
     * Handle mouse up
     */
    handleMouseUp(e) {
        if (e.button === 0) {
            this.mouse.down = false;

            // Releasing the button locks in the power and shows the committed
            // trajectory; the player clicks again to actually fire.
            if (this.isCharging) {
                this.lockAim();
            }
        } else if (e.button === 2) {
            this.mouse.rightDown = false;
        }
    }

    /**
     * Handle mouse wheel for zoom
     */
    handleWheel(e) {
        const zoomSpeed = 0.1;
        const direction = e.deltaY > 0 ? -1 : 1;
        const camera = this.game.camera;

        const oldZoom = camera.zoom;
        camera.zoom = Math.max(0.5, Math.min(2, camera.zoom + direction * zoomSpeed));

        // Zoom toward the cursor so the point under the mouse stays put
        if (camera.zoom !== oldZoom) {
            const rect = this.game.canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;
            const worldX = sx / oldZoom + camera.x;
            const worldY = sy / oldZoom + camera.y;

            camera.x = worldX - sx / camera.zoom;
            camera.y = worldY - sy / camera.zoom;
            camera.targetX = camera.x;
            camera.targetY = camera.y;
        }

        // Update zoom display
        this.updateZoomDisplay();

        e.preventDefault();
    }

    /**
     * Update zoom level display
     */
    updateZoomDisplay() {
        const zoomEl = this.game.dom.elements.zoomLevel;
        if (zoomEl) {
            const percentage = Math.round(this.game.camera.zoom * 100);
            zoomEl.textContent = percentage + '%';
        }
    }

    /**
     * Update aim angle from mouse position
     */
    updateAimFromMouse() {
        // Block aiming if it's not our turn or during countdown
        if (!this.game.isMyTurn() || this.game.phase === 'countdown') {
            return;
        }

        const koala = this.game.getCurrentKoala();
        if (!koala) return;

        const dx = this.mouse.x - koala.x;
        const dy = this.mouse.y - (koala.y - 10);

        // Determine facing direction based on mouse position - ONLY if not manually moving
        const isMoving = this.keys['KeyA'] || this.keys['ArrowLeft'] || this.keys['KeyD'] || this.keys['ArrowRight'];
        if (!isMoving) {
            koala.facingLeft = dx < 0;
        }

        // Calculate world angle directly (full 360 degrees)
        // atan2 returns -PI to PI, this gives us full freedom
        const newAngle = Math.atan2(dy, dx);

        // Only sync if angle actually changed significantly
        if (Math.abs(newAngle - koala.aimAngle) > 0.01) {
            koala.aimAngle = newAngle;

            // NETWORK SYNC: Send aim update to opponent (throttled)
            if (this.game.networkManager && !this.game.isPractice) {
                const now = performance.now();
                if (!this.lastMouseAimSync || now - this.lastMouseAimSync > 66) {
                    this.game.networkManager.sendAim(koala.aimAngle);
                    this.lastMouseAimSync = now;
                }
            }
        }
    }

    /**
     * Update loop for input-related UI or states
     */
    update(dt) {
        this.updateWeaponBarVisibility(dt);

        // Premium touch: show a crosshair cursor while we can aim/fire
        const canAim = this.game.isMyTurn() &&
            (this.game.phase === 'aiming' || this.game.phase === 'firing' || this.game.phase === 'armed');
        const desiredCursor = canAim ? 'crosshair' : 'default';
        if (this.game.canvas.style.cursor !== desiredCursor) {
            this.game.canvas.style.cursor = desiredCursor;
        }
    }

    /**
     * Update during aiming phase
     */
    updateAiming(koala, dt) {
        // Block movement if it's not our turn or during countdown
        if (!this.game.isMyTurn() || this.game.phase === 'countdown') {
            return;
        }

        // WASD or Arrow key movement
        let moveDir = 0;
        if (this.keys['KeyA'] || this.keys['ArrowLeft']) {
            moveDir = -1;
            koala.facingLeft = true;
        }
        if (this.keys['KeyD'] || this.keys['ArrowRight']) {
            moveDir = 1;
            koala.facingLeft = false;
        }

        let positionChanged = false;
        if (moveDir !== 0) {
            // Double-check that koala is actually on ground before allowing ground movement
            // This prevents "walking on air" after terrain is destroyed
            if (koala.onGround) {
                const footY = koala.y + koala.height / 2;
                // Check if there's actually terrain below feet
                const stillOnGround = this.game.terrain.checkCollision(koala.x, footY) ||
                    this.game.terrain.checkCollision(koala.x, footY + 1) ||
                    this.game.terrain.checkCollision(koala.x, footY + 2);
                if (!stillOnGround) {
                    // Terrain was destroyed! Start falling.
                    koala.onGround = false;
                }
            }

            if (koala.onGround) {
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
            } else {
                // Air control - significantly reduced to match slow walk speed
                koala.vx += moveDir * 50 * dt; // Reduced acceleration
                koala.vx = Math.max(-40, Math.min(40, koala.vx)); // Lower air speed cap
                positionChanged = true;
            }
        }

        // Keyboard aiming (up/down arrows) - full rotation
        let aimChanged = false;
        if (this.keys['ArrowUp'] || this.keys['KeyW']) {
            koala.aimAngle -= this.aimSpeed * dt;
            aimChanged = true;
        }
        if (this.keys['ArrowDown'] || this.keys['KeyS']) {
            koala.aimAngle += this.aimSpeed * dt;
            aimChanged = true;
        }

        // Normalize angle to -PI to PI range (full rotation)
        while (koala.aimAngle > Math.PI) koala.aimAngle -= 2 * Math.PI;
        while (koala.aimAngle < -Math.PI) koala.aimAngle += 2 * Math.PI;

        // Update facing from aim ONLY when the player is actively aiming with
        // the keyboard (W/S). Walking sets facing to the move direction (above),
        // and the mouse sets it on mouse-move (updateAimFromMouse). When idle we
        // leave facing alone — this kills the annoying snap-back where the body
        // whipped around to face the mouse the instant you stopped walking.
        if (moveDir === 0 && aimChanged) {
            koala.facingLeft = Math.abs(koala.aimAngle) > Math.PI / 2;
        }

        // Blowtorch movement sync
        if (koala.blowtorchActive && koala.blowtorchDigging) {
            positionChanged = true;
        }

        // NETWORK SYNC: Send position and aim updates to opponent (throttled)
        if (this.game.networkManager && !this.game.isPractice) {
            const now = performance.now();

            // Throttle position updates to 20 times per second (every 50ms)
            if (positionChanged && (!this.lastMoveSync || now - this.lastMoveSync > 50)) {
                this.game.networkManager.sendMove(
                    koala.x, 
                    koala.y, 
                    koala.facingLeft, 
                    koala.blowtorchActive ? this.mouse.down : undefined
                );
                this.lastMoveSync = now;
            }

            // Throttle aim updates to 15 times per second (every 66ms)
            if (aimChanged && (!this.lastAimSync || now - this.lastAimSync > 66)) {
                this.game.networkManager.sendAim(koala.aimAngle);
                this.lastAimSync = now;
            }
        }
    }

    /**
     * Handle auto-hiding of the weapon bar
     */
    updateWeaponBarVisibility(dt) {
        if (!this.weaponBar) return;

        // 1. Mouse Hover Check (Highest Priority)
        let isMouseOverBar = false;
        const rect = this.weaponBar.getBoundingClientRect();
        isMouseOverBar = (
            this.mouse.screenX >= rect.left &&
            this.mouse.screenX <= rect.right &&
            this.mouse.screenY >= rect.top &&
            this.mouse.screenY <= rect.bottom
        );

        if (isMouseOverBar && (this.game.phase === 'aiming' || this.game.phase === 'retreat')) {
            this.weaponBar.classList.remove('minimized', 'faded');
            this.isWeaponBarHidden = false;
            return;
        }

        // 2. Character Movement (Makes bar DISAPPEAR)
        const moveKeys = ['KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight', 'Enter', 'Backspace'];
        const isMoving = moveKeys.some(key => this.keys[key]);

        // 3. Looking/Aiming/Charging (Makes bar TRANSPARENT)
        const aimKeys = ['ArrowUp', 'ArrowDown', 'KeyW', 'KeyS', 'Space'];
        const isAiming = aimKeys.some(key => this.keys[key]);
        const isFiring = this.isCharging;
        const isPanning = this.mouse.rightDown;
        const mouseMovedRecently = (performance.now() - this.mouse.lastMoveTime) < 1500;

        const shouldFade = isAiming || isFiring || isPanning || mouseMovedRecently;

        // 4. Phase check
        if (this.game.phase !== 'aiming' && this.game.phase !== 'retreat') {
            this.weaponBar.classList.add('minimized');
            this.weaponBar.classList.remove('faded');
            this.isWeaponBarHidden = true;
            return;
        }

        // Apply classes
        if (isMoving) {
            this.weaponBar.classList.add('minimized');
            this.weaponBar.classList.remove('faded');
            this.isWeaponBarHidden = true;
        } else if (shouldFade) {
            this.weaponBar.classList.add('faded');
            this.weaponBar.classList.remove('minimized');
            this.isWeaponBarHidden = false; // It's still there, just transparent
        } else {
            this.weaponBar.classList.remove('minimized', 'faded');
            this.isWeaponBarHidden = false;
        }
    }

    /**
     * Start charging power
     */
    startCharging() {
        if (this.game.phase !== 'aiming') return;

        this.isCharging = true;
        this.game.phase = 'firing';
        this.game.weaponManager.startCharge();

        // Show power bar
        const powerBarContainer = this.game.dom.elements.powerBarContainer;
        if (powerBarContainer) {
            powerBarContainer.classList.remove('hidden');
        }
    }

    /**
     * Lock in the current power and enter the "armed" phase. The trajectory
     * stays on screen and the player can keep fine-tuning the aim with the
     * mouse before committing with a second click.
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

    /**
     * Commit the locked-in shot and actually fire.
     */
    confirmFire() {
        if (this.game.phase !== 'armed') return;

        const koala = this.game.getCurrentKoala();
        if (!koala) return;

        const power = (this.lockedPower != null)
            ? this.lockedPower
            : this.game.weaponManager.power / this.game.weaponManager.maxPower;
        this.lockedPower = null;

        // aimAngle is the world angle directly (full 360)
        console.log('Firing - angle:', koala.aimAngle.toFixed(2), 'radians,',
            (koala.aimAngle * 180 / Math.PI).toFixed(1), 'degrees, power:', power.toFixed(2));

        this._hidePowerBar();
        this.game.fireWeapon(koala.aimAngle, power);
    }

    /**
     * Cancel a charging or locked shot without firing, returning to aiming.
     */
    cancelCharge() {
        if (this.game.phase !== 'firing' && this.game.phase !== 'armed') return;

        this.isCharging = false;
        this.lockedPower = null;
        this.game.phase = 'aiming';
        this.game.weaponManager.power = 0;
        this.game.weaponManager.isCharging = false;

        this._hidePowerBar();
        this.game.audioManager.playClick();

        console.log('🚫 Shot cancelled — re-aim');
    }

    /**
     * Hide and reset the power bar UI (shared by fire/cancel paths).
     */
    _hidePowerBar() {
        const powerBarContainer = this.game.dom.elements.powerBarContainer;
        const powerFill = this.game.dom.elements.powerFill;
        if (powerBarContainer) {
            powerBarContainer.classList.add('hidden');
            powerBarContainer.classList.remove('locked');
        }
        if (powerFill) powerFill.style.width = '0%';
    }

    /**
     * Make koala jump (forward hop)
     */
    jump() {
        const koala = this.game.getCurrentKoala();
        if (!koala || !koala.onGround) return;

        // Forward hop - a short, snappy arc. Air friction is now ~1.0 so this
        // horizontal momentum is preserved through the jump (no floaty drop).
        koala.vy = -260;
        koala.vx = koala.facingLeft ? -135 : 135; // Forward momentum
        koala.onGround = false;
        koala.isJumping = true;

        // NETWORK SYNC: Send jump to opponent
        if (this.game.networkManager && !this.game.isPractice) {
            this.game.networkManager.send({
                type: 'jump',
                x: koala.x,
                y: koala.y,
                vx: koala.vx,
                vy: koala.vy
            });
        }
    }

    /**
     * Make koala high jump / backflip
     */
    highJump() {
        const koala = this.game.getCurrentKoala();
        if (!koala || !koala.onGround) return;

        // Backflip - a higher jump that hops backward with one clean somersault.
        // Height/distance toned down and the spin is now a single controlled
        // rotation (see Game.updateKoalaAnimations) instead of 4+ wild flips.
        koala.vy = -400;
        koala.vx = koala.facingLeft ? 165 : -165;
        koala.onGround = false;
        koala.isBackflipping = true;
        koala.backflipRotation = 0; // Start spin

        // NETWORK SYNC: Send high jump to opponent
        if (this.game.networkManager && !this.game.isPractice) {
            this.game.networkManager.send({
                type: 'highJump',
                x: koala.x,
                y: koala.y,
                vx: koala.vx,
                vy: koala.vy,
                facingLeft: koala.facingLeft
            });
        }
    }

    /**
     * Clean up event listeners
     */
    destroy() {
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
    }
}
