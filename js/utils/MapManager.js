/**
 * Map Manager - Handles saving, loading and listing custom maps
 * Uses IndexedDB for storage (supports hundreds of MB, unlike localStorage's ~5MB limit)
 */

export class MapManager {
    static DB_NAME = 'koala_artillery_db';
    static STORE_NAME = 'maps';
    static DB_VERSION = 1;
    static LEGACY_STORAGE_KEY = 'koala_artillery_maps';

    static _db = null;

    /**
     * Open (or reuse) the IndexedDB connection
     * @returns {Promise<IDBDatabase>}
     */
    static _getDB() {
        if (this._db) return Promise.resolve(this._db);

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME, { keyPath: 'name' });
                }
            };

            request.onsuccess = (e) => {
                this._db = e.target.result;
                resolve(this._db);
            };

            request.onerror = (e) => {
                console.error('IndexedDB open error:', e.target.error);
                reject(e.target.error);
            };
        });
    }

    /**
     * One-time migration: move maps from localStorage to IndexedDB
     * and remove the old key so this never runs again.
     */
    static async migrateFromLocalStorage() {
        const data = localStorage.getItem(this.LEGACY_STORAGE_KEY);
        if (!data) return;

        try {
            const maps = JSON.parse(data);
            if (Array.isArray(maps) && maps.length > 0) {
                for (const map of maps) {
                    await this.saveMap(map);
                }
                localStorage.removeItem(this.LEGACY_STORAGE_KEY);
                console.log(`🗺️ Migrated ${maps.length} map(s) from localStorage → IndexedDB`);
            }
        } catch (e) {
            console.error('Failed to migrate maps from localStorage:', e);
        }
    }

    /**
     * Save a map to IndexedDB (insert or update by name)
     * @param {Object} mapData - The map data to save
     */
    static async saveMap(mapData) {
        try {
            const db = await this._getDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.STORE_NAME, 'readwrite');
                const store = tx.objectStore(this.STORE_NAME);
                store.put(mapData);

                tx.oncomplete = () => {
                    console.log('🗺️ Map saved:', mapData.name);
                    resolve();
                };
                tx.onerror = (e) => {
                    console.error('Failed to save map:', e.target.error);
                    reject(e.target.error);
                };
            });
        } catch (e) {
            console.error('Map save error:', e);
            alert('⚠️ Failed to save map. Storage may be full or unavailable.');
            throw e;
        }
    }

    /**
     * Get all custom maps from IndexedDB
     * @returns {Promise<Array>} List of map data objects
     */
    static async getAllMaps() {
        try {
            const db = await this._getDB();
            return new Promise((resolve) => {
                const tx = db.transaction(this.STORE_NAME, 'readonly');
                const store = tx.objectStore(this.STORE_NAME);
                const request = store.getAll();

                request.onsuccess = () => resolve(request.result || []);
                request.onerror = (e) => {
                    console.error('Failed to read maps:', e.target.error);
                    resolve([]);
                };
            });
        } catch (e) {
            console.error('Failed to open map database:', e);
            return [];
        }
    }

    /**
     * Get a map by index or name
     * @param {string|number} identifier - The map name or index
     */
    static async getMap(identifier) {
        const maps = await this.getAllMaps();
        if (typeof identifier === 'number') {
            return maps[identifier];
        }
        return maps.find(m => m.name === identifier);
    }

    /**
     * Delete a map from IndexedDB
     * @param {string} mapName - The name of the map to delete
     */
    static async deleteMap(mapName) {
        try {
            const db = await this._getDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.STORE_NAME, 'readwrite');
                const store = tx.objectStore(this.STORE_NAME);
                store.delete(mapName);

                tx.oncomplete = () => {
                    console.log('🗺️ Map deleted:', mapName);
                    resolve();
                };
                tx.onerror = (e) => {
                    console.error('Failed to delete map:', e.target.error);
                    reject(e.target.error);
                };
            });
        } catch (e) {
            console.error('Map delete error:', e);
        }
    }
}
