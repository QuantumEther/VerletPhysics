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
  REDLINE_RPM,
  STALL_RPM,
  PEAK_ENGINE_TORQUE_NM,
  DEFAULT_BOUNCINESS,
  DEFAULT_STALL_RESISTANCE,
  DEFAULT_TIRE_FRICTION_COEFF,
  DEFAULT_ROLLING_RESISTANCE_COEFF,
  DEFAULT_AERO_DRAG_COEFF,
  DEFAULT_MAP_WIDTH,
  DEFAULT_MAP_HEIGHT,
  COG_HEIGHT,
  CAMERA_SPRING_STIFFNESS,
  CAMERA_DAMPING_FACTOR,
  DEFAULT_SIM_FPS,
  CAR_MASS_KG,
  WHEEL_RADIUS,
  FINAL_DRIVE_RATIO,
  BRAKE_FORCE,
  IDLE_CREEP_FORCE,
  PACEJKA_B,
  PACEJKA_C,
  TIRE_PEAK_SLIP_ANGLE_DEG,
  TIRE_PEAK_SLIP_RATIO,
  MAX_FRONT_WHEEL_ANGLE_RAD,
  STEERING_DRAG_RANGE_PX,
  STEERING_SELF_CENTER_RATE,
  CONSTRAINT_ITERATIONS,
  CHECKERBOARD_TILE_SIZE_PX,
  MAX_TRAIL_ARROWS,
  GEAR_RATIOS,
  DEFAULT_YAW_DAMPING,
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
    velocityX: 0,         // m/s, X component of centre-of-mass velocity
    velocityY: 0,         // m/s, Y component
    speed: 0,             // m/s, magnitude of (velocityX, velocityY)
    angularVelocity: 0,   // rad/s, rate of heading change
    prevHeading: 0,       // heading from the previous step (to derive angularVelocity)
    prevVelocityX: 0,     // velocity from the previous step (to derive acceleration)
    prevVelocityY: 0,
    longitudinalAccel: 0, // m/s², acceleration along the car's forward axis
                          // positive = accelerating forward, negative = braking
    lateralAccel: 0,      // m/s², acceleration perpendicular to forward axis
                          // positive = rightward, negative = leftward
  },

  // -----------------------------------------------------------
  // WHEEL LOADS — normal force on each tyre (Newtons, SI)
  // Computed by computeWeightTransfer() each step.
  // These scale the peak grip force in the Pacejka tire model.
  // All four should sum to carMassKg × GRAVITY ≈ 11 772 N.
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
    clutchPedalPosition:  0.0,   // starts floored (disengaged) — safe for gear selection
    clutchEngagement:     0.0,   // derived from pedal position
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
    cogHeight:               COG_HEIGHT,        // metres (was cogHeightPx in pixels)
    bounciness:              DEFAULT_BOUNCINESS,
    stallResistance:         DEFAULT_STALL_RESISTANCE,
    yawDamping:              DEFAULT_YAW_DAMPING, // N·m·s/rad; opposes angular velocity

    trailSpawnInterval: 0.08,   // seconds between arrow spawns
    trailLifespan:      2.0,    // seconds until an arrow fades
    trailFade:          0.7,    // opacity exponent; higher = faster fade

    cameraStiffness:        CAMERA_SPRING_STIFFNESS,
    cameraDamping:          CAMERA_DAMPING_FACTOR,
    cameraZoomSensitivity:  0.3,

    motionBlurSamples:    6,
    motionBlurIntensity:  0.6,
    motionBlurThreshold:  10,   // m/s; blur only appears above this speed (~36 km/h)

    mapWidth:   DEFAULT_MAP_WIDTH,   // metres
    mapHeight:  DEFAULT_MAP_HEIGHT,  // metres

    gaugeLabelScale: 1.0,   // multiplier for gauge tick-label font size

    clutchBitePoint:  0.35,
    clutchBiteRange:  0.20,
    clutchBiteCurve:  1.8,
    clutchEngageTime: 0.30,

    // --- Engine & Drivetrain (new sliders) ---
    peakEngineTorqueNm: PEAK_ENGINE_TORQUE_NM,
    idleRpm:            IDLE_RPM,
    redlineRpm:         REDLINE_RPM,
    stallRpm:           STALL_RPM,
    wheelRadius:        WHEEL_RADIUS,        // metres
    finalDriveRatio:    FINAL_DRIVE_RATIO,
    brakeForce:         BRAKE_FORCE,         // Newtons
    idleCreepForce:     IDLE_CREEP_FORCE,    // Newtons
    gearRatio1:         GEAR_RATIOS['1'],
    gearRatio2:         GEAR_RATIOS['2'],
    gearRatio3:         GEAR_RATIOS['3'],
    gearRatio4:         GEAR_RATIOS['4'],
    gearRatio5:         GEAR_RATIOS['5'],
    gearRatio6:         GEAR_RATIOS['6'],

    // --- Tire Model (new sliders) ---
    pacejkaB:              PACEJKA_B,
    pacejkaC:              PACEJKA_C,
    peakSlipAngleDeg:      TIRE_PEAK_SLIP_ANGLE_DEG,
    peakSlipRatio:         TIRE_PEAK_SLIP_RATIO,
    maxFrontWheelAngle:    MAX_FRONT_WHEEL_ANGLE_RAD,
    steeringDragRange:     STEERING_DRAG_RANGE_PX,
    steeringSelfCenterRate: STEERING_SELF_CENTER_RATE,

    // --- World & Visual (new sliders) ---
    constraintIterations:  CONSTRAINT_ITERATIONS,
    checkerboardTileSize:  CHECKERBOARD_TILE_SIZE_PX,
    maxTrailArrows:        MAX_TRAIL_ARROWS,
  },

};

export default state;
