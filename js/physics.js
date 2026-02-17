// =============================================================
// PHYSICS — Verlet integration, bicycle-model steering, engine,
//           drivetrain with torque-based model, camera tracking
// =============================================================
//
// DRIVETRAIN MODEL (v9 — correct torque-based):
//
//   The throttle pedal controls AIRFLOW → ENGINE TORQUE.
//   Engine torque goes through the gearbox and becomes WHEEL FORCE.
//   Wheel force accelerates the car. The car's speed feeds back
//   through the drivetrain to determine ENGINE RPM.
//
//   When clutch is locked: RPM = speed × 60 / wheelCirc × gear × final
//   This is a rigid mechanical connection — no blending, no syncing.
//   RPM is an OUTPUT of the system, not an input.
//
//   Speed is limited per gear because at REDLINE the engine
//   produces no more torque. No artificial speed cap needed.
//
//   Drag uses rolling resistance (constant) + aerodynamic drag (v²),
//   not exponential Verlet damping. The linearFriction slider
//   controls the rolling resistance magnitude.
//
// Call order per physics step (enforced by main.js):
//   1. updateHeadingAndSteering(dt)
//   2. updateEngine(dt)
//   3. computeAcceleration(dt)
//   4. verletStep(dt, accel)
//   5. clampDisplacement()
//   6. handleBoundaryCollisions(dt)
//   7. cacheVelocity(dt)
//   8. updateRollingOrientation(dt)
//   9. updateCamera(dt)
// =============================================================

import state from './state.js';
import {
  BALL_RADIUS,
  MAX_DISPLACEMENT_PER_STEP,
  BRAKE_FORCE,
  IDLE_RPM,
  REDLINE_RPM,
  STEERING_RETURN_SPEED,
  GEAR_RATIOS,
  FINAL_DRIVE_RATIO,
  IDLE_CREEP_FORCE,
  REV_MATCH_BLIP_DURATION,
  STALL_RPM_THRESHOLD,
  ENGINE_BRAKING_COEFFICIENT,
  REFERENCE_SPEED,
  TAU,
  NORMAL_TEMP_CELSIUS,
  MAX_TEMP_CELSIUS,
  COLD_START_TEMP,
  CAMERA_MIN_ZOOM,
  CAMERA_MAX_ZOOM,
  CAMERA_ZOOM_SPEED_THRESHOLD,
} from './constants.js';


// Aerodynamic drag coefficient.
// Tuned so top speed in 6th at redline ≈ 670 px/s with default force.
const AERO_DRAG_COEFF = 0.00005;

// Engine torque peak RPM (where the engine is most efficient).
const TORQUE_PEAK_RPM = 4500;


// =============================================================
// ENGINE TORQUE CURVE
// =============================================================
// Returns normalized torque [0, 1] at a given RPM.
// Shape: parabolic peak at TORQUE_PEAK_RPM.
//   idle (800):   ~34%  — engine is lazy at low RPM
//   4500 RPM:     100%  — torque peak
//   redline (8000): ~41% — falling off but still usable
// =============================================================

function torqueCurveNormalized(rpm) {
  const rpmRange = REDLINE_RPM - IDLE_RPM;
  const distanceFromPeak = (rpm - TORQUE_PEAK_RPM) / rpmRange;
  return Math.max(0, 1.0 - 2.5 * distanceFromPeak * distanceFromPeak);
}


// ---- Clutch helpers ----

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function clutchTransferFactor(rawEngagement, params) {
  const bite  = clamp01(params.clutchBitePoint);
  const range = Math.max(0.001, params.clutchBiteRange);
  const shaped = smoothstep(bite, bite + range, rawEngagement);
  const curve  = Math.max(1.0, params.clutchCurve);
  return Math.pow(shaped, curve);
}


// ---- RPM from wheel speed (rigid drivetrain coupling) ----

function rpmFromSpeed(speed, gearRatio) {
  const absGear = Math.abs(gearRatio);
  if (absGear < 0.001) return IDLE_RPM;
  const wheelCircumference = 2 * Math.PI * state.params.wheelRadius;
  const wheelRPM = (speed * 60) / wheelCircumference;
  return wheelRPM * absGear * FINAL_DRIVE_RATIO;
}


// =============================================================
// 1. HEADING + STEERING
// =============================================================

export function updateHeadingAndSteering(dt) {
  const steering = state.steering;
  const params = state.params;

  if (!steering.isDragging) {
    const returnAmount = STEERING_RETURN_SPEED * dt;
    if (Math.abs(steering.wheelAngle) < returnAmount) {
      steering.wheelAngle = 0;
    } else {
      steering.wheelAngle -= Math.sign(steering.wheelAngle) * returnAmount;
    }
  }

  const speed = Math.hypot(state.velocity.x, state.velocity.y);
  const normalizedSpeed = speed / REFERENCE_SPEED;
  const headingChangeRate = steering.wheelAngle * params.turnRateCoefficient * normalizedSpeed;
  state.carHeading += headingChangeRate * dt;

  state.carHeading += state.spinVelocity * dt;
  state.spinVelocity *= Math.exp(-params.angularFriction * dt);
  state.carHeading = ((state.carHeading % TAU) + TAU) % TAU;
}


// =============================================================
// 2. ENGINE UPDATE (torque-based — RPM from wheels)
// =============================================================

export function updateEngine(dt) {
  const params = state.params;
  const input  = state.input;
  const engine = state.engine;

  if (!engine.isRunning) {
    engine.rpm = 0;
    return;
  }

  const speed = Math.hypot(state.velocity.x, state.velocity.y);

  // ---- Clutch pedal transition ----
  const clutchTarget = input.clutchPressed ? 0.0 : 1.0;
  const clutchTime = Math.max(0.05, params.clutchEngagementTime);
  const clutchRate = 1.0 / clutchTime;
  if (engine.clutchEngagement < clutchTarget) {
    engine.clutchEngagement = Math.min(clutchTarget, engine.clutchEngagement + clutchRate * dt);
  } else if (engine.clutchEngagement > clutchTarget) {
    engine.clutchEngagement = Math.max(clutchTarget, engine.clutchEngagement - clutchRate * dt);
  }

  // ---- Throttle pedal position ----
  let throttleAmount = 0.0;
  if (input.mouseThrottleActive) {
    throttleAmount = input.mouseThrottleAmount;
  } else if (input.throttlePressed) {
    throttleAmount = 1.0;
  }

  // ---- Stall recovery ----
  if (engine.isStalled) {
    if (throttleAmount > 0.1 && engine.clutchEngagement < 0.3) {
      engine.isStalled = false;
      engine.rpm = IDLE_RPM;
    } else {
      engine.rpm = 0;
      return;
    }
  }

  // ---- Compute RPM ----
  const gearRatio = GEAR_RATIOS[engine.currentGear] || 0;
  const absGearRatio = Math.abs(gearRatio);
  const effectiveClutch = clutchTransferFactor(engine.clutchEngagement, params);
  const wheelDemandedRPM = rpmFromSpeed(speed, gearRatio);
  const freeTargetRPM = IDLE_RPM + throttleAmount * (REDLINE_RPM - IDLE_RPM);
  const freeRate = throttleAmount > 0.01 ? params.throttleRise : params.throttleFall;

  if (effectiveClutch > 0.99 && absGearRatio > 0.001) {
    // CLUTCH LOCKED — rigid coupling.
    // RPM is computed from wheel speed through the drivetrain.
    engine.rpm = wheelDemandedRPM;

    if (engine.revMatchTimer > 0) engine.revMatchTimer -= dt;

    // ---- STALL CHECK ----
    // A real engine stalls when the drivetrain load overwhelms
    // the engine's ability to maintain idle. This depends on:
    //   - How low the RPM is (lower = closer to stalling)
    //   - The gear ratio (higher gear = more load at low speed)
    //   - Engine power (strong engines resist stalling)
    //   - Whether the driver is giving throttle
    //
    // stallResistance (0–1) models flywheel inertia and idle torque:
    //   0.0 = tiny engine, stalls in 1st if you dump clutch at standstill
    //   0.5 = normal car, can launch in 1st easily, 3rd is tricky
    //   1.0 = powerful engine, can launch in 3rd gear without stalling
    //
    // The stall threshold scales inversely with stallResistance and gear ratio.
    // In 1st gear (ratio 3.5), the engine has a lot of mechanical advantage
    // so it's harder to stall. In 6th gear (ratio 0.8), very easy to stall.
    const resistanceFactor = 0.1 + 0.9 * params.stallResistance;
    const gearAdvantage = absGearRatio / 3.5; // normalized: 1st=1.0, 6th=0.23
    const effectiveStallThreshold = STALL_RPM_THRESHOLD / (resistanceFactor * (0.3 + 0.7 * gearAdvantage));

    // Don't stall if driver is giving throttle — engine fights harder
    const throttleProtection = throttleAmount > 0.1 ? 0.5 : 1.0;

    if (engine.rpm < effectiveStallThreshold * throttleProtection && speed < 5) {
      engine.isStalled = true;
      engine.rpm = 0;
      return;
    }

    // At very low RPM (below idle), the engine bogs but doesn't stall.
    // Clamp RPM to idle — the engine fights to stay alive.
    // This is what lets you launch: wheel-demanded RPM is 0, but
    // the engine maintains idle and pushes the car through torque.
    if (engine.rpm < IDLE_RPM) {
      engine.rpm = IDLE_RPM;
    }

  } else if (effectiveClutch > 0.001 && absGearRatio > 0.001) {
    // CLUTCH SLIPPING — blend between free-rev and wheel demand.
    // This is the normal launch state: clutch partially engaged,
    // engine free-revs higher than wheel speed, torque transfers
    // through the slipping clutch.
    const freeRPM = engine.rpm + (freeTargetRPM - engine.rpm) * freeRate;
    engine.rpm = freeRPM * (1.0 - effectiveClutch) + wheelDemandedRPM * effectiveClutch;

    // Stall during engagement (only if engine can't maintain idle)
    const resistanceFactor = 0.1 + 0.9 * params.stallResistance;
    if (engine.rpm < STALL_RPM_THRESHOLD / resistanceFactor && effectiveClutch > 0.7 && speed < 5 && throttleAmount < 0.1) {
      engine.isStalled = true;
      engine.rpm = 0;
      return;
    }

  } else {
    // CLUTCH OUT or NEUTRAL — free revving with inertia
    engine.rpm += (freeTargetRPM - engine.rpm) * freeRate;

    if (engine.revMatchTimer > 0) {
      engine.revMatchTimer -= dt;
      engine.rpm += (engine.revMatchTargetRPM - engine.rpm) * 0.3;
    }
  }

  engine.rpm = Math.max(IDLE_RPM, Math.min(REDLINE_RPM, engine.rpm));

  // Temperature
  updateEngineTemperature(dt, throttleAmount, effectiveClutch, speed);

  // Overheat
  if (engine.temperatureCelsius > MAX_TEMP_CELSIUS) {
    const overheatAmount = engine.temperatureCelsius - MAX_TEMP_CELSIUS;
    const penaltyRatio = Math.min(1.0, overheatAmount / (MAX_TEMP_CELSIUS * 0.2));
    if (Math.random() < penaltyRatio * 0.15) {
      engine.rpm = Math.max(IDLE_RPM, engine.rpm - 500 - Math.random() * 1500 * penaltyRatio);
    }
  }
}


function updateEngineTemperature(dt, throttleAmount, effectiveClutch, speed) {
  const engine = state.engine;
  const params = state.params;
  const ambient = 25;
  const rpmNorm = clamp01((engine.rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM));
  const speedNorm = clamp01(speed / 800);

  const load = rpmNorm * rpmNorm * (0.25 + 0.75 * throttleAmount) * (0.35 + 0.65 * effectiveClutch);
  const towardNormal = (NORMAL_TEMP_CELSIUS - engine.temperatureCelsius) * 0.90;
  const loadHeat = params.heatGenerationRate * load;
  const deltaToAmbient = Math.max(0, engine.temperatureCelsius - ambient);
  const cooling = params.heatDissipationRate * (0.30 + 1.20 * speedNorm)
                  * (deltaToAmbient / (MAX_TEMP_CELSIUS - ambient));

  engine.temperatureCelsius += (towardNormal + loadHeat - cooling) * dt;
  engine.temperatureCelsius = Math.max(ambient, Math.min(MAX_TEMP_CELSIUS * 1.25, engine.temperatureCelsius));
}


// =============================================================
// 3. ACCELERATION (torque → wheel force, with drag)
// =============================================================

export function computeAcceleration(dt) {
  const params = state.params;
  const input = state.input;
  const engine = state.engine;
  const speed = Math.hypot(state.velocity.x, state.velocity.y);

  // ---- Drag (always active, even with engine off) ----
  let dragAccelMagnitude = 0;
  if (speed > 0.5) {
    // Rolling resistance: linearFriction × 3 gives px/s² decel.
    // 0 = ice, 2.0 (default) = normal road (6 px/s²), 5.0 = deep gravel
    const rollingResistance = params.linearFriction * 3.0;
    const aeroDrag = AERO_DRAG_COEFF * speed * speed;
    dragAccelMagnitude = rollingResistance + aeroDrag;
  }

  if (engine.isStalled || !engine.isRunning) {
    if (speed < 0.5) return { x: 0, y: 0 };
    return {
      x: (-state.velocity.x / speed) * dragAccelMagnitude,
      y: (-state.velocity.y / speed) * dragAccelMagnitude,
    };
  }

  const gearRatio = GEAR_RATIOS[engine.currentGear] || 0;
  const absGearRatio = Math.abs(gearRatio);
  const effectiveClutch = clutchTransferFactor(engine.clutchEngagement, params);

  // Cold start penalty
  let coldStartMultiplier = 1.0;
  if (engine.temperatureCelsius < NORMAL_TEMP_CELSIUS) {
    const coldRatio = (engine.temperatureCelsius - COLD_START_TEMP)
                    / (NORMAL_TEMP_CELSIUS - COLD_START_TEMP);
    coldStartMultiplier = 0.5 + 0.5 * clamp01(coldRatio);
  }

  // Throttle
  let throttleAmount = 0.0;
  if (input.mouseThrottleActive) {
    throttleAmount = input.mouseThrottleAmount;
  } else if (input.throttlePressed) {
    throttleAmount = 1.0;
  }

  // ---- Engine torque → wheel force ----
  let driveAccelMagnitude = 0;

  if (absGearRatio > 0.001 && effectiveClutch > 0.001) {
    // Peak torque from slider: 200–2000 → 12.5–125 torque units
    const peakTorque = params.forceMagnitude / 16.0;
    const torqueFromCurve = torqueCurveNormalized(engine.rpm);
    const engineTorque = peakTorque * torqueFromCurve * throttleAmount * coldStartMultiplier;
    const wheelForce = engineTorque * absGearRatio * FINAL_DRIVE_RATIO / state.params.wheelRadius;
    driveAccelMagnitude = (wheelForce / params.ballMass) * effectiveClutch;

    // Idle creep
    if (throttleAmount < 0.05 && speed < 50 && engine.rpm <= IDLE_RPM + 200) {
      const creepAccel = (IDLE_CREEP_FORCE * absGearRatio * effectiveClutch) / params.ballMass;
      driveAccelMagnitude = Math.max(driveAccelMagnitude, creepAccel);
    }

    // Engine braking (compression resistance when coasting in gear)
    if (throttleAmount < 0.1 && speed > 5 && engine.rpm > IDLE_RPM + 100) {
      const rpmAboveIdle = (engine.rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM);
      const engineBraking = rpmAboveIdle * ENGINE_BRAKING_COEFFICIENT
                          * peakTorque * absGearRatio * FINAL_DRIVE_RATIO
                          / state.params.wheelRadius / params.ballMass * effectiveClutch;
      dragAccelMagnitude += engineBraking;
    }
  }

  // ---- Compose forces ----
  const forwardX = Math.cos(state.carHeading);
  const forwardY = Math.sin(state.carHeading);
  const directionSign = (gearRatio >= 0) ? 1 : -1;

  // Drive: along heading
  let ax = directionSign * forwardX * driveAccelMagnitude;
  let ay = directionSign * forwardY * driveAccelMagnitude;

  // Drag: opposes velocity
  if (speed > 0.5) {
    ax += (-state.velocity.x / speed) * dragAccelMagnitude;
    ay += (-state.velocity.y / speed) * dragAccelMagnitude;
  }

  // Brake: opposes velocity
  if (input.brakePressed && speed > 0.1) {
    ax += (-state.velocity.x / speed) * BRAKE_FORCE / params.ballMass;
    ay += (-state.velocity.y / speed) * BRAKE_FORCE / params.ballMass;
  }

  return { x: ax, y: ay };
}


// =============================================================
// 4. VERLET INTEGRATION (pure — no damping)
// =============================================================
// All friction/drag is in computeAcceleration. The integrator
// is now pure Verlet: x_new = x + (x - x_prev) + a × dt²
// =============================================================

export function verletStep(dt, acceleration) {
  const ball = state.ball;
  const newX = ball.x + (ball.x - ball.prevX) + acceleration.x * dt * dt;
  const newY = ball.y + (ball.y - ball.prevY) + acceleration.y * dt * dt;
  ball.prevX = ball.x;
  ball.prevY = ball.y;
  ball.x = newX;
  ball.y = newY;
}


// =============================================================
// 5. DISPLACEMENT CLAMPING
// =============================================================

export function clampDisplacement() {
  const ball = state.ball;
  const deltaX = ball.x - ball.prevX;
  const deltaY = ball.y - ball.prevY;
  const distance = Math.hypot(deltaX, deltaY);

  if (distance > MAX_DISPLACEMENT_PER_STEP) {
    const scale = MAX_DISPLACEMENT_PER_STEP / distance;
    ball.x = ball.prevX + deltaX * scale;
    ball.y = ball.prevY + deltaY * scale;
  }
}


// =============================================================
// 6. BOUNDARY COLLISIONS + SPIN GENERATION
// =============================================================

export function handleBoundaryCollisions(dt) {
  const ball = state.ball;
  const mapWidth = state.params.mapWidth;
  const mapHeight = state.params.mapHeight;
  const cor = state.params.bounciness;
  const grip = state.params.wallGripCoefficient;
  let collidedAny = false;

  const velocityX = (ball.x - ball.prevX) / dt;
  const velocityY = (ball.y - ball.prevY) / dt;

  if (ball.x + BALL_RADIUS > mapWidth) {
    const penetration = ball.x + BALL_RADIUS - mapWidth;
    ball.x = mapWidth - BALL_RADIUS - penetration * cor;
    ball.prevX = ball.x - (ball.prevX - ball.x) * cor;
    collidedAny = true;
    state.spinVelocity += (velocityY / BALL_RADIUS) * grip;
  }
  if (ball.x - BALL_RADIUS < 0) {
    const penetration = BALL_RADIUS - ball.x;
    ball.x = BALL_RADIUS + penetration * cor;
    ball.prevX = ball.x - (ball.prevX - ball.x) * cor;
    collidedAny = true;
    state.spinVelocity -= (velocityY / BALL_RADIUS) * grip;
  }
  if (ball.y + BALL_RADIUS > mapHeight) {
    const penetration = ball.y + BALL_RADIUS - mapHeight;
    ball.y = mapHeight - BALL_RADIUS - penetration * cor;
    ball.prevY = ball.y - (ball.prevY - ball.y) * cor;
    collidedAny = true;
    state.spinVelocity -= (velocityX / BALL_RADIUS) * grip;
  }
  if (ball.y - BALL_RADIUS < 0) {
    const penetration = BALL_RADIUS - ball.y;
    ball.y = BALL_RADIUS + penetration * cor;
    ball.prevY = ball.y - (ball.prevY - ball.y) * cor;
    collidedAny = true;
    state.spinVelocity += (velocityX / BALL_RADIUS) * grip;
  }
  if (collidedAny) state.spinVelocity *= cor;
}


// =============================================================
// 7. VELOCITY CACHE
// =============================================================

export function cacheVelocity(dt) {
  state.velocity.x = (state.ball.x - state.ball.prevX) / dt;
  state.velocity.y = (state.ball.y - state.ball.prevY) / dt;
}


// =============================================================
// 8. ROLLING ORIENTATION
// =============================================================

export function updateRollingOrientation(dt) {
  const vel = state.velocity;
  state.orientation.x += (-vel.y / BALL_RADIUS) * dt;
  state.orientation.y += ( vel.x / BALL_RADIUS) * dt;
  state.orientation.x = ((state.orientation.x % TAU) + TAU) % TAU;
  state.orientation.y = ((state.orientation.y % TAU) + TAU) % TAU;
}


// =============================================================
// 9. CAMERA
// =============================================================

export function updateCamera(dt) {
  const cam = state.camera;
  const params = state.params;
  const ball = state.ball;
  const speed = Math.hypot(state.velocity.x, state.velocity.y);

  const stiffness = params.cameraStiffness;
  const damping = Math.exp(-params.cameraDamping * dt);
  const springForceX = (ball.x - cam.x) * stiffness;
  const springForceY = (ball.y - cam.y) * stiffness;
  const newCamX = cam.x + (cam.x - cam.prevX) * damping + springForceX * dt * dt;
  const newCamY = cam.y + (cam.y - cam.prevY) * damping + springForceY * dt * dt;
  cam.prevX = cam.x; cam.prevY = cam.y;
  cam.x = newCamX; cam.y = newCamY;

  const speedAboveThreshold = Math.max(0, speed - CAMERA_ZOOM_SPEED_THRESHOLD);
  cam.targetZoom = Math.max(CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM - speedAboveThreshold * params.cameraZoomSensitivity / 1000);
  cam.zoom += (cam.targetZoom - cam.zoom) * 2.0 * dt;
  cam.zoom = Math.max(CAMERA_MIN_ZOOM, Math.min(CAMERA_MAX_ZOOM, cam.zoom));
}


// =============================================================
// GEAR SHIFT (called from input.js)
// =============================================================

export function handleGearChange(newGear) {
  const engine = state.engine;
  if (newGear === engine.currentGear) return;

  const oldRatio = Math.abs(GEAR_RATIOS[engine.currentGear] || 0);
  const newRatio = Math.abs(GEAR_RATIOS[newGear] || 0);
  engine.previousGear = engine.currentGear;
  engine.currentGear = newGear;

  if (newRatio === 0 || oldRatio === 0) return;

  const speed = Math.hypot(state.velocity.x, state.velocity.y);
  const wheelRPM = (speed * 60) / (2 * Math.PI * state.params.wheelRadius);
  const expectedRPM = wheelRPM * newRatio * FINAL_DRIVE_RATIO;

  if (newRatio < oldRatio) {
    engine.revMatchTimer = REV_MATCH_BLIP_DURATION;
    engine.revMatchTargetRPM = Math.min(REDLINE_RPM, expectedRPM);
  }
}