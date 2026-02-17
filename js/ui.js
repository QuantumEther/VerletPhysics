// =============================================================
// UI — slider binding, info bar updates, needle physics
// =============================================================
// Handles all DOM ↔ state synchronisation.
//
// initSliders() connects every HTML slider to its state.params field.
// updateInfoBar() refreshes the text displays in the info bar.
// createNeedlePhysics() returns a spring-damper object for gauge needles.
//
// The needle physics model is separate from the physics simulation —
// it only animates the visual gauge needle, never affects car behaviour.
// =============================================================

import state from './state.js';
import {
  NEEDLE_STIFFNESS,
  NEEDLE_DAMPING,
  NEEDLE_RISE_BOOST,
  NEEDLE_FALL_BOOST,
  NEEDLE_FLUTTER_THRESHOLD,
  KPH_TO_PX_PER_SEC,
} from './constants.js';


// =============================================================
// NEEDLE PHYSICS
// =============================================================

// Creates and returns a needle physics instance.
// The needle is a spring-damper system that smoothly tracks a target
// normalised position [0, 1] without explicit velocity storage.
//
// Usage:
//   const needle = createNeedlePhysics();
//   // each frame:
//   const displayNormalized = needle.step(targetNormalized);
//
// The needle has:
//   - Asymmetric response: faster rise (RISE_BOOST), slower fall (FALL_BOOST)
//   - Flutter at high readings (> FLUTTER_THRESHOLD) to simulate a real meter
//   - Spring stiffness and exponential damping for smooth, non-oscillating motion
export function createNeedlePhysics() {
  let needlePosition = 0;    // current spring position [0, 1]
  let needleVelocity = 0;    // spring velocity (not physics velocity; spring-internal)
  let flutterCounter = 0;    // incrementing tick counter for flutter oscillation

  return {
    // Advances the needle toward targetNormalized and returns the new position.
    // Call once per animation frame.
    step(targetNormalized) {
      flutterCounter++;

      // Spring force toward target.
      const springForce = (targetNormalized - needlePosition) * NEEDLE_STIFFNESS;

      // Asymmetric response: faster when rising, slower when falling.
      const movingUp = springForce > 0;
      const boostFactor = movingUp ? NEEDLE_RISE_BOOST : NEEDLE_FALL_BOOST;

      needleVelocity += springForce * boostFactor;
      needleVelocity *= NEEDLE_DAMPING; // exponential decay each step

      needlePosition += needleVelocity;

      // Flutter near the top of the scale: simulates a vibrating mechanical needle.
      if (needlePosition > NEEDLE_FLUTTER_THRESHOLD) {
        const flutterAmplitude = (needlePosition - NEEDLE_FLUTTER_THRESHOLD) * 0.012;
        needlePosition += Math.sin(flutterCounter * 0.15) * flutterAmplitude;
      }

      // Clamp to [0, 1].
      needlePosition = needlePosition < 0 ? 0 : needlePosition > 1 ? 1 : needlePosition;
      return needlePosition;
    },
  };
}


// =============================================================
// SLIDER BINDING
// =============================================================

// Connects all HTML sliders to their corresponding state.params fields.
// Each slider writes its value to state.params on the 'input' event,
// and reads the initial state.params value on setup.
//
// The function expects HTML elements with specific id attributes,
// matching the IDs in index.html. If an element is not found, that
// slider is silently skipped (no exception thrown).
export function initSliders() {
  // Generic binder: links a slider element to a params field.
  // getValue:  slider string → typed value for state.params
  // getDisplay: typed value → display string for the label element
  // The label element is expected to have id = sliderId + 'Value'.
  function bindSlider(sliderId, getValue, getDisplay) {
    const slider = document.getElementById(sliderId);
    const label  = document.getElementById(sliderId + 'Value');
    if (!slider) return;

    // Read from slider into params on change.
    slider.addEventListener('input', () => {
      const value = getValue(slider.value);
      // Derive the params key from the slider id (camelCase convention).
      // The slider id IS the params key, so we use it directly.
      // Each call below explicitly maps id to params key for clarity.
    });
  }

  // We use explicit bindings rather than a generic mapping, because each
  // slider may need custom value conversion (log scale, inversion, etc.)
  // and we want the code to be readable without decoding a mapping table.

  function bind(sliderId, paramsKey, parseValue, formatDisplay) {
    const slider       = document.getElementById(sliderId);
    const displayLabel = document.getElementById(sliderId + 'Value');
    if (!slider) return;

    // Initialise slider from state.params (in case HTML default differs).
    // We do NOT set slider.value here because the HTML value is the source of
    // truth at startup — we set params from the slider on init.
    const initialValue = parseValue(slider.value);
    state.params[paramsKey] = initialValue;
    if (displayLabel) displayLabel.textContent = formatDisplay(initialValue);

    slider.addEventListener('input', () => {
      const value = parseValue(slider.value);
      state.params[paramsKey] = value;
      if (displayLabel) displayLabel.textContent = formatDisplay(value);
    });
  }

  // Helper formatters.
  const fmt1  = (v) => v.toFixed(1);
  const fmt2  = (v) => v.toFixed(2);
  const fmt3  = (v) => v.toFixed(3);
  const fmt4  = (v) => v.toFixed(4);
  const fmtInt = (v) => String(Math.round(v));
  const fmtPct = (v) => (v * 100).toFixed(0) + '%';
  const parseFloat1 = (s) => parseFloat(s);
  const parseInt1   = (s) => parseInt(s, 10);

  // ---- Simulation ----
  bind('simulationFps',    'simulationFps',    (s) => {
    // Snap to nearest 10 Hz.
    const raw    = parseInt(s, 10);
    const snapped = Math.round(raw / 10) * 10;
    return Math.max(10, Math.min(120, snapped));
  }, fmtInt);

  bind('timeScale', 'timeScale', parseFloat1, fmt2);

  // ---- Car physics ----
  bind('carMassKg',             'carMassKg',            parseFloat1, fmtInt);
  bind('rollingResistanceCoeff','rollingResistanceCoeff',parseFloat1, fmt4);
  bind('aeroDragCoeff',         'aeroDragCoeff',         parseFloat1, fmt5);
  bind('tireFrictionCoeff',     'tireFrictionCoeff',     parseFloat1, fmt2);
  bind('cogHeightPx',           'cogHeightPx',           parseFloat1, fmt1);
  bind('bounciness',            'bounciness',            parseFloat1, fmt2);
  bind('stallResistance',       'stallResistance',       parseFloat1, fmt2);

  // ---- Clutch ----
  bind('clutchBitePoint',  'clutchBitePoint',  parseFloat1, fmt2);
  bind('clutchBiteRange',  'clutchBiteRange',  parseFloat1, fmt2);
  bind('clutchBiteCurve',  'clutchBiteCurve',  parseFloat1, fmt1);
  bind('clutchEngageTime', 'clutchEngageTime', parseFloat1, fmt2);

  // ---- Trail ----
  bind('trailSpawnInterval', 'trailSpawnInterval', (s) => {
    // Logarithmic mapping: 0.001 s to 10 s.
    const raw = parseFloat(s) / 100; // slider 0–100 → 0–1
    return 0.001 * Math.pow(10000, raw); // log scale
  }, (v) => v.toFixed(3) + 's');

  bind('trailLifespan', 'trailLifespan', parseFloat1, fmt1);
  bind('trailFade',     'trailFade',     parseFloat1, fmt2);

  // ---- Camera ----
  bind('cameraStiffness',       'cameraStiffness',       parseFloat1, fmt1);
  bind('cameraDamping',         'cameraDamping',         parseFloat1, fmt1);
  bind('cameraZoomSensitivity', 'cameraZoomSensitivity', parseFloat1, fmt2);

  // ---- Motion blur ----
  bind('motionBlurSamples',   'motionBlurSamples',   parseInt1,   fmtInt);
  bind('motionBlurIntensity', 'motionBlurIntensity', parseFloat1, fmt2);
  bind('motionBlurThreshold', 'motionBlurThreshold', parseFloat1, fmtInt);

  // ---- Map ----
  bind('mapWidth',  'mapWidth',  parseFloat1, fmtInt);
  bind('mapHeight', 'mapHeight', parseFloat1, fmtInt);

  // ---- Gauges ----
  bind('gaugeLabelScale', 'gaugeLabelScale', (s) => {
    // Slider 60–160 → scale 0.6–1.6
    return parseFloat(s) / 100;
  }, (v) => v.toFixed(1) + '×');

  // ---- Engine toggle button ----
  const engineToggleButton = document.getElementById('engineToggle');
  if (engineToggleButton) {
    engineToggleButton.addEventListener('click', () => {
      state.engine.isRunning = !state.engine.isRunning;
      if (state.engine.isRunning) {
        state.engine.isStalled = false;
        state.engine.rpm = 800; // restart at idle
        engineToggleButton.textContent = 'Engine ON';
        engineToggleButton.style.background = '#2ecc71';
      } else {
        engineToggleButton.textContent = 'Engine OFF';
        engineToggleButton.style.background = '#e74c3c';
      }
    });
  }
}

// Helper: 5 decimal place formatter (for very small coefficients like aeroDragCoeff).
function fmt5(v) { return v.toFixed(5); }


// =============================================================
// INFO BAR
// =============================================================

// Updates the text displays in the info bar at the bottom of the simulation canvas.
// Called once per animation frame from main.js.
// Reads from state.body and state.engine.
export function updateInfoBar() {
  const body   = state.body;
  const engine = state.engine;
  const trail  = state.trail;

  setInfoCell('velocityDisplay',
    `${(body.speed / KPH_TO_PX_PER_SEC).toFixed(1)} km/h`);

  setInfoCell('rpmDisplay',
    engine.isStalled ? 'STALL' :
    !engine.isRunning ? 'OFF' :
    `${Math.round(engine.rpm)} rpm`);

  setInfoCell('gearDisplay', engine.currentGear);

  setInfoCell('headingDisplay',
    `${(body.heading * 180 / Math.PI % 360 + 360).toFixed(0)}°`);

  setInfoCell('clutchDisplay',
    `${(engine.clutchEngagement * 100).toFixed(0)}%`);

  setInfoCell('trailDisplay',
    `${trail.arrows.length} arrows`);
}

// Sets the textContent of an info cell by id, silently skipping if not found.
function setInfoCell(elementId, text) {
  const element = document.getElementById(elementId);
  if (element) element.textContent = text;
}
