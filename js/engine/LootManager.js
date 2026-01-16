/**
 * LootManager - Handles weighted random loot crate spawning
 */

export class LootManager {
    constructor(game) {
        this.game = game;

        // Global settings
        this.crateDropChance = 0.20; // 20% chance per turn
        this.maxCratesOnMap = 5;

        // Active crates on the map
        this.crates = [];

        // Category weights (Health vs Weapon)
        this.categoryWeights = {
            health: 40,
            weapon: 60
        };

        // Health loot table
        this.healthLootTable = [
            { id: 'health_small', name: 'Small Health Pack', weight: 50, healAmount: 25, rarity: 'common' },
            { id: 'health_medium', name: 'Medium Health Pack', weight: 35, healAmount: 50, rarity: 'uncommon' },
            { id: 'health_large', name: 'Large Health Pack', weight: 15, healAmount: 100, rarity: 'rare' }
        ];

        // Weapon loot table
        this.weaponLootTable = [
            { id: 'grenade', name: 'Grenade Crate', weight: 35, ammo: 2, rarity: 'common' },
            { id: 'dynamite', name: 'Dynamite Crate', weight: 25, ammo: 1, rarity: 'uncommon' },
            { id: 'teleport', name: 'Teleport Crate', weight: 15, ammo: 1, rarity: 'rare' },
            { id: 'airstrike', name: 'Airstrike Crate', weight: 15, ammo: 1, rarity: 'rare' },
            { id: 'holygrenade', name: 'Holy Hand Grenade Crate', weight: 10, ammo: 1, rarity: 'legendary' }
        ];

        // Rarity colors for visual effects
        this.rarityColors = {
            common: '#4ade80',      // Green
            uncommon: '#60a5fa',    // Blue
            rare: '#a78bfa',        // Purple
            legendary: '#fbbf24'    // Gold
        };
    }

    /**
     * Get a random function (uses seeded random if available for multiplayer sync)
     */
    random() {
        return this.game.seededRandom ? this.game.seededRandom() : Math.random();
    }

    /**
     * Select an item from a weighted loot table
     */
    selectFromLootTable(lootTable) {
        const totalWeight = lootTable.reduce((sum, item) => sum + item.weight, 0);
        let roll = this.random() * totalWeight;

        for (const item of lootTable) {
            roll -= item.weight;
            if (roll <= 0) {
                return item;
            }
        }

        // Fallback to last item
        return lootTable[lootTable.length - 1];
    }

    /**
     * Select a category (health or weapon)
     */
    selectCategory() {
        const totalWeight = this.categoryWeights.health + this.categoryWeights.weapon;
        const roll = this.random() * totalWeight;

        return roll < this.categoryWeights.health ? 'health' : 'weapon';
    }

    /**
     * Check if a crate should spawn at turn start
     * Called at the beginning of each turn
     */
    onTurnStart() {
        // Check if we've hit max crates
        if (this.crates.length >= this.maxCratesOnMap) {
            return null;
        }

        // Roll for spawn chance
        if (this.random() > this.crateDropChance) {
            return null; // No spawn this turn
        }

        // Determine category
        const category = this.selectCategory();

        // Select specific item from that category
        let item;
        if (category === 'health') {
            item = this.selectFromLootTable(this.healthLootTable);
        } else {
            item = this.selectFromLootTable(this.weaponLootTable);
        }

        // Find spawn position
        const position = this.findSpawnPosition();
        if (!position) {
            return null; // No valid position found
        }

        // Create the crate
        const crate = this.createCrate(category, item, position.x, position.y);

        console.log(`📦 Crate spawned: ${item.name} (${item.rarity}) at (${position.x}, ${position.y})`);

        // NETWORK SYNC: Send crate spawn to opponent
        if (this.game.networkManager && !this.game.isPractice) {
            this.game.networkManager.send({
                type: 'crateSpawn',
                category,
                itemId: item.id,
                x: position.x,
                y: position.y
            });
        }

        return crate;
    }

    /**
     * Handle remote crate spawn from network
     */
    handleRemoteCrateSpawn(data) {
        console.log('📦 Remote crate spawn:', data);

        // Find the item from loot tables
        let item;
        if (data.category === 'health') {
            item = this.healthLootTable.find(i => i.id === data.itemId);
        } else {
            item = this.weaponLootTable.find(i => i.id === data.itemId);
        }

        if (item) {
            this.createCrate(data.category, item, data.x, data.y);
        }
    }

    /**
     * Find a valid spawn position for a crate
     */
    findSpawnPosition() {
        const margin = 100;
        const maxAttempts = 50;

        for (let i = 0; i < maxAttempts; i++) {
            // Random X within map bounds
            const x = margin + this.random() * (this.game.worldWidth - margin * 2);

            // Find ground Y using terrain raycast
            const groundY = this.game.terrain.findGroundY(x);

            if (groundY === null || groundY < 50 || groundY > this.game.worldHeight - 100) {
                continue; // Invalid position
            }

            // Check not too close to any koala
            let tooCloseToKoala = false;
            for (const team of this.game.teams) {
                for (const koala of team.koalas) {
                    if (!koala.isAlive) continue;
                    const dist = Math.hypot(x - koala.x, groundY - koala.y);
                    if (dist < 80) {
                        tooCloseToKoala = true;
                        break;
                    }
                }
                if (tooCloseToKoala) break;
            }

            if (tooCloseToKoala) continue;

            // Check not too close to other crates
            let tooCloseToCrate = false;
            for (const crate of this.crates) {
                const dist = Math.hypot(x - crate.x, groundY - crate.y);
                if (dist < 60) {
                    tooCloseToCrate = true;
                    break;
                }
            }

            if (tooCloseToCrate) continue;

            // Valid position found!
            return { x, y: groundY - 20 }; // Slightly above ground
        }

        return null; // No valid position found
    }

    /**
     * Create a crate object
     */
    createCrate(category, item, x, y) {
        const crate = {
            id: Date.now() + Math.floor(this.random() * 1000),
            category,
            item,
            x,
            y,
            spawnY: y - 200, // Start above and fall down
            targetY: y,
            falling: true,
            fallSpeed: 0,
            parachuteOpen: true,
            collected: false,
            glowColor: this.rarityColors[item.rarity],
            rarity: item.rarity,
            bobOffset: this.random() * Math.PI * 2, // For idle animation
            lifetime: 0
        };

        this.crates.push(crate);
        return crate;
    }

    /**
     * Update all crates
     */
    update(dt) {
        for (let i = this.crates.length - 1; i >= 0; i--) {
            const crate = this.crates[i];
            crate.lifetime += dt;

            // Falling animation
            if (crate.falling) {
                if (crate.parachuteOpen) {
                    // Slow parachute descent
                    crate.fallSpeed = 60; // pixels per second
                } else {
                    // Fast fall
                    crate.fallSpeed += 400 * dt;
                }

                crate.y += crate.fallSpeed * dt;

                // Check if landed
                if (crate.y >= crate.targetY) {
                    crate.y = crate.targetY;
                    crate.falling = false;
                    crate.parachuteOpen = false;
                }
            }

            // Check collection by any koala using spatial grid
            if (!crate.falling && !crate.collected) {
                const collectionRadius = 30;
                const nearbyEntities = this.game.spatialGrid.queryRadius(crate.x, crate.y, collectionRadius);

                for (const { entity } of nearbyEntities) {
                    // Only process koalas (they have isAlive property)
                    if (!entity.isAlive || entity.isAlive === undefined) continue;

                    const koala = entity;
                    // Find which team this koala belongs to
                    const team = this.game.teams.find(t => t.koalas.includes(koala));
                    if (team) {
                        this.collectCrate(crate, koala, team);
                        break;
                    }
                }
            }

            // Remove collected crates
            if (crate.collected) {
                this.crates.splice(i, 1);
            }
        }
    }

    /**
     * Collect a crate
     */
    collectCrate(crate, koala, team) {
        crate.collected = true;

        // Play collection sound
        this.game.audioManager.playPowerup?.();

        if (crate.category === 'health') {
            // Heal the koala
            const healAmount = crate.item.healAmount;
            const oldHealth = koala.health;
            koala.health = Math.min(100, koala.health + healAmount);
            const actualHeal = koala.health - oldHealth;

            console.log(`❤️ ${koala.name} collected ${crate.item.name}: +${actualHeal} HP`);

            // Create floating text
            this.game.createFloatingText?.(crate.x, crate.y - 30, `+${actualHeal}`, '#4ade80');

        } else {
            // Give weapon ammo to the TEAM (not just this koala)
            const weapon = this.game.weaponManager.getWeapon(crate.item.id);
            if (weapon) {
                weapon.ammo = (weapon.ammo || 0) + crate.item.ammo;
                console.log(`💣 ${team.name} collected ${crate.item.name}: +${crate.item.ammo} ${weapon.name}`);

                // Update weapon UI
                this.game.updateWeaponUI();

                // Create floating text
                this.game.createFloatingText?.(crate.x, crate.y - 30, `+${crate.item.ammo} ${weapon.name}`, this.rarityColors[crate.rarity]);
            }
        }

        // Create collection particles
        this.createCollectionParticles(crate);

        // Update team health display
        this.game.updateTeamHealth();
    }

    /**
     * Create particles when crate is collected
     */
    createCollectionParticles(crate) {
        for (let i = 0; i < 10; i++) {
            this.game.addParticle({
                type: 'spark',
                x: crate.x,
                y: crate.y,
                vx: (this.random() - 0.5) * 200,
                vy: (this.random() - 0.5) * 200 - 50,
                color: crate.glowColor,
                lifetime: 0.5 + this.random() * 0.5,
                age: 0,
                size: 3 + this.random() * 3
            });
        }
    }

    /**
     * Render all crates
     */
    render(ctx) {
        for (const crate of this.crates) {
            this.renderCrate(ctx, crate);
        }
    }

    /**
     * Render a single crate
     */
    renderCrate(ctx, crate) {
        const x = crate.x;
        const y = crate.falling ? crate.spawnY + (crate.y - crate.spawnY) : crate.y;

        // Bob animation when landed
        const bobY = crate.falling ? 0 : Math.sin(crate.lifetime * 2 + crate.bobOffset) * 3;

        ctx.save();
        ctx.translate(x, y + bobY);

        // Glow effect
        ctx.shadowColor = crate.glowColor;
        ctx.shadowBlur = 15 + Math.sin(crate.lifetime * 4) * 5;

        // Parachute (if falling)
        if (crate.parachuteOpen && crate.falling) {
            ctx.fillStyle = '#f0f0f0';
            ctx.beginPath();
            ctx.arc(0, -40, 25, Math.PI, 0);
            ctx.fill();

            // Parachute strings
            ctx.strokeStyle = '#888';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(-20, -30);
            ctx.lineTo(-8, -5);
            ctx.moveTo(20, -30);
            ctx.lineTo(8, -5);
            ctx.moveTo(0, -40);
            ctx.lineTo(0, -5);
            ctx.stroke();
        }

        // Crate box
        const size = 24;
        ctx.fillStyle = crate.category === 'health' ? '#d32f2f' : '#8B4513';
        ctx.fillRect(-size / 2, -size / 2, size, size);

        // Crate border
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.strokeRect(-size / 2, -size / 2, size, size);

        // Cross pattern or icon
        ctx.fillStyle = '#fff';
        if (crate.category === 'health') {
            // Medical cross
            ctx.fillRect(-3, -8, 6, 16);
            ctx.fillRect(-8, -3, 16, 6);
        } else {
            // Weapon icon (simple bomb)
            ctx.beginPath();
            ctx.arc(0, 2, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillRect(-1, -8, 2, 6);
        }

        // Rarity indicator (corner badge)
        ctx.fillStyle = crate.glowColor;
        ctx.beginPath();
        ctx.moveTo(size / 2 - 2, -size / 2);
        ctx.lineTo(size / 2, -size / 2);
        ctx.lineTo(size / 2, -size / 2 + 8);
        ctx.closePath();
        ctx.fill();

        ctx.restore();
    }

    /**
     * Reset all crates (for game restart)
     */
    reset() {
        this.crates = [];
    }
}
