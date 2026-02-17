// =============================================================
// CONSTANTS — All magic numbers live here. Every value has a
// comment explaining its source and what changing it affects.
// All objects are frozen so they cannot be mutated at runtime.
//
// UNIT SYSTEM:
//   All physics quantities use SI units:
//     lengths        → metres (m)
//     speeds         → metres per second (m/s)
//     forces         → Newtons (N = kg·m/s²)
//     accelerations  → m/s²
//     torques        → Newton-metres (N·m)
//     mass           → kilograms (kg)
//   Conversion to pixels happens ONLY in renderer.js via
//   ctx.scale(PIXELS_PER_METER, PIXELS_PER_METER) inside
//   applyCameraTransform(). No pixel arithmetic in physics.
// =============================================================

// -------------------------------------------------------------
// WORLD SCALE
// 1 metre of real-world length = PIXELS_PER_METER pixels.
// At 10 px/m the car body (8 m long) renders as 80 px on screen.
// This constant is used ONLY by the renderer to scale world→screen.
// Physics never multiplies by this value.
// -------------------------------------------------------------
export const PIXELS_PER_METER = 10;

// Conversion factor: multiply km/h by this to get m/s.
// Derivation: 1 km/h = 1000 m / 3600 s ≈ 0.2778 m/s.
export const KPH_TO_MPS = 1000 / 3600; // ≈ 0.2778

// -------------------------------------------------------------
// CAR BODY GEOMETRY (metres)
// The car is represented by four Verlet particles at wheel positions.
// Half-width and half-length are measured from the car's centre of mass.
// These determine rest distances for the six rigid constraints.
// At PIXELS_PER_METER = 10:  2m → 20px, 4m → 40px on screen.
// -------------------------------------------------------------
export const CAR_HALF_WIDTH  = 2.0; // m
export const CAR_HALF_LENGTH = 4.0; // m

// Derived rest distances for all six rigid distance constraints (metres).
export const CONSTRAINT_AXLE_WIDTH  = CAR_HALF_WIDTH  * 2; // 4.0 m
export const CONSTRAINT_SIDE_LENGTH = CAR_HALF_LENGTH * 2; // 8.0 m
export const CONSTRAINT_DIAGONAL    =
  Math.sqrt(CONSTRAINT_AXLE_WIDTH ** 2 + CONSTRAINT_SIDE_LENGTH ** 2); // ≈ 8.944 m

// Number of Jakobsen constraint solver iterations per physics sub-step.
// 4 is the minimum for a rigid rectangle; 6 gives a noticeably stiffer body.
export const CONSTRAINT_ITERATIONS = 6;

// -------------------------------------------------------------
// PHYSICS
// -------------------------------------------------------------
export const CAR_MASS_KG = 1200; // kg

// Gravitational acceleration (SI, m/s²).
// Previously GRAVITY_PX_PER_SEC2 = 9.8 × PIXELS_PER_METER = 98 px/s²,
// which inflated all normal-force calculations by 10×. Now correct.
export const GRAVITY = 9.81; // m/s²

// Height of the centre of gravity above the ground (metres).
// 0.5 m is typical for a sports car.
// Previously COG_HEIGHT_PX = 5 px = 0.5 m — same physical value, now explicit.
export const COG_HEIGHT = 0.5; // m

// Moment of inertia (rectangular plate approximation, kg·m²).
// I = mass × (halfLength² + halfWidth²) / 3
// With metre geometry: 1200 × (4² + 2²) / 3 = 8000 kg·m².
// Previously ≈800,000 kg·px² — 100× too large due to pixel units.
export const MOMENT_OF_INERTIA =
  CAR_MASS_KG * (CAR_HALF_LENGTH ** 2 + CAR_HALF_WIDTH ** 2) / 3; // ≈ 8000 kg·m²

// Maximum displacement a wheel particle can move in a single sub-step (metres).
// Prevents tunnelling through map walls.
export const MAX_DISPLACEMENT_PER_STEP = CAR_HALF_WIDTH * 0.9; // 1.8 m

// Default coefficient of restitution for wall collisions.
export const DEFAULT_BOUNCINESS = 0.5;

// -------------------------------------------------------------
// ENGINE
// -------------------------------------------------------------
export const IDLE_RPM        = 800;  // engine minimum speed when running
export const REDLINE_RPM     = 7000; // fuel cut / hard limiter above this
export const TORQUE_PEAK_RPM = 4500; // RPM at which parabolic torque curve peaks

// Engine stall threshold.
export const STALL_RPM = 600;

// Peak engine torque in Newton-metres.
// 2800 N·m is hypercar territory. A normal family car ≈ 200–350 N·m.
// Tune via the peakEngineTorqueNm slider.
// With WHEEL_RADIUS = 0.35 m, 1st gear full throttle peak:
//   driveForce = 2800 × 3.5 × 4.1 / 0.35 ≈ 117,600 N  (~9.8 g)
export const PEAK_ENGINE_TORQUE_NM = 2800;

// Braking force when the brake pedal is held (Newtons).
// 9810 N / 1200 kg ≈ 8.2 m/s² ≈ 0.83 g — realistic for a road car.
export const BRAKE_FORCE = 9810; // N

// Small forward force at idle so the car creeps without throttle.
// 200 N > rolling drag (141 N) so the car just barely creeps forward.
export const IDLE_CREEP_FORCE = 200; // N

// -------------------------------------------------------------
// DRIVETRAIN
// -------------------------------------------------------------
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

export const FINAL_DRIVE_RATIO = 4.1;

// Effective driven wheel radius (metres).
// 0.35 m = typical for 205/55R16 tyres.
// Previously WHEEL_RADIUS_PX = 24 px = 2.4 m — physically absurd.
export const WHEEL_RADIUS = 0.35; // m

// -------------------------------------------------------------
// CLUTCH
// -------------------------------------------------------------
export const CLUTCH_BITE_POINT  = 0.35;
export const CLUTCH_BITE_RANGE  = 0.20;
export const CLUTCH_BITE_CURVE  = 1.8;
export const CLUTCH_ENGAGE_TIME = 0.30;
export const DEFAULT_STALL_RESISTANCE = 0.7;

// -------------------------------------------------------------
// TIRE MODEL (Pacejka simplified, E = 0)
// Formula: F = normalLoad × frictionCoeff × sin(C × atan(B × normalizedSlip))
// -------------------------------------------------------------
export const PACEJKA_B = 10.0;
export const PACEJKA_C = 1.9;
export const TIRE_PEAK_SLIP_ANGLE_DEG = 8.0;
export const TIRE_PEAK_SLIP_RATIO = 0.12;
export const DEFAULT_TIRE_FRICTION_COEFF = 1.0;

// -------------------------------------------------------------
// DRAG
// -------------------------------------------------------------
// Rolling resistance coefficient (true SI value, dimensionless).
// Force = coeff × mass × GRAVITY.
// Now that GRAVITY = 9.81 m/s² this uses the real-world value.
// At 0.012: rollingDrag = 0.012 × 1200 × 9.81 ≈ 141 N.
export const DEFAULT_ROLLING_RESISTANCE_COEFF = 0.012;

// Aerodynamic drag coefficient (N·s²/m²).
// Formula: F = coeff × speed²  (speed in m/s, F in N).
// From first principles: F = 0.5 × ρ × Cd × A × v²
//   ρ = 1.225 kg/m³, Cd = 0.30, A = 2.2 m²  → coeff ≈ 0.404
// At 200 km/h (55.6 m/s): aeroDrag ≈ 1237 N.
export const DEFAULT_AERO_DRAG_COEFF = 0.4;

// -------------------------------------------------------------
// STEERING
// -------------------------------------------------------------
export const MAX_FRONT_WHEEL_ANGLE_RAD = 0.52;
export const STEERING_DRAG_RANGE_PX    = 150; // pixels (HUD/input, not world space)
export const STEERING_SELF_CENTER_RATE = 5.0;

// -------------------------------------------------------------
// CAMERA
// -------------------------------------------------------------
export const CAMERA_SPRING_STIFFNESS        = 3.0;
export const CAMERA_DAMPING_FACTOR          = 4.0;
export const CAMERA_MIN_ZOOM               = 0.3;
export const CAMERA_MAX_ZOOM               = 1.0;
export const CAMERA_ZOOM_SPEED_THRESHOLD_KPH = 80;

// -------------------------------------------------------------
// GAUGES
// -------------------------------------------------------------
export const SPEEDOMETER_MAX_KPH    = 200;
export const TACHOMETER_MAX_RPM     = 7000;
export const TACHOMETER_REDLINE_RPM = 6500;
export const NEEDLE_STIFFNESS         = 0.070;
export const NEEDLE_DAMPING           = 0.855;
export const NEEDLE_RISE_BOOST        = 1.35;
export const NEEDLE_FALL_BOOST        = 0.75;
export const NEEDLE_FLUTTER_THRESHOLD = 0.80;

// -------------------------------------------------------------
// TRAIL ARROWS
// -------------------------------------------------------------
export const MAX_TRAIL_ARROWS          = 600;
export const TRAIL_ARROW_BASE_LENGTH_PX = 22; // pixels (visual only)

// Speed considered "fast" for trail colour and size scaling (m/s).
// 25 m/s ≈ 90 km/h. Previously TRAIL_REFERENCE_SPEED_PX = 250 px/s = 25 m/s.
export const TRAIL_REFERENCE_SPEED = 25; // m/s

// -------------------------------------------------------------
// WORLD / MAP
// -------------------------------------------------------------
// Map dimensions in metres.  300 m × 10 px/m = 3000 px on screen.
export const DEFAULT_MAP_WIDTH  = 300; // m
export const DEFAULT_MAP_HEIGHT = 240; // m
export const CHECKERBOARD_TILE_SIZE_PX = 80; // pixels (visual only)

// -------------------------------------------------------------
// SIMULATION TIMING
// -------------------------------------------------------------
export const DEFAULT_SIM_FPS    = 60;
export const MAX_FRAME_TIME_SEC = 0.25;

// -------------------------------------------------------------
// MATH UTILITIES
// -------------------------------------------------------------
export const TAU        = 2 * Math.PI;
export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;
