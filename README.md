# BASTOS TOWER

**A 1v1 first-person brawler on a rooftop.** One rule: **knock your opponent off the roof.**

Punch, kick, stun, knock out, grab, carry, then throw your opponent into the void. Smash them with a frying pan, lob a cinder block at their head, blow up a gas bottle, break the railing, make them walk the plank… Everything is driven by physics.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build in dist/
npm run preview    # serve the build
```

No external assets: models, textures, animations and sound are **all procedural**. The game starts instantly and works offline.

---

## Controls

| Action | Key |
|---|---|
| Move | `WASD` (QWERTY) / `ZQSD` (AZERTY, auto-detected) |
| Sprint / Jump | `Shift` / `Space` |
| Left / right punch | `Left click` / `Right click`. **Tap** = fast punch, **hold** = charged punch (hook / uppercut) |
| Kick | `F` (hold = Sparta kick, ideal near the edge) |
| Block | `Q` (QWERTY) / `A` (AZERTY). Blocking right before the hit = **parry** |
| Dodge | `C` |
| Pick up / grab / lift / drop | `E` (context-sensitive) |
| Holding an object | `Left click` = swing, `Right click` held = aim and throw (more power the longer you hold) |
| Carrying an opponent | `Click` held = **THROW** |
| Being carried | Mash any key to break free |
| Pause | `Esc` |
| Instant rematch | `R` / `Enter` on the results screen |

## Game loop

1. **Hit**: every punch and kick fills the opponent's **daze** gauge (combos and head hits fill it faster).
2. **Stun**: the opponent staggers, sees stars and loses control. They can be **grabbed** (`E`).
3. **K.O.**: hit a stunned opponent hard, or empty their health, and they go full ragdoll for several seconds.
4. **Grab → Lift → Throw**: `E` to grab (drag), `E` again to lift them over your head, run to the edge, then hold-and-release a click to throw.
5. **Fall**: anyone who goes over the edge loses. Slow motion, cinematic camera, results, rematch.

Health works like *Smash Bros*: the more beaten up you are, **the further you fly**. Knockback, objects and explosions all launch bodies physically. A low parapet trips a fighter who gets shoved into it, and the railing breaks under heavy impacts.

## Architecture

```
src/
  core/        Engine (renderer, postprocessing, quality, dynamic resolution), fixed-step Loop
               with slow-mo and hitstop, Input (pointer lock, QWERTY/AZERTY), EventBus, math
  physics/     Rapier wrapper: collision layers, owner registry, collision/contact-force events
  world/       Arena (roof, colliders, gaps, breakable railing, plank, AI knowledge of the edges),
               City (instanced skyline, shader-lit windows, vertex-animated traffic), Sky,
               procedural textures, static batching
  fighters/    Fighter (shared state machine + controller + damage + grabbing),
               Rig (single skinned mesh = 1 draw call), Animator (procedural animation),
               IK (two-bone + cartoon stretch), Ragdoll (11 bodies, motorized joints),
               attacks (trajectory data), Characters (roster)
  control/     PlayerController (input → intent), AIController (opponent brain)
  combat/      CombatSystem: swept hitboxes vs hurtboxes, projectile/body/explosion impacts
  interaction/ InteractionSystem: context action (pick up, grab, lift, drop)
  props/       Object catalog (light / heavy / blunt / absurd) + PropSystem (instancing, specials)
  camera/      CameraRig: FPS (bob, trauma shake, kicks, dynamic FOV), orbit when KO'd, fall cam
  view/        ViewModel: first-person arms and leg (separate pass, fixed FOV)
  fx/          Pooled particles (blood, teeth, debris, sprites), decals, comic onomatopoeia
  audio/       WebAudio synthesis (impacts, formant voices, gibberish, music) + event director
  ui/          HUD (DOM, cached writes)
  game/        Game (orchestration, match flow), events, settings
```

### Notable technical choices

- **What you see is what hits.** Every strike is a keyframed trajectory of the limb in aim space. The same curve drives the hitbox (a sphere swept between two simulation steps, tested against head/torso/limb capsules), the opponent's arm/leg IK, and the player's first-person fists.
- **One state machine for both fighters.** `NORMAL → HIT → STUNNED → KO → GRABBED → CARRIED → THROWN → FALLING` (+ `GETTING_UP`), with a whitelist of allowed transitions. Every state has a timer or a physical exit condition, so nothing gets stuck. The AI writes the same `Intent` as the human player.
- **Real physics.** Rapier 3D (WASM) handles the kinematic character controller, props, and ragdolls whose joints have angular motors ("muscle tone": limp when KO'd, firm when stunned). A carried body has a kinematic torso while its limbs flop freely.
- **Smooth slow motion.** The simulation always ticks 60 times per second of *real* time, but each tick integrates `dt × timeScale`, so slow-mo and hitstop stay fluid.
- **Performance.** About 120 draw calls for the whole scene:
  - Fighters are one rigidly skinned mesh each.
  - Props are instanced per type.
  - The roof is merged per material.
  - The city is instanced in culled sectors, with an LOD fade on the windows.
  - Traffic animates on the GPU.
  - Particles live in fixed pools with no allocation.
  - Inactive opponents are pooled.
  - Resolution scales dynamically, and there are 3 quality presets.

## Debug

`?debug` exposes `window.bastos` and allows input without pointer lock. `?q=low|medium|high` forces the quality.
