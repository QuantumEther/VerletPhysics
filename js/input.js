// =============================================================
// INPUT — keyboard and mouse event handlers
// =============================================================
// Writes to: state.input, state.steering (via mouse drag)
// Reads from: constants (steering geometry, key definitions)
// Calls: handleGearChange() from physics.js when a gear key is pressed
//
// Control scheme:
//   D key:            full throttle (binary; mouse drag gives analog)
//   S key:            brake
//   A key:            clutch pedal to floor (hold to disengage, release to engage)
//   Right-click drag: steering wheel (horizontal drag)
//   Left-click drag:  analog throttle (vertical drag, up = more throttle)
//   Shift+left-click: also steering (alternative for one-button mice)
//
//   Gear changes (while A is held or at any time):
//     Numpad 7 → 1st gear
//     Numpad 1 → 2nd gear
//     Numpad 8 → 3rd gear
//     Numpad 2 → 4th gear
//     Numpad 9 → 5th gear
//     Numpad 3 → 6th gear
//     Numpad 4 / 5 / 6 → Neutral
//     Q + Numpad 1 → Reverse
// =============================================================

import state from './state.js';
import { handleGearChange } from './physics.js';
import {
  STEERING_DRAG_RANGE_PX,
  MAX_FRONT_WHEEL_ANGLE_RAD,
} from './constants.js';


// Keys that should have their default browser behaviour suppressed
// (e.g., numpad keys scroll the page; space opens quick-find).
const KEYS_TO_SUPPRESS_DEFAULT = new Set([
  'KeyD', 'KeyS', 'KeyA', 'KeyQ',
  'Numpad1', 'Numpad2', 'Numpad3',
  'Numpad4', 'Numpad5', 'Numpad6',
  'Numpad7', 'Numpad8', 'Numpad9',
  'Space',
]);

// Maximum vertical drag distance for full throttle (pixels).
// Dragging the mouse this many pixels upward from the drag start = 100% throttle.
const THROTTLE_DRAG_RANGE_PX = 120;

// Maximum visual steering wheel angle the HUD indicator can show (radians).
// This is deliberately larger than MAX_FRONT_WHEEL_ANGLE_RAD to give an
// arcade-style steering wheel with many turns of lock visible on screen.
const MAX_VISUAL_WHEEL_ANGLE_RAD = Math.PI * 2.5;


// =============================================================
// INITIALISATION
// =============================================================

// Attaches all keyboard and mouse event listeners to the simulation canvas.
// Must be called once from main.js after the canvas is created.
export function initInput(simulationCanvas) {
  document.addEventListener('keydown',  onKeyDown);
  document.addEventListener('keyup',    onKeyUp);

  simulationCanvas.addEventListener('mousedown',  onMouseDown);
  simulationCanvas.addEventListener('mousemove',  onMouseMove);
  simulationCanvas.addEventListener('mouseup',    onMouseUp);
  simulationCanvas.addEventListener('mouseleave', onMouseUp); // treat leaving as release

  // Prevent context menu on right-click so right-drag works without interruption.
  simulationCanvas.addEventListener('contextmenu', (event) => event.preventDefault());
}


// =============================================================
// KEYBOARD EVENTS
// =============================================================

function onKeyDown(event) {
  if (KEYS_TO_SUPPRESS_DEFAULT.has(event.code)) {
    event.preventDefault();
  }

  state.input.heldKeys[event.code] = true;

  switch (event.code) {
    case 'KeyD':
      state.input.throttleKeyHeld = true;
      break;

    case 'KeyS':
      state.input.brakeKeyHeld = true;
      break;

    case 'KeyA':
      state.input.clutchKeyHeld = true;
      break;

    // Gear selection via numpad.
    // The gear is selectable at any time; holding A first is conventional
    // but not enforced — the engine/clutch model handles the consequence.
    case 'Numpad7': selectGear('1', event); break;
    case 'Numpad1': selectGear(isQHeld() ? 'R' : '2', event); break;
    case 'Numpad8': selectGear('3', event); break;
    case 'Numpad2': selectGear('4', event); break;
    case 'Numpad9': selectGear('5', event); break;
    case 'Numpad3': selectGear('6', event); break;
    case 'Numpad4':
    case 'Numpad5':
    case 'Numpad6':
      selectGear('N', event);
      break;
  }
}

function onKeyUp(event) {
  delete state.input.heldKeys[event.code];

  switch (event.code) {
    case 'KeyD':
      state.input.throttleKeyHeld = false;
      break;

    case 'KeyS':
      state.input.brakeKeyHeld = false;
      break;

    case 'KeyA':
      state.input.clutchKeyHeld = false;
      break;
  }
}

// Returns true if the Q key is currently held.
// Q + Numpad1 selects Reverse.
function isQHeld() {
  return !!state.input.heldKeys['KeyQ'];
}

// Maps a gear letter to a call to handleGearChange in physics.js.
// gear: 'N', 'R', '1' through '6'
function selectGear(gear, _event) {
  handleGearChange(gear);
}


// =============================================================
// MOUSE EVENTS
// =============================================================

function onMouseDown(event) {
  event.preventDefault();

  // Right mouse button (button 2) OR Shift+Left button (button 0):
  //   → steering drag
  const isSteeringButton = event.button === 2 ||
                           (event.button === 0 && event.shiftKey);

  // Left mouse button without Shift: → throttle drag
  const isThrottleButton = event.button === 0 && !event.shiftKey;

  if (isSteeringButton) {
    state.steering.isDragging    = true;
    state.steering.dragStartX    = event.clientX;
  }

  if (isThrottleButton) {
    state.input.mouseThrottleActive       = true;
    state.input.mouseThrottleDragStartY   = event.clientY;
  }
}

function onMouseMove(event) {
  // Steering: horizontal drag from the drag start position maps to wheel angle.
  // Full STEERING_DRAG_RANGE_PX pixels of drag = full visual steering lock.
  if (state.steering.isDragging) {
    const dragDelta     = event.clientX - state.steering.dragStartX;
    const normalisedDrag = dragDelta / STEERING_DRAG_RANGE_PX; // can exceed ±1

    // Visual wheel angle: larger range than physical tyre angle for feel.
    state.steering.wheelAngle = normalisedDrag * MAX_VISUAL_WHEEL_ANGLE_RAD;
    // Clamp so the visual doesn't spin forever with large drags.
    const maxVisual = MAX_VISUAL_WHEEL_ANGLE_RAD;
    if (state.steering.wheelAngle >  maxVisual) state.steering.wheelAngle =  maxVisual;
    if (state.steering.wheelAngle < -maxVisual) state.steering.wheelAngle = -maxVisual;
  }

  // Throttle: vertical drag, up from start = more throttle.
  // Canvas Y increases downward, so dragging up = negative delta = more throttle.
  if (state.input.mouseThrottleActive) {
    const dragDelta       = event.clientY - state.input.mouseThrottleDragStartY;
    const normalisedDrag  = -dragDelta / THROTTLE_DRAG_RANGE_PX; // negative = up
    state.input.mouseThrottleAmount = Math.max(0, Math.min(1, normalisedDrag));
  }
}

function onMouseUp(event) {
  if (event.button === 2 ||
      (event.button === 0 && event.shiftKey) ||
      event.type === 'mouseleave') {
    state.steering.isDragging = false;
  }

  if (event.button === 0 || event.type === 'mouseleave') {
    state.input.mouseThrottleActive = false;
    // Do NOT reset mouseThrottleAmount here — let physics read the last value
    // for one more frame; it will be suppressed because mouseThrottleActive=false.
    // Actually, we do want to reset it so the car doesn't hold throttle if the
    // user releases without dragging back to zero.
    state.input.mouseThrottleAmount = 0;
  }
}
