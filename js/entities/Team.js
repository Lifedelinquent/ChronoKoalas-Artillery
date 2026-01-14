/**
 * Team - Collection of koalas
 */

export class Team {
    constructor(name, color) {
        this.name = name;
        this.color = color;
        this.koalas = [];
        this.weapons = null; // Team-specific inventory
        this.currentKoalaIndex = 0; // Track who's turn it is next
    }

    /**
     * Add a koala to the team
     */
    addKoala(koala) {
        this.koalas.push(koala);
    }

    /**
     * Check if team has any alive koalas
     */
    isAlive() {
        return this.koalas.some(k => k.isAlive);
    }

    /**
     * Get total health of all koalas
     */
    getTotalHealth() {
        return this.koalas.reduce((sum, k) => sum + (k.isAlive ? k.health : 0), 0);
    }

    /**
     * Get number of alive koalas
     */
    getAliveCount() {
        return this.koalas.filter(k => k.isAlive).length;
    }

    /**
     * Get next alive koala after given index
     */
    getNextAliveKoala(currentIndex) {
        for (let i = 1; i <= this.koalas.length; i++) {
            const idx = (currentIndex + i) % this.koalas.length;
            if (this.koalas[idx].isAlive) {
                return { koala: this.koalas[idx], index: idx };
            }
        }
        return null;
    }
}
