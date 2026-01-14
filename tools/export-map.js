/**
 * Map Export Utility
 * Extracts the current game terrain and saves it as a .koalamap file
 * 
 * Run this in the browser console while in a game to export the current map!
 */

(function exportCurrentMap() {
    // Find the game instance
    if (!window.game && !window.gameInstance) {
        console.error('❌ No game instance found! Start a game first.');
        return;
    }

    const game = window.game || window.gameInstance;
    const terrain = game.terrain || game.world?.terrain;

    if (!terrain) {
        console.error('❌ No terrain found in game!');
        return;
    }

    // Get terrain canvas
    const terrainCanvas = terrain.getCanvas ? terrain.getCanvas() : terrain.canvas;

    if (!terrainCanvas) {
        console.error('❌ Could not get terrain canvas!');
        return;
    }

    // Create map data in the same format as MapEditor
    const mapData = {
        name: 'Zoo Map',
        version: 1,
        width: terrain.width,
        height: terrain.height,
        terrain: terrainCanvas.toDataURL('image/png'),
        objects: [], // Game objects are baked into terrain
        spawns: {
            team1: [],
            team2: []
        }
    };

    // Convert to JSON
    const json = JSON.stringify(mapData, null, 2);

    // Create download link
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Zoo_Map.koalamap';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log('✅ Map exported successfully as Zoo_Map.koalamap!');
})();
