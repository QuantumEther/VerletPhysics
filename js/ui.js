// =============================================================
// UI — slider binding, info bar updates, needle physics
// =============================================================
// Handles all DOM ↔ state synchronization.
//
// Special slider behaviors:
//   - Turn Rate: ranges [-5, +5] with 0 center (negative = inverted)
//   - Spawn Interval: logarithmic mapping for fine control at low values
//   - Sim FPS: snaps to nearest 10Hz tick
//   - Temperature Rise/Fall: independent from throttle rise/fall
//   - Camera and Motion Blur: new control panels
//   - Map Width/Height: world boundary size
// =============================================================

import state from './state.js';
import {
  NEEDLE_STIFFNESS,
  NEEDLE_DAMPING,
  NEEDLE_RISE_BOOST,
  NEEDLE_FALL_BOOST,
  NEEDLE_FLUTTER_THRESHOLD,
  SPAWN_SLIDER_MIN,
  SPAWN_SLIDER_MAX,
} from './constants.js';


// =============================================================
// NEEDLE PHYSICS (spring-damped gauge needle animation)
// =============================================================

export function createNeedlePhysics() {
  return {
    normalizedPosition: 0,
    velocity: 0,
    tickCounter: 0,

    step(targetNormalized) {
      const boost = targetNormalized > this.normalizedPosition ? NEEDLE_RISE_BOOST : NEEDLE_FALL_BOOST;
      const springForce = (targetNormalized - this.normalizedPosition) * NEEDLE_STIFFNESS * boost;
      this.velocity += springForce;
      this.velocity *= NEEDLE_DAMPING;
      this.normalizedPosition += this.velocity;
      this.tickCounter += 1;

      const flutter = (this.normalizedPosition > NEEDLE_FLUTTER_THRESHOLD)
        ? Math.sin(this.tickCounter * 0.12) * 0.002
        : 0;

      return Math.max(0, Math.min(1, this.normalizedPosition + flutter));
    }
  };
}


// =============================================================
// LOGARITHMIC SLIDER HELPERS
// =============================================================
// The spawn interval slider uses a logarithmic scale so that
// values near 0.001s have fine-grained control while values
// near 10s have coarser jumps.
//
// Mapping: sliderPosition ∈ [0, 1] → value = min × (max/min)^position
// Inverse: value → sliderPosition = log(value/min) / log(max/min)
// =============================================================

function logSliderToValue(sliderNormalized) {
  return SPAWN_SLIDER_MIN * Math.pow(SPAWN_SLIDER_MAX / SPAWN_SLIDER_MIN, sliderNormalized);
}

function valueToLogSlider(value) {
  return Math.log(value / SPAWN_SLIDER_MIN) / Math.log(SPAWN_SLIDER_MAX / SPAWN_SLIDER_MIN);
}


// =============================================================
// FPS SNAP HELPER
// =============================================================
// Snaps the FPS slider value to the nearest multiple of 10
// when the value is within a snap threshold.
// =============================================================

const FPS_SNAP_THRESHOLD = 3;  // snap if within 3 of a multiple of 10

function snapFPS(rawValue) {
  const nearest10 = Math.round(rawValue / 10) * 10;
  if (Math.abs(rawValue - nearest10) <= FPS_SNAP_THRESHOLD) {
    return nearest10;
  }
  return Math.round(rawValue);
}


// =============================================================
// SLIDER INITIALIZATION
// =============================================================

export function initSliders() {
  /**
   * Generic slider binder.
   */
  function bindSlider(sliderId, displayId, getter, setter, formatter) {
    const slider = document.getElementById(sliderId);
    const display = document.getElementById(displayId);
    if (!slider || !display) return;  // guard against missing elements
    display.textContent = formatter(getter());
    slider.addEventListener('input', () => {
      setter(parseFloat(slider.value));
      display.textContent = formatter(getter());
    });
  }

  const p = state.params;

  // ---- FPS slider with tick snapping ----
  const fpsSlider = document.getElementById('fpsSlider');
  const fpsDisplay = document.getElementById('fpsValue');
  if (fpsSlider && fpsDisplay) {
    fpsDisplay.textContent = p.simulationFPS;
    fpsSlider.addEventListener('input', () => {
      const oldDt = 1 / p.simulationFPS;
      const rawValue = parseFloat(fpsSlider.value);
      p.simulationFPS = snapFPS(rawValue);
      fpsSlider.value = p.simulationFPS;  // snap the thumb visually
      const newDt = 1 / p.simulationFPS;
      const ratio = newDt / oldDt;

      // Rescale Verlet implicit velocity to preserve speed across FPS changes
      const ball = state.ball;
      ball.prevX = ball.x - (ball.x - ball.prevX) * ratio;
      ball.prevY = ball.y - (ball.y - ball.prevY) * ratio;

      fpsDisplay.textContent = p.simulationFPS;
    });
  }

  // ---- Physics sliders ----
  bindSlider('forceSlider',    'forceValue',    () => p.forceMagnitude,  v => p.forceMagnitude = v,  v => v);
  bindSlider('massSlider',     'massValue',     () => p.ballMass,        v => p.ballMass = v,        v => v.toFixed(1));
  bindSlider('linFricSlider',  'linFricValue',  () => p.linearFriction,  v => p.linearFriction = v,  v => v.toFixed(1));
  bindSlider('angFricSlider',  'angFricValue',  () => p.angularFriction, v => p.angularFriction = v, v => v.toFixed(1));
  bindSlider('bounceSlider',   'bounceValue',   () => p.bounciness,      v => p.bounciness = v,      v => v.toFixed(2));
  bindSlider('timeScaleSlider','timeScaleValue', () => p.timeScale,      v => p.timeScale = v,       v => v.toFixed(1));

  // ---- Trail sliders ----
  // Spawn interval uses logarithmic mapping
  const spawnSlider = document.getElementById('spawnIntervalSlider');
  const spawnDisplay = document.getElementById('spawnIntervalValue');
  if (spawnSlider && spawnDisplay) {
    // Initialize slider position from the current value
    const initialNorm = valueToLogSlider(p.trailSpawnInterval);
    spawnSlider.value = initialNorm;
    spawnDisplay.textContent = p.trailSpawnInterval.toFixed(3);

    spawnSlider.addEventListener('input', () => {
      const normalized = parseFloat(spawnSlider.value);
      p.trailSpawnInterval = logSliderToValue(normalized);
      // Format display based on magnitude
      if (p.trailSpawnInterval < 0.01) {
        spawnDisplay.textContent = p.trailSpawnInterval.toFixed(4);
      } else if (p.trailSpawnInterval < 1) {
        spawnDisplay.textContent = p.trailSpawnInterval.toFixed(3);
      } else {
        spawnDisplay.textContent = p.trailSpawnInterval.toFixed(1);
      }
    });
  }

  bindSlider('lifespanSlider',      'lifespanValue',      () => p.trailLifespan,      v => p.trailLifespan = v,      v => v.toFixed(1));
  bindSlider('fadeSlider',          'fadeValue',          () => p.trailFade,          v => p.trailFade = v,          v => v.toFixed(2));

  // ---- Steering: Turn Rate now ranges [-5, +5] ----
  bindSlider('turnRateSlider',  'turnRateValue',
    () => p.turnRateCoefficient,
    v => p.turnRateCoefficient = v,
    v => {
      const sign = v > 0 ? '+' : v < 0 ? '' : ' ';
      return sign + v.toFixed(1);
    }
  );
  bindSlider('wallGripSlider',  'wallGripValue',  () => p.wallGripCoefficient,  v => p.wallGripCoefficient = v,  v => v.toFixed(2));

  // ---- Gauge label size ----
  const gaugeLabelSlider = document.getElementById('gaugeLabelSize');
  const gaugeLabelDisplay = document.getElementById('gaugeLabelReadout');
  if (gaugeLabelSlider && gaugeLabelDisplay) {
    gaugeLabelDisplay.textContent = gaugeLabelSlider.value;
    gaugeLabelSlider.addEventListener('input', () => {
      p.gaugeLabelScale = parseFloat(gaugeLabelSlider.value) / 100;
      gaugeLabelDisplay.textContent = gaugeLabelSlider.value;
    });
  }

  // ---- Canvas resolution ----
  bindSlider('canvasResolutionSlider', 'canvasResolutionValue', () => p.canvasResolution, v => p.canvasResolution = v, v => v.toFixed(1));

  // ---- Engine throttle response ----
  bindSlider('throttleRiseSlider',  'throttleRiseValue',  () => p.throttleRise,  v => p.throttleRise = v,  v => v.toFixed(2));
  bindSlider('throttleFallSlider',  'throttleFallValue',  () => p.throttleFall,  v => p.throttleFall = v,  v => v.toFixed(2));
  bindSlider('wheelRadiusSlider',   'wheelRadiusValue',   () => p.wheelRadius,      v => p.wheelRadius = v,      v => Math.round(v));
  bindSlider('stallResistSlider',   'stallResistValue',   () => p.stallResistance,  v => p.stallResistance = v,  v => v.toFixed(2));

  // ---- Clutch bite/slip model ----
  bindSlider('clutchTimeSlider',   'clutchTimeValue',   () => p.clutchEngagementTime, v => p.clutchEngagementTime = v, v => v.toFixed(2));
  bindSlider('clutchBiteSlider',   'clutchBiteValue',   () => p.clutchBitePoint,      v => p.clutchBitePoint = v,      v => v.toFixed(2));
  bindSlider('clutchRangeSlider',  'clutchRangeValue',  () => p.clutchBiteRange,      v => p.clutchBiteRange = v,      v => v.toFixed(2));
  bindSlider('clutchCurveSlider',  'clutchCurveValue',  () => p.clutchCurve,          v => p.clutchCurve = v,          v => v.toFixed(1));
  bindSlider('clutchSyncSlider',   'clutchSyncValue',   () => p.clutchSyncRPMPerSec,  v => p.clutchSyncRPMPerSec = v,  v => Math.round(v));

  // ---- Engine on/off toggle ----
  const engineBtn = document.getElementById('engineToggleBtn');
  if (engineBtn) {
    const updateLabel = () => {
      engineBtn.textContent = state.engine.isRunning ? '⏹ STOP ENGINE' : '▶ START ENGINE';
      engineBtn.style.borderColor = state.engine.isRunning ? '#c0392b' : '#27ae60';
      engineBtn.style.color = state.engine.isRunning ? '#c0392b' : '#27ae60';
    };
    updateLabel();
    engineBtn.addEventListener('click', () => {
      state.engine.isRunning = !state.engine.isRunning;
      if (state.engine.isRunning) { state.engine.isStalled = false; state.engine.rpm = 800; }
      updateLabel();
    });
  }

  // ---- Temperature rise/fall (independent from throttle) ----
  bindSlider('heatRiseSlider',  'heatRiseValue',  () => p.heatGenerationRate,  v => p.heatGenerationRate = v,  v => v.toFixed(0));
  bindSlider('heatFallSlider',  'heatFallValue',  () => p.heatDissipationRate, v => p.heatDissipationRate = v, v => v.toFixed(0));

  // ---- Camera sliders ----
  bindSlider('cameraStiffnessSlider', 'cameraStiffnessValue', () => p.cameraStiffness,      v => p.cameraStiffness = v,      v => v.toFixed(1));
  bindSlider('cameraDampingSlider',   'cameraDampingValue',   () => p.cameraDamping,         v => p.cameraDamping = v,         v => v.toFixed(1));
  bindSlider('cameraZoomSlider',      'cameraZoomValue',      () => p.cameraZoomSensitivity, v => p.cameraZoomSensitivity = v, v => v.toFixed(2));

  // ---- Motion blur sliders ----
  bindSlider('blurSamplesSlider',   'blurSamplesValue',   () => p.motionBlurSamples,   v => p.motionBlurSamples = v,   v => Math.round(v));
  bindSlider('blurIntensitySlider', 'blurIntensityValue', () => p.motionBlurIntensity, v => p.motionBlurIntensity = v, v => v.toFixed(2));
  bindSlider('blurThresholdSlider', 'blurThresholdValue', () => p.motionBlurThreshold, v => p.motionBlurThreshold = v, v => Math.round(v));

  // ---- Map size sliders ----
  bindSlider('mapWidthSlider',  'mapWidthValue',  () => p.mapWidth,  v => p.mapWidth = v,  v => Math.round(v));
  bindSlider('mapHeightSlider', 'mapHeightValue', () => p.mapHeight, v => p.mapHeight = v, v => Math.round(v));
}


// =============================================================
// INFO BAR UPDATE
// =============================================================

export function updateInfoBar() {
  const speed = Math.hypot(state.velocity.x, state.velocity.y);
  const headingDegrees = ((state.carHeading * 180 / Math.PI) % 360 + 360) % 360;

  document.getElementById('velocityDisplay').textContent = speed.toFixed(1);
  document.getElementById('rpmDisplay').textContent =
    !state.engine.isRunning ? 'OFF' :
    state.engine.isStalled ? 'STALL' : Math.round(state.engine.rpm);
  document.getElementById('gearDisplay').textContent = state.engine.currentGear;
  document.getElementById('headingDisplay').textContent = headingDegrees.toFixed(0) + '°';
  document.getElementById('trailCount').textContent = state.trail.arrows.length;
  document.getElementById('tempDisplay').textContent =
    Math.round(state.engine.temperatureCelsius) + '°';
}