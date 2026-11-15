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
| **Multiplayer** | Up to 4 players over WebRTC (PeerJS), plus spectators. Same colour = allies. Lobby and in-game chat, rematch votes, back-to-lobby. Deterministic lockstep keeps every client identical; dropped players reconnect and spectators can join mid-match. |
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
4. **Online lockstep** (`tests/lockstep.test.js`) — several complete clients in one tab, joined by a fake network with delay and jitter: a 3-player match with a spectator must stay identical turn after turn; a spectator joining mid-match must catch up from the command log; a deliberately corrupted client must be detected and repaired; a vanished player must be forfeited; and a client that falls out of step must be pulled back by the host.

Add `?only=lockstep` or `?only=determinism` to run one suite.

These guard the determinism that multiplayer, replays and the instant replay depend on: all simulation randomness comes from seeded streams (`seededRandom` shared, `hostRandom` for crates and drum fuses, `aiRandom` for the CPU), the world steps at a fixed 1/60 s, terrain collision is edited with plain arithmetic (never read back from the canvas), and all human input enters through `InputManager.dispatch()`.

## 🌐 How online play stays in sync

Online matches use **deterministic lockstep**, the model Worms Armageddon and Hedgewars use:

- Every client runs the whole simulation. Positions, damage, craters, crates and turn changes are **never sent** — only the input commands of whoever's turn it is, stamped with the simulation frame they happened on (`network/LockstepSession.js`).
- The turn owner plays with zero input delay and streams its frames; everyone else steps only frames that have been confirmed, so they trail by the network latency and can never guess wrong.
- At the start of every turn each client fingerprints its world and compares it with the host's. A client that disagrees adopts the host's snapshot on that exact frame (`network/StateSync.js`), so a drift is repaired within one turn. The HUD chip (`● 42 ms`) shows the round trip, and its tooltip counts repairs.
- The host keeps the command log. A reconnecting player or a spectator arriving mid-match rebuilds the match from the seed by replaying the log at full speed.
- Every connection has a heartbeat, so a dead link is noticed in seconds; a player who doesn't return within 45 s forfeits.

Rule for new gameplay code: the simulation must not branch on who is watching (`isMyTurn()`, host/guest) or draw from `Math.random()` — anything that changes the world has to come from the command stream and the seeded RNGs.

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
      Control.js            who is at the controls (local player / CPU / online stream)
    InputManager.js       keyboard/mouse → actions → commands (dispatch)
    TurnManager.js, Physics.js, Terrain.js, Renderer.js, MatchStats.js, Cosmetics.js, ...
  weapons/                WeaponManager (definitions), WeaponBehaviors (per-type hooks), Projectile
  ai/AIController.js      CPU brain
  replay/                 Replay (recorder/player/storage), InstantReplay
  singleplayer/           SinglePlayer (modes, missions, medals), Tutorial
  network/
    NetworkManager.js     transport + lobby: PeerJS star topology, heartbeat, reconnect
    LockstepSession.js    online sync: input stream, frame gating, turn checksums, late join
    StateSync.js          turn snapshots (hash / apply) used to detect and repair drift
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
