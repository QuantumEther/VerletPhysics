// =============================================================
// RENDERER — all canvas drawing
// =============================================================
// Two render passes per frame:
//
//   WORLD SPACE (camera transform applied):
//     1. Checkerboard background (with optional motion blur)
//     2. Map boundary rectangle
//     3. Trail arrows
//     4. Car body rectangle
//
//   SCREEN SPACE (no transform, pixel-exact HUD):
//     5. Steering wheel indicator
//     6. Throttle bar
//     7. Brake bar
//     8. Clutch pedal bar (with bite zone marked)
//     9. Gear indicator (large character)
//
//   GAUGE CANVASES (separate canvas elements):
//    10. Tachometer (0–7000 RPM, redline at 6500)
//    11. Speedometer (0–200 km/h)
//    12. Third canvas: used as a lateral-G gauge (0–1.5 G)
//
// Each function is self-contained. A failure in one does not affect others.
// =============================================================

import state from './state.js';
import {
  CAR_HALF_WIDTH,
  CAR_HALF_LENGTH,
  CHECKERBOARD_TILE_SIZE_PX,
  CLUTCH_BITE_POINT,
  CLUTCH_BITE_RANGE,
  KPH_TO_PX_PER_SEC,
  NEEDLE_STIFFNESS,
  NEEDLE_DAMPING,
  NEEDLE_RISE_BOOST,
  NEEDLE_FALL_BOOST,
  NEEDLE_FLUTTER_THRESHOLD,
} from './constants.js';


// =============================================================
// CAMERA TRANSFORM
// =============================================================

// Applies the camera transform to ctx before drawing world-space content.
// After this call, canvas coordinates match world coordinates scaled and
// offset by the camera's position and zoom.
export function applyCameraTransform(ctx, viewportWidth, viewportHeight) {
  ctx.save();
  // Move origin to viewport centre so the car appears in the middle of the screen.
  ctx.translate(viewportWidth * 0.5, viewportHeight * 0.5);
  // Scale by zoom (< 1 = zoomed out, = 1 = normal).
  ctx.scale(state.camera.zoom, state.camera.zoom);
  // Offset so the camera's world position is at the viewport centre.
  ctx.translate(-state.camera.x, -state.camera.y);
}

// Restores the context to the state before applyCameraTransform.
// Must be called before drawing screen-space HUD elements.
export function removeCameraTransform(ctx) {
  ctx.restore();
}


// =============================================================
// CHECKERBOARD BACKGROUND
// =============================================================

// Draws the tiled checkerboard pattern, with an optional motion-blur effect
// that trails behind the car's movement direction.
// Only tiles visible in the current viewport + camera margin are drawn.
export function drawCheckerboard(ctx, viewportWidth, viewportHeight) {
  const camera = state.camera;
  const body   = state.body;
  const params = state.params;
  const tile   = CHECKERBOARD_TILE_SIZE_PX;

  // How many tile widths the viewport covers (accounting for zoom).
  const tilesAcross = (viewportWidth  / camera.zoom / tile) + 2;
  const tilesDown   = (viewportHeight / camera.zoom / tile) + 2;

  // Top-left visible tile index.
  const startTileX = Math.floor((camera.x - viewportWidth  * 0.5 / camera.zoom) / tile) - 1;
  const startTileY = Math.floor((camera.y - viewportHeight * 0.5 / camera.zoom) / tile) - 1;

  // Motion blur: draw the checkerboard several times with decreasing alpha,
  // offset opposite to the velocity direction so it looks like the ground is
  // blurring behind the car (like motion blur in photography).
  const speed       = body.speed;
  const blurSamples = params.motionBlurSamples;
  const blurIntensity = params.motionBlurIntensity;

  let sampleCount = 1;
  let blurOffsetPerSample = 0;

  if (speed > params.motionBlurThreshold && blurSamples > 1) {
    sampleCount          = blurSamples;
    blurOffsetPerSample  = Math.min(speed * 0.025, 8); // px per sample, world space
  }

  for (let sample = sampleCount - 1; sample >= 0; sample--) {
    // Earlier samples (larger index) are more transparent and further behind.
    const sampleAlpha = sample === 0
      ? 1.0
      : blurIntensity * (1 - sample / sampleCount);

    // Offset opposite to velocity.
    const invSpeed = speed > 0.001 ? 1 / speed : 0;
    const offsetX  = -body.velocityX * invSpeed * blurOffsetPerSample * sample;
    const offsetY  = -body.velocityY * invSpeed * blurOffsetPerSample * sample;

    ctx.globalAlpha = sampleAlpha;

    for (let col = 0; col <= tilesAcross; col++) {
      for (let row = 0; row <= tilesDown; row++) {
        const tileX     = (startTileX + col) * tile + offsetX;
        const tileY     = (startTileY + row) * tile + offsetY;
        const isLight   = (startTileX + col + startTileY + row) % 2 === 0;
        ctx.fillStyle   = isLight ? '#d4c5a9' : '#c0af90';
        ctx.fillRect(tileX, tileY, tile, tile);
      }
    }
  }

  ctx.globalAlpha = 1.0;
}


// =============================================================
// MAP BOUNDARY
// =============================================================

// Draws a dashed rectangle marking the edge of the driveable area.
export function drawMapBoundary(ctx) {
  const params = state.params;
  ctx.save();
  ctx.strokeStyle = 'rgba(80, 80, 80, 0.6)';
  ctx.lineWidth   = 3;
  ctx.setLineDash([20, 12]);
  ctx.strokeRect(0, 0, params.mapWidth, params.mapHeight);
  ctx.setLineDash([]);
  ctx.restore();
}


// =============================================================
// CAR BODY
// =============================================================

// Draws the car as a filled rectangle centred on body.centerX/Y
// and rotated to body.heading. Also draws a windshield strip and
// a heading marker line at the front to show orientation clearly.
//
// The four Verlet wheel particles are physics-only; they are not drawn here.
// The visual rectangle is derived from the body's computed centre and heading.
export function drawCar(ctx) {
  const body    = state.body;
  const engine  = state.engine;

  ctx.save();
  ctx.translate(body.centerX, body.centerY);
  ctx.rotate(body.heading);

  // Drop shadow for depth.
  ctx.shadowColor   = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur    = 8;
  ctx.shadowOffsetX = 3;
  ctx.shadowOffsetY = 3;

  // Car body: yellow rectangle.
  ctx.fillStyle = '#ffd966';
  ctx.fillRect(-CAR_HALF_WIDTH, -CAR_HALF_LENGTH,
               CAR_HALF_WIDTH * 2, CAR_HALF_LENGTH * 2);

  // Clear shadow for subsequent detail elements.
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur  = 0;

  // Windshield strip near the front of the car (light blue-grey tint).
  const windshieldHeight = CAR_HALF_LENGTH * 0.3;
  ctx.fillStyle = 'rgba(140, 195, 230, 0.45)';
  ctx.fillRect(-CAR_HALF_WIDTH + 4, -CAR_HALF_LENGTH,
               CAR_HALF_WIDTH * 2 - 8, windshieldHeight);

  // Heading marker line across the very front edge of the car (red).
  // This makes the car's orientation immediately obvious.
  ctx.strokeStyle = '#c0392b';
  ctx.lineWidth   = 3;
  ctx.lineCap     = 'butt';
  ctx.beginPath();
  ctx.moveTo(-CAR_HALF_WIDTH + 2, -CAR_HALF_LENGTH);
  ctx.lineTo( CAR_HALF_WIDTH - 2, -CAR_HALF_LENGTH);
  ctx.stroke();

  // Car outline to give a clean border.
  ctx.strokeStyle = '#b38f40';
  ctx.lineWidth   = 1.5;
  ctx.strokeRect(-CAR_HALF_WIDTH, -CAR_HALF_LENGTH,
                 CAR_HALF_WIDTH * 2, CAR_HALF_LENGTH * 2);

  // Stall indicator: red tint over the whole car when engine is stalled.
  if (engine.isStalled) {
    ctx.fillStyle = 'rgba(200, 50, 50, 0.25)';
    ctx.fillRect(-CAR_HALF_WIDTH, -CAR_HALF_LENGTH,
                 CAR_HALF_WIDTH * 2, CAR_HALF_LENGTH * 2);
  }

  ctx.restore();
}


// =============================================================
// HUD — STEERING WHEEL
// =============================================================

// Draws a small steering wheel icon in the lower-right corner of the screen.
// The wheel rotates with the visual steering angle.
export function drawSteeringWheelHud(ctx, canvasWidth, canvasHeight) {
  const wheelRadius = 30;
  const marginRight  = 60;
  const marginBottom = 60;
  const centreX = canvasWidth  - marginRight;
  const centreY = canvasHeight - marginBottom;

  ctx.save();
  ctx.translate(centreX, centreY);
  ctx.rotate(state.steering.wheelAngle);

  // Outer ring.
  ctx.beginPath();
  ctx.arc(0, 0, wheelRadius, 0, Math.PI * 2);
  ctx.strokeStyle = '#ccc';
  ctx.lineWidth   = 3;
  ctx.stroke();

  // Crosshair spokes.
  ctx.strokeStyle = '#ccc';
  ctx.lineWidth   = 2;
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI * 0.5) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(angle) * wheelRadius * 0.7, Math.sin(angle) * wheelRadius * 0.7);
    ctx.stroke();
  }

  // Red dot at the 12 o'clock position to show absolute rotation.
  ctx.beginPath();
  ctx.arc(0, -wheelRadius * 0.7, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#e74c3c';
  ctx.fill();

  // Centre hub.
  ctx.beginPath();
  ctx.arc(0, 0, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#aaa';
  ctx.fill();

  ctx.restore();
}


// =============================================================
// HUD — THROTTLE BAR
// =============================================================

// Draws a vertical bar showing current throttle position.
// Full height = 100% throttle. Colour shifts warm as throttle increases.
export function drawThrottleBar(ctx, canvasWidth, canvasHeight) {
  const input  = state.input;
  let throttle = 0;
  if (input.mouseThrottleActive) {
    throttle = input.mouseThrottleAmount;
  } else if (input.throttleKeyHeld) {
    throttle = 1.0;
  }

  const barWidth  = 16;
  const barHeight = 80;
  const marginRight  = 100;
  const marginBottom = 30;
  const barLeft = canvasWidth  - marginRight;
  const barTop  = canvasHeight - marginBottom - barHeight;

  // Background (empty bar).
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.fillRect(barLeft, barTop, barWidth, barHeight);

  // Fill level.
  const fillHeight = barHeight * throttle;
  let barColor;
  if (throttle < 0.5) {
    barColor = `rgb(0, ${Math.round(180 + 60 * throttle * 2)}, ${Math.round(220 * (1 - throttle * 2))})`;
  } else if (throttle < 0.8) {
    const fraction = (throttle - 0.5) / 0.3;
    barColor = `rgb(${Math.round(255 * fraction)}, ${Math.round(240 - 80 * fraction)}, 0)`;
  } else {
    barColor = '#e74c3c';
  }
  ctx.fillStyle = barColor;
  ctx.fillRect(barLeft, barTop + barHeight - fillHeight, barWidth, fillHeight);

  // Border.
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth   = 1;
  ctx.strokeRect(barLeft, barTop, barWidth, barHeight);

  // Label.
  ctx.fillStyle  = 'rgba(255,255,255,0.7)';
  ctx.font       = '10px monospace';
  ctx.textAlign  = 'center';
  ctx.fillText('THR', barLeft + barWidth * 0.5, barTop - 6);
}


// =============================================================
// HUD — BRAKE BAR
// =============================================================

// Draws a vertical bar showing brake pedal state (binary: off / full).
export function drawBrakeBar(ctx, canvasWidth, canvasHeight) {
  const brakeAmount = state.input.brakeKeyHeld ? 1.0 : 0.0;

  const barWidth  = 16;
  const barHeight = 80;
  const marginRight  = 122;  // left of throttle bar
  const marginBottom = 30;
  const barLeft = canvasWidth  - marginRight;
  const barTop  = canvasHeight - marginBottom - barHeight;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.fillRect(barLeft, barTop, barWidth, barHeight);

  const fillHeight = barHeight * brakeAmount;
  ctx.fillStyle = brakeAmount > 0 ? '#e74c3c' : 'rgba(255,255,255,0.1)';
  ctx.fillRect(barLeft, barTop + barHeight - fillHeight, barWidth, fillHeight);

  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth   = 1;
  ctx.strokeRect(barLeft, barTop, barWidth, barHeight);

  ctx.fillStyle  = 'rgba(255,255,255,0.7)';
  ctx.font       = '10px monospace';
  ctx.textAlign  = 'center';
  ctx.fillText('BRK', barLeft + barWidth * 0.5, barTop - 6);
}


// =============================================================
// HUD — CLUTCH BAR
// =============================================================

// Draws a vertical bar showing the clutch pedal position.
// The bite zone is marked with two horizontal lines so the driver can
// see where engagement begins (bottom line) and where it is fully engaged
// (top line). Between the lines is where the car responds to clutch control.
//
// Bar fill from bottom = pedal released (engaged).
// Bar empty = pedal on floor (disengaged).
export function drawClutchBar(ctx, canvasWidth, canvasHeight) {
  const engine    = state.engine;
  const params    = state.params;

  const pedalPosition = engine.clutchPedalPosition; // 0 = floor, 1 = released

  const barWidth  = 16;
  const barHeight = 80;
  const marginRight  = 144; // left of brake bar
  const marginBottom = 30;
  const barLeft = canvasWidth  - marginRight;
  const barTop  = canvasHeight - marginBottom - barHeight;

  // Background.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.fillRect(barLeft, barTop, barWidth, barHeight);

  // Fill: pedal position (0 = bottom = disengaged, 1 = full height = released/engaged).
  const fillHeight = barHeight * pedalPosition;
  ctx.fillStyle = 'rgba(100, 200, 255, 0.7)';
  ctx.fillRect(barLeft, barTop + barHeight - fillHeight, barWidth, fillHeight);

  // Bite zone markers: two horizontal lines showing where grip starts and ends.
  // Bottom line = bitePoint (engagement begins).
  // Top line = bitePoint + biteRange (fully engaged above here).
  const bitePoint     = params.clutchBitePoint;
  const biteRange     = params.clutchBiteRange;
  const biteTopY      = barTop + barHeight * (1 - (bitePoint + biteRange));
  const biteBottomY   = barTop + barHeight * (1 - bitePoint);

  // Yellow zone between the bite lines.
  ctx.fillStyle = 'rgba(255, 220, 0, 0.25)';
  ctx.fillRect(barLeft, biteTopY, barWidth, biteBottomY - biteTopY);

  // Bite zone border lines.
  ctx.strokeStyle = '#f1c40f';
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  ctx.moveTo(barLeft, biteTopY);
  ctx.lineTo(barLeft + barWidth, biteTopY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(barLeft, biteBottomY);
  ctx.lineTo(barLeft + barWidth, biteBottomY);
  ctx.stroke();

  // Bar border.
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth   = 1;
  ctx.strokeRect(barLeft, barTop, barWidth, barHeight);

  // Label.
  ctx.fillStyle  = 'rgba(255,255,255,0.7)';
  ctx.font       = '10px monospace';
  ctx.textAlign  = 'center';
  ctx.fillText('CLT', barLeft + barWidth * 0.5, barTop - 6);
}


// =============================================================
// HUD — GEAR INDICATOR
// =============================================================

// Draws a large character showing the current gear.
// Positioned in the lower-left corner of the screen.
// Colour: green for 1–6, white for Neutral, red for Reverse.
export function drawGearIndicator(ctx, canvasWidth, canvasHeight) {
  const gear        = state.engine.currentGear;
  const isStalled   = state.engine.isStalled;

  let gearColor;
  if (isStalled) {
    gearColor = '#e74c3c'; // red when stalled
  } else if (gear === 'N') {
    gearColor = 'rgba(255,255,255,0.85)';
  } else if (gear === 'R') {
    gearColor = '#e67e22'; // orange for reverse
  } else {
    gearColor = '#2ecc71'; // green for forward gears
  }

  const displayChar = isStalled ? 'STALL' : gear;

  ctx.save();
  ctx.font         = isStalled ? 'bold 20px monospace' : 'bold 52px monospace';
  ctx.fillStyle    = gearColor;
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'bottom';
  // Add a subtle shadow for readability on the checkerboard.
  ctx.shadowColor  = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur   = 4;
  ctx.fillText(displayChar, 20, canvasHeight - 20);
  ctx.restore();
}


// =============================================================
// ANALOG GAUGE
// =============================================================

// Draws a complete analog gauge on a separate canvas context.
// This is the generic gauge renderer used for tachometer, speedometer,
// and any other gauge. Each gauge is independent — a failure here
// affects only that canvas, not the simulation.
//
// config: {
//   value:          current reading (in gauge units)
//   min:            minimum scale value
//   max:            maximum scale value
//   title:          text below the needle pivot
//   subtitle:       smaller text below title (e.g., "km/h")
//   majorStep:      interval between major tick marks with labels
//   minorDivisions: how many minor ticks between each major tick
//   redFrom:        gauge value at which the red zone begins (null = no red zone)
//   needleNormalized: 0–1 normalised position from the needle physics spring
//   labelFormatter: function(value) → string for major tick labels
//   labelFontScale: multiplier for tick label font size (from params.gaugeLabelScale)
// }
export function drawAnalogGauge(ctx, canvasWidth, canvasHeight, config) {
  const {
    value,
    min,
    max,
    title,
    subtitle,
    majorStep,
    minorDivisions,
    redFrom,
    needleNormalized,
    labelFormatter,
    labelFontScale,
  } = config;

  const centreX = canvasWidth  * 0.5;
  const centreY = canvasHeight * 0.55;
  const radius  = Math.min(canvasWidth, canvasHeight) * 0.40;

  // Gauge sweep: from 225° to −45° (clockwise), i.e., 270° of arc.
  const startAngle = (225 / 180) * Math.PI;
  const endAngle   = (-45  / 180) * Math.PI;
  const sweepAngle = Math.PI * 1.5; // 270° in radians

  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // --- Face background ---
  const faceGradient = ctx.createRadialGradient(centreX, centreY, 0, centreX, centreY, radius);
  faceGradient.addColorStop(0, '#f5f0e8');
  faceGradient.addColorStop(1, '#d9c9a8');
  ctx.beginPath();
  ctx.arc(centreX, centreY, radius, 0, Math.PI * 2);
  ctx.fillStyle = faceGradient;
  ctx.fill();

  // Face border.
  ctx.strokeStyle = '#5a4a2a';
  ctx.lineWidth   = 2.5;
  ctx.stroke();

  // --- Red zone ---
  if (redFrom !== null && redFrom < max) {
    const redStartAngle = startAngle + sweepAngle * ((redFrom - min) / (max - min));
    ctx.beginPath();
    ctx.arc(centreX, centreY, radius * 0.85, redStartAngle, endAngle);
    ctx.arc(centreX, centreY, radius * 0.70, endAngle, redStartAngle, true);
    ctx.closePath();
    ctx.fillStyle = 'rgba(200, 40, 40, 0.35)';
    ctx.fill();
  }

  // --- Tick marks and labels ---
  const totalRange = max - min;
  const majorCount = Math.round(totalRange / majorStep);

  for (let major = 0; major <= majorCount; major++) {
    const majorValue = min + major * majorStep;
    const majorAngle = startAngle + sweepAngle * (major / majorCount);

    // Major tick.
    const outerR  = radius * 0.90;
    const innerR  = radius * 0.75;
    const labelR  = radius * 0.60;

    ctx.save();
    ctx.translate(centreX, centreY);
    ctx.rotate(majorAngle);

    ctx.beginPath();
    ctx.moveTo(0, -innerR);
    ctx.lineTo(0, -outerR);
    ctx.strokeStyle = '#3a2a0a';
    ctx.lineWidth   = 2;
    ctx.stroke();

    // Label at major tick.
    ctx.rotate(-majorAngle); // un-rotate for text
    const labelX = Math.cos(majorAngle - Math.PI * 0.5) * labelR;
    const labelY = Math.sin(majorAngle - Math.PI * 0.5) * labelR;
    const fontSize = Math.round(radius * 0.12 * (labelFontScale || 1.0));
    ctx.font       = `${fontSize}px sans-serif`;
    ctx.fillStyle  = '#2a1a00';
    ctx.textAlign  = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelFormatter ? labelFormatter(majorValue) : String(majorValue),
                 labelX, labelY);

    // Minor ticks between major ticks (skip on last major).
    if (major < majorCount && minorDivisions > 1) {
      for (let minor = 1; minor < minorDivisions; minor++) {
        const minorAngle = majorAngle + sweepAngle * (minor / minorDivisions / majorCount);
        ctx.save();
        ctx.rotate(minorAngle);
        ctx.beginPath();
        ctx.moveTo(0, -outerR);
        ctx.lineTo(0, -(outerR - (outerR - innerR) * 0.5));
        ctx.strokeStyle = '#5a4a2a';
        ctx.lineWidth   = 1;
        ctx.stroke();
        ctx.restore();
        ctx.rotate(-minorAngle + majorAngle); // compensate parent rotate
      }
    }

    ctx.restore();
  }

  // --- Needle ---
  const needleAngle = startAngle + sweepAngle * needleNormalized;

  ctx.save();
  ctx.translate(centreX, centreY);
  ctx.rotate(needleAngle);

  // Needle shadow.
  ctx.shadowColor   = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur    = 4;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;

  // Needle body: red, tapers to a point.
  ctx.beginPath();
  ctx.moveTo(-3, 0);
  ctx.lineTo(0, -(radius * 0.80)); // tip
  ctx.lineTo(3, 0);
  ctx.lineTo(0, radius * 0.15);    // tail counterweight
  ctx.closePath();
  ctx.fillStyle = '#c0392b';
  ctx.fill();

  ctx.shadowColor = 'transparent';

  // Pivot cap (circle at centre, covers needle base).
  const pivotGradient = ctx.createRadialGradient(-2, -2, 1, 0, 0, 10);
  pivotGradient.addColorStop(0, '#fff');
  pivotGradient.addColorStop(1, '#888');
  ctx.beginPath();
  ctx.arc(0, 0, 8, 0, Math.PI * 2);
  ctx.fillStyle = pivotGradient;
  ctx.fill();

  ctx.restore();

  // --- Title and subtitle ---
  ctx.fillStyle  = '#2a1a00';
  ctx.textAlign  = 'center';

  const titleFontSize = Math.round(radius * 0.14);
  ctx.font         = `bold ${titleFontSize}px sans-serif`;
  ctx.textBaseline = 'bottom';
  ctx.fillText(title, centreX, centreY + radius * 0.40);

  const subtitleFontSize = Math.round(radius * 0.11);
  ctx.font         = `${subtitleFontSize}px sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillText(subtitle, centreX, centreY + radius * 0.40);

  // --- Vignette: darkened ring around the edge for realism ---
  const vignetteGradient = ctx.createRadialGradient(centreX, centreY, radius * 0.6,
                                                     centreX, centreY, radius);
  vignetteGradient.addColorStop(0, 'rgba(0,0,0,0)');
  vignetteGradient.addColorStop(1, 'rgba(0,0,0,0.15)');
  ctx.beginPath();
  ctx.arc(centreX, centreY, radius, 0, Math.PI * 2);
  ctx.fillStyle = vignetteGradient;
  ctx.fill();
}
