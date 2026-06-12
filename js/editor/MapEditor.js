/**
 * Map Editor - Create custom terrain maps
 */

import { MapManager } from '../utils/MapManager.js';
import { processTerrainImage } from '../utils/TerrainMask.js';

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
        this.currentTool = 'draw'; // draw, erase, rect, ellipse, line, spawn1, spawn2
        this.brushSize = 50;
        this.terrainColor = '#8B4513'; // Dirt brown

        // DOM control references (populated in setupDOM)
        this.dom = {};

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

        // Map bounds (detected during import or recalculated)
        // These define the "actual playable area" vs empty space
        this.mapBounds = {
            topY: 0,            // Highest Y with terrain (0 = very top)
            bottomY: 1200,      // Lowest Y with terrain (before water)
            waterLevel: 1140    // Water level (worldHeight - 60)
        };

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
        this.handleResize = this.handleResize.bind(this);
        this.render = this.render.bind(this);
    }

    /**
     * Initialize the editor
     */
    init() {
        // Setup canvas size
        this.handleResize();
        window.addEventListener('resize', this.handleResize);

        // Mouse events
        this.canvas.addEventListener('mousemove', this.handleMouseMove);
        this.canvas.addEventListener('mousedown', this.handleMouseDown);
        this.canvas.addEventListener('mouseup', this.handleMouseUp);
        this.canvas.addEventListener('wheel', this.handleWheel);
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // Keyboard events
        window.addEventListener('keydown', this.handleKeyDown);

        // Wire up the HTML sidebar controls
        this.setupDOM();

        // Initialize with blank terrain
        this.clearTerrain();

        // Save initial state
        this.saveToHistory();

        // Start render loop
        this.animationId = requestAnimationFrame(this.render);

        console.log('🗺️ Map Editor initialized');
    }

    /**
     * Wire up the HTML sidebar controls (tools, sliders, swatches, actions).
     * Building the swatches here keeps the colour lists single-sourced from
     * this.terrainColors / this.backgroundColors.
     */
    setupDOM() {
        const $ = (id) => document.getElementById(id);

        // Tool buttons
        this.dom.tools = Array.from(document.querySelectorAll('.editor-tool'));
        this.dom.tools.forEach(btn => {
            btn.onclick = () => this.setTool(btn.dataset.tool);
        });

        // Brush size slider
        this.dom.brushSlider = $('editor-brush-slider');
        this.dom.brushValue = $('editor-brush-value');
        if (this.dom.brushSlider) {
            this.dom.brushSlider.value = this.brushSize;
            this.dom.brushSlider.oninput = () => this.setBrushSize(parseInt(this.dom.brushSlider.value, 10));
        }

        // Terrain swatches
        const terrainWrap = $('editor-terrain-swatches');
        this.dom.terrainSwatches = [];
        if (terrainWrap) {
            terrainWrap.innerHTML = '';
            Object.keys(this.terrainColors).forEach(type => {
                const sw = document.createElement('button');
                sw.className = 'editor-swatch';
                sw.style.background = this.terrainColors[type];
                sw.textContent = type;
                sw.dataset.terrain = type;
                sw.title = `${type} terrain`;
                sw.onclick = () => this.setTerrainType(type);
                terrainWrap.appendChild(sw);
                this.dom.terrainSwatches.push(sw);
            });
        }

        // Background swatches
        const bgWrap = $('editor-bg-swatches');
        this.dom.bgSwatches = [];
        if (bgWrap) {
            bgWrap.innerHTML = '';
            this.backgroundColors.forEach(color => {
                const sw = document.createElement('button');
                sw.className = 'editor-swatch bg';
                sw.style.background = color;
                sw.dataset.bg = color;
                sw.title = color;
                sw.onclick = () => this.setBackground(color);
                bgWrap.appendChild(sw);
                this.dom.bgSwatches.push(sw);
            });
        }

        // Action buttons
        this.dom.undo = $('editor-undo');
        this.dom.redo = $('editor-redo');
        this.dom.grid = $('editor-grid');
        if (this.dom.undo) this.dom.undo.onclick = () => this.undo();
        if (this.dom.redo) this.dom.redo.onclick = () => this.redo();
        if (this.dom.grid) this.dom.grid.onclick = () => this.toggleGrid();
        const fillBtn = $('editor-fillground');
        if (fillBtn) fillBtn.onclick = () => this.fillGround();
        const clearBtn = $('editor-clear');
        if (clearBtn) clearBtn.onclick = () => {
            this.clearTerrain();
            this.saveToHistory();
        };

        // Initial UI sync
        this.refreshToolUI();
        this.refreshSwatchUI();
        this.refreshActionUI();
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

        // Draw/Erase while mouse is down (only for brush tools).
        // Interpolate from the previous point so fast strokes stay continuous
        // instead of leaving a trail of disconnected circles.
        if (this.mouse.down && this.isDrawing &&
            (this.currentTool === 'draw' || this.currentTool === 'erase')) {
            this.applyBrushStroke(this.lastMouse.x, this.lastMouse.y, this.mouse.x, this.mouse.y);
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
            this.mouse.down = true;
            this.isDrawing = true;

            // Seed the stroke origin so the first interpolated segment starts here
            this.lastMouse.x = this.mouse.x;
            this.lastMouse.y = this.mouse.y;

            if (this.currentTool === 'rect' || this.currentTool === 'ellipse' || this.currentTool === 'line') {
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
                } else if (this.shapeStart && this.currentTool === 'line') {
                    this.applyBrushStroke(this.shapeStart.x, this.shapeStart.y, this.mouse.x, this.mouse.y);
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
        // Ignore shortcuts while typing in a form control (e.g. the brush slider)
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;

        // Tool shortcuts
        if (e.key === '1' || e.key === 'd') this.setTool('draw');
        if (e.key === '2' || e.key === 'e') this.setTool('erase');
        if (e.key === '3' || e.key === 'r') this.setTool('rect');
        if (e.key === '4' || e.key === 'c') this.setTool('ellipse');
        if (e.key === '5' || e.key === 'l') this.setTool('line');
        if (e.key === '6') this.setTool('spawn1');
        if (e.key === '7') this.setTool('spawn2');

        // Brush size
        if (e.key === '[') this.setBrushSize(Math.max(5, this.brushSize - 10));
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
            this.toggleGrid();
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
     * Stamp the brush once at a position.
     * @param {number} x
     * @param {number} y
     * @param {'draw'|'erase'} mode
     */
    stampBrush(x, y, mode) {
        const ctx = this.terrainCtx;
        const radius = this.brushSize / 2;

        if (mode === 'erase') {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = 'white';
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalCompositeOperation = 'source-over';
        } else {
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = this.terrainColors[this.selectedTerrainType];
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fill();
            this.addTerrainTexture(x, y, radius);
        }
    }

    /**
     * Apply brush at a single position (used for the initial click).
     */
    applyBrush(x, y) {
        const mode = this.currentTool === 'erase' ? 'erase' : 'draw';
        this.stampBrush(x, y, mode);
    }

    /**
     * Stamp the brush along the segment (x0,y0)->(x1,y1) so fast strokes and
     * the Line tool produce a continuous band rather than spaced-out dots.
     */
    applyBrushStroke(x0, y0, x1, y1) {
        const mode = this.currentTool === 'erase' ? 'erase' : 'draw';
        const dist = Math.hypot(x1 - x0, y1 - y0);
        // Overlap stamps generously for a smooth edge
        const step = Math.max(2, this.brushSize / 4);
        const steps = Math.ceil(dist / step);

        for (let i = 0; i <= steps; i++) {
            const t = steps === 0 ? 0 : i / steps;
            this.stampBrush(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, mode);
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
        this.refreshToolUI();
    }

    /**
     * Set brush size
     */
    setBrushSize(size) {
        this.brushSize = size;
        if (this.dom.brushSlider) this.dom.brushSlider.value = size;
        if (this.dom.brushValue) this.dom.brushValue.textContent = size;
    }

    /**
     * Set terrain type
     */
    setTerrainType(type) {
        this.selectedTerrainType = type;
        this.refreshSwatchUI();
    }

    /**
     * Set the sky/background colour
     */
    setBackground(color) {
        this.backgroundColor = color;
        this.refreshSwatchUI();
    }

    /**
     * Toggle the alignment grid
     */
    toggleGrid() {
        this.showGrid = !this.showGrid;
        this.refreshActionUI();
    }

    /**
     * Fill a solid ground floor across the full map width. Most artillery maps
     * need a base to stand on, so this saves hand-painting one stroke at a time.
     * Fills from the water line up by ~1/3 of the map height.
     */
    fillGround() {
        const ctx = this.terrainCtx;
        const groundTop = Math.round(this.worldHeight * 0.66);
        const groundBottom = this.worldHeight;

        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = this.terrainColors[this.selectedTerrainType];
        ctx.fillRect(0, groundTop, this.worldWidth, groundBottom - groundTop);
        this.addShapeTexture(0, groundTop, this.worldWidth, groundBottom - groundTop, 'rect');

        this.saveToHistory();
    }

    /**
     * Highlight the active tool button
     */
    refreshToolUI() {
        if (!this.dom.tools) return;
        this.dom.tools.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === this.currentTool);
        });
    }

    /**
     * Highlight the active terrain + background swatches
     */
    refreshSwatchUI() {
        if (this.dom.terrainSwatches) {
            this.dom.terrainSwatches.forEach(sw => {
                sw.classList.toggle('active', sw.dataset.terrain === this.selectedTerrainType);
            });
        }
        if (this.dom.bgSwatches) {
            this.dom.bgSwatches.forEach(sw => {
                sw.classList.toggle('active', sw.dataset.bg === this.backgroundColor);
            });
        }
    }

    /**
     * Sync action buttons (grid toggle state, undo/redo enabled state)
     */
    refreshActionUI() {
        if (this.dom.grid) this.dom.grid.classList.toggle('active', this.showGrid);
        if (this.dom.undo) this.dom.undo.disabled = this.historyIndex <= 0;
        if (this.dom.redo) this.dom.redo.disabled = this.historyIndex >= this.history.length - 1;
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

        this.refreshActionUI();
    }

    /**
     * Undo last action
     */
    undo() {
        if (this.historyIndex > 0) {
            this.historyIndex--;
            this.terrainCtx.putImageData(this.history[this.historyIndex], 0, 0);
            this.refreshActionUI();
        }
    }

    /**
     * Redo last undone action
     */
    redo() {
        if (this.historyIndex < this.history.length - 1) {
            this.historyIndex++;
            this.terrainCtx.putImageData(this.history[this.historyIndex], 0, 0);
            this.refreshActionUI();
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

        // Draw lightweight on-canvas HUD (coords + zoom). The tool UI now lives
        // in the HTML sidebar, so this only shows context that follows the view.
        this.drawHUD();

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
        if (this.currentTool !== 'rect' && this.currentTool !== 'ellipse' && this.currentTool !== 'line') return;

        const ctx = this.ctx;
        const x1 = this.shapeStart.x;
        const y1 = this.shapeStart.y;
        const x2 = this.mouse.x;
        const y2 = this.mouse.y;

        // Line preview: a thick stroke at the current brush width
        if (this.currentTool === 'line') {
            ctx.strokeStyle = this.terrainColors[this.selectedTerrainType] + 'cc';
            ctx.lineWidth = this.brushSize;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
            ctx.lineWidth = 1;
            return;
        }

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

        if (this.currentTool === 'draw' || this.currentTool === 'erase' || this.currentTool === 'line') {
            ctx.strokeStyle = this.currentTool === 'erase' ?
                '#ff4444' : this.terrainColors[this.selectedTerrainType];
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
     * Draw a small on-canvas HUD: live cursor coordinates and zoom level.
     * The tool palette now lives in the HTML sidebar, so this stays minimal
     * and is anchored to the top-right to avoid colliding with the sidebar.
     */
    drawHUD() {
        const ctx = this.ctx;
        const mouseX = Math.round(this.mouse.x);
        const mouseY = Math.round(this.mouse.y);

        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(this.canvas.width - 190, 60, 180, 56);

        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px Outfit';
        ctx.textAlign = 'left';
        ctx.fillText(`X: ${mouseX}   Y: ${mouseY}`, this.canvas.width - 178, 84);
        ctx.fillStyle = '#9fb4d8';
        ctx.font = '13px Outfit';
        ctx.fillText(`Zoom: ${Math.round(this.camera.zoom * 100)}%`, this.canvas.width - 178, 104);
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

        // Recalculate map bounds before export to ensure accuracy
        this.calculateMapBounds();
        console.log('   Map bounds:', JSON.stringify(this.mapBounds));

        return {
            name: name,
            version: 2, // Bumped version for new bounds feature
            width: this.worldWidth,
            height: this.worldHeight,
            backgroundColor: this.backgroundColor,
            terrain: this.terrainCanvas.toDataURL('image/png'),
            objects: [...this.placedObjects], // Copy array
            spawns: spawnsCopy,  // Use the deep copy
            mapBounds: { ...this.mapBounds }  // Include playable area bounds
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
                this.calculateMapBounds();
                this.saveToHistory();
                this.refreshSwatchUI();
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
     * Turn an imported image into a *playable* terrain mask.
     *
     * Two kinds of source images are handled (see js/utils/TerrainMask.js):
     *  - Silhouette PNGs that already encode terrain via transparency: we keep
     *    that design (transparent = air, opaque = solid).
     *  - Opaque pictures (photos, JPGs, renders) that have no transparency:
     *    every pixel would otherwise become solid, leaving the koalas nowhere to
     *    stand. We derive a terrain mask from the picture's brightness so the
     *    landmasses become solid and the darker background/cavities become open
     *    air — giving a map you play *inside*, with caves and ledges, not a flat
     *    floor you stand on top of.
     */
    processImportedImage() {
        const W = this.worldWidth, H = this.worldHeight;
        const imageData = this.terrainCtx.getImageData(0, 0, W, H);

        processTerrainImage(imageData.data, W, H);

        this.terrainCtx.putImageData(imageData, 0, 0);

        // Calculate and store the actual map bounds
        this.calculateMapBounds();
    }

    /**
     * Calculate the actual map boundaries by scanning for terrain.
     * This detects where the "real" map starts/ends vs empty space.
     */
    calculateMapBounds() {
        const imageData = this.terrainCtx.getImageData(0, 0, this.worldWidth, this.worldHeight);
        const data = imageData.data;
        const width = this.worldWidth;
        const height = this.worldHeight;

        let topY = height;  // Will find minimum
        let bottomY = 0;    // Will find maximum

        // Scan all pixels to find terrain bounds
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x += 5) { // Sample every 5 pixels for speed
                const idx = (y * width + x) * 4;
                if (data[idx + 3] > 128) {
                    // Found terrain pixel
                    if (y < topY) topY = y;
                    if (y > bottomY) bottomY = y;
                }
            }
        }

        // Update bounds
        this.mapBounds = {
            topY: topY < height ? topY : 0,
            bottomY: bottomY > 0 ? bottomY : height,
            waterLevel: this.worldHeight - 60
        };

        console.log(`📐 Map bounds calculated: Top Y=${this.mapBounds.topY}, Bottom Y=${this.mapBounds.bottomY}`);
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
        window.removeEventListener('resize', this.handleResize);
    }
}
