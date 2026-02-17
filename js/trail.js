// =============================================================
// TRAIL — velocity arrow spawning, aging, and rendering
// =============================================================
// The trail is a visual record of the car's recent velocity.
// Arrows are placed at the car's position each spawn interval,
// oriented by the car's velocity vector, and sized by the car's speed.
//
// Each arrow captures its lifespan at spawn time. Changing the slider
// after arrows are spawned does not retroactively shorten or lengthen
// existing arrows — they live out their snapshot lifespan.
//
// Arrows are stored in state.trail.arrows and rendered by drawTrailArrows()
// which is called from renderer.js in the world-space (camera-transformed) pass.
// =============================================================

import state from './state.js';
import {
  MAX_TRAIL_ARROWS,
  TRAIL_ARROW_BASE_LENGTH_PX,
  TRAIL_REFERENCE_SPEED_PX,
} from './constants.js';


// =============================================================
// SPAWN
// =============================================================

// Spawns a new trail arrow at the car's current position and velocity.
// The arrow is only spawned if the car is moving (speed > 1 px/s).
// If the arrow count exceeds the cap, the oldest arrow is removed first.
// Caller is responsible for accumulating time and calling this at the
// correct interval — see main.js.
export function spawnTrailArrow() {
  const body   = state.body;
  const trail  = state.trail;
  const params = state.params;

  if (body.speed < 1.0) return; // no point drawing arrows at rest

  // Cull oldest arrow if at cap, before pushing the new one.
  if (trail.arrows.length >= MAX_TRAIL_ARROWS) {
    trail.arrows.shift();
  }

  // Snapshot the lifespan from params at spawn time.
  // This means slider changes affect future arrows only, not existing ones.
  const snapshotLifespan = params.trailLifespan;

  trail.arrows.push({
    x:        body.centerX,
    y:        body.centerY,
    angle:    Math.atan2(body.velocityY, body.velocityX), // world-space angle
    speed:    body.speed,
    age:      0,
    lifespan: snapshotLifespan,
  });
}


// =============================================================
// UPDATE
// =============================================================

// Ages all trail arrows by dt seconds and removes any that have expired.
// Iterates backward to preserve array indices when splicing.
export function updateTrailArrows(dt) {
  const arrows = state.trail.arrows;

  for (let index = arrows.length - 1; index >= 0; index--) {
    arrows[index].age += dt;
    if (arrows[index].age >= arrows[index].lifespan) {
      arrows.splice(index, 1);
    }
  }
}


// =============================================================
// RENDERING
// =============================================================

// Draws all trail arrows onto the provided canvas context.
// This function is called from renderer.js inside the camera transform,
// so all coordinates are in world space.
export function drawTrailArrows(ctx) {
  const arrows = state.trail.arrows;
  const params = state.params;

  for (const arrow of arrows) {
    // Fade: opacity falls off as arrow ages.
    // trailFade controls the exponent: higher = faster fade.
    const normalizedAge = arrow.age / arrow.lifespan; // 0 at birth, 1 at death
    const opacity = Math.pow(1.0 - normalizedAge, params.trailFade);

    if (opacity < 0.01) continue; // skip nearly-invisible arrows

    // Size: length and lineWidth scale with speed.
    const speedRatio  = arrow.speed / TRAIL_REFERENCE_SPEED_PX;
    const arrowLength = TRAIL_ARROW_BASE_LENGTH_PX * Math.max(0.4, speedRatio);
    const lineWidth   = Math.max(1, 2 * Math.min(speedRatio, 2.0));

    // Colour: green (slow) → yellow (reference speed) → red (fast).
    const arrowColor  = speedToColor(arrow.speed, opacity);

    ctx.save();
    ctx.translate(arrow.x, arrow.y);
    ctx.rotate(arrow.angle);

    // Arrow shaft.
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(arrowLength, 0);
    ctx.strokeStyle = arrowColor;
    ctx.lineWidth   = lineWidth;
    ctx.lineCap     = 'round';
    ctx.stroke();

    // Arrowhead triangle at the tip.
    const headLength = arrowLength * 0.35;
    const headWidth  = headLength  * 0.45;
    ctx.beginPath();
    ctx.moveTo(arrowLength, 0);
    ctx.lineTo(arrowLength - headLength,  headWidth);
    ctx.lineTo(arrowLength - headLength, -headWidth);
    ctx.closePath();
    ctx.fillStyle = arrowColor;
    ctx.fill();

    ctx.restore();
  }
}


// =============================================================
// COLOUR HELPER
// =============================================================

// Returns a CSS rgba() string that interpolates:
//   green (0, 200, 100) at speed = 0
//   yellow (255, 220, 0) at speed = TRAIL_REFERENCE_SPEED_PX
//   red (255, 50, 50) at speed = 2 × TRAIL_REFERENCE_SPEED_PX
function speedToColor(speed, alpha) {
  const ref = TRAIL_REFERENCE_SPEED_PX;

  let red, green, blue;

  if (speed < ref) {
    // Green → yellow
    const fraction = speed / ref; // 0 at green, 1 at yellow
    red   = Math.round(255 * fraction);
    green = Math.round(200 + 20 * fraction); // 200 → 220
    blue  = Math.round(100 * (1 - fraction));
  } else {
    // Yellow → red
    const fraction = Math.min(1, (speed - ref) / ref); // 0 at yellow, 1 at red
    red   = 255;
    green = Math.round(220 * (1 - fraction) + 50 * fraction); // 220 → 50
    blue  = Math.round(50  * fraction); // 0 → 50
  }

  return `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(3)})`;
}
