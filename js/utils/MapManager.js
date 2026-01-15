/**
 * Map Manager - Handles saving, loading and listing custom maps
 */

export class MapManager {
    static STORAGE_KEY = 'koala_artillery_maps';

    /**
     * Save a map to local storage
     * @param {Object} mapData - The map data to save
     */
    static saveMap(mapData) {
        const maps = this.getAllMaps();

        // Find existing map with same name or add new
        const index = maps.findIndex(m => m.name === mapData.name);
        if (index !== -1) {
            maps[index] = mapData;
        } else {
            maps.push(mapData);
        }

        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(maps));
        console.log('🗺️ Map saved to local storage:', mapData.name);
    }

    /**
     * Get all custom maps from local storage
     * @returns {Array} List of map data objects
     */
    static getAllMaps() {
        const data = localStorage.getItem(this.STORAGE_KEY);
        try {
            return data ? JSON.parse(data) : [];
        } catch (e) {
            console.error('Failed to parse maps from local storage', e);
            return [];
        }
    }

    /**
     * Get a map by index or name
     * @param {string|number} identifier - The map name or index
     */
    static getMap(identifier) {
        const maps = this.getAllMaps();
        if (typeof identifier === 'number') {
            return maps[identifier];
        }
        return maps.find(m => m.name === identifier);
    }

    /**
     * Delete a map from local storage
     * @param {string} mapName - The name of the map to delete
     */
    static deleteMap(mapName) {
        let maps = this.getAllMaps();
        maps = maps.filter(m => m.name !== mapName);
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(maps));
    }
}
