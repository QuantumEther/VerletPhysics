// =============================================================
// RENDERER — all canvas drawing: world (checkerboard, trails,
//            ball, motion blur) + screen-space HUD (steering,
//            gauges, throttle indicator)
// =============================================================
// The renderer is split into world-space and screen-space phases.
//
// WORLD SPACE (affected by camera transform):
//   1. Checkerboard background (with speed-based motion blur)
//   2. Trail arrows
//   3. Ball (with configurable motion blur)
//   4. Map boundary walls
//
// SCREEN SPACE (drawn after camera transform is removed):
//   1. Steering wheel HUD
//   2. Throttle bar indicator
//   3. Analog gauges (on separate canvases)
// =============================================================

import state from './state.js';
import {
  BALL_RADIUS,
  CHECKERBOARD_TILE_SIZE,
} from './constants.js';


// =============================================================
// CAMERA TRANSFORM
// =============================================================
// Applies the camera translation and zoom so that all subsequent
// draw calls are in world coordinates. The camera center is placed
// at the center of the viewport.
// =============================================================

/**
 * Apply camera transform to the context.
 * After calling this, all draw calls use world coordinates.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} viewportWidth  - CSS-pixel width of the viewport
 * @param {number} viewportHeight - CSS-pixel height of the viewport
 */
export function applyCameraTransform(ctx, viewportWidth, viewportHeight) {
  const cam = state.camera;
  ctx.save();
  // Move origin to viewport center, apply zoom, then offset by camera position
  ctx.translate(viewportWidth / 2, viewportHeight / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);
}

/**
 * Remove camera transform (restores to screen space).
 * @param {CanvasRenderingContext2D} ctx
 */
export function removeCameraTransform(ctx) {
  ctx.restore();
}


// =============================================================
// CHECKERBOARD BACKGROUND (with motion blur)
// =============================================================
// Draws a tiled checkerboard across the visible portion of the
// world. When the ball is moving fast, the checkerboard is drawn
// multiple times at offset positions with reduced alpha, creating
// a directional motion blur effect.
// =============================================================

/**
 * Draw the checkerboard background with optional motion blur.
 *
 * @param {CanvasRenderingContext2D} ctx - already has camera transform applied
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 */
export function drawCheckerboard(ctx, viewportWidth, viewportHeight) {
  const cam = state.camera;
  const speed = Math.hypot(state.velocity.x, state.velocity.y);
  const params = state.params;
  const tileSize = CHECKERBOARD_TILE_SIZE;

  // Calculate visible world region (accounting for zoom)
  const halfW = (viewportWidth / 2) / cam.zoom;
  const halfH = (viewportHeight / 2) / cam.zoom;
  const visibleLeft   = cam.x - halfW - tileSize;
  const visibleTop    = cam.y - halfH - tileSize;
  const visibleRight  = cam.x + halfW + tileSize;
  const visibleBottom = cam.y + halfH + tileSize;

  // Snap to tile grid
  const startCol = Math.floor(visibleLeft / tileSize);
  const endCol   = Math.ceil(visibleRight / tileSize);
  const startRow = Math.floor(visibleTop / tileSize);
  const endRow   = Math.ceil(visibleBottom / tileSize);

  // ---- Motion blur passes ----
  const blurEnabled = speed > params.motionBlurThreshold;
  const blurSamples = blurEnabled ? Math.max(1, Math.round(params.motionBlurSamples)) : 1;
  const blurIntensity = blurEnabled ? params.motionBlurIntensity : 1.0;

  // Blur offset direction (opposite to velocity)
  const velDirX = speed > 1 ? -state.velocity.x / speed : 0;
  const velDirY = speed > 1 ? -state.velocity.y / speed : 0;

  // Maximum blur offset scales with speed
  const maxBlurOffset = blurEnabled ? Math.min(speed * 0.08, 60) : 0;

  for (let pass = 0; pass < blurSamples; pass++) {
    const passRatio = blurSamples > 1 ? pass / (blurSamples - 1) : 0;
    const offsetX = velDirX * maxBlurOffset * passRatio;
    const offsetY = velDirY * maxBlurOffset * passRatio;

    // Alpha decreases for older ghost passes
    const passAlpha = blurEnabled
      ? (1.0 / blurSamples) * blurIntensity * (1 - passRatio * 0.5)
      : 1.0;

    ctx.save();
    ctx.globalAlpha = Math.min(1, passAlpha);
    ctx.translate(offsetX, offsetY);

    // Draw tiles
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const isLight = (row + col) % 2 === 0;
        ctx.fillStyle = isLight ? '#1a2030' : '#151b28';
        ctx.fillRect(col * tileSize, row * tileSize, tileSize, tileSize);
      }
    }

    ctx.restore();

    // Only the first pass draws at full alpha when blur is off
    if (!blurEnabled) break;
  }
}


// =============================================================
// MAP BOUNDARY WALLS
// =============================================================
// Draws the world boundary as a visible border so the player
// can see where the edges are.
// =============================================================

/**
 * Draw the map boundary rectangle.
 * @param {CanvasRenderingContext2D} ctx - with camera transform applied
 */
export function drawMapBoundary(ctx) {
  const mapW = state.params.mapWidth;
  const mapH = state.params.mapHeight;

  ctx.save();
  ctx.strokeStyle = 'rgba(232, 196, 74, 0.4)';
  ctx.lineWidth = 4;
  ctx.setLineDash([20, 10]);
  ctx.strokeRect(0, 0, mapW, mapH);
  ctx.setLineDash([]);
  ctx.restore();
}


// =============================================================
// BALL RENDERING (with configurable motion blur)
// =============================================================

/**
 * Draw the ball with optional motion blur ghost copies.
 * The number of samples, intensity, and speed threshold are
 * all controlled by sliders.
 *
 * @param {CanvasRenderingContext2D} ctx - with camera transform applied
 */
export function drawBall(ctx) {
  const speed = Math.hypot(state.velocity.x, state.velocity.y);
  const params = state.params;
  const blurEnabled = speed > params.motionBlurThreshold;

  if (blurEnabled) {
    const samples = Math.max(1, Math.round(params.motionBlurSamples));
    const blurDistance = Math.min(speed * 0.06, 50);
    const dirX = speed > 1 ? -state.velocity.x / speed : 0;
    const dirY = speed > 1 ? -state.velocity.y / speed : 0;

    // Draw ghost copies behind the ball (oldest = farthest, most transparent)
    for (let i = samples; i >= 1; i--) {
      const ratio = i / samples;
      const alpha = (params.motionBlurIntensity * 0.15) / (i * 0.5);
      ctx.save();
      ctx.globalAlpha = Math.min(0.4, alpha);
      ctx.translate(dirX * blurDistance * ratio, dirY * blurDistance * ratio);
      drawBallGeometry(ctx, state.carHeading);
      ctx.restore();
    }
  }

  // Draw the main ball at full opacity
  drawBallGeometry(ctx, state.carHeading);
}

/**
 * Internal: draw ball geometry at current state.ball position.
 * Separated so it can be called multiple times for motion blur.
 */
function drawBallGeometry(ctx, heading) {
  ctx.save();
  ctx.translate(state.ball.x, state.ball.y);
  ctx.rotate(heading);

  // Drop shadow
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetX = 4;
  ctx.shadowOffsetY = 4;
  ctx.beginPath();
  ctx.arc(0, 0, BALL_RADIUS, 0, 2 * Math.PI);
  ctx.fillStyle = '#ffd966';
  ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  // Radial highlight
  const highlightGradient = ctx.createRadialGradient(
    -BALL_RADIUS * 0.3, -BALL_RADIUS * 0.3, 0,
    0, 0, BALL_RADIUS
  );
  highlightGradient.addColorStop(0, 'rgba(255,255,255,0.25)');
  highlightGradient.addColorStop(0.6, 'rgba(255,255,255,0)');
  ctx.beginPath();
  ctx.arc(0, 0, BALL_RADIUS, 0, 2 * Math.PI);
  ctx.fillStyle = highlightGradient;
  ctx.fill();

  // Border ring
  ctx.beginPath();
  ctx.arc(0, 0, BALL_RADIUS, 0, 2 * Math.PI);
  ctx.strokeStyle = '#b38f40';
  ctx.lineWidth = 3;
  ctx.stroke();

  // "A" letter
  ctx.font = 'bold 28px "JetBrains Mono", monospace';
  ctx.fillStyle = '#3d2b1a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('A', 0, 1);

  // Red heading indicator
  ctx.beginPath();
  ctx.moveTo(BALL_RADIUS * 0.6, 0);
  ctx.lineTo(BALL_RADIUS * 0.95, 0);
  ctx.strokeStyle = 'rgba(200, 50, 30, 0.7)';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.stroke();

  ctx.restore();
}


// =============================================================
// STEERING WHEEL HUD (screen space)
// =============================================================

export function drawSteeringWheel(ctx, canvasWidth, canvasHeight) {
  const centerX = canvasWidth - 70;
  const centerY = canvasHeight - 70;
  const radius = 30;

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(state.steering.wheelAngle);

  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, 2 * Math.PI);
  ctx.fillStyle = 'rgba(20,20,30,0.9)';
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 8;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#e8c44a';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(-radius, 0);
  ctx.lineTo(radius, 0);
  ctx.moveTo(0, -radius);
  ctx.lineTo(0, radius);
  ctx.strokeStyle = '#e8c44a';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0, -radius + 4, 4, 0, 2 * Math.PI);
  ctx.fillStyle = '#c0392b';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(0, 0, 6, 0, 2 * Math.PI);
  ctx.fillStyle = '#b38f40';
  ctx.fill();

  ctx.restore();
}


// =============================================================
// THROTTLE BAR HUD (screen space)
// =============================================================
// Shows the current analog throttle amount as a vertical bar
// next to the steering wheel.
// =============================================================

export function drawThrottleBar(ctx, canvasWidth, canvasHeight) {
  const barWidth = 12;
  const barHeight = 80;
  const barX = canvasWidth - 120;
  const barY = canvasHeight - 100;

  // Determine current throttle amount
  let throttle = 0;
  if (state.input.mouseThrottleActive) {
    throttle = state.input.mouseThrottleAmount;
  } else if (state.input.throttlePressed) {
    throttle = 1.0;
  }

  // Background
  ctx.save();
  ctx.fillStyle = 'rgba(20,20,30,0.8)';
  ctx.strokeStyle = 'rgba(232,196,74,0.4)';
  ctx.lineWidth = 1;
  ctx.fillRect(barX, barY, barWidth, barHeight);
  ctx.strokeRect(barX, barY, barWidth, barHeight);

  // Fill (from bottom up)
  const fillHeight = barHeight * throttle;
  const fillColor = throttle > 0.8 ? '#c0392b' : throttle > 0.5 ? '#e8c44a' : '#48d4e8';
  ctx.fillStyle = fillColor;
  ctx.fillRect(barX, barY + barHeight - fillHeight, barWidth, fillHeight);

  // Label
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '9px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('THR', barX + barWidth / 2, barY - 4);

  ctx.restore();
}


// =============================================================
// ANALOG GAUGE RENDERING (unchanged from previous version)
// =============================================================

function roundRectPath(ctx, x, y, width, height, cornerRadius) {
  const r = Math.min(cornerRadius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

export function drawAnalogGauge(ctx, canvasWidth, canvasHeight, config) {
  const {
    value, min, max, title, subtitle, unitRight,
    majorStep, minorDiv, redFrom, labelFormatter,
    labelFontScale = 1.0
  } = config;

  const W = canvasWidth;
  const H = canvasHeight;

  ctx.clearRect(0, 0, W, H);

  const pad = Math.min(W, H) * 0.08;
  const faceX = pad, faceY = pad;
  const faceW = W - pad * 2, faceH = H - pad * 2;
  const centerX = W * 0.50;
  const centerY = H * 0.88;
  const arcRadius = Math.min(W, H) * 0.42;
  const arcStart = Math.PI * 1.05;
  const arcEnd   = Math.PI * 1.95;

  const angleForValue = (v) => {
    const normalized = (v - min) / (max - min);
    return arcStart + (arcEnd - arcStart) * Math.max(0, Math.min(1, normalized));
  };

  // Face background
  const faceGradient = ctx.createRadialGradient(
    centerX, centerY - arcRadius * 0.65, arcRadius * 0.25,
    centerX, centerY, arcRadius * 1.6
  );
  faceGradient.addColorStop(0.00, '#fff2cf');
  faceGradient.addColorStop(0.35, '#f4e6c2');
  faceGradient.addColorStop(1.00, '#dec89a');
  ctx.save();
  roundRectPath(ctx, faceX, faceY, faceW, faceH, 30);
  ctx.fillStyle = faceGradient;
  ctx.fill();
  ctx.restore();

  // Paper grain
  ctx.save();
  ctx.globalAlpha = 0.08;
  for (let i = 0; i < 520; i++) {
    ctx.fillStyle = `rgba(30,20,10,${Math.random() * 0.06})`;
    ctx.fillRect(Math.random() * W, Math.random() * H, 1, 1);
  }
  ctx.restore();

  // Arc groove
  ctx.save();
  ctx.beginPath();
  ctx.arc(centerX, centerY, arcRadius, arcStart, arcEnd);
  ctx.lineWidth = arcRadius * 0.12;
  ctx.strokeStyle = 'rgba(0,0,0,0.10)';
  ctx.stroke();
  ctx.restore();

  // Red zone
  if (typeof redFrom === 'number') {
    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, arcRadius, angleForValue(redFrom), arcEnd);
    ctx.lineWidth = arcRadius * 0.045;
    ctx.strokeStyle = 'rgba(160,30,30,0.70)';
    ctx.stroke();
    ctx.restore();
  }

  // Tick marks
  const majorCount = Math.floor((max - min) / majorStep);
  const totalMinorTicks = majorCount * minorDiv;

  ctx.save();
  ctx.strokeStyle = 'rgba(20,20,20,0.78)';
  ctx.lineCap = 'round';
  for (let i = 0; i <= totalMinorTicks; i++) {
    const tickValue = min + i * (majorStep / minorDiv);
    const isMajor = (i % minorDiv === 0);
    const angle = angleForValue(tickValue);
    const innerRadius = isMajor ? arcRadius * 0.78 : arcRadius * 0.86;

    ctx.lineWidth = isMajor ? 5 : 2.5;
    ctx.beginPath();
    ctx.moveTo(
      centerX + Math.cos(angle) * innerRadius,
      centerY + Math.sin(angle) * innerRadius
    );
    ctx.lineTo(
      centerX + Math.cos(angle) * arcRadius,
      centerY + Math.sin(angle) * arcRadius
    );
    ctx.stroke();
  }
  ctx.restore();

  // Major tick labels
  ctx.save();
  ctx.fillStyle = 'rgba(20,20,20,0.90)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const labelPixelSize = Math.round(
    H * 0.055 * Math.max(0.4, Math.min(2.0, labelFontScale))
  );
  ctx.font = `800 ${labelPixelSize}px "JetBrains Mono", monospace`;
  for (let i = 0; i <= majorCount; i++) {
    const tickValue = min + i * majorStep;
    const angle = angleForValue(tickValue);
    ctx.fillText(
      labelFormatter(tickValue),
      centerX + Math.cos(angle) * arcRadius * 0.64,
      centerY + Math.sin(angle) * arcRadius * 0.64
    );
  }
  ctx.restore();

  // Title and subtitle
  ctx.save();
  ctx.fillStyle = 'rgba(20,20,20,0.86)';
  ctx.textAlign = 'center';
  ctx.font = `900 ${Math.round(H * 0.075)}px "JetBrains Mono", monospace`;
  ctx.fillText(title, centerX, H * 0.20);
  ctx.font = `700 ${Math.round(H * 0.045)}px "JetBrains Mono", monospace`;
  ctx.fillText(subtitle, centerX, H * 0.27);
  ctx.textAlign = 'right';
  ctx.font = `800 ${Math.round(H * 0.060)}px "JetBrains Mono", monospace`;
  ctx.fillText(unitRight, W - pad * 1.15, H * 0.86);
  ctx.restore();

  // Needle
  const needleAngle = angleForValue(value);
  const needleTipX = centerX + Math.cos(needleAngle) * arcRadius * 0.92;
  const needleTipY = centerY + Math.sin(needleAngle) * arcRadius * 0.92;

  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,0.30)';
  ctx.lineWidth = 12;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(centerX + 6, centerY + 6);
  ctx.lineTo(needleTipX + 6, needleTipY + 6);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = '#c0392b';
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(centerX, centerY);
  ctx.lineTo(needleTipX, needleTipY);
  ctx.stroke();
  ctx.restore();

  // Pivot cap
  ctx.save();
  const capRadius = arcRadius * 0.07;
  const capGradient = ctx.createRadialGradient(
    centerX - capRadius * 0.2, centerY - capRadius * 0.2, capRadius * 0.2,
    centerX, centerY, capRadius
  );
  capGradient.addColorStop(0, 'rgba(255,255,255,0.92)');
  capGradient.addColorStop(0.45, 'rgba(180,180,180,0.96)');
  capGradient.addColorStop(1, 'rgba(80,80,80,0.96)');
  ctx.beginPath();
  ctx.arc(centerX, centerY, capRadius, 0, Math.PI * 2);
  ctx.fillStyle = capGradient;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.stroke();
  ctx.restore();

  // Vignette
  ctx.save();
  const vignetteGradient = ctx.createRadialGradient(
    centerX, centerY - arcRadius * 0.65, arcRadius * 0.25,
    centerX, centerY, arcRadius * 1.7
  );
  vignetteGradient.addColorStop(0, 'rgba(255,255,255,0)');
  vignetteGradient.addColorStop(0.65, 'rgba(255,255,255,0.03)');
  vignetteGradient.addColorStop(1, 'rgba(0,0,0,0.12)');
  roundRectPath(ctx, faceX, faceY, faceW, faceH, 30);
  ctx.fillStyle = vignetteGradient;
  ctx.fill();
  ctx.restore();
}
