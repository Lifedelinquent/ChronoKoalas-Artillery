/**
 * Input Manager - Handles keyboard, mouse, and touch input
 */

export class InputManager {
    constructor(game) {
        this.game = game;

        // Input state
        this.keys = {};
        this.mouse = { x: 0, y: 0, down: false };
        this.isCharging = false;

        // Movement settings
        this.moveSpeed = 12;
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
        window.addEventListener('blur', () => {
            this.windowFocused = false;
        });
        window.addEventListener('focus', () => {
            // Brief delay before accepting clicks after refocus
            this.focusTimeout = setTimeout(() => {
                this.windowFocused = true;
            }, 200);
        });

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
        this.game.weaponManager.selectWeapon(weaponId);
        this.game.updateWeaponUI();

        // Save as team's last selected weapon
        const team = this.game.getCurrentTeam();
        if (team) {
            team.lastSelectedWeapon = weaponId;
        }
    }

    /**
     * Handle key down
     */
    handleKeyDown(e) {
        this.keys[e.code] = true;

        // Number keys for weapon timer
        if (e.code >= 'Digit1' && e.code <= 'Digit5') {
            const timer = parseInt(e.code.replace('Digit', ''));
            this.game.weaponManager.setTimer(timer);
        }

        // Space to fire
        if (e.code === 'Space') {
            e.preventDefault(); // Prevent spacebar from triggering focused buttons

            if (this.game.phase === 'aiming') {
                const weapon = this.game.weaponManager.currentWeapon;
                // Don't start charging for targetted weapons (use mouse click instead)
                if (weapon && !weapon.targetted) {
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

        // F3 to toggle performance debugging
        if (e.code === 'F3') {
            window.debugPerformance = !window.debugPerformance;
            console.log(`🔧 Performance debugging: ${window.debugPerformance ? 'ON' : 'OFF'}`);
            e.preventDefault();
        }
    }

    /**
     * Handle key up
     */
    handleKeyUp(e) {
        this.keys[e.code] = false;

        // Release space to fire
        if (e.code === 'Space' && this.isCharging) {
            this.releaseCharge();
        }
    }

    /**
     * Handle mouse move
     */
    handleMouseMove(e) {
        const rect = this.game.canvas.getBoundingClientRect();
        this.mouse.x = (e.clientX - rect.left) / this.game.camera.zoom + this.game.camera.x;
        this.mouse.y = (e.clientY - rect.top) / this.game.camera.zoom + this.game.camera.y;

        // Update aim angle based on mouse position
        if (this.game.phase === 'aiming' || this.game.phase === 'firing') {
            this.updateAimFromMouse();
        }

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
                } else if (weapon && weapon.type === 'melee') {
                    // Melee hits are instant
                    const koala = this.game.getCurrentKoala();
                    this.game.fireWeapon(koala.aimAngle, 1.0); // Full power swing
                } else {
                    this.startCharging();
                }
            }
        } else if (e.button === 2) { // Right click
            this.mouse.rightDown = true;

            // Cancel charging if currently charging
            if (this.isCharging) {
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

            if (this.isCharging) {
                this.releaseCharge();
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

        this.game.camera.zoom = Math.max(0.5, Math.min(2,
            this.game.camera.zoom + direction * zoomSpeed
        ));

        // Update zoom display
        this.updateZoomDisplay();

        e.preventDefault();
    }

    /**
     * Update zoom level display
     */
    updateZoomDisplay() {
        const zoomEl = document.getElementById('zoom-level');
        if (zoomEl) {
            const percentage = Math.round(this.game.camera.zoom * 100);
            zoomEl.textContent = percentage + '%';
        }
    }

    /**
     * Update aim angle from mouse position
     */
    updateAimFromMouse() {
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
        koala.aimAngle = Math.atan2(dy, dx);
    }

    /**
     * Update during aiming phase
     */
    updateAiming(koala, dt) {
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

        if (moveDir !== 0) {
            if (koala.onGround) {
                // Ground movement with terrain following
                const result = this.game.physics.canWalkUp(koala, moveDir * this.moveSpeed * dt);
                if (result.canMove) {
                    koala.x += moveDir * this.moveSpeed * dt;
                    if (result.newY !== koala.y) {
                        koala.y = result.newY;
                    }
                }
            } else {
                // Air control - significantly reduced to match slow walk speed
                koala.vx += moveDir * 50 * dt; // Reduced acceleration
                koala.vx = Math.max(-40, Math.min(40, koala.vx)); // Lower air speed cap
            }
        }

        // Keyboard aiming (up/down arrows) - full rotation
        if (this.keys['ArrowUp'] || this.keys['KeyW']) {
            koala.aimAngle -= this.aimSpeed * dt;
        }
        if (this.keys['ArrowDown'] || this.keys['KeyS']) {
            koala.aimAngle += this.aimSpeed * dt;
        }

        // Normalize angle to -PI to PI range (full rotation)
        while (koala.aimAngle > Math.PI) koala.aimAngle -= 2 * Math.PI;
        while (koala.aimAngle < -Math.PI) koala.aimAngle += 2 * Math.PI;

        // Update facing direction based on aim angle - ONLY if not walking
        if (moveDir === 0) {
            koala.facingLeft = Math.abs(koala.aimAngle) > Math.PI / 2;
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
        document.getElementById('power-bar-container').classList.remove('hidden');
    }

    /**
     * Release charge and fire
     */
    releaseCharge() {
        this.isCharging = false;

        const koala = this.game.getCurrentKoala();
        if (!koala) return;

        const power = this.game.weaponManager.getPower();

        // aimAngle is now the world angle directly (full 360)
        console.log('Firing - angle:', koala.aimAngle.toFixed(2), 'radians,',
            (koala.aimAngle * 180 / Math.PI).toFixed(1), 'degrees');

        this.game.fireWeapon(koala.aimAngle, power);

        // Hide power bar
        document.getElementById('power-bar-container').classList.add('hidden');
        document.getElementById('power-fill').style.width = '0%';
    }

    /**
     * Cancel charging without firing
     */
    cancelCharge() {
        if (!this.isCharging) return;

        this.isCharging = false;
        this.game.phase = 'aiming';
        this.game.weaponManager.power = 0;
        this.game.weaponManager.isCharging = false;

        // Hide power bar
        document.getElementById('power-bar-container').classList.add('hidden');
        document.getElementById('power-fill').style.width = '0%';

        console.log('🚫 Charge cancelled');
    }

    /**
     * Make koala jump
     */
    jump() {
        const koala = this.game.getCurrentKoala();
        if (!koala || !koala.onGround) return;

        // Quick, responsive jump
        koala.vy = -350; // Stronger jump
        koala.onGround = false;
        koala.isJumping = true;
    }

    /**
     * Make koala high jump / backflip
     */
    highJump() {
        const koala = this.game.getCurrentKoala();
        if (!koala || !koala.onGround) return;

        // Backflip - higher jump with backward movement and spin
        koala.vy = -450; // Much stronger
        koala.vx = koala.facingLeft ? 200 : -200;
        koala.onGround = false;
        koala.isBackflipping = true;
        koala.backflipRotation = 0; // Start spin
    }

    /**
     * Clean up event listeners
     */
    destroy() {
        window.removeEventListener('keydown', this.handleKeyDown);
        window.removeEventListener('keyup', this.handleKeyUp);
        this.game.canvas.removeEventListener('mousemove', this.handleMouseMove);
        this.game.canvas.removeEventListener('mousedown', this.handleMouseDown);
        this.game.canvas.removeEventListener('mouseup', this.handleMouseUp);
        if (this.weaponBar && this.handleWeaponClick) {
            this.weaponBar.removeEventListener('click', this.handleWeaponClick);
        }
    }
}
