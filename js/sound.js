// =============================================================
// js/sound.js — Engine Sound Module (Phase 8 + Phase 10 Fix)
// =============================================================
// Extracted from engine_sound.html and adapted as a pure ES6 module.
// Zero DOM dependencies — all parameters live in state.soundParams.
// Receives RPM and throttle via function arguments only.
//
// Phase 10 Fix: applyAllAudioParams() now reads from state.soundParams
// instead of module-level soundParams to allow real-time slider updates.
//
// Exports:
//   startEngine()                                — init AudioContext + node graph
//   stopEngine()                                 — tear down graph, suspend context
//   updateEngineSound(rpm, maxRpm, throttle)     — called every physics sub-step
// =============================================================

import state from './state.js';

// =============================================================
// MODULE-LEVEL AUDIO NODE VARIABLES
// =============================================================

let audioCtx       = null;  // AudioContext — created on first startEngine() call
let masterGain     = null;  // Master volume control
let summingGain    = null;  // Mix bus before distortion
let waveshaper     = null;  // Distortion waveshaper
let dryGain        = null;  // Dry (pre-reverb) send
let wetGain        = null;  // Wet (post-reverb) send
let convolver      = null;  // Reverb convolver

// Oscillator sources
let mainOsc        = null;  // Main sawtooth oscillator
let subOsc         = null;  // Sub sine oscillator
let harmonicOsc    = null;  // Harmonic triangle oscillator
let turboOsc       = null;  // Turbo/supercharger sine oscillator
let noiseSource    = null;  // Looping white noise buffer source

// Per-source gain and filter nodes
let mainGainNode   = null;
let mainLowpass    = null;
let subGainNode    = null;
let harmonicGainNode = null;
let turboGainNode  = null;
let noiseBandpass  = null;
let noiseGainNode  = null;

// =============================================================
// STATE
// =============================================================

let isRunning      = false;   // True after startEngine(), false after stopEngine()
let lastUpdateTime = -1;      // audioCtx.currentTime at last applyAllAudioParams call

// Debounce threshold: skip audio param updates if called again within 1ms.
// Prevents over-scheduling AudioParams across multiple physics sub-steps per frame.
const DEBOUNCE_THRESHOLD = 0.001;

// Smooth ramp time for AudioParam changes — 50ms, matching engine_sound.html.
const SMOOTH_TIME = 0.05;

// RPM range constants matching engine_sound.html
const MIN_RPM = 600;

// Cylinder count — 5 cylinders default (inline-5, distinctive sound)
let cylinderCount = 5;

// =============================================================
// SOUND PARAMETERS — defaults matching engine_sound.html resetDefaults()
// =============================================================
// All former document.getElementById() reads are replaced by this object.
// A future setSoundParam(key, value) call can adjust these at runtime.

const soundParams = {
  masterVol:      0.5,    // Master output volume [0–1]
  mainGain:       0.3,    // Sawtooth oscillator gain [0–1]
  mainFltLow:     200,    // Filter cutoff at idle RPM (Hz)
  mainFltHigh:    2000,   // Filter cutoff at max RPM (Hz)
  mainFltQ:       0.7,    // Filter resonance Q factor
  subGain:        0.25,   // Sub oscillator gain [0–1]
  subMult:        0.5,    // Sub oscillator frequency multiplier
  harmonicEnable: false,  // Enable 2.5th harmonic oscillator
  harmonicGain:   0.2,    // Harmonic oscillator gain [0–1]
  harmonicMult:   2.5,    // Harmonic oscillator frequency multiplier
  noiseGain:      0.1,    // Exhaust/intake noise gain [0–1]
  noiseLow:       300,    // Noise bandpass center at idle (Hz)
  noiseHigh:      2500,   // Noise bandpass center at max RPM (Hz)
  noiseQ:         1.5,    // Noise bandpass Q factor
  turboEnable:    false,  // Enable turbo/supercharger whine oscillator
  turboGain:      0.15,   // Turbo oscillator gain [0–1]
  turboMult:      20,     // Turbo oscillator frequency multiplier
  distDrive:      0,      // Distortion drive amount [0–1]
  reverbMix:      0,      // Reverb wet/dry mix [0–1]
};

// =============================================================
// HELPER — Create white noise buffer
// =============================================================

function createNoiseBuffer(ctx, duration) {
  // Fills a mono AudioBuffer with uniform white noise [-1, 1].
  // duration in seconds; looped by the BufferSourceNode.
  const sampleRate = ctx.sampleRate;
  const bufferSize = Math.floor(sampleRate * duration);
  const buffer     = ctx.createBuffer(1, bufferSize, sampleRate);
  const data       = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

// =============================================================
// HELPER — Create reverb impulse response
// =============================================================

function createReverbImpulse(ctx, duration, decay) {
  // Generates a stereo exponentially-decaying noise impulse for the convolver.
  // duration in seconds, decay controls how quickly it fades.
  const sampleRate = ctx.sampleRate;
  const length     = Math.floor(sampleRate * duration);
  const buffer     = ctx.createBuffer(2, length, sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t        = i / sampleRate;
      const envelope = Math.exp(-decay * t);
      data[i]        = (Math.random() * 2 - 1) * envelope;
    }
  }
  return buffer;
}

// =============================================================
// HELPER — Update waveshaper distortion curve
// =============================================================

function setDistortionCurve(drive) {
  // Builds a soft-clip wave shaping curve. drive=0 is linear, drive=1 is full clip.
  if (!waveshaper) return;
  const samples = 2048;
  const curve   = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    const a = 1 - drive;
    const b = drive;
    curve[i] = a * x + b * Math.tanh(3 * x);
  }
  waveshaper.curve = curve;
}

// =============================================================
// INTERNAL — Apply all audio parameters from soundParams + current RPM
// =============================================================

function applyAllAudioParams(rpm, maxRpm, throttlePosition) {
  if (!isRunning || !audioCtx) return;

  // Firing frequency for a 4-stroke engine: RPM × cylinders / 120
  // (Each cylinder fires once every 2 crankshaft revolutions = RPM/2/60 × cylinders)
  const mainFreq = rpm * cylinderCount / 120;

  // Normalise RPM to [0, 1] range for parameter sweeps
  const rpmNorm = Math.max(0, Math.min(1, (rpm - MIN_RPM) / (maxRpm - MIN_RPM)));

  const now = audioCtx.currentTime;
  const rampTo = now + SMOOTH_TIME;

  // ── Master volume ──────────────────────────────────────────
  masterGain.gain.linearRampToValueAtTime(state.soundParams.masterVol, rampTo);

  // ── Main oscillator (sawtooth) ─────────────────────────────
  // Filter cutoff sweeps from mainFltLow at idle to mainFltHigh at redline.
  const mainCutoff = state.soundParams.mainFltLow +
    rpmNorm * (state.soundParams.mainFltHigh - state.soundParams.mainFltLow);

  mainOsc.frequency.linearRampToValueAtTime(mainFreq, rampTo);
  mainGainNode.gain.linearRampToValueAtTime(state.soundParams.mainGain, rampTo);
  mainLowpass.frequency.linearRampToValueAtTime(mainCutoff, rampTo);
  mainLowpass.Q.linearRampToValueAtTime(state.soundParams.mainFltQ, rampTo);

  // ── Sub oscillator (sine) ──────────────────────────────────
  subOsc.frequency.linearRampToValueAtTime(mainFreq * state.soundParams.subMult, rampTo);
  subGainNode.gain.linearRampToValueAtTime(state.soundParams.subGain, rampTo);

  // ── Harmonic oscillator (triangle, 2.5× default) ──────────
  const harmonicGain = state.soundParams.harmonicEnable ? state.soundParams.harmonicGain : 0;
  harmonicOsc.frequency.linearRampToValueAtTime(mainFreq * state.soundParams.harmonicMult, rampTo);
  harmonicGainNode.gain.linearRampToValueAtTime(harmonicGain, rampTo);

  // ── Turbo oscillator (sine, 20× default) ──────────────────
  const turboGain = state.soundParams.turboEnable ? state.soundParams.turboGain : 0;
  turboOsc.frequency.linearRampToValueAtTime(mainFreq * state.soundParams.turboMult, rampTo);
  turboGainNode.gain.linearRampToValueAtTime(turboGain, rampTo);

  // ── Exhaust/intake noise (bandpass-filtered white noise) ───
  // Center frequency sweeps from noiseLow at idle to noiseHigh at redline.
  // Throttle position boosts noise gain slightly at high throttle (intake roar).
  const noiseCenter = state.soundParams.noiseLow +
    rpmNorm * (state.soundParams.noiseHigh - state.soundParams.noiseLow);
  const noiseGainBoost = state.soundParams.noiseGain * (1 + throttlePosition * 0.3);

  noiseGainNode.gain.linearRampToValueAtTime(noiseGainBoost, rampTo);
  noiseBandpass.frequency.linearRampToValueAtTime(noiseCenter, rampTo);
  noiseBandpass.Q.linearRampToValueAtTime(state.soundParams.noiseQ, rampTo);

  // ── Distortion drive ───────────────────────────────────────
  setDistortionCurve(state.soundParams.distDrive);

  // ── Reverb mix ─────────────────────────────────────────────
  dryGain.gain.linearRampToValueAtTime(1 - state.soundParams.reverbMix, rampTo);
  wetGain.gain.linearRampToValueAtTime(state.soundParams.reverbMix, rampTo);
}

// =============================================================
// EXPORT — startEngine()
// =============================================================

export function startEngine() {
  if (isRunning) return;

  // Create or resume AudioContext (must be called from a user gesture).
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  // ── Master gain ────────────────────────────────────────────
  masterGain = audioCtx.createGain();
  masterGain.gain.value = soundParams.masterVol;

  // ── Mix bus (summing point before distortion) ──────────────
  summingGain = audioCtx.createGain();
  summingGain.gain.value = 1;

  // ── Distortion waveshaper ──────────────────────────────────
  waveshaper = audioCtx.createWaveShaper();
  waveshaper.oversample = '4x';
  setDistortionCurve(soundParams.distDrive);

  // ── Reverb dry/wet split ───────────────────────────────────
  dryGain  = audioCtx.createGain();
  wetGain  = audioCtx.createGain();
  convolver = audioCtx.createConvolver();
  convolver.buffer = createReverbImpulse(audioCtx, 2.0, 3.0);

  // Signal chain:
  // summingGain → waveshaper → dryGain → masterGain → output
  //                          → convolver → wetGain → masterGain
  summingGain.connect(waveshaper);
  waveshaper.connect(dryGain);
  waveshaper.connect(convolver);
  convolver.connect(wetGain);
  dryGain.connect(masterGain);
  wetGain.connect(masterGain);
  masterGain.connect(audioCtx.destination);

  // ── Main oscillator chain (sawtooth → gain → lowpass → sum) ─
  mainOsc = audioCtx.createOscillator();
  mainOsc.type = 'sawtooth';
  mainOsc.frequency.value = MIN_RPM * cylinderCount / 120;

  mainGainNode = audioCtx.createGain();
  mainGainNode.gain.value = soundParams.mainGain;

  mainLowpass = audioCtx.createBiquadFilter();
  mainLowpass.type = 'lowpass';
  mainLowpass.frequency.value = soundParams.mainFltLow;
  mainLowpass.Q.value = soundParams.mainFltQ;

  mainOsc.connect(mainGainNode);
  mainGainNode.connect(mainLowpass);
  mainLowpass.connect(summingGain);

  // ── Sub oscillator chain (sine → gain → sum) ──────────────
  subOsc = audioCtx.createOscillator();
  subOsc.type = 'sine';
  subOsc.frequency.value = MIN_RPM * cylinderCount / 120 * soundParams.subMult;

  subGainNode = audioCtx.createGain();
  subGainNode.gain.value = soundParams.subGain;

  subOsc.connect(subGainNode);
  subGainNode.connect(summingGain);

  // ── Harmonic oscillator chain (triangle → gain → sum) ─────
  harmonicOsc = audioCtx.createOscillator();
  harmonicOsc.type = 'triangle';
  harmonicOsc.frequency.value = MIN_RPM * cylinderCount / 120 * soundParams.harmonicMult;

  harmonicGainNode = audioCtx.createGain();
  harmonicGainNode.gain.value = soundParams.harmonicEnable ? soundParams.harmonicGain : 0;

  harmonicOsc.connect(harmonicGainNode);
  harmonicGainNode.connect(summingGain);

  // ── Turbo oscillator chain (sine → gain → sum) ────────────
  turboOsc = audioCtx.createOscillator();
  turboOsc.type = 'sine';
  turboOsc.frequency.value = MIN_RPM * cylinderCount / 120 * soundParams.turboMult;

  turboGainNode = audioCtx.createGain();
  turboGainNode.gain.value = soundParams.turboEnable ? soundParams.turboGain : 0;

  turboOsc.connect(turboGainNode);
  turboGainNode.connect(summingGain);

  // ── Noise chain (buffer → bandpass → gain → sum) ──────────
  const noiseBuffer = createNoiseBuffer(audioCtx, 2);
  noiseSource = audioCtx.createBufferSource();
  noiseSource.buffer = noiseBuffer;
  noiseSource.loop = true;

  noiseBandpass = audioCtx.createBiquadFilter();
  noiseBandpass.type = 'bandpass';
  noiseBandpass.frequency.value = soundParams.noiseLow;
  noiseBandpass.Q.value = soundParams.noiseQ;

  noiseGainNode = audioCtx.createGain();
  noiseGainNode.gain.value = soundParams.noiseGain;

  noiseSource.connect(noiseBandpass);
  noiseBandpass.connect(noiseGainNode);
  noiseGainNode.connect(summingGain);

  // ── Start all sources ──────────────────────────────────────
  mainOsc.start(0);
  subOsc.start(0);
  harmonicOsc.start(0);
  turboOsc.start(0);
  noiseSource.start(0);

  isRunning = true;
  lastUpdateTime = -1;

  // Cleanup on page unload — prevents AudioContext from hanging open.
  window.addEventListener('beforeunload', stopEngine);
}

// =============================================================
// EXPORT — stopEngine()
// =============================================================

export function stopEngine() {
  if (!isRunning) return;

  // Stop all oscillator and noise sources.
  try { mainOsc.stop(0);     } catch (_) {}
  try { subOsc.stop(0);      } catch (_) {}
  try { harmonicOsc.stop(0); } catch (_) {}
  try { turboOsc.stop(0);    } catch (_) {}
  try { noiseSource.stop(0); } catch (_) {}

  // Disconnect and null all nodes to release memory.
  [
    mainOsc, subOsc, harmonicOsc, turboOsc, noiseSource,
    mainGainNode, subGainNode, harmonicGainNode, turboGainNode, noiseGainNode,
    mainLowpass, noiseBandpass,
    summingGain, waveshaper, dryGain, wetGain, convolver, masterGain,
  ].forEach(node => {
    if (node && node.disconnect) node.disconnect();
  });

  mainOsc = subOsc = harmonicOsc = turboOsc = noiseSource = null;
  mainGainNode = subGainNode = harmonicGainNode = turboGainNode = noiseGainNode = null;
  mainLowpass = noiseBandpass = null;
  summingGain = waveshaper = dryGain = wetGain = convolver = masterGain = null;

  isRunning = false;

  if (audioCtx && audioCtx.state === 'running') {
    audioCtx.suspend();
  }
}

// =============================================================
// EXPORT — updateEngineSound(rpm, maxRpm, throttlePosition)
// =============================================================
// Called every physics sub-step from physics.js.
// rpm              — current engine RPM (0 = stalled/off, fade to silence)
// maxRpm           — tachometer max (used for normalisation)
// throttlePosition — [0, 1] throttle input (boosts noise gain slightly)

export function updateEngineSound(rpm, maxRpm, throttlePosition) {
  // Guard: AudioContext not started yet — button not clicked.
  if (!isRunning || !audioCtx) return;

  // Debounce: called multiple times per animation frame (physics sub-steps).
  // Skip if AudioContext clock has not advanced by at least 1ms since last call.
  if (audioCtx.currentTime - lastUpdateTime < DEBOUNCE_THRESHOLD) return;
  lastUpdateTime = audioCtx.currentTime;

  // rpm === 0 means engine is stalled or turned off — fade master gain to silence.
  if (rpm === 0) {
    masterGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.2);
    return;
  }

  // Restore master gain if it was faded (engine restarted after stall).
  masterGain.gain.linearRampToValueAtTime(
    state.soundParams.masterVol,
    audioCtx.currentTime + SMOOTH_TIME
  );

  // Update all audio parameters for current RPM and throttle.
  applyAllAudioParams(rpm, maxRpm, throttlePosition);
}

/**
 * Update a single sound parameter and apply it to the audio nodes.
 * Called from soundStateManager when parameters change (e.g., from sliders).
 * Safe to call whether or not the engine is running.
 *
 * @param {string} paramName - Parameter key (e.g., 'masterVol', 'mainGain')
 * @param {number|boolean} newValue - New value
 */
export function setSoundParam(paramName, newValue) {
  if (!audioCtx) return; // Engine not running, nothing to update

  // Update both module-level and state soundParams to keep them in sync
  soundParams[paramName] = newValue;
  state.soundParams[paramName] = newValue;

  // Apply parameter-specific changes to audio nodes
  const now = audioCtx.currentTime;
  const time = now + SMOOTH_TIME; // Smooth ramping to avoid clicks

  switch (paramName) {
    case 'masterVol':
      masterGain.gain.linearRampToValueAtTime(newValue, time);
      break;

    case 'mainGain':
      mainGainNode.gain.linearRampToValueAtTime(newValue, time);
      break;

    case 'mainFltLow':
    case 'mainFltHigh':
    case 'mainFltQ':
      // Filter cutoff will be recalculated based on current RPM on next updateEngineSound call
      break;

    case 'subGain':
      subGainNode.gain.linearRampToValueAtTime(newValue, time);
      break;

    case 'subMult':
      // Frequency multiplier — oscillator frequency will update on next updateEngineSound call
      break;

    case 'harmonicEnable':
    case 'harmonicGain':
      if (soundParams.harmonicEnable && harmonicGainNode) {
        harmonicGainNode.gain.linearRampToValueAtTime(
          soundParams.harmonicEnable ? soundParams.harmonicGain : 0,
          time
        );
      }
      break;

    case 'harmonicMult':
      // Frequency multiplier — oscillator frequency will update on next updateEngineSound call
      break;

    case 'noiseGain':
      noiseGainNode.gain.linearRampToValueAtTime(newValue, time);
      break;

    case 'noiseLow':
    case 'noiseHigh':
    case 'noiseQ':
      // Bandpass center will be recalculated based on current RPM on next updateEngineSound call
      break;

    case 'turboEnable':
    case 'turboGain':
      if (soundParams.turboEnable && turboGainNode) {
        turboGainNode.gain.linearRampToValueAtTime(
          soundParams.turboEnable ? soundParams.turboGain : 0,
          time
        );
      }
      break;

    case 'turboMult':
      // Frequency multiplier — oscillator frequency will update on next updateEngineSound call
      break;

    case 'distDrive':
      // Waveshaper amount — will recalculate on next updateEngineSound call
      break;

    case 'reverbMix':
      // Update wet/dry mix
      if (dryGain && wetGain) {
        const wetAmount = Math.min(1, newValue);
        const dryAmount = Math.max(0, 1 - newValue);
        dryGain.gain.linearRampToValueAtTime(dryAmount, time);
        wetGain.gain.linearRampToValueAtTime(wetAmount, time);
      }
      break;

    default:
      // Unknown parameter, ignore
      break;
  }
}
