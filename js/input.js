// =============================================================
// INPUT — keyboard and mouse event handlers
// =============================================================
// Writes to: state.input, state.steering, state.engine (via physics)
// Reads from: constants (key sets, steering geometry)
//
// Mouse controls:
//   Right-click drag horizontal → steering wheel angle
//   Left-click drag vertical   → analog throttle (0–1)
//
// Keyboard controls:
//   D = full throttle (binary fallback when mouse not used)
//   S = brake
//   A = clutch
//   Numpad = gear selection (only while clutch held)
// =============================================================

import state from './state.js';
import { handleGearChange } from './physics.js';
import {
  GAME_KEYS,
  MAX_STEERING_ANGLE,
  STEERING_DRAG_RANGE
} from './constants.js';

// Maximum vertical drag distance for full throttle (pixels)
const THROTTLE_DRAG_RANGE = 120;


/**
 * Register all input event listeners.
 * Called once from main.js at startup.
 *
 * @param {HTMLCanvasElement} simCanvas - the simulation canvas
 */
export function initInput(simCanvas) {

  // ----- KEYBOARD: throttle, brake, clutch, gear selection -----

  window.addEventListener('keydown', (event) => {
    const key = event.key;
    const code = event.code;
    state.input.heldKeys[key] = true;

    // Suppress browser defaults for game keys and numpad
    if (GAME_KEYS.has(key) || key.startsWith('Arrow') || code.startsWith('Numpad')) {
      event.preventDefault();
    }

    // Throttle = D (binary fallback; mouse drag gives analog control)
    if (key === 'd' || key === 'D') state.input.throttlePressed = true;

    // Brake = S
    if (key === 's' || key === 'S') state.input.brakePressed = true;

    // Clutch = A
    if (key === 'a' || key === 'A') state.input.clutchPressed = true;

    // Gear selection (only allowed while clutch is held)
    if (state.input.clutchPressed) {
      selectGear(code);
    }
  });

  window.addEventListener('keyup', (event) => {
    const key = event.key;
    const code = event.code;
    state.input.heldKeys[key] = false;

    if (key === 'd' || key === 'D') state.input.throttlePressed = false;
    if (key === 's' || key === 'S') state.input.brakePressed = false;
    if (key === 'a' || key === 'A') state.input.clutchPressed = false;

    if (GAME_KEYS.has(key) || key.startsWith('Arrow') || code.startsWith('Numpad')) {
      event.preventDefault();
    }
  });


  // ----- MOUSE: right-click drag = steering, left-click drag = throttle -----

  simCanvas.addEventListener('mousedown', (event) => {
    event.preventDefault();

    if (event.button === 2 || event.button === 0 && event.shiftKey) {
      // Right-click (or shift+left-click) = steering
      state.steering.isDragging = true;
      state.steering.dragStartX = event.clientX;
    } else if (event.button === 0) {
      // Left-click = analog throttle via vertical drag
      state.input.mouseThrottleActive = true;
      state.input.mouseThrottleDragStartY = event.clientY;
      state.input.mouseThrottleAmount = 0.0;
    }
  });

  // Prevent the right-click context menu on the canvas
  simCanvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });

  window.addEventListener('mousemove', (event) => {
    // Steering drag (right-click or shift+left-click)
    if (state.steering.isDragging) {
      const deltaX = event.clientX - state.steering.dragStartX;
      const clampedDelta = Math.max(-STEERING_DRAG_RANGE, Math.min(STEERING_DRAG_RANGE, deltaX));
      state.steering.wheelAngle = (clampedDelta / STEERING_DRAG_RANGE) * MAX_STEERING_ANGLE;
    }

    // Analog throttle drag (left-click vertical)
    if (state.input.mouseThrottleActive) {
      // Dragging UP increases throttle, dragging DOWN decreases
      const deltaY = state.input.mouseThrottleDragStartY - event.clientY;
      const normalizedThrottle = Math.max(0, Math.min(1, deltaY / THROTTLE_DRAG_RANGE));
      state.input.mouseThrottleAmount = normalizedThrottle;
    }
  });

  window.addEventListener('mouseup', (event) => {
    if (event.button === 2 || (event.button === 0 && state.steering.isDragging && !state.input.mouseThrottleActive)) {
      state.steering.isDragging = false;
    }
    if (event.button === 0) {
      state.input.mouseThrottleActive = false;
      state.input.mouseThrottleAmount = 0.0;
      // Also release steering if it was shift+left-click
      if (state.steering.isDragging && !event.shiftKey) {
        state.steering.isDragging = false;
      }
    }
  });
}


/**
 * Map numpad key codes to gear changes.
 * Now calls physics.handleGearChange() so the drivetrain can
 * react to the shift (rev-match blips, RPM adjustments, etc).
 *
 * Gear layout on numpad:
 *   7=1st  8=3rd  9=5th
 *   4=N    5=N    6=N
 *   1=2nd  2=4th  3=6th
 *   (Q+1 = Reverse)
 *
 * @param {string} code - the KeyboardEvent.code value
 */
function selectGear(code) {
  const held = state.input.heldKeys;
  let newGear = null;

  switch (code) {
    case 'Numpad7': newGear = '1'; break;
    case 'Numpad1':
      newGear = (held['q'] || held['Q']) ? 'R' : '2';
      break;
    case 'Numpad8': newGear = '3'; break;
    case 'Numpad2': newGear = '4'; break;
    case 'Numpad9': newGear = '5'; break;
    case 'Numpad3': newGear = '6'; break;
    case 'Numpad4':
    case 'Numpad5':
    case 'Numpad6': newGear = 'N'; break;
  }

  if (newGear !== null) {
    handleGearChange(newGear);
  }
}
