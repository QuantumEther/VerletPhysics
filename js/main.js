// =============================================================
// MAIN — entry point and game loop
// =============================================================
// Wires all modules together. Owns the requestAnimationFrame
// loop with fixed-timestep physics sub-stepping and variable-
// rate rendering.
//
// Render pipeline:
//   1. Apply canvas resolution
//   2. Apply camera transform (world space begins)
//   3. Draw checkerboard background (with motion blur)
//   4. Draw map boundary walls
//   5. Draw trail arrows
//   6. Draw ball (with motion blur)
//   7. Remove camera transform (screen space begins)
//   8. Draw HUD elements (steering wheel, throttle bar)
//   9. Draw analog gauges (separate canvases)
// =============================================================

import state from './state.js';
import { MAX_SPEED_GAUGE, REDLINE_RPM, MAX_TEMP_CELSIUS, NORMAL_TEMP_CELSIUS } from './constants.js';
import { initInput } from './input.js';
import {
  updateHeadingAndSteering,
  updateEngine,
  computeAcceleration,
  verletStep,
  clampDisplacement,
  handleBoundaryCollisions,
  cacheVelocity,
  updateRollingOrientation,
  updateCamera,
} from './physics.js';
import { spawnTrailArrow, updateTrailArrows, drawTrailArrows } from './trail.js';
import {
  applyCameraTransform,
  removeCameraTransform,
  drawCheckerboard,
  drawMapBoundary,
  drawBall,
  drawSteeringWheel,
  drawThrottleBar,
  drawAnalogGauge,
} from './renderer.js';
import { initSliders, updateInfoBar, createNeedlePhysics } from './ui.js';


// =============================================================
// INITIALIZATION
// =============================================================

const simCanvas = document.getElementById('simCanvas');
const simCtx = simCanvas.getContext('2d');
const speedCanvas = document.getElementById('speedCanvas');
const speedCtx = speedCanvas.getContext('2d');
const rpmCanvas = document.getElementById('rpmCanvas');
const rpmCtx = rpmCanvas.getContext('2d');
const heatCanvas = document.getElementById('heatCanvas');
const heatCtx = heatCanvas.getContext('2d');

initInput(simCanvas);
initSliders();

const speedNeedle = createNeedlePhysics();
const rpmNeedle = createNeedlePhysics();
const heatNeedle = createNeedlePhysics();

// =============================================================
// PHYSICS WORLD / VIEWPORT
// =============================================================
// The viewport (what you see on screen) is the CSS size of simCanvas.
// The world (map) can be much larger, defined by state.params.mapWidth/mapHeight.
// The camera follows the ball within the world.
// =============================================================

let viewportWidth = simCanvas.offsetWidth;
let viewportHeight = simCanvas.offsetHeight;

/**
 * Center the ball and camera in the world at startup.
 */
function initializePositions() {
  const cx = state.params.mapWidth / 2;
  const cy = state.params.mapHeight / 2;

  // Ball starts at world center
  state.ball.x = cx;
  state.ball.y = cy;
  state.ball.prevX = cx;
  state.ball.prevY = cy;

  // Camera starts on ball
  state.camera.x = cx;
  state.camera.y = cy;
  state.camera.prevX = cx;
  state.camera.prevY = cy;
}

initializePositions();


// =============================================================
// CANVAS RESOLUTION HELPER
// =============================================================

function applyCanvasResolution(canvas, context, resolution) {
  const displayWidth = canvas.offsetWidth;
  const displayHeight = canvas.offsetHeight;

  viewportWidth = displayWidth;
  viewportHeight = displayHeight;

  canvas.width = Math.round(displayWidth * resolution);
  canvas.height = Math.round(displayHeight * resolution);

  context.scale(resolution, resolution);

  return { width: displayWidth, height: displayHeight };
}


// =============================================================
// GAME LOOP
// =============================================================

function mainLoop(currentTimestamp) {
  requestAnimationFrame(mainLoop);

  const loop = state.loop;
  const params = state.params;

  if (!loop.previousTimestamp) {
    loop.previousTimestamp = currentTimestamp;
    return;
  }

  let frameTime = (currentTimestamp - loop.previousTimestamp) / 1000;
  if (frameTime > 0.25) frameTime = 0.25;
  loop.previousTimestamp = currentTimestamp;

  loop.accumulator += frameTime * params.timeScale;
  const dt = 1 / params.simulationFPS;

  // ---- Fixed-timestep physics sub-steps ----
  while (loop.accumulator >= dt) {
    // 1. Heading from steering input
    updateHeadingAndSteering(dt);

    // 2. Full engine/drivetrain update (RPM, temperature, clutch, stall)
    updateEngine(dt);

    // 3. Compute drive force + braking acceleration
    const acceleration = computeAcceleration(dt);

    // 4. Verlet position integration
    verletStep(dt, acceleration);

    // 5. Prevent wall tunneling
    clampDisplacement();

    // 6. Boundary collisions (uses mapWidth/mapHeight from state.params)
    handleBoundaryCollisions(dt);

    // 7. Cache velocity
    cacheVelocity(dt);

    // 8. Rolling orientation (cosmetic)
    updateRollingOrientation(dt);

    // 9. Camera tracking (Verlet-based with zoom)
    updateCamera(dt);

    // 10. Trail: spawn arrows at configured interval
    state.trail.spawnAccumulator += dt;
    while (state.trail.spawnAccumulator >= params.trailSpawnInterval) {
      spawnTrailArrow();
      state.trail.spawnAccumulator -= params.trailSpawnInterval;
    }
    updateTrailArrows(dt);

    loop.accumulator -= dt;
  }


  // ---- RENDER ----

  // Apply canvas resolution scaling
  const displayDims = applyCanvasResolution(simCanvas, simCtx, params.canvasResolution);

  // Clear canvas
  simCtx.clearRect(0, 0, displayDims.width, displayDims.height);

  // ---- WORLD SPACE (camera transform active) ----
  applyCameraTransform(simCtx, displayDims.width, displayDims.height);

  drawCheckerboard(simCtx, displayDims.width, displayDims.height);
  drawMapBoundary(simCtx);
  drawTrailArrows(simCtx);
  drawBall(simCtx);

  removeCameraTransform(simCtx);

  // ---- SCREEN SPACE (HUD elements) ----
  drawSteeringWheel(simCtx, displayDims.width, displayDims.height);
  drawThrottleBar(simCtx, displayDims.width, displayDims.height);

  // Update info bar
  updateInfoBar();

  // ---- GAUGE RENDERING ----
  const speed = Math.hypot(state.velocity.x, state.velocity.y);
  const speedNormalized = Math.min(speed / MAX_SPEED_GAUGE, 1);
  const speedNeedleValue = speedNeedle.step(speedNormalized);

  const rpmNormalized = (!state.engine.isRunning || state.engine.isStalled)
    ? 0
    : Math.min(state.engine.rpm / REDLINE_RPM, 1);
  const rpmNeedleValue = rpmNeedle.step(rpmNormalized);

  // Heat gauge: normalize within gauge range 60–130°C
  const heatGaugeMin = 60;
  const heatGaugeMax = 130;
  const heatNormalized = Math.max(0, Math.min(1,
    (state.engine.temperatureCelsius - heatGaugeMin) / (heatGaugeMax - heatGaugeMin)
  ));
  const heatNeedleValue = heatNeedle.step(heatNormalized);

  const labelScale = params.gaugeLabelScale;

  // Speedometer
  drawAnalogGauge(speedCtx, speedCanvas.width, speedCanvas.height, {
    value: speedNeedleValue * MAX_SPEED_GAUGE,
    min: 0,
    max: MAX_SPEED_GAUGE,
    title: 'SPEED',
    subtitle: 'VELOCITY',
    unitRight: 'px/s',
    majorStep: 100,
    minorDiv: 4,
    redFrom: 600,
    labelFormatter: (v) => String(Math.round(v)),
    labelFontScale: labelScale,
  });

  // RPM gauge
  drawAnalogGauge(rpmCtx, rpmCanvas.width, rpmCanvas.height, {
    value: rpmNeedleValue * REDLINE_RPM,
    min: 0,
    max: 8000,
    title: 'RPM',
    subtitle: 'ENGINE',
    unitRight: 'x1000',
    majorStep: 1000,
    minorDiv: 5,
    redFrom: 7000,
    labelFormatter: (v) => String(Math.round(v / 1000)),
    labelFontScale: labelScale,
  });

  // Heat gauge
  const heatDisplayValue = heatGaugeMin + heatNeedleValue * (heatGaugeMax - heatGaugeMin);
  drawAnalogGauge(heatCtx, heatCanvas.width, heatCanvas.height, {
    value: heatDisplayValue,
    min: heatGaugeMin,
    max: heatGaugeMax,
    title: 'TEMP',
    subtitle: 'HEAT',
    unitRight: '°C',
    majorStep: 10,
    minorDiv: 2,
    redFrom: MAX_TEMP_CELSIUS,
    labelFormatter: (v) => String(Math.round(v)),
    labelFontScale: labelScale,
  });
}

requestAnimationFrame(mainLoop);
