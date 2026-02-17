// =============================================================
// CONSTANTS — All magic numbers live here. Every value has a
// comment explaining its source and what changing it affects.
// All objects are frozen so they cannot be mutated at runtime.
// =============================================================

// -------------------------------------------------------------
// WORLD SCALE
// 1 metre of real-world length = PIXELS_PER_METER pixels.
// At 10 px/m the car body (80 px long) represents an 8-metre car —
// slightly large but readable on screen at the default zoom.
// Increasing this makes the world feel smaller; all physics forces
// scale with the square of this factor (since acceleration = px/s²).
// -------------------------------------------------------------
export const PIXELS_PER_METER = 10;

// Conversion factor: multiply km/h by this to get px/s.
// Derivation: 1 km/h = 1000 m / 3600 s → multiply by PIXELS_PER_METER.
// At 100 km/h → 277.8 px/s; at 200 km/h → 555.6 px/s.
export const KPH_TO_PX_PER_SEC = (1000 / 3600) * PIXELS_PER_METER; // ≈ 2.778

// -------------------------------------------------------------
// CAR BODY GEOMETRY (pixels)
// The car is represented by four Verlet particles at wheel positions.
// Half-width and half-length are measured from the car's centre of mass.
// These determine rest distances for the six rigid constraints.
// Making the car narrower (smaller CAR_HALF_WIDTH) reduces slip angles.
// Making it shorter (smaller CAR_HALF_LENGTH) sharpens turn radius.
// -------------------------------------------------------------
export const CAR_HALF_WIDTH  = 20; // 4 m real width at 10 px/m
export const CAR_HALF_LENGTH = 40; // 8 m real length at 10 px/m

// Derived rest distances for all six rigid distance constraints.
// Precomputed here so physics.js does not recompute them every step.
export const CONSTRAINT_AXLE_WIDTH  = CAR_HALF_WIDTH  * 2; // FL↔FR and RL↔RR
export const CONSTRAINT_SIDE_LENGTH = CAR_HALF_LENGTH * 2; // FL↔RL and FR↔RR
export const CONSTRAINT_DIAGONAL    =                       // FL↔RR and FR↔RL
  Math.sqrt(CONSTRAINT_AXLE_WIDTH ** 2 + CONSTRAINT_SIDE_LENGTH ** 2);

// Number of Jakobsen constraint solver iterations per physics sub-step.
// 4 is the minimum for a rigid rectangle; 6 gives a noticeably stiffer body.
// More iterations → stiffer body, higher CPU cost.
export const CONSTRAINT_ITERATIONS = 6;

// -------------------------------------------------------------
// PHYSICS
// -------------------------------------------------------------
export const CAR_MASS_KG = 1200; // nominal car mass; all F=ma calculations use this

// Gravitational acceleration in pixel units.
// = 9.8 m/s² × PIXELS_PER_METER
// Used to compute normal loads for weight transfer and rolling resistance.
export const GRAVITY_PX_PER_SEC2 = 9.8 * PIXELS_PER_METER; // = 98 px/s²

// Height of the centre of gravity above the ground in pixels.
// = 0.5 m × PIXELS_PER_METER = 5 px.
// Increasing this amplifies weight transfer under acceleration and braking,
// making the car more prone to understeer on turn-in and oversteer on exit.
export const COG_HEIGHT_PX = 5;

// Moment of inertia (rectangular plate approximation).
// I = mass × (halfLength² + halfWidth²) / 3
// Used to convert net torque to angular acceleration: α = τ / I.
// Reducing this makes the car spin faster; increasing it makes it more stable.
export const MOMENT_OF_INERTIA =
  CAR_MASS_KG * (CAR_HALF_LENGTH ** 2 + CAR_HALF_WIDTH ** 2) / 3; // ≈ 800 000 kg·px²

// Maximum displacement a wheel particle can move in a single sub-step.
// Prevents tunnelling through map walls. Set to 90 % of CAR_HALF_WIDTH.
export const MAX_DISPLACEMENT_PER_STEP = CAR_HALF_WIDTH * 0.9; // ≈ 18 px

// Default coefficient of restitution for wall collisions.
// 0 = perfectly inelastic (no bounce); 1 = perfectly elastic.
// 0.5 gives a firm but not jarring wall bounce.
export const DEFAULT_BOUNCINESS = 0.5;

// -------------------------------------------------------------
// ENGINE
// -------------------------------------------------------------
export const IDLE_RPM        = 800;  // engine minimum speed when running
export const REDLINE_RPM     = 7000; // fuel cut / hard limiter above this
export const TORQUE_PEAK_RPM = 4500; // RPM at which parabolic torque curve peaks

// Engine stall threshold.
// If RPM drops below this while the clutch is in the slip/engaged zone
// and the car is nearly stationary, the engine stalls.
// Lowering makes the car harder to stall; raising makes it easier.
export const STALL_RPM = 400;

// Peak engine torque in Newton-metres (pixel-scaled).
// Tuned so the car reaches ≈ 200 km/h in 6th gear at redline with default mass.
// Increasing this makes all gears more aggressive.
export const PEAK_ENGINE_TORQUE_NM = 280;

// Braking deceleration when the brake pedal is held (px/s²).
// 800 px/s² ≈ 8 m/s² ≈ 0.82 g, which is realistic for a road car.
export const BRAKE_FORCE = 800;

// Small forward force at idle so the car creeps without throttle input.
// Mimics the idle-creep behaviour of a real manual car with clutch just released.
export const IDLE_CREEP_FORCE = 20; // px/s²

// -------------------------------------------------------------
// DRIVETRAIN
// -------------------------------------------------------------
// Gear ratios. Higher ratio = more torque multiplication, lower top speed.
// Reverse uses a negative ratio so the drivetrain knows to flip direction.
// Ratios chosen so:
//   1st tops out at ≈ 50 km/h at redline
//   6th tops out at ≈ 200 km/h at redline
// FINAL_DRIVE_RATIO is applied on top of every gear ratio.
export const GEAR_RATIOS = Object.freeze({
  N:   0,
  '1': 3.5,
  '2': 2.1,
  '3': 1.4,
  '4': 1.0,
  '5': 0.75,
  '6': 0.58,
  R:  -3.0,
});

// Differential ratio applied after the gearbox, always active.
// Combined ratio determines engine-to-wheel speed:
//   engineRPM = wheelRPM × |gearRatio| × FINAL_DRIVE_RATIO
export const FINAL_DRIVE_RATIO = 4.1;

// Effective driven wheel radius (pixels).
// wheelSpeed (px/s) = (engineRPM / 60) × TAU × WHEEL_RADIUS_PX
//                     ÷ (|gearRatio| × FINAL_DRIVE_RATIO)
export const WHEEL_RADIUS_PX = 24;

// -------------------------------------------------------------
// CLUTCH
// Pedal position is 0 (floor = fully disengaged) to 1 (released = fully engaged).
// Three zones:
//   [0, BITE_POINT)             → clutch fully disengaged
//   [BITE_POINT, BITE_POINT + BITE_RANGE] → slip zone (bite point feel)
//   (BITE_POINT + BITE_RANGE, 1] → clutch fully engaged
// CLUTCH_BITE_CURVE is the power exponent shaping the transition inside the slip zone.
// Higher value → more sudden ("grabbier") engagement.
// -------------------------------------------------------------
export const CLUTCH_BITE_POINT  = 0.35; // pedal position where bite begins
export const CLUTCH_BITE_RANGE  = 0.20; // width of slip zone
export const CLUTCH_BITE_CURVE  = 2.5;  // power exponent; higher = grabbier
export const CLUTCH_ENGAGE_TIME = 0.30; // seconds for pedal to travel full range

// How hard the engine fights to stay alive during engagement (0–1).
// 0 = stalls very easily; 1 = nearly impossible to stall.
// At 0.5 the engine stalls if you dump the clutch at idle.
export const DEFAULT_STALL_RESISTANCE = 0.5;

// -------------------------------------------------------------
// TIRE MODEL (Pacejka simplified, E = 0)
// Formula: F = normalLoad × frictionCoeff × sin(C × atan(B × normalizedSlip))
// normalizedSlip maps the actual slip to [0, 1] at the peak, so B and C
// control shape (width of peak, falloff rate) rather than scale.
// -------------------------------------------------------------
export const PACEJKA_B = 10.0; // stiffness factor; controls slope near origin
export const PACEJKA_C = 1.9;  // shape factor; controls width of the peak

// Lateral slip angle at which peak grip occurs (degrees).
// Real tyres peak around 6–10°. Lowering this makes cornering more sensitive.
export const TIRE_PEAK_SLIP_ANGLE_DEG = 8.0;

// Longitudinal slip ratio at peak grip (dimensionless, 0–1).
// Real tyres typically peak at 0.10–0.15.
export const TIRE_PEAK_SLIP_RATIO = 0.12;

// Baseline tyre–road friction coefficient (dry asphalt).
// 1.0 is a common real-world value. Reduce for wet road, increase for slicks.
export const DEFAULT_TIRE_FRICTION_COEFF = 1.0;

// -------------------------------------------------------------
// DRAG
// -------------------------------------------------------------
// Rolling resistance coefficient (dimensionless).
// Force = coeff × normal load. Typical value for a car on tarmac ≈ 0.015.
export const DEFAULT_ROLLING_RESISTANCE_COEFF = 0.015;

// Aerodynamic drag coefficient (units: px⁻¹, applied as F = coeff × speed²).
// Tuned so that top speed in 6th gear at redline ≈ 200 km/h.
// Increasing this reduces top speed and makes the car decelerate faster off-throttle.
export const DEFAULT_AERO_DRAG_COEFF = 0.00018;

// -------------------------------------------------------------
// STEERING
// -------------------------------------------------------------
// Maximum angle the front wheels can turn from straight ahead (radians).
// 0.52 rad ≈ 30°. Real sports cars have 30–40° of steering lock.
export const MAX_FRONT_WHEEL_ANGLE_RAD = 0.52;

// Horizontal mouse drag distance that corresponds to full steering lock (pixels).
// Smaller = more sensitive; larger = more precision required.
export const STEERING_DRAG_RANGE_PX = 150;

// Speed at which the steering wheel self-centres when the mouse is not dragging (rad/s).
export const STEERING_SELF_CENTER_RATE = 5.0;

// -------------------------------------------------------------
// CAMERA
// -------------------------------------------------------------
export const CAMERA_SPRING_STIFFNESS        = 3.0;  // how aggressively camera follows car
export const CAMERA_DAMPING_FACTOR          = 4.0;  // how quickly oscillations settle
export const CAMERA_MIN_ZOOM               = 0.3;  // farthest zoom out
export const CAMERA_MAX_ZOOM               = 1.0;  // no zoom (1:1)

// Speed in km/h above which the camera begins zooming out to show more of the track.
export const CAMERA_ZOOM_SPEED_THRESHOLD_KPH = 80;

// -------------------------------------------------------------
// GAUGES
// -------------------------------------------------------------
export const SPEEDOMETER_MAX_KPH    = 200;
export const TACHOMETER_MAX_RPM     = 7000;
export const TACHOMETER_REDLINE_RPM = 6500;

// Analog needle spring-damper parameters.
// STIFFNESS controls how fast the needle tracks the target.
// DAMPING prevents overshoot.
// Asymmetric RISE/FALL boost: snappy rise, sluggish fall — real meter feel.
export const NEEDLE_STIFFNESS         = 0.070;
export const NEEDLE_DAMPING           = 0.855;
export const NEEDLE_RISE_BOOST        = 1.35;
export const NEEDLE_FALL_BOOST        = 0.75;

// Above this normalised position (0–1) the needle adds a small random flutter,
// mimicking the vibration of a mechanical meter near the danger zone.
export const NEEDLE_FLUTTER_THRESHOLD = 0.80;

// -------------------------------------------------------------
// TRAIL ARROWS
// -------------------------------------------------------------
// Maximum number of trail arrows alive at any moment.
// Oldest arrows are culled when the cap is reached.
export const MAX_TRAIL_ARROWS = 600;

// Base visual length of a trail arrow at TRAIL_REFERENCE_SPEED_PX (pixels).
export const TRAIL_ARROW_BASE_LENGTH_PX = 22;

// Speed considered "fast" for trail colour and size scaling (px/s).
// At this speed arrows are yellow; above it they tend toward red.
export const TRAIL_REFERENCE_SPEED_PX = 250;

// -------------------------------------------------------------
// WORLD / MAP
// -------------------------------------------------------------
export const DEFAULT_MAP_WIDTH_PX      = 3000;
export const DEFAULT_MAP_HEIGHT_PX     = 2400;
export const CHECKERBOARD_TILE_SIZE_PX = 80;

// -------------------------------------------------------------
// SIMULATION TIMING
// -------------------------------------------------------------
export const DEFAULT_SIM_FPS = 60;

// Maximum time (seconds) a single frame may represent.
// Prevents the "spiral of death" where a slow frame causes more physics work,
// which makes the next frame slower, causing it to do even more, and so on.
export const MAX_FRAME_TIME_SEC = 0.25;

// -------------------------------------------------------------
// MATH UTILITIES
// -------------------------------------------------------------
export const TAU        = 2 * Math.PI; // full circle in radians
export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;
