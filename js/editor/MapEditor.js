/**
 * Map Editor - Create custom terrain maps
 */

import { MapManager } from '../utils/MapManager.js';

export class MapEditor {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // World dimensions (same as game)
        this.worldWidth = 2400;
        this.worldHeight = 1200;

        // Create terrain canvas (the actual map data)
        this.terrainCanvas = document.createElement('canvas');
        this.terrainCanvas.width = this.worldWidth;
        this.terrainCanvas.height = this.worldHeight;
        this.terrainCtx = this.terrainCanvas.getContext('2d');

        // Camera/viewport
        this.camera = {
            x: 0,
            y: 0,
            zoom: 1.1, // Start at 110% zoom (matching game)
            targetX: 0,
            targetY: 0
        };

        // Tools
        this.currentTool = 'draw'; // draw, erase, rect, ellipse
        this.brushSize = 50;
        this.brushHardness = 1.0; // 1.0 = hard edge, 0.0 = soft
        this.terrainColor = '#8B4513'; // Dirt brown

        // Terrain colors palette
        this.terrainColors = {
            dirt: '#8B4513',
            rock: '#696969',
            grass: '#228B22',
            sand: '#C2B280'
        };
        this.selectedTerrainType = 'dirt';

        // Mouse state
        this.mouse = { x: 0, y: 0, down: false, rightDown: false };
        this.lastMouse = { x: 0, y: 0 };
        this.isDrawing = false;

        // Shape tool state (for rect/ellipse)
        this.shapeStart = null;

        // Objects placed on map
        this.placedObjects = [];
        this.selectedObject = null;

        // Spawns
        this.spawns = {
            team1: [],
            team2: []
        };

        // Undo history
        this.history = [];
        this.historyIndex = -1;
        this.maxHistory = 20;

        // Grid
        this.showGrid = false;
        this.gridSize = 50;

        // Background color (sky)
        this.backgroundColor = '#1a1a2e'; // Default dark blue
        this.backgroundColors = [
            '#1a1a2e', // Dark blue (default)
            '#87CEEB', // Sky blue
            '#2c3e50', // Dark slate
            '#1a472a', // Forest green
            '#4a0000', // Dark red
            '#2d132c', // Purple
            '#0a0a0a', // Near black
            '#f5deb3'  // Wheat/beige
        ];

        // Animation
        this.animationId = null;

        // Bind methods
        this.handleMouseMove = this.handleMouseMove.bind(this);
        this.handleMouseDown = this.handleMouseDown.bind(this);
        this.handleMouseUp = this.handleMouseUp.bind(this);
        this.handleWheel = this.handleWheel.bind(this);
        this.handleKeyDown = this.handleKeyDown.bind(this);
        this.render = this.render.bind(this);
    }

    /**
     * Initialize the editor
     */
    init() {
        // Setup canvas size
        this.handleResize();
        window.addEventListener('resize', () => this.handleResize());

        // Mouse events
        this.canvas.addEventListener('mousemove', this.handleMouseMove);
        this.canvas.addEventListener('mousedown', this.handleMouseDown);
        this.canvas.addEventListener('mouseup', this.handleMouseUp);
        this.canvas.addEventListener('wheel', this.handleWheel);
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // Keyboard events
        window.addEventListener('keydown', this.handleKeyDown);

        // Initialize with blank terrain
        this.clearTerrain();

        // Save initial state
        this.saveToHistory();

        // Start render loop
        this.animationId = requestAnimationFrame(this.render);

        console.log('🗺️ Map Editor initialized');
    }

    /**
     * Handle window resize
     */
    handleResize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    /**
     * Clear terrain to empty
     */
    clearTerrain() {
        this.terrainCtx.clearRect(0, 0, this.worldWidth, this.worldHeight);

        // Draw sky gradient background (visual only, not solid)
        const gradient = this.terrainCtx.createLinearGradient(0, 0, 0, this.worldHeight);
        gradient.addColorStop(0, '#1a1a2e');
        gradient.addColorStop(0.5, '#16213e');
        gradient.addColorStop(1, '#0f3460');
        this.terrainCtx.fillStyle = gradient;
        this.terrainCtx.fillRect(0, 0, this.worldWidth, this.worldHeight);

        // Clear terrain data (make it transparent for actual terrain)
        this.terrainCtx.clearRect(0, 0, this.worldWidth, this.worldHeight);
    }

    /**
     * Handle mouse movement
     */
    handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;

        // Convert to world coordinates
        this.mouse.x = screenX / this.camera.zoom + this.camera.x;
        this.mouse.y = screenY / this.camera.zoom + this.camera.y;

        // Pan with right mouse button
        if (this.mouse.rightDown) {
            this.camera.x -= e.movementX / this.camera.zoom;
            this.camera.y -= e.movementY / this.camera.zoom;
            this.clampCamera();
        }

        // Draw/Erase while mouse is down (only for brush tools)
        if (this.mouse.down && this.isDrawing &&
            (this.currentTool === 'draw' || this.currentTool === 'erase')) {
            this.applyBrush(this.mouse.x, this.mouse.y);
        }

        this.lastMouse.x = this.mouse.x;
        this.lastMouse.y = this.mouse.y;
    }

    /**
     * Handle mouse down
     */
    handleMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;

        // CRITICAL: Always update world coordinates from the click event
        // This fixes the bug where mouse.x/y were stale (0,0) if user didn't move mouse first
        this.mouse.x = screenX / this.camera.zoom + this.camera.x;
        this.mouse.y = screenY / this.camera.zoom + this.camera.y;

        if (e.button === 0) { // Left click
            // Check if clicking on UI elements first (in screen coordinates)
            if (this.handleUIClick(screenX, screenY)) {
                return; // UI was clicked, don't start drawing
            }

            this.mouse.down = true;
            this.isDrawing = true;

            if (this.currentTool === 'rect' || this.currentTool === 'ellipse') {
                this.shapeStart = { x: this.mouse.x, y: this.mouse.y };
            } else if (this.currentTool === 'spawn1') {
                const spawnPoint = { x: Math.round(this.mouse.x), y: Math.round(this.mouse.y) };
                this.spawns.team1.push(spawnPoint);
                console.log('📍 Team 1 Spawn placed:', spawnPoint, 'Total:', this.spawns.team1.length);
                this.saveToHistory();
            } else if (this.currentTool === 'spawn2') {
                const spawnPoint = { x: Math.round(this.mouse.x), y: Math.round(this.mouse.y) };
                this.spawns.team2.push(spawnPoint);
                console.log('📍 Team 2 Spawn placed:', spawnPoint, 'Total:', this.spawns.team2.length);
                this.saveToHistory();
            } else {
                // For brush tools, apply immediately
                this.applyBrush(this.mouse.x, this.mouse.y);
            }
        } else if (e.button === 2) { // Right click
            // If spawn tool is active, remove nearby spawn
            if (this.currentTool === 'spawn1' || this.currentTool === 'spawn2') {
                const team = this.currentTool === 'spawn1' ? this.spawns.team1 : this.spawns.team2;
                const index = team.findIndex(s => Math.hypot(s.x - this.mouse.x, s.y - this.mouse.y) < 20);
                if (index !== -1) {
                    team.splice(index, 1);
                    this.saveToHistory();
                    return;
                }
            }
            this.mouse.rightDown = true;
        }
    }

    /**
     * Handle clicks on UI elements (returns true if UI was clicked)
     */
    handleUIClick(screenX, screenY) {
        // Check if click is within sidebar (0-200px)
        if (screenX > 200) return false;

        // Tool buttons
        const tools = [
            { id: 'draw', y: 95 },
            { id: 'erase', y: 120 },
            { id: 'rect', y: 145 },
            { id: 'ellipse', y: 170 },
            { id: 'spawn1', y: 195 },
            { id: 'spawn2', y: 220 }
        ];

        for (const tool of tools) {
            if (screenY >= tool.y - 15 && screenY <= tool.y + 7 &&
                screenX >= 15 && screenX <= 185) {
                this.setTool(tool.id);
                return true;
            }
        }

        // Terrain type buttons (2x2 grid starting at y=400)
        const terrainTypes = ['dirt', 'rock', 'grass', 'sand'];
        for (let i = 0; i < terrainTypes.length; i++) {
            const x = 20 + (i % 2) * 85;
            const y = 400 + Math.floor(i / 2) * 35;
            if (screenX >= x && screenX <= x + 70 &&
                screenY >= y && screenY <= y + 25) {
                this.setTerrainType(terrainTypes[i]);
                return true;
            }
        }

        // Background color buttons (row starting at y=510)
        for (let i = 0; i < this.backgroundColors.length; i++) {
            const x = 20 + (i % 4) * 45;
            const y = 510 + Math.floor(i / 4) * 30;
            if (screenX >= x && screenX <= x + 35 &&
                screenY >= y && screenY <= y + 22) {
                this.backgroundColor = this.backgroundColors[i];
                return true;
            }
        }

        return false;
    }

    /**
     * Handle mouse up
     */
    handleMouseUp(e) {
        if (e.button === 0) {
            this.mouse.down = false;
            if (this.isDrawing) {
                // For shape tools, draw the final shape
                if (this.shapeStart && (this.currentTool === 'rect' || this.currentTool === 'ellipse')) {
                    this.applyShape(this.shapeStart.x, this.shapeStart.y, this.mouse.x, this.mouse.y);
                    this.shapeStart = null;
                }
                this.isDrawing = false;
                this.saveToHistory();
            }
        } else if (e.button === 2) {
            this.mouse.rightDown = false;
        }
    }

    /**
     * Handle mouse wheel (zoom)
     */
    handleWheel(e) {
        e.preventDefault();
        const zoomSpeed = 0.1;
        const direction = e.deltaY > 0 ? -1 : 1;

        const oldZoom = this.camera.zoom;
        this.camera.zoom = Math.max(0.25, Math.min(2, this.camera.zoom + direction * zoomSpeed));

        // Zoom towards mouse position
        if (this.camera.zoom !== oldZoom) {
            const zoomRatio = this.camera.zoom / oldZoom;
            this.camera.x = this.mouse.x - (this.mouse.x - this.camera.x) * zoomRatio;
            this.camera.y = this.mouse.y - (this.mouse.y - this.camera.y) * zoomRatio;
            this.clampCamera();
        }
    }

    /**
     * Handle keyboard input
     */
    handleKeyDown(e) {
        // Tool shortcuts
        if (e.key === '1' || e.key === 'd') this.setTool('draw');
        if (e.key === '2' || e.key === 'e') this.setTool('erase');
        if (e.key === '3' || e.key === 'r') this.setTool('rect');
        if (e.key === '4' || e.key === 'c') this.setTool('ellipse');
        if (e.key === '5') this.setTool('spawn1');
        if (e.key === '6') this.setTool('spawn2');

        // Brush size
        if (e.key === '[') this.setBrushSize(Math.max(10, this.brushSize - 10));
        if (e.key === ']') this.setBrushSize(Math.min(200, this.brushSize + 10));

        // Undo/Redo
        if (e.ctrlKey && e.key === 'z') {
            e.preventDefault();
            this.undo();
        }
        if (e.ctrlKey && e.key === 'y') {
            e.preventDefault();
            this.redo();
        }

        // Grid toggle
        if (e.key === 'g') {
            this.showGrid = !this.showGrid;
        }

        // Clear
        if (e.key === 'Delete') {
            this.clearTerrain();
            this.saveToHistory();
        }
    }

    /**
     * Clamp camera to world bounds (with margin to allow viewing outside the map)
     */
    clampCamera() {
        const viewWidth = this.canvas.width / this.camera.zoom;
        const viewHeight = this.canvas.height / this.camera.zoom;

        // Allow panning beyond map edges by this margin
        const margin = 400;

        this.camera.x = Math.max(-margin, Math.min(this.worldWidth - viewWidth + margin, this.camera.x));
        this.camera.y = Math.max(-margin, Math.min(this.worldHeight - viewHeight + margin, this.camera.y));
    }

    /**
     * Apply brush at position
     */
    applyBrush(x, y) {
        const ctx = this.terrainCtx;
        const size = this.brushSize;

        if (this.currentTool === 'draw') {
            // Draw terrain
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = this.terrainColors[this.selectedTerrainType];
            ctx.beginPath();
            ctx.arc(x, y, size / 2, 0, Math.PI * 2);
            ctx.fill();

            // Add texture noise
            this.addTerrainTexture(x, y, size / 2);

        } else if (this.currentTool === 'erase') {
            // Erase terrain (create hole)
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = 'white';
            ctx.beginPath();
            ctx.arc(x, y, size / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalCompositeOperation = 'source-over';
        }
    }

    /**
     * Apply a shape (rectangle or ellipse) to terrain
     */
    applyShape(x1, y1, x2, y2) {
        const ctx = this.terrainCtx;
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);

        if (width < 5 || height < 5) return; // Ignore tiny shapes

        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = this.terrainColors[this.selectedTerrainType];

        if (this.currentTool === 'rect') {
            ctx.fillRect(left, top, width, height);
            // Add texture
            this.addShapeTexture(left, top, width, height, 'rect');
        } else if (this.currentTool === 'ellipse') {
            ctx.beginPath();
            ctx.ellipse(left + width / 2, top + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
            ctx.fill();
            // Add texture
            this.addShapeTexture(left, top, width, height, 'ellipse');
        }
    }

    /**
     * Add texture to a shape
     */
    addShapeTexture(left, top, width, height, shapeType) {
        const ctx = this.terrainCtx;
        const baseColor = this.terrainColors[this.selectedTerrainType];
        const count = Math.floor((width * height) / 200); // Density based on size

        for (let i = 0; i < count; i++) {
            let px, py;
            if (shapeType === 'rect') {
                px = left + Math.random() * width;
                py = top + Math.random() * height;
            } else {
                // For ellipse, use rejection sampling
                const rx = width / 2;
                const ry = height / 2;
                const cx = left + rx;
                const cy = top + ry;
                let valid = false;
                while (!valid) {
                    px = left + Math.random() * width;
                    py = top + Math.random() * height;
                    const dx = (px - cx) / rx;
                    const dy = (py - cy) / ry;
                    if (dx * dx + dy * dy <= 1) valid = true;
                }
            }

            ctx.fillStyle = this.adjustBrightness(baseColor, (Math.random() - 0.5) * 30);
            ctx.beginPath();
            ctx.arc(px, py, 2 + Math.random() * 3, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    /**
     * Add texture to terrain
     */
    addTerrainTexture(x, y, radius) {
        const ctx = this.terrainCtx;
        const baseColor = this.terrainColors[this.selectedTerrainType];

        // Add some noise/speckles for texture
        for (let i = 0; i < 10; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * radius * 0.8;
            const px = x + Math.cos(angle) * dist;
            const py = y + Math.sin(angle) * dist;

            ctx.fillStyle = this.adjustBrightness(baseColor, (Math.random() - 0.5) * 30);
            ctx.beginPath();
            ctx.arc(px, py, 2 + Math.random() * 3, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    /**
     * Adjust color brightness
     */
    adjustBrightness(hex, amount) {
        const num = parseInt(hex.slice(1), 16);
        const r = Math.min(255, Math.max(0, (num >> 16) + amount));
        const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00FF) + amount));
        const b = Math.min(255, Math.max(0, (num & 0x0000FF) + amount));
        return `rgb(${r},${g},${b})`;
    }

    /**
     * Set current tool
     */
    setTool(tool) {
        this.currentTool = tool;
        this.updateToolbarUI();
    }

    /**
     * Set brush size
     */
    setBrushSize(size) {
        this.brushSize = size;
        this.updateToolbarUI();
    }

    /**
     * Set terrain type
     */
    setTerrainType(type) {
        this.selectedTerrainType = type;
        this.updateToolbarUI();
    }

    /**
     * Save current state to history
     */
    saveToHistory() {
        // Remove any redo states
        this.history = this.history.slice(0, this.historyIndex + 1);

        // Save terrain as image data
        const imageData = this.terrainCtx.getImageData(0, 0, this.worldWidth, this.worldHeight);
        this.history.push(imageData);

        // Limit history size
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        } else {
            this.historyIndex++;
        }
    }

    /**
     * Undo last action
     */
    undo() {
        if (this.historyIndex > 0) {
            this.historyIndex--;
            this.terrainCtx.putImageData(this.history[this.historyIndex], 0, 0);
        }
    }

    /**
     * Redo last undone action
     */
    redo() {
        if (this.historyIndex < this.history.length - 1) {
            this.historyIndex++;
            this.terrainCtx.putImageData(this.history[this.historyIndex], 0, 0);
        }
    }

    /**
     * Main render loop
     */
    render() {
        const ctx = this.ctx;

        // Clear screen
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        // Apply camera transform
        ctx.save();
        ctx.scale(this.camera.zoom, this.camera.zoom);
        ctx.translate(-this.camera.x, -this.camera.y);

        // Draw sky gradient
        this.drawSky();

        // Draw terrain
        ctx.drawImage(this.terrainCanvas, 0, 0);

        // Draw water
        this.drawWater();

        // Draw grid
        if (this.showGrid) {
            this.drawGrid();
        }

        // Draw placed objects
        this.drawObjects();

        // Draw spawns
        this.drawSpawns();

        // Draw shape preview (while dragging rect/ellipse)
        this.drawShapePreview();

        // Always draw map boundaries (to show playable area)
        this.drawMapBoundaries();

        // Draw brush cursor
        this.drawBrushCursor();

        ctx.restore();

        // Draw UI overlay (not affected by camera)
        this.drawUI();

        // Continue loop
        this.animationId = requestAnimationFrame(this.render);
    }

    /**
     * Draw sky background
     */
    drawSky() {
        const ctx = this.ctx;
        // Use the selected background color
        ctx.fillStyle = this.backgroundColor;
        ctx.fillRect(0, 0, this.worldWidth, this.worldHeight);
    }

    /**
     * Draw water at bottom
     */
    drawWater() {
        const ctx = this.ctx;
        const waterY = this.worldHeight - 60;

        const gradient = ctx.createLinearGradient(0, waterY, 0, this.worldHeight);
        gradient.addColorStop(0, 'rgba(30, 144, 255, 0.8)');
        gradient.addColorStop(1, 'rgba(0, 50, 100, 0.9)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, waterY, this.worldWidth, 60);
    }

    /**
     * Draw grid overlay
     */
    drawGrid() {
        const ctx = this.ctx;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;

        for (let x = 0; x <= this.worldWidth; x += this.gridSize) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, this.worldHeight);
            ctx.stroke();
        }

        for (let y = 0; y <= this.worldHeight; y += this.gridSize) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(this.worldWidth, y);
            ctx.stroke();
        }
    }

    /**
     * Draw map boundaries - shows the playable area limits
     * Always visible to help designers see the exact map edges
     */
    drawMapBoundaries() {
        const ctx = this.ctx;

        // Top boundary (Y = 0)
        ctx.strokeStyle = 'rgba(255, 100, 100, 0.8)'; // Red
        ctx.lineWidth = 3;
        ctx.setLineDash([10, 10]);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(this.worldWidth, 0);
        ctx.stroke();

        // Draw "TOP" label
        ctx.fillStyle = 'rgba(255, 100, 100, 0.9)';
        ctx.font = 'bold 16px Arial';
        ctx.textAlign = 'left';
        ctx.fillText('TOP (Y=0)', 10, 20);

        // Bottom boundary (Y = worldHeight)
        ctx.strokeStyle = 'rgba(255, 100, 100, 0.8)';
        ctx.beginPath();
        ctx.moveTo(0, this.worldHeight);
        ctx.lineTo(this.worldWidth, this.worldHeight);
        ctx.stroke();

        // Draw "BOTTOM" label
        ctx.fillText(`BOTTOM (Y=${this.worldHeight})`, 10, this.worldHeight - 8);

        // Left boundary (X = 0)
        ctx.strokeStyle = 'rgba(100, 255, 100, 0.6)'; // Green
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, this.worldHeight);
        ctx.stroke();

        // Right boundary (X = worldWidth)
        ctx.beginPath();
        ctx.moveTo(this.worldWidth, 0);
        ctx.lineTo(this.worldWidth, this.worldHeight);
        ctx.stroke();

        // Water level line (Y = worldHeight - 60)
        const waterY = this.worldHeight - 60;
        ctx.strokeStyle = 'rgba(100, 180, 255, 0.8)'; // Blue
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(0, waterY);
        ctx.lineTo(this.worldWidth, waterY);
        ctx.stroke();

        // Draw "WATER" label
        ctx.fillStyle = 'rgba(100, 180, 255, 0.9)';
        ctx.fillText(`WATER LINE (Y=${waterY})`, 10, waterY - 8);

        // Middle of map line (Y = worldHeight / 2)
        const middleY = this.worldHeight / 2;
        ctx.strokeStyle = 'rgba(255, 255, 100, 0.6)'; // Yellow
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 8]);
        ctx.beginPath();
        ctx.moveTo(0, middleY);
        ctx.lineTo(this.worldWidth, middleY);
        ctx.stroke();

        // Draw "MIDDLE" label
        ctx.fillStyle = 'rgba(255, 255, 100, 0.9)';
        ctx.fillText(`MIDDLE (Y=${middleY})`, 10, middleY - 8);

        // Center crosshair for reference (small crosshair at exact center)
        const cx = this.worldWidth / 2;
        const cy = this.worldHeight / 2;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 6]);
        ctx.beginPath();
        ctx.moveTo(cx - 30, cy);
        ctx.lineTo(cx + 30, cy);
        ctx.moveTo(cx, cy - 30);
        ctx.lineTo(cx, cy + 30);
        ctx.stroke();

        // Map dimensions label at center
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(`Map: ${this.worldWidth} x ${this.worldHeight}`, cx, cy + 50);

        // Reset line dash
        ctx.setLineDash([]);
    }

    /**
     * Draw placed objects
     */
    drawObjects() {
        const ctx = this.ctx;

        for (const obj of this.placedObjects) {
            ctx.save();
            ctx.translate(obj.x, obj.y);

            switch (obj.type) {
                case 'tree':
                    ctx.fillStyle = '#228B22';
                    ctx.beginPath();
                    ctx.arc(0, -30, 25, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.fillStyle = '#8B4513';
                    ctx.fillRect(-5, -10, 10, 40);
                    break;
                case 'barrel':
                    ctx.fillStyle = '#c0392b';
                    ctx.fillRect(-12, -20, 24, 40);
                    ctx.fillStyle = '#e74c3c';
                    ctx.fillRect(-10, -18, 20, 36);
                    break;
                case 'crate':
                    ctx.fillStyle = '#d4a574';
                    ctx.fillRect(-15, -15, 30, 30);
                    ctx.strokeStyle = '#8B4513';
                    ctx.lineWidth = 2;
                    ctx.strokeRect(-15, -15, 30, 30);
                    break;
                case 'boulder':
                    ctx.fillStyle = '#696969';
                    ctx.beginPath();
                    ctx.ellipse(0, 0, 20, 15, 0, 0, Math.PI * 2);
                    ctx.fill();
                    break;
            }

            ctx.restore();
        }
    }

    /**
     * Draw spawn points
     */
    drawSpawns() {
        const ctx = this.ctx;

        // Team 1 spawns (red)
        for (const spawn of this.spawns.team1) {
            ctx.fillStyle = 'rgba(231, 76, 60, 0.7)';
            ctx.beginPath();
            ctx.arc(spawn.x, spawn.y, 15, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 12px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('1', spawn.x, spawn.y + 4);
        }

        // Team 2 spawns (blue)
        for (const spawn of this.spawns.team2) {
            ctx.fillStyle = 'rgba(52, 152, 219, 0.7)';
            ctx.beginPath();
            ctx.arc(spawn.x, spawn.y, 15, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 12px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('2', spawn.x, spawn.y + 4);
        }
    }

    /**
     * Draw shape preview while dragging
     */
    drawShapePreview() {
        if (!this.shapeStart || !this.isDrawing) return;
        if (this.currentTool !== 'rect' && this.currentTool !== 'ellipse') return;

        const ctx = this.ctx;
        const x1 = this.shapeStart.x;
        const y1 = this.shapeStart.y;
        const x2 = this.mouse.x;
        const y2 = this.mouse.y;

        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);

        // Draw preview with semi-transparent fill
        ctx.fillStyle = this.terrainColors[this.selectedTerrainType] + '80'; // 50% opacity
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);

        if (this.currentTool === 'rect') {
            ctx.fillRect(left, top, width, height);
            ctx.strokeRect(left, top, width, height);
        } else if (this.currentTool === 'ellipse') {
            ctx.beginPath();
            ctx.ellipse(left + width / 2, top + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        ctx.setLineDash([]);
    }

    /**
     * Draw brush cursor
     */
    drawBrushCursor() {
        const ctx = this.ctx;

        if (this.currentTool === 'draw' || this.currentTool === 'erase') {
            ctx.strokeStyle = this.currentTool === 'draw' ?
                this.terrainColors[this.selectedTerrainType] : '#ff4444';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.arc(this.mouse.x, this.mouse.y, this.brushSize / 2, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
        } else if (this.currentTool === 'rect' || this.currentTool === 'ellipse') {
            // Show crosshair for shape tools
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1;
            const size = 10;
            ctx.beginPath();
            ctx.moveTo(this.mouse.x - size, this.mouse.y);
            ctx.lineTo(this.mouse.x + size, this.mouse.y);
            ctx.moveTo(this.mouse.x, this.mouse.y - size);
            ctx.lineTo(this.mouse.x, this.mouse.y + size);
            ctx.stroke();
        }
    }

    /**
     * Draw UI overlay
     */
    drawUI() {
        const ctx = this.ctx;

        // Toolbar background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(0, 0, 200, this.canvas.height);

        // Title
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 18px Outfit';
        ctx.fillText('Map Editor', 20, 30);

        // Tools section
        ctx.font = 'bold 14px Outfit';
        ctx.fillText('Tools', 20, 70);

        const tools = [
            { id: 'draw', label: '🖌️ Draw (1)', y: 95 },
            { id: 'erase', label: '🧹 Erase (2)', y: 120 },
            { id: 'rect', label: '▭ Rectangle (3)', y: 145 },
            { id: 'ellipse', label: '⬭ Ellipse (4)', y: 170 },
            { id: 'spawn1', label: '🚩 Team 1 Spawn', y: 195 },
            { id: 'spawn2', label: '🚩 Team 2 Spawn', y: 220 }
        ];

        tools.forEach(tool => {
            ctx.fillStyle = this.currentTool === tool.id ? '#3498db' : '#666';
            ctx.fillRect(15, tool.y - 15, 170, 22);
            ctx.fillStyle = '#fff';
            ctx.font = '13px Outfit';
            ctx.fillText(tool.label, 25, tool.y);
        });

        // Brush size
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px Outfit';
        ctx.fillText('Brush Size', 20, 260);
        ctx.font = '13px Outfit';
        ctx.fillText(`${this.brushSize}px  [ / ]`, 20, 280);

        // Draw brush size indicator
        ctx.strokeStyle = '#3498db';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(100, 320, Math.min(this.brushSize / 2, 40), 0, Math.PI * 2);
        ctx.stroke();

        // Terrain type
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px Outfit';
        ctx.fillText('Terrain', 20, 380);

        const terrainTypes = ['dirt', 'rock', 'grass', 'sand'];
        terrainTypes.forEach((type, i) => {
            const x = 20 + (i % 2) * 85;
            const y = 400 + Math.floor(i / 2) * 35;
            ctx.fillStyle = this.terrainColors[type];
            ctx.fillRect(x, y, 70, 25);
            if (this.selectedTerrainType === type) {
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.strokeRect(x, y, 70, 25);
            }
            ctx.fillStyle = '#fff';
            ctx.font = '11px Outfit';
            ctx.fillText(type, x + 5, y + 17);
        });

        // Background color section
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px Outfit';
        ctx.fillText('Background', 20, 490);

        // Background color swatches (2 rows of 4)
        this.backgroundColors.forEach((color, i) => {
            const x = 20 + (i % 4) * 45;
            const y = 510 + Math.floor(i / 4) * 30;
            ctx.fillStyle = color;
            ctx.fillRect(x, y, 35, 22);
            if (this.backgroundColor === color) {
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.strokeRect(x, y, 35, 22);
            }
        });

        // Instructions (moved down)
        ctx.fillStyle = '#888';
        ctx.font = '11px Outfit';
        const instructions = [
            'Left click: Draw/Place',
            'Right drag: Pan',
            'Scroll: Zoom',
            'G: Toggle grid',
            'Ctrl+Z: Undo',
            'Del: Clear all'
        ];
        instructions.forEach((text, i) => {
            ctx.fillText(text, 20, 600 + i * 18);
        });

        // Zoom indicator
        ctx.fillStyle = '#fff';
        ctx.font = '12px Outfit';
        ctx.fillText(`Zoom: ${Math.round(this.camera.zoom * 100)}%`, 20, this.canvas.height - 40);

        // Mouse coordinates display
        ctx.fillStyle = '#3498db';
        ctx.font = 'bold 12px Outfit';
        const mouseX = Math.round(this.mouse.x);
        const mouseY = Math.round(this.mouse.y);
        ctx.fillText(`X: ${mouseX}  Y: ${mouseY}`, 20, this.canvas.height - 20);

        // Also show a floating coordinate near the mouse cursor (top right of screen)
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(this.canvas.width - 150, 10, 140, 30);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px Outfit';
        ctx.textAlign = 'right';
        ctx.fillText(`X: ${mouseX}  Y: ${mouseY}`, this.canvas.width - 20, 30);
        ctx.textAlign = 'left';
    }

    /**
     * Update toolbar UI (for external HTML toolbar if used)
     */
    updateToolbarUI() {
        // Update any external HTML elements if they exist
        const brushSizeEl = document.getElementById('editor-brush-size');
        if (brushSizeEl) brushSizeEl.textContent = this.brushSize + 'px';
    }

    /**
     * Export map data as JSON
     */
    exportMap(name = 'Untitled Map') {
        // Deep copy spawns to avoid reference issues
        const spawnsCopy = {
            team1: this.spawns.team1.map(s => ({ x: s.x, y: s.y })),
            team2: this.spawns.team2.map(s => ({ x: s.x, y: s.y }))
        };

        console.log('📦 Exporting map:', name);
        console.log('   Team 1 spawns:', JSON.stringify(spawnsCopy.team1));
        console.log('   Team 2 spawns:', JSON.stringify(spawnsCopy.team2));

        return {
            name: name,
            version: 1,
            width: this.worldWidth,
            height: this.worldHeight,
            backgroundColor: this.backgroundColor,
            terrain: this.terrainCanvas.toDataURL('image/png'),
            objects: [...this.placedObjects], // Copy array
            spawns: spawnsCopy  // Use the deep copy
        };
    }

    /**
     * Import map from JSON
     */
    importMap(mapData) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                this.terrainCtx.clearRect(0, 0, this.worldWidth, this.worldHeight);
                this.terrainCtx.drawImage(img, 0, 0);
                this.placedObjects = mapData.objects || [];
                this.spawns = mapData.spawns || { team1: [], team2: [] };
                this.backgroundColor = mapData.backgroundColor || '#1a1a2e';
                this.saveToHistory();
                resolve();
            };
            img.src = mapData.terrain;
        });
    }

    /**
     * Import an image file as terrain
     * @param {HTMLImageElement} img - The loaded image element
     */
    importImage(img) {
        return new Promise((resolve) => {
            // Clear current terrain
            this.terrainCtx.clearRect(0, 0, this.worldWidth, this.worldHeight);

            // Calculate scaling to FILL the entire map (no margins)
            const scaleX = this.worldWidth / img.width;
            const scaleY = this.worldHeight / img.height;

            // Use larger scale to cover the whole map area
            const scale = Math.max(scaleX, scaleY);

            const scaledWidth = img.width * scale;
            const scaledHeight = img.height * scale;

            // Center the image (it might crop slightly if aspect ratio differs)
            const offsetX = (this.worldWidth - scaledWidth) / 2;
            const offsetY = (this.worldHeight - scaledHeight) / 2;

            // Draw scaled image to terrain
            this.terrainCtx.drawImage(img, offsetX, offsetY, scaledWidth, scaledHeight);

            // Process pixels for binary mask
            this.processImportedImage();

            // Reset state
            this.placedObjects = [];
            this.spawns = { team1: [], team2: [] };
            this.saveToHistory();

            console.log('🖼️ Image imported (Full Fill):', img.width, 'x', img.height, '→', this.worldWidth, 'x', this.worldHeight);
            resolve();
        });
    }

    /**
     * Process imported image to ensure proper terrain format
     * Makes fully transparent pixels proper air (for collision detection)
     */
    processImportedImage() {
        const imageData = this.terrainCtx.getImageData(0, 0, this.worldWidth, this.worldHeight);
        const data = imageData.data;

        // Loop through all pixels
        for (let i = 0; i < data.length; i += 4) {
            const alpha = data[i + 3];

            // If pixel is mostly transparent, make it fully transparent (air)
            if (alpha < 128) {
                data[i] = 0;     // R
                data[i + 1] = 0; // G
                data[i + 2] = 0; // B
                data[i + 3] = 0; // A (fully transparent)
            } else {
                // Make it fully opaque (solid terrain)
                data[i + 3] = 255;
            }
        }

        this.terrainCtx.putImageData(imageData, 0, 0);
    }


    /**
     * Clean up resources
     */
    destroy() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
        }
        this.canvas.removeEventListener('mousemove', this.handleMouseMove);
        this.canvas.removeEventListener('mousedown', this.handleMouseDown);
        this.canvas.removeEventListener('mouseup', this.handleMouseUp);
        this.canvas.removeEventListener('wheel', this.handleWheel);
        window.removeEventListener('keydown', this.handleKeyDown);
    }
}
