// =============================================================
// MAIN — entry point and game loop
// =============================================================
// Wires all modules together. Owns the requestAnimationFrame loop
// with fixed-timestep physics sub-stepping and variable-rate rendering.
//
// PHYSICS STEP ORDER (enforced here, documented in physics.js):
//   1.  updateSteering(dt)
//   2.  updateEngine(dt)
//   3.  computeBodyDerivedState(dt)
//   4.  computeWeightTransfer()
//   5.  computeTireForces()
//   6.  computeDragForces()
//   7.  computeBrakeForce()
//   8.  combine into net linear + angular acceleration
//   9.  verletIntegrateAllPoints(dt, ...)
//  10.  solveRigidBodyConstraints()
//  11.  clampParticleDisplacements()
//  12.  handleBoundaryCollisions()
//  13.  solveRigidBodyConstraints()  (again after collision)
//  14.  computeBodyDerivedState(dt)  (recompute for camera and render)
//  15.  updateCamera(dt)
//  16.  trail spawn / update
//  17.  updateEngineSound(...)       (no-op stub)
//
// RENDER ORDER (once per animation frame, after all sub-steps):
//   World space (camera transform applied):
//     drawCheckerboard, drawMapBoundary, drawTrailArrows, drawCar
//   Screen space (HUD, no camera transform):
//     drawSteeringWheelHud, drawThrottleBar, drawBrakeBar, drawClutchBar,
//     drawGearIndicator, updateInfoBar
//   Gauge canvases (separate contexts):
//     Tachometer, Speedometer, Lateral-G gauge
// =============================================================

import state from './state.js';
import {
  DEFAULT_MAP_WIDTH_PX,
  DEFAULT_MAP_HEIGHT_PX,
  MAX_FRAME_TIME_SEC,
  MOMENT_OF_INERTIA,
  TACHOMETER_MAX_RPM,
  TACHOMETER_REDLINE_RPM,
  SPEEDOMETER_MAX_KPH,
  KPH_TO_PX_PER_SEC,
} from './constants.js';

import { initInput } from './input.js';

import {
  initializeCarBody,
  updateSteering,
  updateEngine,
  computeBodyDerivedState,
  computeWeightTransfer,
  computeTireForces,
  computeDragForces,
  computeBrakeForce,
  verletIntegrateAllPoints,
  solveRigidBodyConstraints,
  clampParticleDisplacements,
  handleBoundaryCollisions,
  updateCamera,
  updateEngineSound,
} from './physics.js';

import {
  spawnTrailArrow,
  updateTrailArrows,
  drawTrailArrows,
} from './trail.js';

import {
  applyCameraTransform,
  removeCameraTransform,
  drawCheckerboard,
  drawMapBoundary,
  drawCar,
  drawSteeringWheelHud,
  drawThrottleBar,
  drawBrakeBar,
  drawClutchBar,
  drawGearIndicator,
  drawAnalogGauge,
} from './renderer.js';

import { initSliders, updateInfoBar, createNeedlePhysics } from './ui.js';


// =============================================================
// CANVAS SETUP
// =============================================================

// Gets and validates a canvas element by id.
// Throws a descriptive error if the element is missing, which is
// easier to diagnose than a null-dereference error later.
function getCanvas(elementId) {
  const canvas = document.getElementById(elementId);
  if (!canvas) throw new Error(`Canvas element #${elementId} not found in index.html`);
  return canvas;
}

// Applies the resolution scaling to a canvas.
// The canvas internal pixel dimensions are set to (cssWidth × resolutionScale)
// and the context is scaled accordingly. This allows trading render quality
// for performance via the resolution slider without changing layout.
function applyCanvasResolution(canvas, ctx, cssWidth, cssHeight, resolutionScale) {
  canvas.width  = Math.round(cssWidth  * resolutionScale);
  canvas.height = Math.round(cssHeight * resolutionScale);
  ctx.scale(resolutionScale, resolutionScale);
}


// =============================================================
// INITIALISATION
// =============================================================

// Canvases.
const simCanvas   = getCanvas('simCanvas');
const rpmCanvas   = getCanvas('rpmCanvas');
const speedCanvas = getCanvas('speedCanvas');
const latGCanvas  = getCanvas('latGCanvas'); // lateral G gauge (third canvas)

const simCtx   = simCanvas.getContext('2d');
const rpmCtx   = rpmCanvas.getContext('2d');
const speedCtx = speedCanvas.getContext('2d');
const latGCtx  = latGCanvas.getContext('2d');

// Apply initial resolution (1× — sliders are not yet connected).
// main canvas uses CSS size; gauge canvases are fixed size in HTML.
const simCssWidth  = simCanvas.clientWidth  || simCanvas.width;
const simCssHeight = simCanvas.clientHeight || simCanvas.height;

// Attach input listeners before anything else so no events are missed.
initInput(simCanvas);

// Bind HTML sliders to state.params. This reads initial HTML slider values
// into state.params so physics starts with the correct parameters.
initSliders();

// Bind canvas resolution slider (not part of state.params, manual handler).
const canvasResolutionSlider = document.getElementById('canvasResolutionSlider');
const canvasResolutionValue  = document.getElementById('canvasResolutionValue');
if (canvasResolutionSlider) {
  const updateCanvasResolution = () => {
    const scale = parseFloat(canvasResolutionSlider.value);
    canvasResolutionValue.textContent = scale.toFixed(1);
    // Canvas will be resized in renderFrame() when next drawn.
  };
  canvasResolutionSlider.addEventListener('input', updateCanvasResolution);
  updateCanvasResolution();
}

// Create needle physics instances for each gauge.
// These are independent spring-damper systems — one per gauge.
const rpmNeedle  = createNeedlePhysics();
const speedNeedle = createNeedlePhysics();
const latGNeedle  = createNeedlePhysics();

// Place the car in the centre of the default map.
initializeCarBody(DEFAULT_MAP_WIDTH_PX * 0.5, DEFAULT_MAP_HEIGHT_PX * 0.5);

// Initial derivation so body state is valid before the first render.
computeBodyDerivedState(1 / 60);
computeWeightTransfer();


// =============================================================
// GAME LOOP
// =============================================================

// requestAnimationFrame callback. Receives the DOMHighResTimeStamp
// in milliseconds.
function mainLoop(timestampMilliseconds) {
  requestAnimationFrame(mainLoop);

  // Convert timestamp to seconds.
  const timestampSeconds = timestampMilliseconds * 0.001;

  // Calculate raw frame time.
  if (state.loop.previousTimestamp === 0) {
    state.loop.previousTimestamp = timestampSeconds;
  }
  let frameTime = timestampSeconds - state.loop.previousTimestamp;
  state.loop.previousTimestamp = timestampSeconds;

  // Apply time scale (1.0 = normal, 0.5 = half speed, 2.0 = double speed).
  frameTime *= state.params.timeScale;

  // Clamp to prevent spiral of death if the tab was hidden or the frame took too long.
  if (frameTime > MAX_FRAME_TIME_SEC) frameTime = MAX_FRAME_TIME_SEC;

  // Fixed physics timestep.
  const physicsFixedDt = 1.0 / state.params.simulationFps;

  state.loop.accumulator += frameTime;

  // Physics sub-steps: run as many fixed-dt steps as the accumulated time allows.
  while (state.loop.accumulator >= physicsFixedDt) {
    runPhysicsStep(physicsFixedDt);
    state.loop.accumulator -= physicsFixedDt;
  }

  // Render once per animation frame (no interpolation).
  renderFrame();
}


// =============================================================
// ONE PHYSICS SUB-STEP
// =============================================================

// Runs a single fixed-dt physics sub-step in the mandatory call order.
// dt is in seconds.
function runPhysicsStep(dt) {
  // 1. Update steering: maps visual wheel angle → front tyre lock angle,
  //    applies self-centring.
  updateSteering(dt);

  // 2. Update engine: advances clutch pedal position, computes clutch
  //    engagement from pedal, updates RPM for the current clutch zone,
  //    checks for stall.
  updateEngine(dt);

  // 3. Derive body state: centre, heading, velocity, angular velocity,
  //    longitudinal and lateral accelerations. Must run before anything
  //    that reads from state.body.
  computeBodyDerivedState(dt);

  // 4. Weight transfer: distributes normal load to each wheel based on
  //    the body's longitudinal and lateral accelerations.
  computeWeightTransfer();

  // 5–7. Compute all forces.
  const tireForces  = computeTireForces();   // { forceX, forceY, torque }
  const dragForces  = computeDragForces();   // { forceX, forceY }
  const brakeForces = computeBrakeForce();   // { forceX, forceY }

  // 8. Sum forces into net values.
  const netForceX  = tireForces.forceX + dragForces.forceX + brakeForces.forceX;
  const netForceY  = tireForces.forceY + dragForces.forceY + brakeForces.forceY;
  const netTorque  = tireForces.torque;

  // 9. Convert to accelerations (F = ma → a = F/m; τ = Iα → α = τ/I).
  const massKg            = state.params.carMassKg;
  const netLinearAccelX   = netForceX / massKg;
  const netLinearAccelY   = netForceY / massKg;
  const netAngularAccel   = netTorque  / MOMENT_OF_INERTIA;

  // 10. Verlet integration: advance all four wheel positions using the
  //     computed linear and angular accelerations.
  verletIntegrateAllPoints(dt, netLinearAccelX, netLinearAccelY, netAngularAccel);

  // 11. Constraint solver pass 1: restore rigid body distances after integration.
  solveRigidBodyConstraints();

  // 12. Anti-tunnelling: clamp any particle that moved too far in one step.
  clampParticleDisplacements();

  // 13. Boundary collisions: bounce particles off map walls.
  handleBoundaryCollisions();

  // 14. Constraint solver pass 2: restore rigidity after collision response.
  //     Without this second pass, a corner hitting a wall can stretch the body.
  solveRigidBodyConstraints();

  // 15. Recompute derived state after integration and collision resolution.
  //     This ensures the camera and renderer read the final, correct values.
  computeBodyDerivedState(dt);

  // 16. Camera: spring-damper follow of body centre, speed-based zoom.
  updateCamera(dt);

  // 17. Trail: spawn arrows at the spawn interval; age and cull existing ones.
  state.trail.spawnAccumulator += dt;
  if (state.trail.spawnAccumulator >= state.params.trailSpawnInterval) {
    state.trail.spawnAccumulator -= state.params.trailSpawnInterval;
    spawnTrailArrow();
  }
  updateTrailArrows(dt);

  // 18. Audio stub: update engine sound with current RPM and throttle.
  let throttleAmount = 0;
  if (state.input.mouseThrottleActive) {
    throttleAmount = state.input.mouseThrottleAmount;
  } else if (state.input.throttleKeyHeld) {
    throttleAmount = 1.0;
  }
  updateEngineSound(state.engine.rpm, TACHOMETER_MAX_RPM, throttleAmount);
}


// =============================================================
// HELPER: Canvas Resolution Scale
// =============================================================

// Get current canvas resolution scale from the slider (0.5 to 2.0).
function getCanvasResolutionScale() {
  if (canvasResolutionSlider) {
    return parseFloat(canvasResolutionSlider.value);
  }
  return 1.0;
}


// =============================================================
// RENDER FRAME
// =============================================================

// Draws one complete frame. Called once per animation frame regardless
// of how many physics sub-steps ran this frame.
function renderFrame() {
  const cssWidth  = simCanvas.clientWidth  || simCanvas.width;
  const cssHeight = simCanvas.clientHeight || simCanvas.height;
  const resolutionScale = getCanvasResolutionScale();

  // Scale canvas buffer by resolution slider (0.5× to 2.0×).
  // This trades render quality for performance.
  const canvasWidth  = Math.round(cssWidth  * resolutionScale);
  const canvasHeight = Math.round(cssHeight * resolutionScale);

  // Match canvas buffer size to scaled size.
  if (simCanvas.width  !== canvasWidth  ||
      simCanvas.height !== canvasHeight) {
    simCanvas.width  = canvasWidth;
    simCanvas.height = canvasHeight;
  }

  // --- World space (camera transform active) ---
  simCtx.clearRect(0, 0, canvasWidth, canvasHeight);
  applyCameraTransform(simCtx, canvasWidth, canvasHeight);
  drawCheckerboard(simCtx, canvasWidth, canvasHeight);
  drawMapBoundary(simCtx);
  drawTrailArrows(simCtx);
  drawCar(simCtx);
  removeCameraTransform(simCtx);

  // --- Screen space (HUD, no camera transform) ---
  drawSteeringWheelHud(simCtx, canvasWidth, canvasHeight);
  drawThrottleBar(simCtx, canvasWidth, canvasHeight);
  drawBrakeBar(simCtx, canvasWidth, canvasHeight);
  drawClutchBar(simCtx, canvasWidth, canvasHeight);
  drawGearIndicator(simCtx, canvasWidth, canvasHeight);

  // Info bar text.
  updateInfoBar();

  // --- Gauge canvases ---
  drawGauges();
}


// Draws all three analog gauge canvases.
// Each gauge is drawn independently so a bug in one cannot break the others.
function drawGauges() {
  const labelFontScale = state.params.gaugeLabelScale;

  // Tachometer: 0–7000 RPM, redline at 6500.
  const rpmNormalized = rpmNeedle.step(
    state.engine.isStalled || !state.engine.isRunning
      ? 0
      : state.engine.rpm / TACHOMETER_MAX_RPM
  );
  drawAnalogGauge(rpmCtx, rpmCanvas.width, rpmCanvas.height, {
    value:           state.engine.rpm,
    min:             0,
    max:             TACHOMETER_MAX_RPM,
    title:           'RPM',
    subtitle:        '× 1000',
    majorStep:       1000,
    minorDivisions:  5,
    redFrom:         TACHOMETER_REDLINE_RPM,
    needleNormalized: rpmNormalized,
    labelFormatter:  (v) => String(v / 1000),
    labelFontScale,
  });

  // Speedometer: 0–200 km/h.
  const speedKph       = state.body.speed / KPH_TO_PX_PER_SEC;
  const speedNormalized = speedNeedle.step(speedKph / SPEEDOMETER_MAX_KPH);
  drawAnalogGauge(speedCtx, speedCanvas.width, speedCanvas.height, {
    value:           speedKph,
    min:             0,
    max:             SPEEDOMETER_MAX_KPH,
    title:           'SPEED',
    subtitle:        'km/h',
    majorStep:       20,
    minorDivisions:  4,
    redFrom:         null,
    needleNormalized: speedNormalized,
    labelFormatter:  (v) => String(Math.round(v)),
    labelFontScale,
  });

  // Lateral G gauge: 0–1.5 G (shows cornering intensity).
  // Computed from state.body.lateralAccel in px/s² → converted to G.
  const lateralG       = Math.abs(state.body.lateralAccel) / (9.8 * 10); // px/s² ÷ (g × px/m)
  const lateralGMax    = 1.5;
  const latGNormalized = latGNeedle.step(lateralG / lateralGMax);
  drawAnalogGauge(latGCtx, latGCanvas.width, latGCanvas.height, {
    value:           lateralG,
    min:             0,
    max:             lateralGMax,
    title:           'LAT G',
    subtitle:        'g-force',
    majorStep:       0.5,
    minorDivisions:  5,
    redFrom:         1.0,
    needleNormalized: latGNormalized,
    labelFormatter:  (v) => v.toFixed(1),
    labelFontScale,
  });
}


// =============================================================
// START
// =============================================================

// Kick off the game loop.
requestAnimationFrame(mainLoop);
