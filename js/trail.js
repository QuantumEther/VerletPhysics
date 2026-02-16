// =============================================================
// TRAIL — velocity arrow spawning, aging, and rendering
// =============================================================
// Self-contained subsystem. The trail is a visual record of the
// ball's recent velocity: arrows placed at the ball's position
// with length/color/width proportional to speed at spawn time.
//
// Each arrow captures its own lifespan at spawn time so that
// changing the lifespan slider doesn't retroactively kill or
// extend existing arrows.
// =============================================================

import state from './state.js';
import {
  ARROW_BASE_LENGTH,
  REFERENCE_SPEED,
  MAX_TRAIL_ARROWS
} from './constants.js';


/**
 * Attempt to spawn a trail arrow at the ball's current position.
 * Only spawns if the ball is moving above a minimum threshold
 * (prevents cluttering the canvas with zero-length arrows).
 */
export function spawnTrailArrow() {
  const velocityX = state.velocity.x;
  const velocityY = state.velocity.y;
  const speed = Math.hypot(velocityX, velocityY);

  // Don't spawn arrows when nearly stationary
  if (speed < 1.0) return;

  state.trail.arrows.push({
    x: state.ball.x,
    y: state.ball.y,
    angle: Math.atan2(velocityY, velocityX),
    speed: speed,
    age: 0,
    // Snapshot the current lifespan so slider changes
    // don't retroactively affect existing arrows
    lifespan: state.params.trailLifespan
  });

  // Cull oldest arrows if we exceed the cap
  const arrows = state.trail.arrows;
  if (arrows.length > MAX_TRAIL_ARROWS) {
    arrows.splice(0, arrows.length - MAX_TRAIL_ARROWS);
  }
}


/**
 * Age all arrows by dt and remove expired ones.
 * Iterates in reverse so splice indices stay valid.
 *
 * @param {number} dt - physics timestep in seconds
 */
export function updateTrailArrows(dt) {
  const arrows = state.trail.arrows;
  for (let i = arrows.length - 1; i >= 0; i--) {
    arrows[i].age += dt;
    if (arrows[i].age >= arrows[i].lifespan) {
      arrows.splice(i, 1);
    }
  }
}


/**
 * Map speed to a green → yellow → red colour string.
 * Green at 0 speed, yellow at REFERENCE_SPEED, red at 2×REFERENCE_SPEED.
 *
 * @param {number} speed - ball speed in px/s
 * @param {number} alpha - opacity 0–1
 * @returns {string} CSS rgba() colour
 */
function speedToColor(speed, alpha) {
  const normalizedSpeed = Math.min(speed / (REFERENCE_SPEED * 2), 1.0);
  let red, green, blue;

  if (normalizedSpeed < 0.5) {
    // Green → Yellow transition
    const t = normalizedSpeed * 2;
    red   = Math.round(100 + 155 * t);
    green = 255;
    blue  = Math.round(100 - 20 * t);
  } else {
    // Yellow → Red transition
    const t = (normalizedSpeed - 0.5) * 2;
    red   = 255;
    green = Math.round(255 - 175 * t);
    blue  = Math.round(80 - 20 * t);
  }

  return `rgba(${red},${green},${blue},${alpha})`;
}


/**
 * Draw all living trail arrows on the given canvas context.
 * Each arrow has:
 *   - Length proportional to speed at spawn time
 *   - Line width proportional to speed
 *   - Colour from green→yellow→red gradient
 *   - Opacity that fades as the arrow ages (controlled by trailFade slider)
 *
 * @param {CanvasRenderingContext2D} ctx - simulation canvas context
 */
export function drawTrailArrows(ctx) {
  const trailFade = state.params.trailFade;

  for (const arrow of state.trail.arrows) {
    // Compute fade-based opacity
    const lifeRatio = Math.max(0, 1 - arrow.age / arrow.lifespan);
    const alpha = trailFade > 0
      ? Math.min(1, lifeRatio + (1 - trailFade))
      : 1;

    // Skip nearly-invisible arrows
    if (alpha < 0.01) continue;

    ctx.save();
    ctx.translate(arrow.x, arrow.y);
    ctx.rotate(arrow.angle);

    // Scale line and arrowhead by speed
    const speedRatio = Math.min(arrow.speed, REFERENCE_SPEED) / REFERENCE_SPEED;
    const length = ARROW_BASE_LENGTH * speedRatio;
    const lineWidth = 1.5 + 2.0 * speedRatio;
    const color = speedToColor(arrow.speed, alpha);

    // Arrow shaft
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(length, 0);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Arrowhead
    const headLength = 6 + 4 * speedRatio;
    const headWidth  = 3 + 2 * speedRatio;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(length, 0);
    ctx.lineTo(length - headLength, -headWidth);
    ctx.lineTo(length - headLength,  headWidth);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }
}
