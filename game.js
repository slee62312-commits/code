const audioBtn = document.getElementById("audioBtn");
const resetBtn = document.getElementById("resetBtn");
const audioStatus = document.getElementById("audioStatus");
const harmonicLevelEl = document.getElementById("harmonicLevel");
const baseNoteEl = document.getElementById("baseNote");
const finalNoteEl = document.getElementById("finalNote");
const valveOffsetEl = document.getElementById("valveOffset");
const comboEl = document.getElementById("combo");
const pressedKeysEl = document.getElementById("pressedKeys");
const staffCanvas = document.getElementById("staffCanvas");
const staffNoteEl = document.getElementById("staffNote");
const metroBtn = document.getElementById("metroBtn");
const bpmSlider = document.getElementById("bpmSlider");
const bpmValueEl = document.getElementById("bpmValue");
const metroTicks = document.querySelectorAll(".tick");

const keycaps = new Map();

document.querySelectorAll(".keycap").forEach((el) => {
  keycaps.set(el.dataset.key, el);
});

const harmonicNotes = [
  { name: "C4", midi: 60 },
  { name: "G4", midi: 67 },
  { name: "C5", midi: 72 },
  { name: "E5", midi: 76 },
  { name: "G5", midi: 79 },
  { name: "C6", midi: 84 },
];

const keyMeta = {
  KeyJ: { label: "J", type: "valve", semitone: 2 },
  KeyK: { label: "K", type: "valve", semitone: 1 },
  KeyL: { label: "L", type: "valve", semitone: 3 },
  KeyW: { label: "W", type: "harmonic", delta: 1 },
  KeyS: { label: "S", type: "harmonic", delta: -1 },
  ShiftLeft: { label: "Shift", type: "retrigger" },
  ShiftRight: { label: "Shift", type: "retrigger" },
};

const valveOrder = ["KeyJ", "KeyK", "KeyL"];
const displayOrder = [
  "KeyJ",
  "KeyK",
  "KeyL",
  "KeyW",
  "KeyS",
  "ShiftLeft",
  "ShiftRight",
];

const state = {
  harmonic: 0,
  valves: {
    KeyJ: false,
    KeyK: false,
    KeyL: false,
  },
  pressed: new Set(),
  audioOn: false,
  audioMode: "none",
  unlocking: false,
  started: false,
  currentNote: null,
  currentMidi: null,
  metronome: {
    on: false,
    bpm: 90,
    beat: 0,
    timer: null,
  },
};

let synth = null;
const comboWindowMs = 45;
let refreshTimer = null;
const webAudio = {
  ctx: null,
  osc: null,
  gain: null,
};

const staffCtx = staffCanvas ? staffCanvas.getContext("2d") : null;
const staffSize = { width: 0, height: 0, ratio: 1 };
const staffLayout = {
  leftPadding: 36,
  rightPadding: 36,
  lineGap: 16,
};
const noteNames = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

function toneAvailable() {
  return typeof window.Tone !== "undefined";
}

function ensureSynth() {
  if (!toneAvailable()) return null;
  if (synth) return synth;
  synth = new Tone.MonoSynth({
    oscillator: { type: "sawtooth" },
    filter: { Q: 2, type: "lowpass", rolloff: -24 },
    envelope: { attack: 0.02, decay: 0.1, sustain: 0.7, release: 0.4 },
    filterEnvelope: {
      attack: 0.01,
      decay: 0.2,
      sustain: 0.6,
      release: 0.3,
      baseFrequency: 200,
      octaves: 3,
    },
  }).toDestination();
  return synth;
}

function midiToNoteName(midi) {
  const name = noteNames[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function ensureWebAudio() {
  if (webAudio.ctx) return webAudio;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  let ctx = null;
  if (toneAvailable() && Tone.getContext) {
    ctx = Tone.getContext().rawContext;
  } else if (AudioContext) {
    ctx = new AudioContext();
  }
  if (!ctx) return null;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);
  webAudio.ctx = ctx;
  webAudio.gain = gain;
  return webAudio;
}

function webAttack(midi) {
  const engine = ensureWebAudio();
  if (!engine) return false;
  engine.ctx.resume();
  if (!engine.osc) {
    const osc = engine.ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = midiToFrequency(midi);
    osc.connect(engine.gain);
    osc.start();
    engine.osc = osc;
  } else {
    engine.osc.frequency.setTargetAtTime(
      midiToFrequency(midi),
      engine.ctx.currentTime,
      0.02
    );
  }
  engine.gain.gain.cancelScheduledValues(engine.ctx.currentTime);
  engine.gain.gain.setTargetAtTime(0.25, engine.ctx.currentTime, 0.02);
  return true;
}

function webSetNote(midi) {
  if (!webAudio.ctx || !webAudio.osc) return;
  webAudio.osc.frequency.setTargetAtTime(
    midiToFrequency(midi),
    webAudio.ctx.currentTime,
    0.02
  );
}

function webRelease() {
  if (!webAudio.ctx || !webAudio.gain) return;
  webAudio.gain.gain.setTargetAtTime(0, webAudio.ctx.currentTime, 0.03);
}

function startWebAudio() {
  const engine = ensureWebAudio();
  if (!engine) return false;
  engine.ctx.resume();
  return true;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resizeStaff() {
  if (!staffCanvas || !staffCtx) return;
  const rect = staffCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = window.devicePixelRatio || 1;
  if (
    staffSize.width === rect.width &&
    staffSize.height === rect.height &&
    staffSize.ratio === ratio
  ) {
    return;
  }
  staffSize.width = rect.width;
  staffSize.height = rect.height;
  staffSize.ratio = ratio;
  staffCanvas.width = rect.width * ratio;
  staffCanvas.height = rect.height * ratio;
  staffCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function parseNoteName(noteName) {
  const match = /^([A-G])([#b]?)(\d+)$/.exec(noteName);
  if (!match) return null;
  return {
    letter: match[1],
    accidental: match[2] || "",
    octave: Number.parseInt(match[3], 10),
  };
}

function getStaffPosition(noteName) {
  const parsed = parseNoteName(noteName);
  if (!parsed) return null;
  const letterIndex = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 }[
    parsed.letter
  ];
  const baseIndex = 4 * 7 + 2;
  const index = parsed.octave * 7 + letterIndex;
  return {
    position: index - baseIndex,
    accidental: parsed.accidental,
  };
}

function drawStaff(noteName) {
  if (!staffCanvas || !staffCtx) return;
  resizeStaff();

  const width = staffSize.width;
  const height = staffSize.height;
  const left = staffLayout.leftPadding;
  const right = width - staffLayout.rightPadding;
  const staffHeight = staffLayout.lineGap * 4;
  const staffTop = (height - staffHeight) / 2;
  const bottomLineY = staffTop + staffLayout.lineGap * 4;
  const step = staffLayout.lineGap / 2;

  staffCtx.clearRect(0, 0, width, height);
  staffCtx.strokeStyle = "rgba(29, 27, 22, 0.7)";
  staffCtx.lineWidth = 1.4;

  for (let i = 0; i < 5; i += 1) {
    const y = staffTop + staffLayout.lineGap * i;
    staffCtx.beginPath();
    staffCtx.moveTo(left, y);
    staffCtx.lineTo(right, y);
    staffCtx.stroke();
  }

  const staffData = getStaffPosition(noteName);
  if (!staffData) return;

  const noteX = left + (right - left) * 0.65;
  const noteY = bottomLineY - staffData.position * step;

  function drawLedgerLine(position) {
    const y = bottomLineY - position * step;
    staffCtx.beginPath();
    staffCtx.moveTo(noteX - 22, y);
    staffCtx.lineTo(noteX + 22, y);
    staffCtx.stroke();
  }

  if (staffData.position < 0) {
    for (let p = -2; p >= staffData.position; p -= 2) {
      drawLedgerLine(p);
    }
  }

  if (staffData.position > 8) {
    for (let p = 10; p <= staffData.position; p += 2) {
      drawLedgerLine(p);
    }
  }

  staffCtx.fillStyle = "rgba(209, 73, 47, 0.9)";
  staffCtx.strokeStyle = "rgba(29, 27, 22, 0.8)";
  staffCtx.lineWidth = 1.2;
  staffCtx.beginPath();
  staffCtx.ellipse(noteX, noteY, 12, 8, -0.35, 0, Math.PI * 2);
  staffCtx.fill();
  staffCtx.stroke();

  if (staffData.accidental) {
    staffCtx.fillStyle = "rgba(29, 27, 22, 0.8)";
    staffCtx.font = "16px IBM Plex Mono, monospace";
    staffCtx.fillText(staffData.accidental, noteX - 34, noteY + 5);
  }
}

function getValveOffset() {
  return valveOrder.reduce((sum, code) => {
    if (!state.valves[code]) return sum;
    return sum + keyMeta[code].semitone;
  }, 0);
}

function getComboString() {
  return valveOrder.map((code) => (state.valves[code] ? "1" : "0")).join("");
}

function getPressedLabels() {
  const labels = displayOrder
    .filter((code) => state.pressed.has(code))
    .map((code) => keyMeta[code].label);
  const unique = [...new Set(labels)];
  return unique.length ? unique.join(" + ") : "None";
}

function getNoteData() {
  const base = harmonicNotes[state.harmonic];
  const offset = getValveOffset();
  const finalMidi = clamp(base.midi - offset, 0, 127);
  const finalNote = midiToNoteName(finalMidi);
  return {
    harmonic: state.harmonic,
    baseNote: base.name,
    finalNote,
    finalMidi,
    offset,
  };
}

function updateUI(data) {
  harmonicLevelEl.textContent = data.harmonic;
  baseNoteEl.textContent = data.baseNote;
  finalNoteEl.textContent = data.finalNote;
  if (staffNoteEl) staffNoteEl.textContent = data.finalNote;
  valveOffsetEl.textContent = data.offset;
  comboEl.textContent = getComboString();
  pressedKeysEl.textContent = getPressedLabels();
}

function triggerAttack(data) {
  if (state.audioMode === "tone") {
    const activeSynth = ensureSynth();
    if (!activeSynth) return false;
    activeSynth.triggerAttack(data.finalNote);
    return true;
  }
  if (state.audioMode === "web") {
    return webAttack(data.finalMidi);
  }
  return false;
}

function triggerSetNote(data) {
  if (state.audioMode === "tone") {
    const activeSynth = ensureSynth();
    if (!activeSynth) return false;
    activeSynth.setNote(data.finalNote);
    return true;
  }
  if (state.audioMode === "web") {
    webSetNote(data.finalMidi);
    return true;
  }
  return false;
}

function triggerRelease() {
  if (state.audioMode === "tone") {
    if (synth) synth.triggerRelease();
    return;
  }
  if (state.audioMode === "web") {
    webRelease();
  }
}

function updateSound(data) {
  if (!state.audioOn) return;
  const shouldPlay = state.pressed.size > 0;
  if (!shouldPlay) {
    if (state.started) {
      triggerRelease();
      state.started = false;
      state.currentNote = null;
      state.currentMidi = null;
    }
    return;
  }

  if (!state.started) {
    if (triggerAttack(data)) {
      state.started = true;
      state.currentNote = data.finalNote;
      state.currentMidi = data.finalMidi;
    }
    return;
  }

  if (data.finalMidi !== state.currentMidi) {
    triggerSetNote(data);
    state.currentNote = data.finalNote;
    state.currentMidi = data.finalMidi;
  }
}

function retriggerNow() {
  const data = getNoteData();
  if (!state.audioOn) return;
  if (state.started) {
    triggerRelease();
  }
  if (triggerAttack(data)) {
    state.started = true;
    state.currentNote = data.finalNote;
    state.currentMidi = data.finalMidi;
  }
}

function updateMetronomeUI() {
  if (bpmValueEl) bpmValueEl.textContent = `${state.metronome.bpm} BPM`;
  if (metroBtn) {
    metroBtn.textContent = state.metronome.on
      ? "Stop Metronome"
      : "Start Metronome";
  }
}

function setBeatIndicator(beatIndex) {
  metroTicks.forEach((tick, idx) => {
    tick.classList.toggle("active", idx === beatIndex);
  });
}

function metronomeClick(accent) {
  const engine = ensureWebAudio();
  if (!engine) return;
  engine.ctx.resume();
  const osc = engine.ctx.createOscillator();
  const gain = engine.ctx.createGain();
  const now = engine.ctx.currentTime;
  osc.type = "square";
  osc.frequency.value = accent ? 1000 : 700;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(accent ? 0.35 : 0.2, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
  osc.connect(gain);
  gain.connect(engine.ctx.destination);
  osc.start(now);
  osc.stop(now + 0.1);
}

function tickMetronome() {
  if (!state.metronome.on) return;
  const beatIndex = state.metronome.beat % 4;
  setBeatIndicator(beatIndex);
  metronomeClick(beatIndex === 0);
  state.metronome.beat += 1;
}

function stopMetronome() {
  if (state.metronome.timer) {
    clearInterval(state.metronome.timer);
    state.metronome.timer = null;
  }
  state.metronome.on = false;
  state.metronome.beat = 0;
  setBeatIndicator(-1);
  updateMetronomeUI();
}

function startMetronomeTimer() {
  if (state.metronome.timer) clearInterval(state.metronome.timer);
  const intervalMs = 60000 / state.metronome.bpm;
  state.metronome.timer = setInterval(tickMetronome, intervalMs);
  tickMetronome();
}

async function startMetronome() {
  if (!state.audioOn) {
    await startAudio();
  }
  if (!state.audioOn) return;
  state.metronome.on = true;
  state.metronome.beat = 0;
  startMetronomeTimer();
  updateMetronomeUI();
}

function refresh() {
  const data = getNoteData();
  updateUI(data);
  updateSound(data);
  drawStaff(data.finalNote);
}

function scheduleRefresh(delay = comboWindowMs) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, delay);
}

function setKeyActive(label, active) {
  const keycap = keycaps.get(label);
  if (!keycap) return;
  keycap.classList.toggle("active", active);
}

function handleValve(code, pressed) {
  if (!state.valves.hasOwnProperty(code)) return;
  state.valves[code] = pressed;
  setKeyActive(keyMeta[code].label, pressed);
}

function handleHarmonicChange(delta) {
  state.harmonic = clamp(state.harmonic + delta, 0, harmonicNotes.length - 1);
}

function handleKeyDown(e) {
  const code = e.code;
  if (!keyMeta[code]) return;
  e.preventDefault();

  if (e.repeat && keyMeta[code].type !== "retrigger") return;

  state.pressed.add(code);
  maybeUnlockAudio();

  if (keyMeta[code].type === "valve") {
    handleValve(code, true);
    scheduleRefresh();
    return;
  }

  if (keyMeta[code].type === "harmonic") {
    setKeyActive(keyMeta[code].label, true);
    handleHarmonicChange(keyMeta[code].delta);
    scheduleRefresh();
  }

  if (keyMeta[code].type === "retrigger") {
    setKeyActive(keyMeta[code].label, true);
    retriggerNow();
    scheduleRefresh(0);
  }
}

function handleKeyUp(e) {
  const code = e.code;
  if (!keyMeta[code]) return;
  e.preventDefault();

  state.pressed.delete(code);

  if (keyMeta[code].type === "valve") {
    handleValve(code, false);
    if (state.pressed.size === 0) {
      refresh();
    } else {
      scheduleRefresh();
    }
    return;
  }

  if (keyMeta[code].type === "harmonic") {
    setKeyActive(keyMeta[code].label, false);
    if (state.pressed.size === 0) {
      refresh();
    } else {
      scheduleRefresh();
    }
  }

  if (keyMeta[code].type === "retrigger") {
    setKeyActive(keyMeta[code].label, false);
    if (state.pressed.size === 0) {
      refresh();
    } else {
      scheduleRefresh();
    }
  }
}

function maybeUnlockAudio() {
  if (state.audioOn || state.unlocking) return;
  state.unlocking = true;
  startAudio().finally(() => {
    state.unlocking = false;
  });
}

async function startAudio() {
  if (toneAvailable()) {
    ensureSynth();
    try {
      await Tone.start();
      state.audioMode = "tone";
      state.audioOn = true;
      audioBtn.textContent = "Stop Audio";
      audioStatus.textContent = "Audio on";
      refresh();
      return;
    } catch (error) {
      // Fall through to Web Audio fallback.
    }
  }

  const startedWeb = startWebAudio();
  if (!startedWeb) {
    audioStatus.textContent = "Audio unavailable";
    return;
  }
  state.audioMode = "web";
  state.audioOn = true;
  audioBtn.textContent = "Stop Audio";
  audioStatus.textContent = "Audio on";
  refresh();
}

function stopAudio() {
  state.audioOn = false;
  audioBtn.textContent = "Start Audio";
  audioStatus.textContent = "Audio off";
  triggerRelease();
  state.audioMode = "none";
  state.started = false;
  state.currentNote = null;
  state.currentMidi = null;
  if (state.metronome.on) stopMetronome();
}

audioBtn.addEventListener("click", () => {
  if (state.audioOn) {
    stopAudio();
  } else {
    startAudio();
  }
});

resetBtn.addEventListener("click", () => {
  state.harmonic = 0;
  scheduleRefresh(0);
});

if (metroBtn) {
  metroBtn.addEventListener("click", () => {
    if (state.metronome.on) {
      stopMetronome();
    } else {
      startMetronome();
    }
  });
}

if (bpmSlider) {
  bpmSlider.addEventListener("input", (e) => {
    const value = Number.parseInt(e.target.value, 10);
    if (Number.isNaN(value)) return;
    state.metronome.bpm = value;
    updateMetronomeUI();
    if (state.metronome.on) startMetronomeTimer();
  });
}

window.addEventListener("keydown", handleKeyDown);
window.addEventListener("keyup", handleKeyUp);
window.addEventListener("blur", () => {
  state.pressed.clear();
  Object.keys(state.valves).forEach((code) => handleValve(code, false));
  ["W", "S", "Shift"].forEach((label) => setKeyActive(label, false));
  refresh();
});
window.addEventListener("resize", () => {
  drawStaff(getNoteData().finalNote);
});

updateMetronomeUI();
refresh();
