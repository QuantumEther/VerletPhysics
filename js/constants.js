// =============================================================
// CONSTANTS — all magic numbers and tuning defaults
// =============================================================
// Single source of truth for every fixed value in the simulator.
// Grouped by subsystem so you can find what you need quickly.
// Nothing here is mutable at runtime — use state.js for that.
// =============================================================

// ---- Ball geometry ----
export const BALL_RADIUS = 24;

// ---- Trail rendering ----
export const ARROW_BASE_LENGTH = 22;      // base arrow length in px
export const REFERENCE_SPEED = 500;       // px/s — "normal" speed for color/size scaling
export const MAX_TRAIL_ARROWS = 600;      // oldest arrows culled beyond this

// ---- Physics safety ----
// Maximum per-step displacement before clamping (prevents wall tunneling).
// Set to 90% of ball radius so the ball can never skip past a wall.
export const MAX_DISPLACEMENT_PER_STEP = BALL_RADIUS * 0.9;

// ---- Gauge limits ----
export const MAX_SPEED_GAUGE = 800;       // px/s — speedometer full scale

// ---- Engine model ----
export const BRAKE_FORCE = 800;           // px/s² deceleration magnitude
export const IDLE_RPM = 800;              // engine idle speed
export const REDLINE_RPM = 8000;          // engine maximum speed

// ---- Steering geometry ----
// MAX_STEERING_ANGLE: the maximum wheel angle in radians.
// ±π/4 × 10 = ±7.85 rad (≈ ±450°) — intentionally large for arcade feel.
export const MAX_STEERING_ANGLE = (Math.PI / 4) * 10.0;
export const STEERING_DRAG_RANGE = 150;   // px of mouse drag for full lock
export const STEERING_RETURN_SPEED = 8.0; // rad/s self-centring rate

// ---- Transmission (realistic model) ----
// GEAR_RATIOS: maps gear name to a TORQUE multiplier.
// Higher number = more torque multiplication = more force at the wheel.
// 1st gear: highest torque, lowest top speed
// 6th gear: lowest torque, highest top speed
// Neutral = 0 (no drive), Reverse is negative.
export const GEAR_RATIOS = Object.freeze({
  'N': 0,
  '1': 3.5,
  '2': 2.5,
  '3': 1.8,
  '4': 1.3,
  '5': 1.0,
  '6': 0.8,
  'R': -2.5
});

// FINAL_DRIVE_RATIO: fixed multiplier between transmission and wheels.
// Combined with gear ratio, determines the RPM↔speed relationship.
// Value of 35.0 is tuned for the pixel-scale world so that:
//   1st gear tops out at ~160 px/s at redline
//   6th gear tops out at ~700 px/s at redline
//   (speedometer range is 0–800 px/s)
export const FINAL_DRIVE_RATIO = 35.0;

// WHEEL_CIRCUMFERENCE_PX: how many px of travel per wheel revolution.
// This is the link between wheel RPM and linear speed:
//   speed (px/s) = wheelRPM × WHEEL_CIRCUMFERENCE_PX / 60
// A larger value means higher top speed per RPM.
export const WHEEL_CIRCUMFERENCE_PX = 150;

// IDLE_CREEP_FORCE: small drive force when in gear at idle with clutch released.
// Simulates the torque converter / friction point of a manual car.
export const IDLE_CREEP_FORCE = 40;

// CLUTCH_ENGAGEMENT_TIME: seconds for the clutch to fully engage/disengage.
// This creates the "clunky" transition feel during gear changes.
export const CLUTCH_ENGAGEMENT_TIME = 0.3;

// REV_MATCH_BLIP_DURATION: seconds for the throttle blip during downshifts.
export const REV_MATCH_BLIP_DURATION = 0.15;

// STALL_RPM_THRESHOLD: if engine RPM drops below this while in gear, the engine stalls.
export const STALL_RPM_THRESHOLD = 500;

// ENGINE_BRAKING_COEFFICIENT: how strongly the engine resists when wheels
// try to spin faster than the engine (deceleration in high gears).
export const ENGINE_BRAKING_COEFFICIENT = 0.3;

// ---- Engine heat model ----
export const NORMAL_TEMP_CELSIUS = 90;    // normal operating temperature
export const MAX_TEMP_CELSIUS = 120;      // redline temperature
export const COLD_START_TEMP = 60;        // initial cold temperature

// ---- Needle physics (spring-damped gauge needles) ----
export const NEEDLE_STIFFNESS = 0.070;
export const NEEDLE_DAMPING = 0.855;
export const NEEDLE_RISE_BOOST = 1.35;    // snappier response on acceleration
export const NEEDLE_FALL_BOOST = 0.75;    // slower decay on deceleration
export const NEEDLE_FLUTTER_THRESHOLD = 0.80; // normalized value above which needle vibrates

// ---- Canvas resolution ----
export const CANVAS_RESOLUTION_MIN = 0.5;
export const CANVAS_RESOLUTION_MAX = 2.0;
export const CANVAS_RESOLUTION_DEFAULT = 1.0;

// ---- Camera system ----
// The camera uses its own Verlet integration to follow the ball with damped lag.
export const CAMERA_DEFAULT_STIFFNESS = 3.0;   // spring constant toward ball
export const CAMERA_DEFAULT_DAMPING = 4.0;      // velocity damping
export const CAMERA_DEFAULT_ZOOM_SENSITIVITY = 0.3; // how quickly zoom responds to speed
export const CAMERA_MIN_ZOOM = 0.3;             // maximum zoom out
export const CAMERA_MAX_ZOOM = 1.0;             // normal zoom (no zoom in beyond 1:1)
export const CAMERA_ZOOM_SPEED_THRESHOLD = 200; // px/s before zoom starts

// ---- Motion blur ----
export const MOTION_BLUR_DEFAULT_SAMPLES = 6;     // ghost copies for blur
export const MOTION_BLUR_DEFAULT_INTENSITY = 0.6;  // alpha multiplier for blur
export const MOTION_BLUR_DEFAULT_THRESHOLD = 100;  // px/s before blur activates
export const CHECKERBOARD_BLUR_STRENGTH = 1.0;     // background blur multiplier

// ---- Map / world size ----
export const DEFAULT_MAP_WIDTH = 3000;    // px — total world width
export const DEFAULT_MAP_HEIGHT = 2400;   // px — total world height
export const CHECKERBOARD_TILE_SIZE = 80; // px — size of each checker square

// ---- Clutch bite/slip model ----
export const CLUTCH_DEFAULT_ENGAGE_TIME  = 0.25;
export const CLUTCH_DEFAULT_BITE_POINT   = 0.35;
export const CLUTCH_DEFAULT_BITE_RANGE   = 0.15;
export const CLUTCH_DEFAULT_BITE_CURVE   = 2.2;
export const CLUTCH_DEFAULT_SYNC_RPM_SEC = 12000;

// ---- Default slider values ----
// These match the HTML slider initial values and are used by state.js.
// Every key here MUST have a corresponding key in state.params.
export const DEFAULTS = Object.freeze({
  simulationFPS: 60,

  forceMagnitude: 800,
  ballMass: 1.2,
  linearFriction: 2.0,
  angularFriction: 2.0,

  bounciness: 1.0,
  timeScale: 1.0,

  // Trail (spawn uses logarithmic slider mapping)
  trailSpawnInterval: 0.08,
  trailLifespan: 2.0,
  trailFade: 0.7,

  // Steering: turnRate now ranges [-5, +5], negative = inverted
  turnRateCoefficient: 2.5,
  wallGripCoefficient: 0.35,

  gaugeLabelScale: 1.0,

  // Engine RPM response (how fast RPM rises/falls)
  throttleRise: 0.12,
  throttleFall: 0.08,

  // Clutch bite/slip model
  clutchEngagementTime: CLUTCH_DEFAULT_ENGAGE_TIME,
  clutchBitePoint:      CLUTCH_DEFAULT_BITE_POINT,
  clutchBiteRange:      CLUTCH_DEFAULT_BITE_RANGE,
  clutchCurve:          CLUTCH_DEFAULT_BITE_CURVE,
  clutchSyncRPMPerSec:  CLUTCH_DEFAULT_SYNC_RPM_SEC,

  // Engine temperature response (independent from RPM sliders)
  heatGenerationRate: 20,   // °C/s at redline RPM load
  heatDissipationRate: 15,  // °C/s passive cooling

  canvasResolution: 1.0,

  // Camera
  cameraStiffness: CAMERA_DEFAULT_STIFFNESS,
  cameraDamping: CAMERA_DEFAULT_DAMPING,
  cameraZoomSensitivity: CAMERA_DEFAULT_ZOOM_SENSITIVITY,

  // Motion blur
  motionBlurSamples: MOTION_BLUR_DEFAULT_SAMPLES,
  motionBlurIntensity: MOTION_BLUR_DEFAULT_INTENSITY,
  motionBlurThreshold: MOTION_BLUR_DEFAULT_THRESHOLD,

  // Map size
  mapWidth: DEFAULT_MAP_WIDTH,
  mapHeight: DEFAULT_MAP_HEIGHT,

  // Wheel size (radius in px — determines mechanical advantage)
  // Smaller wheels = more launch torque, lower top speed
  // Larger wheels = less torque, higher top speed
  // Default 24 matches the ball visual radius
  wheelRadius: 24,

  // Stall resistance: 0 = stalls very easily, 1 = almost impossible to stall
  // Models engine idle torque and flywheel inertia.
  // At 0: engine stalls if you dump clutch at any speed below ~30 px/s
  // At 1: engine can launch in 3rd gear from standstill without stalling
  stallResistance: 0.5,
});

// ---- Logarithmic slider mapping for trail spawn ----
// The slider produces a linear value in [0, 1].
// We map it to an exponential range for fine control at low values.
export const SPAWN_SLIDER_MIN = 0.001;    // minimum spawn interval (seconds)
export const SPAWN_SLIDER_MAX = 10.0;     // maximum spawn interval (seconds)

// ---- Input detection ----
// Keys that should have their browser default action suppressed
export const GAME_KEYS = new Set(['a', 'A', 's', 'S', 'd', 'D', 'q', 'Q']);

// ---- Math shorthand ----
export const TAU = 2 * Math.PI;