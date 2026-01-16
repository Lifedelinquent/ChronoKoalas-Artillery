# 🐨 Koala Artillery

A fast-paced, Worms-style artillery game featuring destructible terrain, various weapons, and strategic turn-based combat. Play as a team of battle-hardened koalas and blast your opponents off the map!

## 🚀 Key Features

- **Destructible Terrain:** Pixel-perfect terrain destruction using a custom canvas-based engine.
- **Strategic Combat:** Wind-affected projectiles, varying weapon types, and environmental hazards.
- **Koala Arsenal:** A wide range of weapons including Bazookas, Grenades, Cluster Bombs, Airstrikes, and more.
- **Performance Optimized:** Custom regional collision updates and efficient rendering for smooth 60+ FPS gameplay.
- **Map Editor:** Create and save your own custom battlefield layouts.
- **Multiplayer Ready:** Supports both local practice and network-based multiplayer.

## 🎮 Controls

### Movement & Actions
| Key | Action |
|-----|--------|
| **Arrow Keys / WASD** | Move Koala |
| **Enter** | Jump |
| **Backspace** | High Jump / Backflip |
| **Space / Left Click** | (Hold) Charge Weapon Power |
| **Right Click** | Cancel Charge (before releasing) |
| **Digits 1-5** | Set Weapon Timer (for Grenades/Mines) |

### Camera & UI
| Input | Action |
|-------|--------|
| **Mouse Wheel** | Zoom In/Out |
| **Right Mouse (Drag)** | Pan Camera |
| **Number Keys / UI** | Select Weapon |
| **F3** | Toggle Performance Debug Monitor |

## 🛠️ Technical Details

- **Core Engine:** Built with Vanilla JavaScript using the HTML5 Canvas API.
- **Physics:** Custom physics system featuring gravity, friction, bounciness, and ray-casting collision detection to prevent tunneling.
- **Terrain System:** Uses a dual-canvas approach (Visual + Collision Mask) with regional updates for high-performance destruction.
- **Audio:** Web Audio API integration for immersive sound effects and music.

## 📦 Installation & Running

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd koala-artillery
   ```

2. **Run a local server:**
   Since the game uses JavaScript Modules and assets, it must be run via a local server. You can use the built-in script:
   ```bash
   npm start
   ```
   Or use any static server like `npx serve` or Live Server.

3. **Open in Browser:**
   Navigate to `http://localhost:8080` (or the port provided by your server).

## 📊 Debugging & Performance

The game includes built-in performance monitoring tools. Press **F3** to enable the debug overlay in the console.

- **Basic Mode:** Reports FPS and average frame times.
- **Detailed Mode:** (Enabled via `window.debugPerformanceDetail = true` in console) Breaks down timing for Projectiles, Physics, Particles, and Rendering.

## 📜 License

This project is licensed under the MIT License - see the LICENSE file for details.
