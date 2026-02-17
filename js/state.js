// =============================================================
// STATE — single source of truth for all mutable simulation data
// =============================================================
// Every other module reads from and writes to this object.
// No logic lives here — only data and initial values.
// Import constants so initial values are kept in sync with the
// single source of truth for all numeric parameters.
// =============================================================

import {
  IDLE_RPM,
  DEFAULT_BOUNCINESS,
  DEFAULT_STALL_RESISTANCE,
  DEFAULT_TIRE_FRICTION_COEFF,
  DEFAULT_ROLLING_RESISTANCE_COEFF,
  DEFAULT_AERO_DRAG_COEFF,
  DEFAULT_MAP_WIDTH_PX,
  DEFAULT_MAP_HEIGHT_PX,
  CAMERA_SPRING_STIFFNESS,
  CAMERA_DAMPING_FACTOR,
  DEFAULT_SIM_FPS,
  CAR_MASS_KG,
} from './constants.js';

// =============================================================
// The single exported state object.
// Every mutable value in the simulation lives as a property here.
// Physics functions update this; the renderer reads from it.
// =============================================================
const state = {

  // -----------------------------------------------------------
  // CAR BODY — four Verlet particles at wheel positions
  // Wheel naming convention:
  //   frontLeft  = FL (driver's left, looking forward)
  //   frontRight = FR
  //   rearLeft   = RL
  //   rearRight  = RR
  // Each particle stores current position and previous position.
  // Velocity is always DERIVED as (current - previous) / dt.
  // prevX/Y are initialised equal to x/y so initial velocity = 0.
  // -----------------------------------------------------------
  wheels: {
    frontLeft:  { x: 0, y: 0, prevX: 0, prevY: 0 },
    frontRight: { x: 0, y: 0, prevX: 0, prevY: 0 },
    rearLeft:   { x: 0, y: 0, prevX: 0, prevY: 0 },
    rearRight:  { x: 0, y: 0, prevX: 0, prevY: 0 },
  },

  // -----------------------------------------------------------
  // BODY — derived quantities recomputed every physics step
  // These are cache values: never set manually, always derived
  // by computeBodyDerivedState() at the top of each sub-step.
  // Reading these outside of a physics step will give stale data
  // from the previous step, which is fine for rendering.
  // -----------------------------------------------------------
  body: {
    centerX: 0,           // average of all four wheel X positions
    centerY: 0,           // average of all four wheel Y positions
    heading: 0,           // radians; 0 = facing up (+Y), increases clockwise
                          // derived: atan2(frontMid - rearMid) + PI/2
    velocityX: 0,         // px/s, X component of centre-of-mass velocity
    velocityY: 0,         // px/s, Y component
    speed: 0,             // px/s, magnitude of (velocityX, velocityY)
    angularVelocity: 0,   // rad/s, rate of heading change
    prevHeading: 0,       // heading from the previous step (to derive angularVelocity)
    prevVelocityX: 0,     // velocity from the previous step (to derive acceleration)
    prevVelocityY: 0,
    longitudinalAccel: 0, // px/s², acceleration along the car's forward axis
                          // positive = accelerating forward, negative = braking
    lateralAccel: 0,      // px/s², acceleration perpendicular to forward axis
                          // positive = rightward, negative = leftward
  },

  // -----------------------------------------------------------
  // WHEEL LOADS — normal force on each tyre (Newtons, pixel-scaled)
  // Computed by computeWeightTransfer() each step.
  // These scale the peak grip force in the Pacejka tire model.
  // All four should sum to carMassKg × gravityPxPerSec2 ≈ 117 600 N.
  // -----------------------------------------------------------
  wheelLoads: {
    frontLeft:  0,
    frontRight: 0,
    rearLeft:   0,
    rearRight:  0,
  },

  // -----------------------------------------------------------
  // STEERING
  // wheelAngle is the visual steering wheel position in radians —
  // what the on-screen HUD shows. The physics uses frontWheelAngle,
  // which maps wheel angle to a physically meaningful tyre lock angle.
  // -----------------------------------------------------------
  steering: {
    wheelAngle:      0,    // radians, visual indicator only; full lock ≈ ±7.85 rad
    frontWheelAngle: 0,    // radians, actual tyre angle used in slip calculations
    isDragging:      false,
    dragStartX:      0,
  },

  // -----------------------------------------------------------
  // INPUT — raw state written by event handlers in input.js
  // Physics reads these once per sub-step. Handlers write to them
  // asynchronously from the game loop, which is safe since JS is
  // single-threaded; the values will be read at the next sub-step.
  // -----------------------------------------------------------
  input: {
    throttleKeyHeld:       false,  // D key: full throttle
    brakeKeyHeld:          false,  // S key: full brake
    clutchKeyHeld:         false,  // A key: clutch pedal to floor
    heldKeys:              {},     // map of currently pressed key codes
    mouseThrottleAmount:   0.0,    // 0.0–1.0; set by left-click drag
    mouseThrottleActive:   false,  // true while left mouse is held
    mouseThrottleDragStartY: 0,
  },

  // -----------------------------------------------------------
  // ENGINE — drivetrain state
  // clutchPedalPosition: 0 = pedal on floor (disengaged), 1 = released (engaged).
  // clutchEngagement:    computed from pedal position via the bite-zone curve;
  //                      0 = no torque transfer, 1 = full rigid coupling.
  // isStalled:           when true, engine produces zero torque.
  //                      Cleared when user blips throttle with partial clutch.
  // isRunning:           top-level engine on/off; false = no torque, no RPM rise.
  // -----------------------------------------------------------
  engine: {
    rpm:                  IDLE_RPM,
    currentGear:          'N',
    previousGear:         'N',
    clutchPedalPosition:  1.0,   // starts released (engaged)
    clutchEngagement:     1.0,   // derived from pedal position
    isStalled:            false,
    isRunning:            true,
    revMatchTimer:        0,     // countdown for automatic blip on downshift
    revMatchTargetRpm:    0,
  },

  // -----------------------------------------------------------
  // CAMERA — Verlet-integrated spring-damper camera
  // Follows body.centerX/Y with configurable lag and zoom.
  // Stored as a Verlet pair so the camera's own damping can be
  // applied purely via position history, no explicit velocity needed.
  // -----------------------------------------------------------
  camera: {
    x:          0,
    y:          0,
    prevX:      0,
    prevY:      0,
    zoom:       1.0,
    targetZoom: 1.0,
  },

  // -----------------------------------------------------------
  // TRAIL — velocity arrow trail system
  // arrows: array of { x, y, angle, speed, age, lifespan }
  // spawnAccumulator: time since last arrow spawn (seconds)
  // -----------------------------------------------------------
  trail: {
    arrows:           [],
    spawnAccumulator: 0,
  },

  // -----------------------------------------------------------
  // LOOP — timing state for the fixed-timestep accumulator
  // -----------------------------------------------------------
  loop: {
    previousTimestamp: 0,
    accumulator:       0,
  },

  // -----------------------------------------------------------
  // PARAMS — tunable parameters exposed via HTML sliders
  // All values here have matching slider elements in index.html.
  // Changing these at runtime takes effect on the next physics step.
  // -----------------------------------------------------------
  params: {
    simulationFps:           DEFAULT_SIM_FPS,
    timeScale:               1.0,
    carMassKg:               CAR_MASS_KG,
    rollingResistanceCoeff:  DEFAULT_ROLLING_RESISTANCE_COEFF,
    aeroDragCoeff:           DEFAULT_AERO_DRAG_COEFF,
    tireFrictionCoeff:       DEFAULT_TIRE_FRICTION_COEFF,
    cogHeightPx:             5,                 // synced with COG_HEIGHT_PX default
    bounciness:              DEFAULT_BOUNCINESS,
    stallResistance:         DEFAULT_STALL_RESISTANCE,

    trailSpawnInterval: 0.08,   // seconds between arrow spawns
    trailLifespan:      2.0,    // seconds until an arrow fades
    trailFade:          0.7,    // opacity exponent; higher = faster fade

    cameraStiffness:        CAMERA_SPRING_STIFFNESS,
    cameraDamping:          CAMERA_DAMPING_FACTOR,
    cameraZoomSensitivity:  0.3,

    motionBlurSamples:    6,
    motionBlurIntensity:  0.6,
    motionBlurThreshold:  100,  // px/s; blur only appears above this speed

    mapWidth:   DEFAULT_MAP_WIDTH_PX,
    mapHeight:  DEFAULT_MAP_HEIGHT_PX,

    gaugeLabelScale: 1.0,   // multiplier for gauge tick-label font size

    clutchBitePoint:  0.35, // synced with CLUTCH_BITE_POINT
    clutchBiteRange:  0.20, // synced with CLUTCH_BITE_RANGE
    clutchBiteCurve:  2.5,  // synced with CLUTCH_BITE_CURVE
    clutchEngageTime: 0.30, // synced with CLUTCH_ENGAGE_TIME
  },

};

export default state;
