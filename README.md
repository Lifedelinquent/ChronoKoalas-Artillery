# 🐨 ChronoKoala's Artillery

A Worms Armageddon-style artillery game in the browser: destructible terrain, 39 weapons, a ninja rope, CPU opponents, a single-player campaign and online play for up to four players — all in vanilla JavaScript and HTML5 canvas.

## 🎮 Ways to play

| Mode | What it is |
|------|------------|
| **Tutorial** | An interactive first lesson: walk, jump, aim, fire, grenades, the rope and teleport, one step at a time. |
| **Training** | Six weapon ranges against 1 HP target dummies. Earn 🥇🥈🥉 medals by clearing a range in as few shots as possible. |
| **Missions** | A 12-mission campaign on fixed maps, laid out as a campaign map. Each mission awards up to ★★★ (win · lose no koalas · flawless within par turns). |
| **Deathmatch** | A ranked ladder from *Absolute Beginner* to *Elite* against tougher and more numerous CPU squads. |
| **Quick Game** | You against 1–3 CPU squads (CPU 1–5) on any map and scheme. |
| **Hotseat** | Two players on one keyboard, each with their own saved team. |
| **Multiplayer** | Up to 4 players over WebRTC (PeerJS), plus spectators. Same colour = allies. Lobby and in-game chat, rematch votes, back-to-lobby. |
| **Map Editor** | Draw or import maps, place spawns, test-play them. |

## ✨ Highlights

- **Destructible terrain** with WA-style lumpy craters, falling mines, drums and graves.
- **39 weapons** in WA-style categories, a scheme editor for ammo, delays, health, timers, hazards, sudden death and more.
- **Smarter CPU** (CPU 1–5): simulates real trajectories, and from CPU 3 up uses utilities — blowtorches toward walled-off enemies, drills down onto enemies below, bridges gaps with girders, ropes out of pits and teleports out of hopeless spots.
- **Replays**: every single-player and hotseat match is saved automatically (🎬 Replays). Watch at 1–8× speed, skip turns, pin favourites, download/import `.koalareplay` files.
- **Instant replay**: a turn that kills a koala is replayed WA-style, with slow motion around the blasts (local games; toggle in Settings).
- **Team editor** (🎩 Teams): team and koala names, hats, gravestones, voice packs and victory dances — used in single player, hotseat and multiplayer.
- **End-of-match stats**: damage, kills, losses, shots, accuracy, friendly fire, crates, plus awards (Sharpshooter, Turn of the Match, Swimming Lessons Needed…).
- **Auto camera** frames long shots and multi-blast weapons (cluster bombs, air strikes), then eases back to your zoom.
- **Touch controls** on phones and tablets: on-screen pads, tap to aim/target, drag to pan, pinch to zoom.
- **Rebindable controls** (⚙️ Settings) and an in-game controls card (**H** / **F1** / the **?** button).
- **Installable / offline**: a PWA — install it from the browser and single player, hotseat, replays and the editor work offline.

## 🕹️ Controls (defaults — rebind in Settings)

| Action | Keys / mouse |
|--------|--------------|
| Walk | ← → or A D |
| Aim | Mouse, or ↑ ↓ / W S |
| Fire | Hold **Space** or left mouse to charge, release to lock the power, press again to shoot |
| Cancel a shot | Right mouse while charging/locked |
| Jump | **Enter** (twice quickly = back hop) |
| High jump | **Backspace** (twice quickly = backflip) |
| Weapon menu | **Tab** / **`** / right-click |
| Grenade fuse | **1–5** |
| Ninja rope | ←/→ swing · ↑/↓ climb · Enter let go · Space re-fire |
| Targeted weapons | Click the map (air strikes, teleport, girder, homing marker) |
| Camera | Right-drag to pan · wheel to zoom |
| Controls card | **H** / **F1** |
| Chat (multiplayer) | **T** |

## 🔫 Arsenal

| Category | Weapons |
|----------|---------|
| Launchers | Bazooka, Homing Missile, Mortar |
| Bombs | Grenade, Cluster Bomb, Banana Bomb, Petrol Bomb, Holy Hand Grenade |
| Guns | Shotgun, Handgun, Uzi, Minigun, Longbow |
| Melee | Fire Punch, Dragon Ball, Baseball Bat, Prod, Kamikaze |
| Explosives | Dynamite, Mine, Sheep |
| Strikes | Air Strike, Napalm Strike, Mine Strike, Armageddon |
| Tools | Blowtorch, Pneumatic Drill, Girder, Ninja Rope, Parachute, Teleport |
| Other | Skip Go, Surrender |

Weapon behaviour lives in `js/weapons/WeaponBehaviors.js` (one entry per weapon type); the numbers live in `js/weapons/WeaponManager.js`.

## 📦 Running it

The game uses ES modules, so it needs a local web server:

```bash
npm start
```

Then open the address it prints (default `http://localhost:8080`).

| Script | What it does |
|--------|--------------|
| `npm start` | Serve the game locally |
| `npm test` | Open the simulation test page (`/tests/`) |
| `npm run check` | Syntax-check every script with Node |
| `npm run sw` | Regenerate the service worker's offline file list — run before deploying changed files |

## 🧪 Tests

`tests/index.html` runs headless matches in the browser:

1. **Same seed → identical match** — a 3-minute CPU vs CPU vs CPU match with crates, mines, drums and wind, run twice and fingerprinted every 300 frames.
2. **Different seed → different match**.
3. **Replay round-trip** — a scripted player fights the CPU through the real input path; replaying the recording must reproduce every checkpoint.

These guard the determinism that multiplayer, replays and the instant replay depend on: all simulation randomness comes from seeded streams (`seededRandom` shared, `hostRandom` for authority-only rolls such as crates, `aiRandom` for the CPU), the world steps at a fixed 1/60 s, and all human input enters through `InputManager.dispatch()`.

## 🛠️ Project layout

```
js/
  main.js                 app shell: menus, game start/end, replays, settings wiring
  engine/
    Game.js               core loop, turn proxies, game over; installs the subsystems below
    game/                 Game subsystems (methods mixed into Game.prototype):
      SpawnSystem.js        team creation and spawn placement
      ProjectileSystem.js   projectile flight, collisions, explosions/damage pipeline
      ToolWeapons.js        melee, blowtorch, drill, kamikaze, teleport, girder, strikes, bursts
      Firing.js             fireWeapon / fireTargettedWeapon (shared checks → WeaponBehaviors)
      RopeSystem.js         ninja rope
      HazardSystem.js       fire, landmines, oil drums
      DeathSystem.js        WA-style deaths and graves
      CameraSystem.js       follow / auto-framing camera
      Effects.js, HUD.js    particles and DOM HUD
      NetSync.js            multiplayer turn adoption and state sync
    InputManager.js       keyboard/mouse → actions → commands (dispatch)
    TurnManager.js, Physics.js, Terrain.js, Renderer.js, MatchStats.js, Cosmetics.js, ...
  weapons/                WeaponManager (definitions), WeaponBehaviors (per-type hooks), Projectile
  ai/AIController.js      CPU brain
  replay/                 Replay (recorder/player/storage), InstantReplay
  singleplayer/           SinglePlayer (modes, missions, medals), Tutorial
  network/NetworkManager.js
  ui/                     MenuManager, SettingsUI, TeamEditor, ReplayUI, ChatUI, TouchControls, SchemeEditor
  utils/                  Settings, TeamStyles, GameScheme, Logger, ...
tests/                    simulation tests
tools/                    audio generation, service-worker list, syntax check, map export
```

## 📊 Debugging

- Add **`?debug`** to the URL (or run `localStorage.setItem('koala_debug', '1')`) to see the detailed console log; it's silent by default.
- **F3** toggles the performance monitor; set `window.debugPerformanceDetail = true` for a per-system breakdown.
- `window.game` is the running match.
- The service worker is skipped on `localhost` so you always get fresh files; add **`?sw`** to test offline mode locally.

## 📜 License

This project is licensed under the MIT License — see the LICENSE file for details.
