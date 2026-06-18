// app.js — wires the game + eye tracker, plus all the UX:
// onboarding wizard, snap-to-cell gaze, dwell-to-reveal, blink/wink-to-flag,
// sound + visual feedback, persisted settings, and best-time tracking.
import { Minesweeper, DIFFICULTIES } from "./minesweeper.js";
import { EyeTracker } from "./eyetracking.js";
import { sfx } from "./sound.js";
import { runWizard } from "./wizard.js";

const $ = (id) => document.getElementById(id);

const boardEl = $("board");
const statusLine = $("status-line");
const mineCounter = $("mine-counter");
const timerEl = $("timer");
const faceBtn = $("reset-btn");
const gazeCursor = $("gaze-cursor");

// ---------- Persistence ----------
const STORE_KEY = "eyesweeper.settings.v1";
const TIMES_KEY = "eyesweeper.besttimes.v1";
const settings = loadJSON(STORE_KEY, {
  dwell: 1.0, sensitivity: 0.5, smoothing: 0.30,
  glasses: false, flagGesture: "blink", sound: true,
  difficulty: "beginner", onboarded: false,
});
const bestTimes = loadJSON(TIMES_KEY, {});

function loadJSON(k, fallback) {
  try { return { ...fallback, ...(JSON.parse(localStorage.getItem(k)) || {}) }; }
  catch { return fallback; }
}
function saveSettings() { try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch {} }
function saveTimes() { try { localStorage.setItem(TIMES_KEY, JSON.stringify(bestTimes)); } catch {} }

// ---------- Game ----------
let currentDifficulty = settings.difficulty in DIFFICULTIES ? settings.difficulty : "beginner";

const game = new Minesweeper(boardEl, {
  onStateChange: (s) => {
    mineCounter.textContent = s.minesRemaining;
    if (s.gameOver) {
      faceBtn.textContent = s.won ? "😎" : "😵";
      if (s.won) {
        sfx.win();
        const prev = bestTimes[currentDifficulty];
        let msg = `You cleared it in ${s.elapsed}s! 🎉`;
        if (prev == null || s.elapsed < prev) {
          bestTimes[currentDifficulty] = s.elapsed; saveTimes(); renderBestTime();
          msg += " New best!";
        }
        statusLine.textContent = msg;
        statusLine.className = "status-line win";
      } else {
        sfx.lose();
        statusLine.textContent = "Boom. Hit a mine — press the face to retry.";
        statusLine.className = "status-line lose";
      }
    } else {
      faceBtn.textContent = "🙂";
    }
  },
  onTick: (t) => { timerEl.textContent = t; },
  onReveal: () => sfx.reveal(),
  onFlag: (flagged) => sfx.flag(flagged),
});

function newGame(msg) {
  game.reset(DIFFICULTIES[currentDifficulty]);
  statusLine.textContent = msg || "New game — good luck.";
  statusLine.className = "status-line";
  kbR = 0; kbC = 0;
}

faceBtn.addEventListener("click", () => newGame());

const diffSelect = $("difficulty-select");
diffSelect.value = currentDifficulty;
diffSelect.addEventListener("change", (e) => {
  currentDifficulty = e.target.value;
  settings.difficulty = currentDifficulty; saveSettings();
  renderBestTime();
  newGame();
});

function renderBestTime() {
  const t = bestTimes[currentDifficulty];
  $("best-time").textContent = t == null ? "—" : `${t}s`;
}

// ---------- Keyboard fallback ----------
let kbR = 0, kbC = 0;
function moveKb(dr, dc) {
  kbR = Math.max(0, Math.min(game.rows - 1, kbR + dr));
  kbC = Math.max(0, Math.min(game.cols - 1, kbC + dc));
  highlightCell(game.grid[kbR][kbC].el);
}
document.addEventListener("keydown", (e) => {
  if (!$("wizard").classList.contains("hidden")) return; // wizard captures focus
  if (!$("calibration-overlay").classList.contains("hidden")) return; // calibrating
  switch (e.key) {
    case "ArrowUp": moveKb(-1, 0); e.preventDefault(); break;
    case "ArrowDown": moveKb(1, 0); e.preventDefault(); break;
    case "ArrowLeft": moveKb(0, -1); e.preventDefault(); break;
    case "ArrowRight": moveKb(0, 1); e.preventDefault(); break;
    case "Enter": case " ": game.reveal(kbR, kbC); e.preventDefault(); break;
    case "f": case "F": game.toggleFlag(kbR, kbC); break;
  }
});

// ---------- Shared highlight + snap ----------
let focusedEl = null;
function highlightCell(el) {
  if (focusedEl === el) return;
  if (focusedEl) { focusedEl.classList.remove("gaze-focus"); clearDwell(focusedEl); }
  focusedEl = el;
  if (el) el.classList.add("gaze-focus");
}

// ---------- Dwell-to-reveal ----------
let dwellSeconds = settings.dwell;
let dwellTarget = null, dwellStart = 0, dwellRing = null;

function clearDwell(el) {
  if (dwellRing && dwellRing.parentElement === el) dwellRing.remove();
  if (dwellTarget === el) { dwellTarget = null; dwellRing = null; }
}
function updateDwell(el, now) {
  if (!el || !el.classList.contains("cell")) {
    if (dwellTarget) { clearDwell(dwellTarget); dwellTarget = null; }
    return;
  }
  const r = +el.dataset.r, c = +el.dataset.c;
  const cell = game.grid[r]?.[c];
  if (!cell || cell.revealed || cell.flagged || game.gameOver) {
    if (dwellTarget) { clearDwell(dwellTarget); dwellTarget = null; }
    return;
  }
  if (dwellTarget !== el) {
    if (dwellTarget) clearDwell(dwellTarget);
    dwellTarget = el; dwellStart = now;
    dwellRing = document.createElement("div");
    dwellRing.className = "dwell-ring";
    el.appendChild(dwellRing);
  }
  const pct = Math.min(1, (now - dwellStart) / (dwellSeconds * 1000));
  if (dwellRing) dwellRing.style.setProperty("--p", `${pct * 360}deg`);
  if (pct >= 1) { clearDwell(el); dwellTarget = null; game.reveal(r, c); }
}

// snap the visible cursor to the center of the focused cell for stability
function cursorTo(g, hitEl) {
  if (hitEl) {
    const rect = hitEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    gazeCursor.classList.add("snapped");
    gazeCursor.style.transform = `translate(${cx}px, ${cy}px)`;
  } else {
    gazeCursor.classList.remove("snapped");
    gazeCursor.style.transform = `translate(${g.x}px, ${g.y}px)`;
  }
}

// ---------- Eye tracker ----------
const tracker = new EyeTracker($("webcam"), {
  onStatus: (s) => {
    if (s.cam) setPill("cam-status", s.cam, s.cam === "on" ? "on" : "off");
    if (s.gaze) setPill("gaze-status", s.gaze, s.gaze === "tracking" ? "active" : "off");
    if (s.signal) setPill("signal-status", s.signal,
      s.signal === "good" ? "on" : (s.signal === "warming…" ? "active" : "off"));
  },
  onOpenness: ({ open, threshold }) => {
    const fill = $("openness-fill");
    fill.style.width = Math.min(100, (open / 1.1) * 100) + "%";
    fill.classList.toggle("closed", open < threshold);
    $("openness-threshold").style.left = Math.min(100, (threshold / 1.1) * 100) + "%";
  },
  onGaze: (g) => {
    if (!g) { gazeCursor.classList.remove("visible"); highlightCell(null); return; }
    gazeCursor.classList.add("visible");
    const hit = game.cellFromPoint(g.x, g.y);
    cursorTo(g, hit ? hit.el : null);
    highlightCell(hit ? hit.el : null);
    updateDwell(hit ? hit.el : null, performance.now());
  },
  onFlag: () => {
    // ignore gestures while an overlay (calibration / wizard) is up
    if (!$("calibration-overlay").classList.contains("hidden")) return;
    if (!$("wizard").classList.contains("hidden")) return;
    gazeCursor.classList.add("blinking");
    setTimeout(() => gazeCursor.classList.remove("blinking"), 220);
    const el = focusedEl;
    if (el && el.classList.contains("cell")) game.toggleFlag(+el.dataset.r, +el.dataset.c);
  },
});

function setPill(id, text, kind) {
  const el = $(id);
  el.textContent = text;
  el.className = "pill " + (kind === "on" ? "pill-on" : kind === "active" ? "pill-active" : "pill-off");
}

// ---------- Apply settings to tracker + UI ----------
function applySettings() {
  dwellSeconds = settings.dwell;
  tracker.sensitivity = settings.sensitivity;
  tracker.smoothing = settings.smoothing;
  tracker.setGlassesMode(settings.glasses);
  tracker.flagGesture = settings.flagGesture;
  sfx.enabled = settings.sound;

  $("dwell-range").value = settings.dwell;
  $("dwell-label").textContent = settings.dwell.toFixed(1) + "s";
  $("blink-range").value = settings.sensitivity;
  $("blink-label").textContent = settings.sensitivity.toFixed(2);
  $("smooth-range").value = settings.smoothing;
  $("smooth-label").textContent = settings.smoothing.toFixed(2);
  $("glasses-toggle").checked = settings.glasses;
  $("flag-gesture").value = settings.flagGesture;
  $("sound-toggle").checked = settings.sound;
}

// ---------- Settings controls ----------
$("dwell-range").addEventListener("input", (e) => {
  settings.dwell = +e.target.value; dwellSeconds = settings.dwell;
  $("dwell-label").textContent = settings.dwell.toFixed(1) + "s"; saveSettings();
});
$("blink-range").addEventListener("input", (e) => {
  settings.sensitivity = +e.target.value; tracker.sensitivity = settings.sensitivity;
  $("blink-label").textContent = settings.sensitivity.toFixed(2); saveSettings();
});
$("smooth-range").addEventListener("input", (e) => {
  settings.smoothing = +e.target.value; tracker.smoothing = settings.smoothing;
  $("smooth-label").textContent = settings.smoothing.toFixed(2); saveSettings();
});
$("glasses-toggle").addEventListener("change", (e) => {
  settings.glasses = e.target.checked; tracker.setGlassesMode(settings.glasses);
  if (settings.glasses && settings.smoothing < 0.35) {
    settings.smoothing = 0.4; tracker.smoothing = 0.4;
    $("smooth-range").value = 0.4; $("smooth-label").textContent = "0.40";
  }
  saveSettings();
});
$("flag-gesture").addEventListener("change", (e) => {
  settings.flagGesture = e.target.value; tracker.flagGesture = settings.flagGesture; saveSettings();
});
$("sound-toggle").addEventListener("change", (e) => {
  settings.sound = e.target.checked; sfx.enabled = settings.sound;
  if (settings.sound) sfx.flag(true);
  saveSettings();
});

// ---------- Eye tracking toggle ----------
const eyeToggle = $("eye-toggle");
const pauseBtn = $("pause-btn");
let eyeOn = false, paused = false;

eyeToggle.addEventListener("click", async () => {
  if (eyeOn) { teardownEye(); return; }
  await startEye();
});

async function startEye() {
  eyeToggle.textContent = "Starting camera…";
  eyeToggle.disabled = true;
  try {
    sfx.resume();
    await tracker.start();
    eyeOn = true;
    eyeToggle.textContent = "Disable eye tracking";
    $("calibrate-btn").disabled = false;
    $("setup-btn").disabled = false;
    pauseBtn.disabled = false;
    return true;
  } catch (err) {
    console.error(err);
    statusLine.textContent =
      "Couldn't start the camera (" + (err?.name || "error") +
      "). Allow camera access and use a secure (https/localhost) page. Mouse + keyboard still work.";
    statusLine.className = "status-line lose";
    return false;
  } finally {
    eyeToggle.disabled = false;
  }
}

function teardownEye() {
  tracker.stop();
  eyeOn = false; paused = false;
  eyeToggle.textContent = "Enable eye tracking";
  pauseBtn.textContent = "⏸"; pauseBtn.disabled = true;
  $("calibrate-btn").disabled = true;
  $("setup-btn").disabled = true;
  gazeCursor.classList.remove("visible");
  highlightCell(null);
}

pauseBtn.addEventListener("click", () => {
  paused = !paused;
  tracker.setPaused(paused);
  pauseBtn.textContent = paused ? "▶" : "⏸";
  if (paused) { gazeCursor.classList.remove("visible"); highlightCell(null); }
});

// ---------- Calibration (standalone "recalibrate") ----------
const calOverlay = $("calibration-overlay");
const calDot = $("calibration-dot");
$("calibrate-btn").addEventListener("click", () => runCalibration());

function calibrationPoints() {
  const m = 0.12;
  const xs = [m, 0.5, 1 - m], ys = [m, 0.5, 1 - m];
  const pts = [];
  for (const y of ys) for (const x of xs) pts.push([x, y]);
  return pts;
}

async function runCalibration() {
  if (!eyeOn) return false;
  if (paused) { paused = false; tracker.setPaused(false); pauseBtn.textContent = "⏸"; }
  tracker.resetCalibration();
  calOverlay.classList.remove("hidden");
  for (const [fx, fy] of calibrationPoints()) {
    const px = fx * window.innerWidth, py = fy * window.innerHeight;
    calDot.style.left = px + "px"; calDot.style.top = py + "px";
    sfx.tick();
    // fill the dot and sample at the same time: the ring IS the progress bar
    await Promise.all([animateDot(calDot, 1100), tracker.collectPoint(px, py, 1100)]);
  }
  calOverlay.classList.add("hidden");
  const ok = tracker.finalizeCalibration();
  statusLine.textContent = ok
    ? "Calibrated! Look at a cell to aim, dwell to reveal, blink to flag."
    : "Calibration failed — try again with good lighting and a steady head.";
  statusLine.className = "status-line" + (ok ? "" : " lose");
  return ok;
}

function animateDot(dot, ms) {
  return new Promise((resolve) => {
    const start = performance.now();
    (function step(now) {
      const p = Math.min(1, (now - start) / ms);
      dot.style.setProperty("--p", `${p * 360}deg`);
      if (p < 1) requestAnimationFrame(step); else resolve();
    })(performance.now());
  });
}

// ---------- Onboarding wizard ----------
$("setup-btn").addEventListener("click", () => openWizard());

function openWizard() {
  runWizard({
    tracker, sfx,
    startEye, runCalibration,
    isEyeOn: () => eyeOn,
    settings, applySettings, saveSettings,
    onDone: () => {
      settings.onboarded = true; saveSettings();
      statusLine.textContent = "All set — happy sweeping! 👁️";
      statusLine.className = "status-line";
    },
  });
}

// ---------- Init ----------
applySettings();
renderBestTime();
newGame("Pick a difficulty and start sweeping.");
// first-time users get the wizard offer
if (!settings.onboarded) {
  statusLine.textContent = "New here? Click “Setup wizard” after enabling eye tracking for a guided start.";
}
