// =============================================================
// STATE — single source of truth for all mutable simulation data
// =============================================================
// Every other module reads from and writes to this object.
// Grouping state by subsystem makes it clear what each module
// touches. Nothing is initialized with magic numbers — all
// defaults come from constants.js.
// =============================================================

import { DEFAULTS, IDLE_RPM, COLD_START_TEMP } from './constants.js';

const state = {

  // ---- Slider-driven parameters (mutated by ui.js) ----
  params: {
    simulationFPS:       DEFAULTS.simulationFPS,

    forceMagnitude:      DEFAULTS.forceMagnitude,
    ballMass:            DEFAULTS.ballMass,
    linearFriction:      DEFAULTS.linearFriction,
    angularFriction:     DEFAULTS.angularFriction,

    bounciness:          DEFAULTS.bounciness,
    timeScale:           DEFAULTS.timeScale,

    trailSpawnInterval:  DEFAULTS.trailSpawnInterval,
    trailLifespan:       DEFAULTS.trailLifespan,
    trailFade:           DEFAULTS.trailFade,

    turnRateCoefficient: DEFAULTS.turnRateCoefficient,
    wallGripCoefficient: DEFAULTS.wallGripCoefficient,

    gaugeLabelScale:     DEFAULTS.gaugeLabelScale,

    throttleRise:        DEFAULTS.throttleRise,
    throttleFall:        DEFAULTS.throttleFall,

    // Clutch bite/slip
    clutchEngagementTime: DEFAULTS.clutchEngagementTime,
    clutchBitePoint:      DEFAULTS.clutchBitePoint,
    clutchBiteRange:      DEFAULTS.clutchBiteRange,
    clutchCurve:          DEFAULTS.clutchCurve,
    clutchSyncRPMPerSec:  DEFAULTS.clutchSyncRPMPerSec,

    // Temperature sliders (independent from throttle rise/fall)
    heatGenerationRate:  DEFAULTS.heatGenerationRate,
    heatDissipationRate: DEFAULTS.heatDissipationRate,

    canvasResolution:    DEFAULTS.canvasResolution,

    // Camera
    cameraStiffness:     DEFAULTS.cameraStiffness,
    cameraDamping:       DEFAULTS.cameraDamping,
    cameraZoomSensitivity: DEFAULTS.cameraZoomSensitivity,

    // Motion blur
    motionBlurSamples:   DEFAULTS.motionBlurSamples,
    motionBlurIntensity: DEFAULTS.motionBlurIntensity,
    motionBlurThreshold: DEFAULTS.motionBlurThreshold,

    // Map / world bounds
    mapWidth:            DEFAULTS.mapWidth,
    mapHeight:           DEFAULTS.mapHeight,

    // Wheel size and stall
    wheelRadius:         DEFAULTS.wheelRadius,
    stallResistance:     DEFAULTS.stallResistance,
  },

  // ---- Ball (Verlet position pair) ----
  // Initial position is (0,0); main.js centerBall() sets it at startup.
  ball: {
    x: 0,
    y: 0,
    prevX: 0,
    prevY: 0,
  },

  // ---- Camera (Verlet position pair — follows ball with lag) ----
  // The camera center in world coordinates. Rendering applies
  // translate(-camX + viewportW/2, -camY + viewportH/2).
  camera: {
    x: 0,
    y: 0,
    prevX: 0,
    prevY: 0,
    zoom: 1.0,         // current zoom level (1.0 = normal, <1 = zoomed out)
    targetZoom: 1.0,   // zoom target (smoothed toward)
  },

  // ---- Car heading (bicycle model) ----
  // Direction the car faces, in radians (0 = +X, π/2 = +Y).
  carHeading: 0,

  // ---- 3D rolling orientation (X/Y axes, invisible in top-down view) ----
  orientation: {
    x: 0,   // pitch from vertical motion
    y: 0,   // roll from horizontal motion
  },

  // ---- Collision-induced Z spin (added to heading) ----
  spinVelocity: 0,

  // ---- Cached velocity (computed once per physics step, reused everywhere) ----
  velocity: {
    x: 0,
    y: 0,
  },

  // ---- Steering wheel position (set by mouse drag) ----
  // The wheel angle controls the RATE of heading change, not heading directly.
  steering: {
    wheelAngle: 0,
    isDragging: false,
    dragStartX: 0,
  },

  // ---- Input flags (set by keyboard and mouse handlers) ----
  input: {
    throttlePressed: false,   // keyboard D key (binary fallback)
    brakePressed: false,      // keyboard S key
    clutchPressed: false,     // keyboard A key
    heldKeys: {},             // tracks which keys are currently down

    // Analog mouse throttle: 0.0 = no throttle, 1.0 = full throttle
    // Set by left-click drag up/down on the canvas.
    mouseThrottleAmount: 0.0,
    mouseThrottleActive: false,  // is the user currently dragging for throttle?
    mouseThrottleDragStartY: 0,  // Y position where drag started
  },

  // ---- Engine ----
  engine: {
    rpm: IDLE_RPM,
    currentGear: 'N',
    temperatureCelsius: COLD_START_TEMP,  // starts cold — cold start penalty active

    // Clutch engagement state: 1.0 = fully engaged, 0.0 = fully disengaged.
    // Transitions smoothly over CLUTCH_ENGAGEMENT_TIME seconds.
    clutchEngagement: 1.0,

    // Rev-match state for downshift blips
    revMatchTimer: 0,          // countdown timer for throttle blip
    revMatchTargetRPM: 0,      // RPM target during blip

    // Stall state
    isStalled: false,

    // Engine on/off toggle
    isRunning: true,

    // Previous gear (for detecting up/down shifts)
    previousGear: 'N',
  },

  // ---- Trail arrows ----
  trail: {
    arrows: [],                // array of {x, y, angle, speed, age, lifespan}
    spawnAccumulator: 0,
  },

  // ---- Main loop timing ----
  loop: {
    previousTimestamp: 0,
    accumulator: 0,
  },
};

export default state;