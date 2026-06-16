// app.js — wires the game, eye tracker, calibration, dwell-to-reveal and blink-to-flag.
import { Minesweeper, DIFFICULTIES } from "./minesweeper.js";
import { EyeTracker } from "./eyetracking.js";

const $ = (id) => document.getElementById(id);

const boardEl = $("board");
const statusLine = $("status-line");
const mineCounter = $("mine-counter");
const timerEl = $("timer");
const faceBtn = $("reset-btn");
const gazeCursor = $("gaze-cursor");

// ---------- Game ----------
const game = new Minesweeper(boardEl, {
  onStateChange: (s) => {
    mineCounter.textContent = s.minesRemaining;
    if (s.gameOver) {
      faceBtn.textContent = s.won ? "😎" : "😵";
      statusLine.textContent = s.won
        ? `You cleared it in ${s.elapsed}s! 🎉`
        : "Boom. Hit a mine — press the face to retry.";
      statusLine.className = "status-line " + (s.won ? "win" : "lose");
    } else {
      faceBtn.textContent = "🙂";
      if (statusLine.className !== "status-line")
        statusLine.className = "status-line";
    }
  },
  onTick: (t) => { timerEl.textContent = t; },
});

faceBtn.addEventListener("click", () => {
  game.reset();
  statusLine.textContent = "New game — good luck.";
  statusLine.className = "status-line";
});

$("difficulty-select").addEventListener("change", (e) => {
  game.reset(DIFFICULTIES[e.target.value]);
  statusLine.textContent = "New game — good luck.";
  statusLine.className = "status-line";
});

// ---------- Keyboard fallback ----------
let kbR = 0, kbC = 0;
function moveKb(dr, dc) {
  kbR = Math.max(0, Math.min(game.rows - 1, kbR + dr));
  kbC = Math.max(0, Math.min(game.cols - 1, kbC + dc));
  highlightCell(game.grid[kbR][kbC].el);
}
document.addEventListener("keydown", (e) => {
  switch (e.key) {
    case "ArrowUp": moveKb(-1, 0); e.preventDefault(); break;
    case "ArrowDown": moveKb(1, 0); e.preventDefault(); break;
    case "ArrowLeft": moveKb(0, -1); e.preventDefault(); break;
    case "ArrowRight": moveKb(0, 1); e.preventDefault(); break;
    case "Enter": case " ": game.reveal(kbR, kbC); e.preventDefault(); break;
    case "f": case "F": game.toggleFlag(kbR, kbC); break;
  }
});

// ---------- Shared highlight helper ----------
let focusedEl = null;
function highlightCell(el) {
  if (focusedEl === el) return;
  if (focusedEl) {
    focusedEl.classList.remove("gaze-focus");
    clearDwell(focusedEl);
  }
  focusedEl = el;
  if (el) el.classList.add("gaze-focus");
}

// ---------- Dwell-to-reveal ----------
let dwellSeconds = 1.0;
let dwellTarget = null;     // el currently being dwelled
let dwellStart = 0;
let dwellRing = null;

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
  // only dwell on actionable (covered, unflagged) cells
  if (!cell || cell.revealed || cell.flagged || game.gameOver) {
    if (dwellTarget) { clearDwell(dwellTarget); dwellTarget = null; }
    return;
  }
  if (dwellTarget !== el) {
    if (dwellTarget) clearDwell(dwellTarget);
    dwellTarget = el;
    dwellStart = now;
    dwellRing = document.createElement("div");
    dwellRing.className = "dwell-ring";
    el.appendChild(dwellRing);
  }
  const pct = Math.min(1, (now - dwellStart) / (dwellSeconds * 1000));
  if (dwellRing) dwellRing.style.setProperty("--p", `${pct * 360}deg`);
  if (pct >= 1) {
    clearDwell(el);
    dwellTarget = null;
    game.reveal(r, c);
  }
}

// ---------- Eye tracker ----------
const tracker = new EyeTracker($("webcam"), {
  onStatus: (s) => {
    if (s.cam) setPill("cam-status", s.cam, s.cam === "on" ? "on" : "off");
    if (s.gaze) setPill("gaze-status", s.gaze, s.gaze === "tracking" ? "active" : "off");
    if (s.blink) setPill("blink-status", s.blink,
      s.blink === "flag!" ? "active" : (s.blink === "closed" ? "active" : "on"));
  },
  onGaze: (g) => {
    if (!g) { gazeCursor.classList.remove("visible"); return; }
    gazeCursor.classList.add("visible");
    gazeCursor.style.transform = `translate(${g.x}px, ${g.y}px)`;
    const hit = game.cellFromPoint(g.x, g.y);
    highlightCell(hit ? hit.el : null);
    updateDwell(hit ? hit.el : null, performance.now());
  },
  onBlink: () => {
    gazeCursor.classList.add("blinking");
    setTimeout(() => gazeCursor.classList.remove("blinking"), 250);
    // flag whatever cell we're currently looking at
    const el = focusedEl;
    if (el && el.classList.contains("cell")) {
      game.toggleFlag(+el.dataset.r, +el.dataset.c);
    }
  },
});

function setPill(id, text, kind) {
  const el = $(id);
  el.textContent = text;
  el.className = "pill " + (kind === "on" ? "pill-on" : kind === "active" ? "pill-active" : "pill-off");
}

// ---------- Eye tracking toggle ----------
const eyeToggle = $("eye-toggle");
let eyeOn = false;
eyeToggle.addEventListener("click", async () => {
  if (eyeOn) {
    tracker.stop();
    eyeOn = false;
    eyeToggle.textContent = "Enable eye tracking";
    $("calibrate-btn").disabled = true;
    gazeCursor.classList.remove("visible");
    return;
  }
  eyeToggle.textContent = "Starting camera…";
  eyeToggle.disabled = true;
  try {
    await tracker.start();
    eyeOn = true;
    eyeToggle.textContent = "Disable eye tracking";
    $("calibrate-btn").disabled = false;
    statusLine.textContent = "Camera on. Click “Calibrate gaze” to aim with your eyes.";
  } catch (err) {
    console.error(err);
    statusLine.textContent =
      "Couldn't start the camera (" + (err?.name || "error") +
      "). Check permissions / use a secure (https/localhost) context. Mouse + keyboard still work.";
    statusLine.className = "status-line lose";
  } finally {
    eyeToggle.disabled = false;
  }
});

// ---------- Calibration flow ----------
const calOverlay = $("calibration-overlay");
const calDot = $("calibration-dot");
$("calibrate-btn").addEventListener("click", runCalibration);

async function runCalibration() {
  if (!eyeOn) return;
  tracker.resetCalibration();
  calOverlay.classList.remove("hidden");
  const margin = 0.12;
  const xs = [margin, 0.5, 1 - margin];
  const ys = [margin, 0.5, 1 - margin];
  const points = [];
  for (const y of ys) for (const x of xs) points.push([x, y]);

  for (const [fx, fy] of points) {
    const px = fx * window.innerWidth;
    const py = fy * window.innerHeight;
    calDot.style.left = px + "px";
    calDot.style.top = py + "px";
    // animate the fill
    await animateDot(calDot, 1100);
    await tracker.collectPoint(px, py, 1100);
  }
  calOverlay.classList.add("hidden");
  const ok = tracker.finalizeCalibration();
  statusLine.textContent = ok
    ? "Calibrated! Look at a cell to aim, dwell to reveal, blink to flag."
    : "Calibration failed — try again with good lighting and a steady head.";
  statusLine.className = "status-line" + (ok ? "" : " lose");
}

function animateDot(dot, ms) {
  return new Promise((resolve) => {
    const start = performance.now();
    function step(now) {
      const p = Math.min(1, (now - start) / ms);
      dot.style.setProperty("--p", `${p * 360}deg`);
      if (p < 1) requestAnimationFrame(step);
      else resolve();
    }
    requestAnimationFrame(step);
  });
}

// ---------- Settings sliders ----------
$("dwell-range").addEventListener("input", (e) => {
  dwellSeconds = +e.target.value;
  $("dwell-label").textContent = dwellSeconds.toFixed(1) + "s";
});
$("blink-range").addEventListener("input", (e) => {
  tracker.blinkThreshold = +e.target.value;
  $("blink-label").textContent = (+e.target.value).toFixed(2);
});
$("smooth-range").addEventListener("input", (e) => {
  tracker.smoothing = +e.target.value;
  $("smooth-label").textContent = (+e.target.value).toFixed(2);
});

// initialize labels
$("dwell-label").textContent = dwellSeconds.toFixed(1) + "s";
