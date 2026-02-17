// =============================================================
// PHYSICS — Verlet integration, four-point rigid body, tire model,
//           weight transfer, engine/clutch/transmission, camera
// =============================================================
//
// ARCHITECTURE:
//   The car body is four Verlet particles (wheel positions).
//   A rigid-body constraint solver keeps them at fixed distances.
//   Forces are computed per-wheel using a simplified Pacejka tire model,
//   then summed into a net linear force and net torque.
//   The net force drives linear acceleration; net torque drives rotation.
//   Both are applied to all four particles via the Verlet integrator.
//
// CALL ORDER (enforced by main.js each sub-step):
//   1. updateSteering(dt)
//   2. updateEngine(dt)
//   3. computeBodyDerivedState(dt)
//   4. computeWeightTransfer()
//   5. computeTireForces()       → returns { forceX, forceY, torque }
//   6. computeDragForces()       → returns { forceX, forceY }
//   7. computeBrakeForce()       → returns { forceX, forceY }
//   8. combine forces into net acceleration and angular acceleration
//   9. verletIntegrateAllPoints(dt, netAccelX, netAccelY, netAngularAccel)
//  10. solveRigidBodyConstraints()
//  11. handleBoundaryCollisions()
//  12. solveRigidBodyConstraints()   (again, to restore shape after collision)
//  13. computeBodyDerivedState(dt)   (recompute for camera and render)
//  14. updateCamera(dt)
// =============================================================

import state from './state.js';
import {
  CAR_HALF_WIDTH,
  CAR_HALF_LENGTH,
  CONSTRAINT_AXLE_WIDTH,
  CONSTRAINT_SIDE_LENGTH,
  CONSTRAINT_DIAGONAL,
  CONSTRAINT_ITERATIONS,
  CAR_MASS_KG,
  GRAVITY_PX_PER_SEC2,
  COG_HEIGHT_PX,
  MOMENT_OF_INERTIA,
  MAX_DISPLACEMENT_PER_STEP,
  IDLE_RPM,
  REDLINE_RPM,
  TORQUE_PEAK_RPM,
  STALL_RPM,
  PEAK_ENGINE_TORQUE_NM,
  BRAKE_FORCE,
  IDLE_CREEP_FORCE,
  GEAR_RATIOS,
  FINAL_DRIVE_RATIO,
  WHEEL_RADIUS_PX,
  CLUTCH_BITE_POINT,
  CLUTCH_BITE_RANGE,
  CLUTCH_BITE_CURVE,
  CLUTCH_ENGAGE_TIME,
  PACEJKA_B,
  PACEJKA_C,
  TIRE_PEAK_SLIP_ANGLE_DEG,
  TIRE_PEAK_SLIP_RATIO,
  MAX_FRONT_WHEEL_ANGLE_RAD,
  STEERING_DRAG_RANGE_PX,
  STEERING_SELF_CENTER_RATE,
  CAMERA_MIN_ZOOM,
  CAMERA_MAX_ZOOM,
  CAMERA_ZOOM_SPEED_THRESHOLD_KPH,
  KPH_TO_PX_PER_SEC,
  TAU,
  DEG_TO_RAD,
} from './constants.js';


// =============================================================
// MATH HELPERS
// =============================================================

// Clamps a value between a minimum and maximum, inclusive.
function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

// Clamps to the [0, 1] range. Used for normalised quantities.
function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// Wraps an angle in radians to the range (-π, π].
// Used to find the shortest angular distance between two headings.
function wrapAngle(angle) {
  while (angle >  Math.PI) angle -= TAU;
  while (angle < -Math.PI) angle += TAU;
  return angle;
}

// Dot product of two 2D vectors.
function dot(ax, ay, bx, by) {
  return ax * bx + ay * by;
}


// =============================================================
// INITIALISATION
// =============================================================

// Places the four wheel particles in a rectangle centred at
// (worldCenterX, worldCenterY) with the car facing up (heading = 0).
// Must be called once before the game loop starts.
// Previous positions are set equal to current so initial velocity = 0.
export function initializeCarBody(worldCenterX, worldCenterY) {
  const wheels = state.wheels;

  // The car faces "up" initially. In canvas coordinates +Y is down,
  // so "front" of the car is at smaller Y (towards the top of the screen).
  wheels.frontLeft.x  = worldCenterX - CAR_HALF_WIDTH;
  wheels.frontLeft.y  = worldCenterY - CAR_HALF_LENGTH;

  wheels.frontRight.x = worldCenterX + CAR_HALF_WIDTH;
  wheels.frontRight.y = worldCenterY - CAR_HALF_LENGTH;

  wheels.rearLeft.x   = worldCenterX - CAR_HALF_WIDTH;
  wheels.rearLeft.y   = worldCenterY + CAR_HALF_LENGTH;

  wheels.rearRight.x  = worldCenterX + CAR_HALF_WIDTH;
  wheels.rearRight.y  = worldCenterY + CAR_HALF_LENGTH;

  // Set previous = current so Verlet starts at rest.
  for (const wheel of Object.values(wheels)) {
    wheel.prevX = wheel.x;
    wheel.prevY = wheel.y;
  }

  // Place camera at the body centre.
  state.camera.x     = worldCenterX;
  state.camera.y     = worldCenterY;
  state.camera.prevX = worldCenterX;
  state.camera.prevY = worldCenterY;
}


// =============================================================
// DERIVED BODY STATE
// =============================================================

// Computes all quantities that depend on wheel positions:
// centre, heading, velocity, angular velocity, and accelerations.
// Must be called at the TOP of each physics sub-step before anything
// else reads from state.body. Also called again at the END of the step
// so camera and render get up-to-date values.
export function computeBodyDerivedState(dt) {
  const wheels = state.wheels;
  const body   = state.body;

  // Save last frame's velocity so we can derive acceleration this frame.
  body.prevVelocityX = body.velocityX;
  body.prevVelocityY = body.velocityY;
  body.prevHeading   = body.heading;

  // Front-axle midpoint and rear-axle midpoint.
  const frontMidX = (wheels.frontLeft.x + wheels.frontRight.x) * 0.5;
  const frontMidY = (wheels.frontLeft.y + wheels.frontRight.y) * 0.5;
  const rearMidX  = (wheels.rearLeft.x  + wheels.rearRight.x)  * 0.5;
  const rearMidY  = (wheels.rearLeft.y  + wheels.rearRight.y)  * 0.5;

  // Centre of mass = midpoint between front and rear axle midpoints.
  body.centerX = (frontMidX + rearMidX) * 0.5;
  body.centerY = (frontMidY + rearMidY) * 0.5;

  // Heading: angle of the vector from rear midpoint to front midpoint.
  // atan2 returns the angle of a vector in standard maths convention.
  // We add PI/2 to rotate so heading 0 means facing up (−Y in canvas).
  body.heading = Math.atan2(frontMidY - rearMidY, frontMidX - rearMidX) + Math.PI * 0.5;

  // Derive linear velocity from centre-of-mass Verlet displacement.
  // Average the four wheel velocities to get the body's CoM velocity.
  let avgVelX = 0, avgVelY = 0;
  for (const wheel of Object.values(wheels)) {
    avgVelX += (wheel.x - wheel.prevX);
    avgVelY += (wheel.y - wheel.prevY);
  }
  // Divide by count (4) and by dt to get px/s.
  const inverseFourDt = 1 / (4 * dt);
  body.velocityX = avgVelX * inverseFourDt;
  body.velocityY = avgVelY * inverseFourDt;
  body.speed     = Math.hypot(body.velocityX, body.velocityY);

  // Angular velocity from heading change. wrapAngle handles wraparound.
  body.angularVelocity = wrapAngle(body.heading - body.prevHeading) / dt;

  // Accelerations: change in velocity per second.
  // These are used by computeWeightTransfer() to shift tyre loads.
  const invDt = 1 / dt;
  const accelX = (body.velocityX - body.prevVelocityX) * invDt;
  const accelY = (body.velocityY - body.prevVelocityY) * invDt;

  // Project world-space acceleration onto car-forward and car-right axes.
  const forwardX = Math.sin(body.heading);  // car forward vector
  const forwardY = -Math.cos(body.heading);
  const rightX   = Math.cos(body.heading);  // car right vector (perpendicular)
  const rightY   = Math.sin(body.heading);

  body.longitudinalAccel = dot(accelX, accelY, forwardX, forwardY);
  body.lateralAccel      = dot(accelX, accelY, rightX,   rightY);
}


// =============================================================
// WEIGHT TRANSFER
// =============================================================

// Computes the normal load (Newtons, pixel-scaled) on each of the four tyres
// based on the car's static weight distribution plus dynamic transfer from
// longitudinal (fore-aft) and lateral (left-right) acceleration.
//
// These loads scale the peak grip force in the Pacejka tire model.
// More load on a tyre → more grip, but with diminishing returns
// (Pacejka's D parameter scales linearly, so doubling load doubles peak force).
//
// Weight transfer requires CoG height: a higher CoG transfers more load
// for the same acceleration. That's why SUVs feel more tippy than sports cars.
export function computeWeightTransfer() {
  const body      = state.body;
  const loads     = state.wheelLoads;
  const params    = state.params;

  const massKg       = params.carMassKg;
  const gravity      = GRAVITY_PX_PER_SEC2;
  const cogHeight    = params.cogHeightPx;
  const wheelbase    = CAR_HALF_LENGTH * 2;  // FL↔RL distance
  const trackWidth   = CAR_HALF_WIDTH  * 2;  // FL↔FR distance

  // Total weight equally split front/rear (assumed 50/50 CoG position).
  const totalWeight    = massKg * gravity;
  const halfWeight     = totalWeight * 0.5;

  // Longitudinal transfer: braking shifts load forward; acceleration shifts it rearward.
  // Transfer = mass × longitudinal_accel × CoG_height / wheelbase
  const longitudinalTransfer = massKg * body.longitudinalAccel * cogHeight / wheelbase;

  // Lateral transfer: cornering shifts load to the outside wheels.
  // Transfer = mass × lateral_accel × CoG_height / trackWidth
  const lateralTransfer = massKg * body.lateralAccel * cogHeight / trackWidth;

  // Each axle gets half the total weight, then longitudinal transfer shifts
  // weight between front and rear axles. Within each axle, lateral transfer
  // shifts weight between left and right.
  //
  // Sign convention:
  //   longitudinalAccel > 0 (accelerating forward) → weight shifts rearward
  //   lateralAccel > 0 (rightward cornering force) → weight shifts to right wheels
  const frontAxleLoad = halfWeight - longitudinalTransfer;
  const rearAxleLoad  = halfWeight + longitudinalTransfer;

  loads.frontLeft  = Math.max(0, frontAxleLoad * 0.5 - lateralTransfer);
  loads.frontRight = Math.max(0, frontAxleLoad * 0.5 + lateralTransfer);
  loads.rearLeft   = Math.max(0, rearAxleLoad  * 0.5 - lateralTransfer);
  loads.rearRight  = Math.max(0, rearAxleLoad  * 0.5 + lateralTransfer);
}


// =============================================================
// ENGINE TORQUE CURVE
// =============================================================

// Returns normalised torque [0, 1] at a given RPM using a parabolic curve.
// Peak (1.0) occurs at TORQUE_PEAK_RPM.
// The falloff is intentionally gentle — the engine is still producing ~30%
// torque at idle and ~45% at redline, which keeps the car driveable in all gears.
// A sharper curve would reward staying near the torque peak more aggressively.
function torqueCurveNormalized(rpm) {
  // Normalise position of rpm within the operating range.
  const rpmRange           = REDLINE_RPM - IDLE_RPM;
  const distanceFromPeak   = (rpm - TORQUE_PEAK_RPM) / rpmRange;
  // Parabola: 1 at peak, falling off with the square of distance from peak.
  // The coefficient 2.5 controls how steeply the curve falls away from the peak.
  return Math.max(0, 1.0 - 2.5 * distanceFromPeak * distanceFromPeak);
}


// =============================================================
// ENGINE CLUTCH MODEL
// =============================================================

// Converts clutch pedal position [0, 1] to engagement factor [0, 1].
// Pedal position: 0 = floor (disengaged), 1 = released (engaged).
// The three zones are:
//   [0, bitePoint)                      → 0.0 (no engagement)
//   [bitePoint, bitePoint + biteRange]  → power-curve ramp (bite zone)
//   (bitePoint + biteRange, 1]          → 1.0 (fully engaged)
// The bite zone is where the real clutch feel happens: it should be narrow
// enough to feel like a real bite point, not a linear 0→1 ramp.
function computeClutchEngagement(pedalPosition, bitePoint, biteRange, biteCurve) {
  if (pedalPosition < bitePoint) {
    return 0.0;
  }
  const slipNormalized = (pedalPosition - bitePoint) / biteRange;
  if (slipNormalized >= 1.0) {
    return 1.0;
  }
  // Power curve: slipNormalized^biteCurve gives a convex ramp.
  // Higher biteCurve → most of the engagement happens in a narrow zone at the top.
  return Math.pow(slipNormalized, biteCurve);
}


// =============================================================
// ENGINE UPDATE
// =============================================================

// Manages RPM, clutch pedal position, clutch engagement, and stall detection.
// This is the heart of the drivetrain model.
//
// The clutch pedal position is the physical position of the pedal (0–1).
// The clutch engagement is derived from it via the bite-zone curve.
// RPM behaves differently depending on which clutch zone we are in.
export function updateEngine(dt) {
  const engine = state.engine;
  const input  = state.input;
  const body   = state.body;
  const params = state.params;

  if (!engine.isRunning) {
    engine.rpm = 0;
    return;
  }

  // --- Compute throttle amount ---
  // Mouse drag takes priority if active; keyboard D key is a binary fallback.
  let throttleAmount = 0;
  if (input.mouseThrottleActive) {
    throttleAmount = input.mouseThrottleAmount;
  } else if (input.throttleKeyHeld) {
    throttleAmount = 1.0;
  }

  // --- Move clutch pedal toward target position ---
  // A key held = push pedal to floor (disengage); released = pedal returns.
  const targetPedalPosition = input.clutchKeyHeld ? 0.0 : 1.0;
  const pedalRate = 1.0 / params.clutchEngageTime; // fraction per second
  if (engine.clutchPedalPosition < targetPedalPosition) {
    engine.clutchPedalPosition = Math.min(
      targetPedalPosition,
      engine.clutchPedalPosition + pedalRate * dt
    );
  } else {
    engine.clutchPedalPosition = Math.max(
      targetPedalPosition,
      engine.clutchPedalPosition - pedalRate * dt
    );
  }

  // --- Compute engagement factor from pedal position ---
  engine.clutchEngagement = computeClutchEngagement(
    engine.clutchPedalPosition,
    params.clutchBitePoint,
    params.clutchBiteRange,
    params.clutchBiteCurve,
  );

  const gearRatio = GEAR_RATIOS[engine.currentGear];

  // --- Handle stalled engine ---
  // A stalled engine produces no torque and no RPM increase until restarted.
  // Recovery: press throttle with clutch partially released (bite zone).
  if (engine.isStalled) {
    engine.rpm = 0;
    const clutchPartiallyReleased = engine.clutchPedalPosition > 0.15 &&
                                    engine.clutchPedalPosition < 0.6;
    if (throttleAmount > 0.05 && clutchPartiallyReleased) {
      // Engine restarts when the driver blips the throttle with partial clutch.
      engine.isStalled = false;
      engine.rpm = IDLE_RPM;
    }
    return;
  }

  // --- Rev-match blip (automatic RPM assist on downshift) ---
  // Briefly raises RPM to match wheel speed so a downshift doesn't cause a jerk.
  if (engine.revMatchTimer > 0) {
    engine.revMatchTimer -= dt;
    // Blend RPM toward the target over the blip duration.
    const blendRate = 8.0;
    engine.rpm += (engine.revMatchTargetRpm - engine.rpm) * blendRate * dt;
  }

  // --- RPM computation: three cases based on clutch zone ---
  if (gearRatio === 0 || engine.clutchEngagement < 0.01) {
    // CASE A: Neutral OR clutch fully disengaged → free-revving engine.
    // RPM follows throttle input with a realistic lag (rise faster than fall).
    const freeRevTarget = IDLE_RPM + throttleAmount * (REDLINE_RPM - IDLE_RPM);
    const riseRate = throttleAmount > 0.01 ? 6.0 : 3.0; // normalised fraction per second
    engine.rpm += (freeRevTarget - engine.rpm) * riseRate * dt;
    engine.rpm  = clamp(engine.rpm, IDLE_RPM, REDLINE_RPM);

  } else if (engine.clutchEngagement > 0.99) {
    // CASE B: Clutch fully engaged → rigid mechanical coupling.
    // RPM is computed from wheel speed — the drivetrain forces them to agree.
    const vehicleSpeed    = body.speed;
    const wheelRpm        = (vehicleSpeed * 60) / (TAU * WHEEL_RADIUS_PX);
    const engineRpmFromWheel = wheelRpm * Math.abs(gearRatio) * FINAL_DRIVE_RATIO;

    engine.rpm = engineRpmFromWheel;

    // Hard redline limiter: if RPM would exceed redline, the engine cuts fuel.
    if (engine.rpm > REDLINE_RPM) {
      engine.rpm = REDLINE_RPM;
    }

    // Stall check: if the wheel is nearly stopped and would drag RPM below stall,
    // the engine stalls. stallResistance adjusts how hard the engine fights it.
    const effectiveStallRpm = STALL_RPM * (1.0 - params.stallResistance * 0.8);
    if (engineRpmFromWheel < effectiveStallRpm && vehicleSpeed < 5) {
      engine.isStalled = true;
      engine.rpm = 0;
      return;
    }

  } else {
    // CASE C: Clutch in slip/bite zone → blend free-rev with wheel demand.
    // This is what makes the clutch feel real: in the slip zone the engine is
    // partially loaded. Too much mismatch between free RPM and wheel demand
    // causes either stalling (if wheel drags RPM down past stall) or wheelspin
    // (if engine is revved high and dumps torque into a stationary wheel).
    const vehicleSpeed       = body.speed;
    const wheelRpm           = (vehicleSpeed * 60) / (TAU * WHEEL_RADIUS_PX);
    const wheelDemandedRpm   = wheelRpm * Math.abs(gearRatio) * FINAL_DRIVE_RATIO;

    // Where would the engine be if running freely?
    const freeRevTarget = IDLE_RPM + throttleAmount * (REDLINE_RPM - IDLE_RPM);
    const riseRate      = throttleAmount > 0.01 ? 6.0 : 3.0;
    const freeRpm       = engine.rpm + (freeRevTarget - engine.rpm) * riseRate * dt;

    // Blend: at full engagement the engine is forced to wheel speed;
    // at zero engagement it free-revs.
    engine.rpm = freeRpm * (1 - engine.clutchEngagement) +
                 wheelDemandedRpm * engine.clutchEngagement;

    engine.rpm = clamp(engine.rpm, 0, REDLINE_RPM);

    // Stall check during engagement: if the clutch is substantially engaged
    // and RPM is dropping below stall while barely moving, the engine stalls.
    const stallThreshold = STALL_RPM * (1.0 - params.stallResistance * 0.6);
    if (engine.rpm < stallThreshold &&
        engine.clutchEngagement > 0.4 &&
        vehicleSpeed < 5) {
      engine.isStalled = true;
      engine.rpm = 0;
    }
  }
}


// =============================================================
// TIRE FORCES
// =============================================================

// Computes the lateral and longitudinal force for a single wheel
// using the simplified Pacejka "Magic Formula" (E=0 variant).
//
// The formula is: F = normalLoad × frictionCoeff × sin(C × atan(B × normalisedSlip))
//
// normalised_slip maps the actual slip value so that 1.0 corresponds to
// the peak grip point (TIRE_PEAK_SLIP_ANGLE_DEG or TIRE_PEAK_SLIP_RATIO).
// Beyond the peak, grip falls off — this is what makes drifting possible.
// The peak prevents infinite lateral force, which is what would happen with
// a linear friction model.
function pacejkaForce(normalLoad, frictionCoeff, slipValue, peakSlipValue) {
  if (peakSlipValue < 0.0001) return 0;
  const normalisedSlip = slipValue / peakSlipValue;
  return normalLoad * frictionCoeff *
         Math.sin(PACEJKA_C * Math.atan(PACEJKA_B * normalisedSlip));
}


// Computes per-wheel tire forces and returns the net body force and net torque.
// The car is rear-wheel-drive: engine torque goes only to rear wheels.
// All four wheels contribute lateral forces (from slip angles).
//
// Returns: { forceX, forceY, torque }
//   forceX, forceY: net force in world space (px/s² when divided by mass)
//   torque: net moment around the body centre of mass (for angular acceleration)
export function computeTireForces() {
  const body        = state.body;
  const engine      = state.engine;
  const loads       = state.wheelLoads;
  const params      = state.params;

  const heading         = body.heading;
  const angularVelocity = body.angularVelocity;
  const frictionCoeff   = params.tireFrictionCoeff;
  const gearRatio       = GEAR_RATIOS[engine.currentGear];

  // Car forward unit vector (in canvas coords: +Y is down, +X is right).
  const forwardX = Math.sin(heading);
  const forwardY = -Math.cos(heading);
  // Car right unit vector (perpendicular, 90° clockwise from forward).
  const rightX   =  Math.cos(heading);
  const rightY   =  Math.sin(heading);

  // Longitudinal speed along the car's forward axis.
  const longitudinalSpeed = dot(body.velocityX, body.velocityY, forwardX, forwardY);
  const speedMagnitude    = Math.max(0.5, body.speed); // avoid division by zero

  // Compute available drive force from engine torque.
  // Only transmitted to rear wheels (rear-wheel-drive assumption).
  let driveForce = 0;
  if (gearRatio !== 0 && engine.clutchEngagement > 0 && !engine.isStalled) {
    const torqueNormalized = torqueCurveNormalized(engine.rpm);
    let throttleAmount = 0;
    if (state.input.mouseThrottleActive) {
      throttleAmount = state.input.mouseThrottleAmount;
    } else if (state.input.throttleKeyHeld) {
      throttleAmount = 1.0;
    }

    const engineTorque  = PEAK_ENGINE_TORQUE_NM * torqueNormalized * throttleAmount;
    const wheelTorque   = engineTorque * Math.abs(gearRatio) * FINAL_DRIVE_RATIO
                          * engine.clutchEngagement;
    driveForce = wheelTorque / WHEEL_RADIUS_PX;

    // Reverse: flip the direction.
    if (gearRatio < 0) driveForce = -driveForce;

    // Idle creep: small force at idle in a low gear even without throttle.
    if (throttleAmount < 0.05 && Math.abs(gearRatio) >= 1.0 &&
        engine.clutchEngagement > 0.9 && Math.abs(longitudinalSpeed) < 30) {
      driveForce += IDLE_CREEP_FORCE * engine.clutchEngagement;
    }
  }

  // Wheel positions (arm vectors from body centre to wheel).
  const wheelPositions = {
    frontLeft:  state.wheels.frontLeft,
    frontRight: state.wheels.frontRight,
    rearLeft:   state.wheels.rearLeft,
    rearRight:  state.wheels.rearRight,
  };

  const peakSlipAngleRad = TIRE_PEAK_SLIP_ANGLE_DEG * DEG_TO_RAD;

  let netForceX = 0;
  let netForceY = 0;
  let netTorque = 0;

  // Process all four wheels.
  const wheelNames = ['frontLeft', 'frontRight', 'rearLeft', 'rearRight'];

  for (const name of wheelNames) {
    const wheelPos    = wheelPositions[name];
    const normalLoad  = loads[name];
    const isFront     = name === 'frontLeft' || name === 'frontRight';
    const isRear      = !isFront;

    // Arm vector: wheel position relative to body centre.
    const armX = wheelPos.x - body.centerX;
    const armY = wheelPos.y - body.centerY;

    // Wheel velocity = body CoM velocity + angular velocity × arm.
    // 2D cross product: ω × arm = (-ω × armY, ω × armX)
    const wheelVelX = body.velocityX + (-angularVelocity * armY);
    const wheelVelY = body.velocityY + ( angularVelocity * armX);

    // The front wheels are steered; rear wheels always align with car heading.
    const steeringAngle = isFront ? state.steering.frontWheelAngle : 0;

    // Wheel's own forward and right vectors (rotated by steering angle).
    const wheelForwardX = Math.sin(heading + steeringAngle);
    const wheelForwardY = -Math.cos(heading + steeringAngle);
    const wheelRightX   =  Math.cos(heading + steeringAngle);
    const wheelRightY   =  Math.sin(heading + steeringAngle);

    // Project wheel velocity onto its own axes.
    const wheelLongitudinalSpeed = dot(wheelVelX, wheelVelY, wheelForwardX, wheelForwardY);
    const wheelLateralSpeed      = dot(wheelVelX, wheelVelY, wheelRightX,   wheelRightY);

    // Slip angle: angle between where the wheel is pointed and where it is going.
    // At zero speed there is no meaningful slip angle; suppress below a threshold.
    const slipAngle = Math.abs(speedMagnitude) > 1.0
      ? Math.atan2(wheelLateralSpeed, Math.abs(wheelLongitudinalSpeed))
      : 0;

    // Lateral force (perpendicular to wheel heading): Pacejka.
    // Opposes the lateral velocity — this is what steers the car.
    const lateralForceMag = pacejkaForce(normalLoad, frictionCoeff,
                                          Math.abs(slipAngle), peakSlipAngleRad);
    // Sign: opposes lateral drift direction.
    const lateralForceSign = wheelLateralSpeed > 0 ? -1 : 1;

    // Longitudinal force (along wheel heading): engine drive + tyre traction.
    let longitudinalForceMag = 0;
    if (isRear) {
      // Drive force from engine, subject to traction limit.
      // Slip ratio approximation: how much wheel speed differs from vehicle speed.
      const wheelSpeedDemand    = driveForce > 0
        ? longitudinalSpeed + driveForce * dt  // where the engine wants the wheel
        : longitudinalSpeed;
      const slipRatio = speedMagnitude > 0.5
        ? (wheelSpeedDemand - longitudinalSpeed) / speedMagnitude
        : 0;
      const clampedSlip = clamp(slipRatio, -1, 1);
      longitudinalForceMag = pacejkaForce(normalLoad, frictionCoeff,
                                           Math.abs(clampedSlip), TIRE_PEAK_SLIP_RATIO);
      longitudinalForceMag *= Math.sign(driveForce + 0.0001); // preserve sign
    }
    // Front wheels: no drive force (FWD not implemented), but do roll resistance
    // at the tyre level. Drag is handled globally in computeDragForces.

    // Friction ellipse: combined lateral and longitudinal force cannot exceed
    // the tyre's grip circle (normalLoad × frictionCoeff).
    // If we exceed it, scale both forces down proportionally.
    const frictionLimit  = normalLoad * frictionCoeff;
    const combinedMag    = Math.hypot(lateralForceMag, longitudinalForceMag);
    let frictionScale    = 1.0;
    if (combinedMag > frictionLimit && combinedMag > 0) {
      frictionScale = frictionLimit / combinedMag;
    }

    const scaledLateral      = lateralForceMag      * frictionScale * lateralForceSign;
    const scaledLongitudinal = longitudinalForceMag * frictionScale;

    // Resolve forces into world space using the wheel's heading.
    const wheelForceX = scaledLongitudinal * wheelForwardX + scaledLateral * wheelRightX;
    const wheelForceY = scaledLongitudinal * wheelForwardY + scaledLateral * wheelRightY;

    netForceX += wheelForceX;
    netForceY += wheelForceY;

    // Torque contribution: 2D cross product of arm and force vectors.
    // τ = armX × forceY - armY × forceX (Z component only).
    netTorque += armX * wheelForceY - armY * wheelForceX;
  }

  return { forceX: netForceX, forceY: netForceY, torque: netTorque };
}


// =============================================================
// DRAG FORCES
// =============================================================

// Computes rolling resistance and aerodynamic drag opposing the car's velocity.
// These are always active and scale with speed and normal load respectively.
//
// Rolling resistance: constant deceleration force, proportional to weight.
// Aerodynamic drag: scales with velocity squared (doubles at double speed = 4× drag).
//
// Returns: { forceX, forceY }
export function computeDragForces() {
  const body   = state.body;
  const params = state.params;

  if (body.speed < 0.5) {
    return { forceX: 0, forceY: 0 };
  }

  const normalForce         = params.carMassKg * GRAVITY_PX_PER_SEC2;
  const rollingResistance   = params.rollingResistanceCoeff * normalForce;
  const aeroDrag            = params.aeroDragCoeff * body.speed * body.speed;
  const totalDragMagnitude  = rollingResistance + aeroDrag;

  // Direction: opposite to velocity.
  const invSpeed = 1 / body.speed;

  return {
    forceX: -body.velocityX * invSpeed * totalDragMagnitude,
    forceY: -body.velocityY * invSpeed * totalDragMagnitude,
  };
}


// =============================================================
// BRAKE FORCE
// =============================================================

// Returns a braking force opposing the car's velocity when the brake pedal is held.
// This is a simplified model: fixed deceleration independent of tyre load.
// A more realistic model would compute per-wheel brake torque and run it
// through the Pacejka model, but this is sufficient for the clutch-feel goal.
//
// Returns: { forceX, forceY }
export function computeBrakeForce() {
  const body  = state.body;
  const input = state.input;

  if (!input.brakeKeyHeld || body.speed < 0.5) {
    return { forceX: 0, forceY: 0 };
  }

  const invSpeed = 1 / body.speed;

  return {
    forceX: -body.velocityX * invSpeed * BRAKE_FORCE,
    forceY: -body.velocityY * invSpeed * BRAKE_FORCE,
  };
}


// =============================================================
// VERLET INTEGRATION
// =============================================================

// Applies linear and rotational acceleration to all four wheel particles.
//
// The Verlet integrator does not store velocity explicitly.
// Instead, velocity is encoded in the gap between current and previous positions:
//   new_position = current + (current - previous) + acceleration × dt²
//
// Linear acceleration (netAccelX, netAccelY) is the same for all four particles
// because the body is rigid — every point translates identically.
//
// Rotational acceleration (netAngularAccel) adds an additional displacement
// to each point proportional to its distance from the centre and perpendicular
// to the arm vector. This is the 2D rotation applied as a linear perturbation.
export function verletIntegrateAllPoints(dt, netAccelX, netAccelY, netAngularAccel) {
  const body = state.body;
  const dtSquared = dt * dt;

  for (const wheel of Object.values(state.wheels)) {
    // Arm vector from body centre to this wheel.
    const armX = wheel.x - body.centerX;
    const armY = wheel.y - body.centerY;

    // Rotational displacement: ω × arm, where 2D cross = (-ω·armY, ω·armX).
    // This is the linearised rotation: for small angles dθ in dt², it's exact.
    const rotDeltaX = -netAngularAccel * armY * dtSquared;
    const rotDeltaY =  netAngularAccel * armX * dtSquared;

    const newX = wheel.x + (wheel.x - wheel.prevX) + (netAccelX * dtSquared) + rotDeltaX;
    const newY = wheel.y + (wheel.y - wheel.prevY) + (netAccelY * dtSquared) + rotDeltaY;

    wheel.prevX = wheel.x;
    wheel.prevY = wheel.y;
    wheel.x = newX;
    wheel.y = newY;
  }
}


// =============================================================
// RIGID BODY CONSTRAINTS (Jakobsen method)
// =============================================================

// Enforces the fixed rest distance between a pair of Verlet particles.
// If the current distance differs from the rest distance, each particle is
// moved by half the error (equal mass assumption) to correct it.
//
// Jakobsen's insight: you do not need to compute velocity — moving the position
// and leaving prevPosition unchanged automatically encodes a velocity impulse.
function enforceDistanceConstraint(particleA, particleB, restDistance) {
  const deltaX = particleB.x - particleA.x;
  const deltaY = particleB.y - particleA.y;
  const currentDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

  if (currentDistance < 0.0001) return; // degenerate; skip

  // Fraction of the error each particle should move (half each for equal mass).
  const correctionScale = (currentDistance - restDistance) / currentDistance * 0.5;

  particleA.x += deltaX * correctionScale;
  particleA.y += deltaY * correctionScale;
  particleB.x -= deltaX * correctionScale;
  particleB.y -= deltaY * correctionScale;
}

// Runs CONSTRAINT_ITERATIONS passes of all six rigid distance constraints.
// Multiple iterations converge the body toward rigidity. After 6 iterations
// the constraint error is typically below 0.01 px for reasonable forces.
//
// The six constraints are the edges of the quadrilateral: four sides and
// two diagonals. The diagonals prevent the rectangle from shearing into a
// parallelogram, which would happen with only four side constraints.
export function solveRigidBodyConstraints() {
  const wh = state.wheels;

  for (let iteration = 0; iteration < CONSTRAINT_ITERATIONS; iteration++) {
    // Four edges: front axle, rear axle, left side, right side.
    enforceDistanceConstraint(wh.frontLeft,  wh.frontRight, CONSTRAINT_AXLE_WIDTH);
    enforceDistanceConstraint(wh.rearLeft,   wh.rearRight,  CONSTRAINT_AXLE_WIDTH);
    enforceDistanceConstraint(wh.frontLeft,  wh.rearLeft,   CONSTRAINT_SIDE_LENGTH);
    enforceDistanceConstraint(wh.frontRight, wh.rearRight,  CONSTRAINT_SIDE_LENGTH);
    // Two diagonals: prevents shear.
    enforceDistanceConstraint(wh.frontLeft,  wh.rearRight,  CONSTRAINT_DIAGONAL);
    enforceDistanceConstraint(wh.frontRight, wh.rearLeft,   CONSTRAINT_DIAGONAL);
  }
}


// =============================================================
// BOUNDARY COLLISIONS
// =============================================================

// Resolves collisions between each wheel particle and the map boundary.
// Uses coefficient of restitution (bounciness) to reflect the velocity
// component normal to the wall.
//
// Strategy: clamp each particle independently, then run the constraint
// solver again (in main.js) to restore body rigidity.
export function handleBoundaryCollisions() {
  const params = state.params;
  const bounciness = params.bounciness;

  const maxX = params.mapWidth;
  const maxY = params.mapHeight;

  for (const wheel of Object.values(state.wheels)) {
    // --- Left wall (x = 0) ---
    if (wheel.x < 0) {
      const velocityX = wheel.x - wheel.prevX;
      wheel.prevX = wheel.x; // place prevX at current position
      wheel.x = 0;
      wheel.prevX = wheel.x - (-velocityX * bounciness); // reflect velocity
    }

    // --- Right wall (x = mapWidth) ---
    if (wheel.x > maxX) {
      const velocityX = wheel.x - wheel.prevX;
      wheel.prevX = wheel.x;
      wheel.x = maxX;
      wheel.prevX = wheel.x - (-velocityX * bounciness);
    }

    // --- Top wall (y = 0) ---
    if (wheel.y < 0) {
      const velocityY = wheel.y - wheel.prevY;
      wheel.prevY = wheel.y;
      wheel.y = 0;
      wheel.prevY = wheel.y - (-velocityY * bounciness);
    }

    // --- Bottom wall (y = mapHeight) ---
    if (wheel.y > maxY) {
      const velocityY = wheel.y - wheel.prevY;
      wheel.prevY = wheel.y;
      wheel.y = maxY;
      wheel.prevY = wheel.y - (-velocityY * bounciness);
    }
  }
}


// =============================================================
// ANTI-TUNNELLING
// =============================================================

// Clamps each wheel particle's displacement in a single sub-step to prevent
// tunnelling through walls at high speeds. If a particle moved more than
// MAX_DISPLACEMENT_PER_STEP, its previous position is adjusted so the
// effective velocity is limited. The Verlet integrator will still apply
// acceleration correctly next step.
export function clampParticleDisplacements() {
  for (const wheel of Object.values(state.wheels)) {
    const displacementX = wheel.x - wheel.prevX;
    const displacementY = wheel.y - wheel.prevY;
    const displacementMagnitude = Math.hypot(displacementX, displacementY);

    if (displacementMagnitude > MAX_DISPLACEMENT_PER_STEP) {
      const scale = MAX_DISPLACEMENT_PER_STEP / displacementMagnitude;
      // Adjust prevX/Y so that the stored velocity is clamped.
      wheel.prevX = wheel.x - displacementX * scale;
      wheel.prevY = wheel.y - displacementY * scale;
    }
  }
}


// =============================================================
// STEERING
// =============================================================

// Maps the visual steering wheel angle (large range, arcade feel) to a
// physically meaningful front wheel lock angle (max ±MAX_FRONT_WHEEL_ANGLE_RAD).
// Self-centres when the mouse is not dragging.
export function updateSteering(dt) {
  const steering = state.steering;

  // Self-centring: when not dragging, steer back to zero.
  if (!steering.isDragging) {
    const returnAmount = STEERING_SELF_CENTER_RATE * dt;
    if (Math.abs(steering.wheelAngle) < returnAmount) {
      steering.wheelAngle = 0;
    } else {
      steering.wheelAngle -= Math.sign(steering.wheelAngle) * returnAmount;
    }
  }

  // Map visual wheel angle to physical tyre lock angle.
  // The visual range (±STEERING_DRAG_RANGE_PX mapped to ±large angle) is
  // compressed to the physical maximum steering lock.
  const normalisedSteering  = clamp(
    steering.wheelAngle / (STEERING_DRAG_RANGE_PX * 3),  // compress to [-1, 1]
    -1, 1
  );
  steering.frontWheelAngle  = normalisedSteering * MAX_FRONT_WHEEL_ANGLE_RAD;
}


// =============================================================
// CAMERA
// =============================================================

// Verlet-integrated spring-damper camera that follows the car's centre of mass.
// The camera has its own position history (camX/prevX), which means its
// "velocity" (and therefore momentum) is implicit in the position pair.
// Spring force pulls camera toward the car; exponential damping kills overshoot.
//
// Zoom is speed-dependent: the faster the car goes, the further the camera
// pulls back to give more view of the road ahead.
export function updateCamera(dt) {
  const cam    = state.camera;
  const body   = state.body;
  const params = state.params;

  // Spring force pulling camera toward body centre.
  const springForceX = (body.centerX - cam.x) * params.cameraStiffness;
  const springForceY = (body.centerY - cam.y) * params.cameraStiffness;

  // Exponential damping: each step the camera's velocity is multiplied by this.
  // Derived from: dampingFactor = e^(-damping × dt).
  const dampingFactor = Math.exp(-params.cameraDamping * dt);

  // Verlet integration: new position from current, previous, and spring force.
  const newCamX = cam.x + (cam.x - cam.prevX) * dampingFactor + springForceX * dt * dt;
  const newCamY = cam.y + (cam.y - cam.prevY) * dampingFactor + springForceY * dt * dt;

  cam.prevX = cam.x;
  cam.prevY = cam.y;
  cam.x     = newCamX;
  cam.y     = newCamY;

  // Zoom out as speed increases.
  const speedKph = body.speed / KPH_TO_PX_PER_SEC;
  const speedAboveThreshold = Math.max(0, speedKph - CAMERA_ZOOM_SPEED_THRESHOLD_KPH);
  cam.targetZoom = Math.max(
    CAMERA_MIN_ZOOM,
    CAMERA_MAX_ZOOM - speedAboveThreshold * params.cameraZoomSensitivity * 0.01
  );

  // Smooth zoom transitions.
  cam.zoom += (cam.targetZoom - cam.zoom) * 2.0 * dt;
}


// =============================================================
// GEAR CHANGES
// =============================================================

// Called by input.js when the driver selects a new gear.
// On downshift, schedules an automatic rev-match blip to reduce
// the jerk that would otherwise occur from RPM mismatch.
// On any shift, clutch engagement is unaffected — the driver still
// controls the clutch pedal independently.
export function handleGearChange(newGear) {
  const engine    = state.engine;
  const body      = state.body;

  const previousRatio = GEAR_RATIOS[engine.currentGear];
  const newRatio      = GEAR_RATIOS[newGear];

  // Rev-match blip for downshifts: if the new gear would demand a higher RPM
  // than the engine currently has, blip the throttle to close the gap.
  if (newRatio !== 0 && previousRatio !== 0 && newRatio > previousRatio) {
    const vehicleSpeed       = body.speed;
    const wheelRpm           = (vehicleSpeed * 60) / (TAU * WHEEL_RADIUS_PX);
    const targetRpm          = wheelRpm * Math.abs(newRatio) * FINAL_DRIVE_RATIO;
    if (targetRpm > engine.rpm) {
      engine.revMatchTargetRpm = Math.min(targetRpm, REDLINE_RPM);
      engine.revMatchTimer     = 0.2; // blip lasts 200 ms
    }
  }

  engine.previousGear = engine.currentGear;
  engine.currentGear  = newGear;
}


// =============================================================
// AUDIO STUB (Phase 8)
// =============================================================

// No-op placeholder for future audio integration.
// When the engine sound system is ready, it will accept these three values
// and update pitch, volume, and character of engine audio accordingly.
// Signature is intentionally stable so connecting it later requires no refactoring.
export function updateEngineSound(_rpm, _maxRpm, _throttlePosition) {
  // Audio not yet implemented. This stub exists so the call in main.js
  // compiles and runs without error, and the interface contract is preserved.
}
