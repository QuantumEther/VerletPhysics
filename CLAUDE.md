# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the Project

No build system or dependencies. Open `index.html` directly in a browser. All code is vanilla ES6 modules loaded natively.

For local development with a file server (avoids module CORS restrictions in some browsers):
```
npx serve .
# or
python -m http.server
```

## Architecture

**VerletPhysics** is a browser-based driving simulator using Verlet integration physics. All state lives in `js/state.js`; all modules import from it and from `js/constants.js`.

### Module Responsibilities

| File | Role |
|------|------|
| `js/state.js` | Single source of truth for all mutable runtime data |
| `js/constants.js` | All magic numbers, frozen with `Object.freeze()` |
| `js/main.js` | Game loop: fixed-timestep accumulator → physics sub-steps → render |
| `js/physics.js` | Verlet integration, engine/drivetrain, clutch, steering, camera, collisions |
| `js/renderer.js` | Canvas 2D drawing: world-space (checkerboard, trails, ball) then screen-space HUD |
| `js/input.js` | Keyboard and mouse event handlers, writes to `state.input` and `state.steering` |
| `js/trail.js` | Velocity arrow trail spawn/age/cull logic |
| `js/ui.js` | Slider↔`state.params` bidirectional binding, needle spring-damper animation |

### Game Loop Order (per physics sub-step)

1. `updateHeadingAndSteering()` — bicycle model
2. `updateEngine()` — RPM, clutch state, temperature
3. `computeAcceleration()` — torque chain → wheel force → net acceleration
4. `verletStep()` — integrate positions
5. `clampDisplacement()` — anti-tunneling
6. `handleBoundaryCollisions()` — wall bounce with grip spin
7. `cacheVelocity()` — derive velocity from position delta
8. `updateRollingOrientation()` — cosmetic 3D orientation
9. `updateCamera()` — Verlet-damped camera follow + speed-based zoom
10. Trail spawn/age

Rendering runs once per animation frame after all sub-steps, split into world-space (camera transform applied) then screen-space HUD (no transform).

### Key Design Decisions

- **Verlet integration** stores `(x, y, prevX, prevY)` — velocity is always derived, never stored directly
- **Drivetrain** is torque-based: throttle → engine torque (parabolic curve peaking at `TORQUE_PEAK_RPM=4500`) → gear/final-drive multiplication → wheel force → acceleration. No speed cap; RPM is back-calculated from wheel speed when clutch is locked
- **Clutch** has three states: locked, slipping, disengaged — controls whether RPM follows wheel speed or free-revs
- **Camera** uses its own Verlet pair (`camX, camPrevX`, etc.) with spring+damping, not the ball's physics
- **Trail arrows** snapshot their lifespan at spawn time so slider changes don't retroactively kill existing arrows; capped at 600 arrows
- **Gauge needles** in `ui.js` use spring-damped needle instances with asymmetric rise/fall and redline flutter
- All tunable slider parameters live in `state.params` and are initialized from `constants.js` defaults that must match the HTML slider `value` attributes

### Controls

- **Right-click drag (horizontal)**: steering wheel angle
- **Left-click drag (vertical)**: analog throttle
- `D`: full throttle, `S`: brake, `A`: clutch hold
- `Numpad 7/1/8/2/9/3`: gears 1–6; `Numpad 4/5/6`: neutral; `Q+Numpad1`: reverse
