/**
 * SpatialGrid - Spatial partitioning for efficient collision detection
 * 
 * Divides the world into a grid of cells. Entities are registered in the cells
 * they overlap. When checking for collisions, only entities in nearby cells
 * are checked instead of all entities.
 */

export class SpatialGrid {
    constructor(worldWidth, worldHeight, cellSize = 100) {
        this.worldWidth = worldWidth;
        this.worldHeight = worldHeight;
        this.cellSize = cellSize;

        // Calculate grid dimensions
        this.cols = Math.ceil(worldWidth / cellSize);
        this.rows = Math.ceil(worldHeight / cellSize);

        // Track entities for quick removal (must be before clear())
        this.entityCells = new Map(); // entity -> Set of cell indices

        // Initialize empty grid
        this.cells = [];
        this.clear();
    }

    /**
     * Clear all cells
     */
    clear() {
        this.cells = [];
        for (let i = 0; i < this.cols * this.rows; i++) {
            this.cells.push(new Set());
        }
        this.entityCells.clear();
    }

    /**
     * Get cell index from world coordinates
     */
    getCellIndex(x, y) {
        const col = Math.floor(x / this.cellSize);
        const row = Math.floor(y / this.cellSize);

        // Clamp to grid bounds
        const clampedCol = Math.max(0, Math.min(this.cols - 1, col));
        const clampedRow = Math.max(0, Math.min(this.rows - 1, row));

        return clampedRow * this.cols + clampedCol;
    }

    /**
     * Get all cell indices that an AABB overlaps
     */
    getCellsForAABB(x, y, width, height) {
        const minCol = Math.max(0, Math.floor((x - width / 2) / this.cellSize));
        const maxCol = Math.min(this.cols - 1, Math.floor((x + width / 2) / this.cellSize));
        const minRow = Math.max(0, Math.floor((y - height / 2) / this.cellSize));
        const maxRow = Math.min(this.rows - 1, Math.floor((y + height / 2) / this.cellSize));

        const indices = [];
        for (let row = minRow; row <= maxRow; row++) {
            for (let col = minCol; col <= maxCol; col++) {
                indices.push(row * this.cols + col);
            }
        }
        return indices;
    }

    /**
     * Get all cell indices within a radius (for explosion checks)
     */
    getCellsInRadius(x, y, radius) {
        return this.getCellsForAABB(x, y, radius * 2, radius * 2);
    }

    /**
     * Insert an entity into the grid
     * Entity must have: x, y, and optionally width/height (defaults to point)
     */
    insert(entity) {
        const width = entity.width || 0;
        const height = entity.height || 0;

        const cellIndices = this.getCellsForAABB(entity.x, entity.y, width, height);

        // Track which cells this entity is in
        this.entityCells.set(entity, new Set(cellIndices));

        // Add entity to each cell
        for (const idx of cellIndices) {
            this.cells[idx].add(entity);
        }
    }

    /**
     * Remove an entity from the grid
     */
    remove(entity) {
        const cellIndices = this.entityCells.get(entity);
        if (cellIndices) {
            for (const idx of cellIndices) {
                this.cells[idx].delete(entity);
            }
            this.entityCells.delete(entity);
        }
    }

    /**
     * Update an entity's position in the grid
     * Call this when an entity moves
     */
    update(entity) {
        // Remove from old cells
        this.remove(entity);
        // Re-insert at new position
        this.insert(entity);
    }

    /**
     * Query all entities near a point
     */
    queryPoint(x, y) {
        const cellIndex = this.getCellIndex(x, y);
        return Array.from(this.cells[cellIndex]);
    }

    /**
     * Query all entities within an AABB
     */
    queryAABB(x, y, width, height) {
        const cellIndices = this.getCellsForAABB(x, y, width, height);
        const result = new Set();

        for (const idx of cellIndices) {
            for (const entity of this.cells[idx]) {
                result.add(entity);
            }
        }

        return Array.from(result);
    }

    /**
     * Query all entities within a radius (for explosions, damage, etc.)
     */
    queryRadius(x, y, radius) {
        const cellIndices = this.getCellsInRadius(x, y, radius);
        const result = [];
        const radiusSq = radius * radius;

        // De-duplicate using a Set
        const seen = new Set();

        for (const idx of cellIndices) {
            for (const entity of this.cells[idx]) {
                if (seen.has(entity)) continue;
                seen.add(entity);

                // Actual distance check
                const dx = entity.x - x;
                const dy = entity.y - y;
                const distSq = dx * dx + dy * dy;

                if (distSq <= radiusSq) {
                    result.push({
                        entity,
                        distance: Math.sqrt(distSq)
                    });
                }
            }
        }

        return result;
    }

    /**
     * Rebuild the entire grid from a list of entities
     * Useful for syncing or after major changes
     */
    rebuild(entities) {
        this.clear();
        for (const entity of entities) {
            this.insert(entity);
        }
    }

    /**
     * Get debug info about grid usage
     */
    getDebugInfo() {
        let totalEntities = 0;
        let maxPerCell = 0;
        let nonEmptyCells = 0;

        for (const cell of this.cells) {
            const count = cell.size;
            totalEntities += count;
            if (count > maxPerCell) maxPerCell = count;
            if (count > 0) nonEmptyCells++;
        }

        return {
            gridSize: `${this.cols}x${this.rows}`,
            cellSize: this.cellSize,
            totalCells: this.cells.length,
            nonEmptyCells,
            totalEntities,
            maxPerCell
        };
    }
}
