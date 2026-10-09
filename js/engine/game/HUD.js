/**
 * HUD - DOM HUD updates: team health, turn/timer/wind displays, weapon panel.
 *
 * Installed onto Game.prototype (see the bottom of Game.js), so every
 * method runs with `this` bound to the Game instance.
 */

export const HUD = {
    /**
     * Build one HUD health bar per team. The markup used to be two static
     * red/blue rows in index.html; with up to 4 squads the rows are generated
     * here and coloured from the team.
     */
    buildTeamHealthUI() {
        const container = document.getElementById('team-health');
        this.teamHpEls = [];
        if (!container) return;

        container.innerHTML = '';
        for (const team of this.teams) {
            const row = document.createElement('div');
            row.className = 'team-hp';

            const name = document.createElement('span');
            name.className = 'team-name';
            name.textContent = team.name;
            name.style.color = team.color;
            name.title = team.name;

            const bar = document.createElement('div');
            bar.className = 'hp-bar';
            const fill = document.createElement('div');
            fill.className = 'hp-fill';
            fill.style.background = team.color;
            bar.appendChild(fill);

            const value = document.createElement('span');
            value.className = 'hp-value';
            value.textContent = team.getTotalHealth();

            row.appendChild(name);
            row.appendChild(bar);
            row.appendChild(value);
            container.appendChild(row);

            this.teamHpEls.push({ row, fill, value });
        }
    },

    /**
     * Update UI elements
     */
    updateTurnIndicator() {
        const team = this.getCurrentTeam();
        const indicator = this.dom.elements.turnIndicator;
        if (indicator && team) {
            // In multiplayer, show if it's your, an ally's, or an enemy's turn
            if (!this.isPractice && this.networkManager) {
                const isMyTurn = this.isMyTurn();
                let turnText;
                if (this.networkManager.isSpectator) {
                    turnText = '👀 Spectating';
                } else if (isMyTurn) {
                    turnText = 'Your Turn!';
                } else if (team.alliance && team.alliance === this.getMyAlliance()) {
                    turnText = "Ally's Turn";
                } else {
                    turnText = 'Enemy Turn';
                }
                indicator.innerHTML = `<span id="current-team" style="color: ${team.color}; ${isMyTurn ? 'font-weight: bold; text-shadow: 0 0 10px ' + team.color : ''}">${team.name}</span> - ${turnText}`;
            } else {
                const cpuTag = team.isCPU ? ' 🤖' : '';
                indicator.innerHTML = `<span id="current-team" style="color: ${team.color}">${team.name}${cpuTag}</span>'s Turn`;
            }
        }
    },

    updateTimerDisplay() {
        const el = this.dom.elements.turnTimer;
        if (el) {
            el.textContent = Math.ceil(this.turnTimer);
            el.style.color = this.turnTimer < 10 ? '#e74c3c' : '#f1c40f';
        }
    },

    updateWindDisplay() {
        const fill = this.dom.elements.windFill;
        const value = this.dom.elements.windValue;

        if (fill) {
            const absWind = Math.abs(this.wind);
            const widthPercent = absWind * 45; // Max 45% from center

            // Remove old classes
            fill.classList.remove('wind-left-fill', 'wind-right-fill');

            if (this.wind < 0) {
                // Left wind (green)
                fill.style.width = widthPercent + '%';
                fill.style.left = (50 - widthPercent) + '%';
                fill.classList.add('wind-left-fill');
            } else if (this.wind > 0) {
                // Right wind (red)
                fill.style.width = widthPercent + '%';
                fill.style.left = '50%';
                fill.classList.add('wind-right-fill');
            } else {
                // No wind
                fill.style.width = '0';
                fill.style.left = '50%';
            }

            // WA-style scrolling chevrons: stronger wind scrolls faster
            const stripeDuration = absWind > 0.01 ? (1.3 - absWind).toFixed(2) : 0;
            fill.style.setProperty('--wind-stripe-duration', stripeDuration + 's');

            // Gust pulse on the whole gauge whenever the wind changes
            const meter = fill.parentElement;
            if (meter) {
                meter.classList.remove('wind-gust');
                void meter.offsetWidth; // Restart the animation
                meter.classList.add('wind-gust');
            }
        }

        if (value) {
            const windStrength = Math.round(Math.abs(this.wind) * 100);
            const direction = this.wind < 0 ? '←' : (this.wind > 0 ? '→' : '');
            value.textContent = direction + windStrength;
            value.style.color = this.wind < 0 ? '#2ecc71' : (this.wind > 0 ? '#e74c3c' : '#fff');
        }
    },

    updateTeamHealth() {
        if (!this.teamHpEls) return;
        for (let i = 0; i < this.teams.length; i++) {
            const team = this.teams[i];
            const els = this.teamHpEls[i];
            if (!els) continue;

            const totalHealth = team.getTotalHealth();
            // Sum real max health (scheme-defined, not always 100 per koala)
            const maxHealth = team.koalas.reduce((sum, k) => sum + k.maxHealth, 0) || 1;
            const percent = (totalHealth / maxHealth) * 100;

            // Overhealing can push totalHealth above maxHealth; clamp the bar
            // width so it doesn't overflow, but show the true HP number.
            els.fill.style.width = Math.min(100, percent) + '%';
            els.value.textContent = totalHealth;
            els.row.classList.toggle('team-dead', !team.isAlive());
        }
    },

    /**
     * Update weapon UI (ammo counts) - Optimized with DOM caching
     */
    updateWeaponUI() {
        // Use cached weapon elements array (no querySelector!)
        const weaponEls = this.dom.weaponArray;
        const currentWeaponId = this.weaponManager.currentWeapon?.id;

        for (let i = 0; i < weaponEls.length; i++) {
            const el = weaponEls[i];
            const weaponId = el.dataset.weapon;
            const weapon = this.weaponManager.getWeapon(weaponId);

            if (weapon) {
                // Update selected state (only toggle if needed)
                const isSelected = weaponId === currentWeaponId;
                if (isSelected !== el.classList.contains('selected')) {
                    el.classList.toggle('selected', isSelected);
                }

                // Scheme unlock delay: locked weapons show a countdown badge
                const delayLeft = this.weaponDelayRemaining(weapon);
                const locked = delayLeft > 0;
                if (locked !== el.classList.contains('locked')) {
                    el.classList.toggle('locked', locked);
                }

                // Cache ammo element on the weapon element itself
                // This avoids querySelector on every update
                if (!el._cachedAmmoEl) {
                    el._cachedAmmoEl = el.querySelector('.ammo-count');
                }
                let ammoEl = el._cachedAmmoEl;

                if (locked || weapon.ammo !== Infinity) {
                    // Badge needed - create or update ammo element
                    if (!ammoEl) {
                        ammoEl = document.createElement('div');
                        ammoEl.className = 'ammo-count';
                        el.appendChild(ammoEl);
                        el._cachedAmmoEl = ammoEl; // Cache the new element
                    }

                    // Only update text if changed
                    const ammoStr = locked ? `🔒${delayLeft}` : weapon.ammo.toString();
                    if (ammoEl.textContent !== ammoStr) {
                        ammoEl.textContent = ammoStr;
                    }

                    // Update disabled state (only toggle if needed)
                    const shouldBeDisabled = locked || weapon.ammo <= 0;
                    if (shouldBeDisabled !== el.classList.contains('disabled')) {
                        el.classList.toggle('disabled', shouldBeDisabled);
                    }
                } else {
                    // Infinite ammo and unlocked - remove ammo element if exists
                    if (ammoEl) {
                        ammoEl.remove();
                        el._cachedAmmoEl = null; // Clear cache
                    }
                    el.classList.remove('disabled');
                }
            }
        }

        // Update active weapon card
        const currentWeapon = this.weaponManager.currentWeapon;
        if (currentWeapon) {
            const cardEl = this.dom.elements.activeWeaponCard;
            const iconContainer = this.dom.elements.activeWeaponIconContainer;
            const nameEl = this.dom.elements.activeWeaponName;
            const ammoEl = this.dom.elements.activeWeaponAmmo;

            if (cardEl && iconContainer && nameEl && ammoEl) {
                // Set weapon name
                nameEl.textContent = currentWeapon.name;

                // Set ammo (or the scheme unlock countdown)
                const cardDelayLeft = this.weaponDelayRemaining(currentWeapon);
                if (cardDelayLeft > 0) {
                    ammoEl.textContent = `🔒 Unlocks in ${cardDelayLeft} round${cardDelayLeft > 1 ? 's' : ''}`;
                } else if (currentWeapon.ammo === Infinity) {
                    ammoEl.textContent = "Ammo: ∞";
                } else {
                    ammoEl.textContent = `Ammo: ${currentWeapon.ammo}`;
                }

                // Set icon/image
                const matchEl = weaponEls.find(el => el.dataset.weapon === currentWeapon.id);
                if (matchEl) {
                    const imgEl = matchEl.querySelector('img');
                    const iconEl = matchEl.querySelector('.weapon-icon');
                    if (imgEl) {
                        iconContainer.innerHTML = `<img src="${imgEl.getAttribute('src')}" alt="${currentWeapon.name}" style="width: 30px; height: 30px; object-fit: contain; image-rendering: pixelated;">`;
                    } else if (iconEl) {
                        iconContainer.innerHTML = `<span class="weapon-icon" style="font-size: 1.4rem;">${iconEl.textContent}</span>`;
                    } else {
                        iconContainer.innerHTML = ``;
                    }
                } else {
                    iconContainer.innerHTML = currentWeapon.icon ? `<span class="weapon-icon" style="font-size: 1.4rem;">${currentWeapon.icon}</span>` : '';
                }

                // Gray out active weapon card if empty or still locked
                if (cardDelayLeft > 0 || (currentWeapon.ammo !== Infinity && currentWeapon.ammo <= 0)) {
                    cardEl.classList.add('out-of-ammo');
                } else {
                    cardEl.classList.remove('out-of-ammo');
                }
            }
        }
    },
};
