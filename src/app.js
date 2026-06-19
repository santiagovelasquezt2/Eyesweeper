// app.js — wires the game + eye tracker, plus all the UX:
// onboarding wizard, snap-to-cell gaze, dwell-to-reveal, blink/wink-to-flag,
// sound + visual feedback, persisted settings, and best-time tracking.
import { Minesweeper, DIFFICULTIES } from "./game/minesweeper.js";
import { EyeTracker } from "./eye/eyetracking.js";
import { sfx } from "./ui/sound.js";
import { runWizard } from "./ui/wizard.js";

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
function formatCounter(value) {
  const sign = value < 0 ? "-" : "";
  const max = sign ? 99 : 999;
  return sign + String(Math.min(Math.abs(value), max)).padStart(sign ? 2 : 3, "0");
}

// ---------- Game ----------
let currentDifficulty = settings.difficulty in DIFFICULTIES ? settings.difficulty : "beginner";

const game = new Minesweeper(boardEl, {
  onStateChange: (s) => {
    mineCounter.textContent = formatCounter(s.minesRemaining);
    if (s.gameOver) {
      faceBtn.className = `face-btn ${s.won ? "face-win" : "face-lose"}`;
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
      faceBtn.className = "face-btn";
    }
  },
  onTick: (t) => { timerEl.textContent = formatCounter(t); },
  onReveal: () => sfx.reveal(),
  onFlag: (flagged) => sfx.flag(flagged),
});

function newGame(msg) {
  game.reset(DIFFICULTIES[currentDifficulty]);
  clearDwell();
  highlightCell(null);
  game.invalidateGeometry();
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
    case "r": case "R": recenterGaze(); e.preventDefault(); break;
  }
});

// ---------- Shared highlight + snap ----------
// `focusedEl` is the single "active cell" the whole gaze layer agrees on
// (highlight, cursor snap, dwell, recenter, flag gesture). It's chosen with
// hysteresis in resolveActive() so brief jitter / gutter hits don't flip it.
// Dwell state lives in the dwell logic below — highlight no longer touches it.
let focusedEl = null;
function highlightCell(el) {
  if (focusedEl === el) return;
  if (focusedEl) focusedEl.classList.remove("gaze-focus");
  focusedEl = el;
  if (el) el.classList.add("gaze-focus");
}

// ---------- Dwell-to-reveal (hysteresis + accumulate/decay) ----------
let dwellSeconds = settings.dwell;
// activeEl: the cell dwell is committed to. dwellProgress: accumulated ms toward
// reveal. dwellRing: the visible progress ring DOM node inside activeEl.
// dwellOffSince: when gaze first left the active cell (null while on it).
// dwellLastNow: previous frame time, for real-elapsed dt.
let activeEl = null, dwellProgress = 0, dwellRing = null;
let dwellOffSince = null, dwellLastNow = 0;
let lastRingPct = -1;
// committedEl/committedAt: the cell a dwell just revealed + when (anti-double-fire).
// committedLeft: has gaze left the committed cell at least once since the commit?
let committedEl = null, committedAt = 0, committedLeft = false;
const DWELL_GRACE_MS = 250; // keep the active cell through brief loss / wander
const DWELL_HYSTERESIS = 0.30; // margin (fraction of a cell) before switching away
const DWELL_HYSTERESIS_MAX = 0.45; // margin grows toward this as the ring fills
const ONSET_MS = 180; // quiet lead-in before the ring starts filling
const LOCKOUT_MS = 500; // block re-dwell on a just-revealed cell for this long

function makeRing(el) {
  const ring = document.createElement("div");
  ring.className = "dwell-ring";
  el.appendChild(ring);
  return ring;
}
function paintRing() {
  if (!dwellRing) return;
  // The first ONSET_MS is a quiet lead-in: ring stays empty so it doesn't flicker
  // as the eye passes over cells. Visible fill spans ONSET_MS → full dwell.
  const span = Math.max(1, dwellSeconds * 1000 - ONSET_MS);
  const pct = Math.max(0, Math.min(1, (dwellProgress - ONSET_MS) / span));
  dwellRing.classList.toggle("onset", pct <= 0);
  if (Math.abs(pct - lastRingPct) < 0.01 && pct !== 0 && pct !== 1) return;
  lastRingPct = pct;
  dwellRing.style.setProperty("--dwell-progress", pct.toFixed(3));
}
// fully reset dwell state and drop the ring
function clearDwell() {
  if (dwellRing) dwellRing.remove();
  dwellRing = null;
  activeEl = null;
  dwellProgress = 0;
  lastRingPct = -1;
  dwellOffSince = null;
}

// Is `el` a still-revealable cell? (exists, not revealed/flagged, game live)
function dwellableCell(el) {
  if (!el || !el.classList.contains("cell")) return null;
  const r = +el.dataset.r, c = +el.dataset.c;
  const cell = game.grid[r]?.[c];
  if (!cell || cell.revealed || cell.flagged || game.gameOver) return null;
  return { r, c, cell };
}

// Pick the active cell with hysteresis. `rawEl` is the literal gaze-hit cell
// (or null), `g` the raw gaze point. Once a cell is active we keep it until the
// raw point leaves its rect by ~30% of a cell on any side — wobble and gutter
// hits stay put. Returns the element the whole gaze layer should treat as active.
function resolveActive(rawEl, g) {
  if (activeEl && document.body.contains(activeEl) && dwellableCell(activeEl)) {
    if (rawEl === activeEl) return activeEl; // squarely on it
    if (g) {
      const rect = cellRect(activeEl);
      // Grow the leave-margin as the dwell fills so a near-complete reveal can't
      // be stolen by jitter at a Voronoi boundary.
      const ratio = Math.max(0, Math.min(1, dwellProgress / (dwellSeconds * 1000)));
      const margin = DWELL_HYSTERESIS + (DWELL_HYSTERESIS_MAX - DWELL_HYSTERESIS) * ratio;
      const mx = rect.width * margin, my = rect.height * margin;
      const inside =
        g.x >= rect.left - mx && g.x <= rect.right + mx &&
        g.y >= rect.top - my && g.y <= rect.bottom + my;
      if (inside) return activeEl; // within the hysteresis margin → keep it
    }
  }
  // Outside the margin (or no active cell yet): adopt the raw hit if valid.
  return dwellableCell(rawEl) ? rawEl : null;
}

function cellRect(el) {
  const r = +el.dataset.r, c = +el.dataset.c;
  if (Number.isNaN(r) || Number.isNaN(c)) return el.getBoundingClientRect();
  const geo = game.getGeometry();
  const left = geo.left + c * geo.cellW;
  const top = geo.top + r * geo.cellH;
  return {
    left,
    top,
    right: left + geo.cellW,
    bottom: top + geo.cellH,
    width: geo.cellW,
    height: geo.cellH,
  };
}

// Drive dwell from the resolved active cell + the raw gaze hit.
// Accumulate only on a real fixation that's on the active cell; otherwise decay
// through the grace window (off-cell jitter, momentary loss, or saccade) and
// only give up after sustained loss. `fixating` is the tracker's fixation flag
// — false during fast eye movement (saccade), true while holding a point.
function updateDwell(activeCandidate, rawEl, now, fixating) {
  const dt = dwellLastNow ? Math.max(0, now - dwellLastNow) : 0;
  dwellLastNow = now;

  // Release the post-commit lock once the resolved active cell leaves it: that's
  // the "gaze must leave the cell once before re-dwell" requirement.
  if (committedEl && activeCandidate !== committedEl) {
    committedLeft = true;
    committedEl = null;
  }

  // Commit to a new cell only once we've genuinely settled on a valid one.
  if (activeCandidate && activeCandidate !== activeEl) {
    clearDwell();
    activeEl = activeCandidate;
    dwellRing = makeRing(activeEl);
  }

  if (!activeEl) { dwellOffSince = null; return; }

  // Committed cell became unrevealable (revealed elsewhere, game over) → drop it.
  if (!dwellableCell(activeEl) || !document.body.contains(activeEl)) { clearDwell(); return; }

  // Anti-double-fire: just after a reveal the eyes linger on the result, which
  // could instantly re-trigger. Hold accumulation while inside the lockout window
  // OR until gaze has left the just-committed cell at least once.
  const lockedOut = (now - committedAt < LOCKOUT_MS) ||
    (activeEl === committedEl && !committedLeft);

  // Accumulate while a real fixation holds the SAME cell hysteresis is keeping
  // active. With nearest-cell snapping the raw hit flips at Voronoi boundaries
  // during a steady fixation, so we gate on the resolved cell, not raw equality.
  if (activeCandidate === activeEl && fixating && !lockedOut) {
    dwellOffSince = null;
    dwellProgress += dt;
  } else {
    // Resolved active cell changed, fixation lost, or locked out. Tolerate brief
    // loss: decay the ring, only giving up after sustained off-cell loss.
    if (dwellOffSince == null) dwellOffSince = now;
    if (activeCandidate !== activeEl && now - dwellOffSince > DWELL_GRACE_MS && !activeCandidate) {
      clearDwell(); // sustained off-cell loss with nothing to switch to → give up
      return;
    }
    dwellProgress = Math.max(0, dwellProgress - dt); // slow decay (ring rewinds)
  }

  paintRing();
  if (dwellProgress >= dwellSeconds * 1000) {
    const { r, c } = dwellableCell(activeEl);
    const revealedEl = activeEl;
    // The cell's on-screen center is a high-confidence "user was looking here"
    // label — grab it before clearDwell()/reveal() mutate state.
    const rect = revealedEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    clearDwell();
    // Arm the post-commit lockout on the revealed cell.
    committedEl = revealedEl; committedAt = now; committedLeft = false;
    game.reveal(r, c);
    // Implicit drift correction: nudge the mapping so this sample lands on center.
    tracker.nudgeRecenter(cx, cy);
  }
}

// snap the visible cursor to the center of the active cell for stability
let cursorVisible = false;
let lastCursorX = NaN, lastCursorY = NaN, lastCursorSnapped = false;

function setCursorVisible(visible) {
  if (cursorVisible === visible) return;
  cursorVisible = visible;
  gazeCursor.classList.toggle("visible", visible);
  if (!visible) {
    lastCursorX = NaN;
    lastCursorY = NaN;
    lastCursorSnapped = false;
  }
}

function moveCursor(x, y, snapped) {
  if (lastCursorSnapped !== snapped) {
    gazeCursor.classList.toggle("snapped", snapped);
    lastCursorSnapped = snapped;
  }
  if (Math.abs(x - lastCursorX) < 0.5 && Math.abs(y - lastCursorY) < 0.5) return;
  lastCursorX = x;
  lastCursorY = y;
  gazeCursor.style.transform = `translate(${x}px, ${y}px)`;
}

function cursorTo(g, hitEl) {
  if (hitEl) {
    const r = +hitEl.dataset.r, c = +hitEl.dataset.c;
    if (Number.isNaN(r) || Number.isNaN(c)) {
      const rect = hitEl.getBoundingClientRect();
      moveCursor(rect.left + rect.width / 2, rect.top + rect.height / 2, true);
      return;
    }
    const geo = game.getGeometry();
    const cx = geo.left + c * geo.cellW + geo.cellW / 2;
    const cy = geo.top + r * geo.cellH + geo.cellH / 2;
    moveCursor(cx, cy, true);
  } else {
    moveCursor(g.x, g.y, false);
  }
}

// ---------- Recenter gaze (drift correction) ----------
// Press R: tell the tracker the user is currently looking at a known point —
// the focused cell's center if there is one, otherwise the viewport center.
function recenterGaze() {
  let tx = window.innerWidth / 2, ty = window.innerHeight / 2;
  if (focusedEl) {
    const rect = cellRect(focusedEl);
    tx = rect.left + rect.width / 2;
    ty = rect.top + rect.height / 2;
  }
  const ok = tracker.recenter(tx, ty);
  if (ok) {
    sfx.tick();
    gazeCursor.classList.add("blinking"); // reuse cursor flash for feedback
    setTimeout(() => gazeCursor.classList.remove("blinking"), 220);
    setPill("gaze-status", "recentered", "active");
  }
}

// ---------- Eye tracker ----------
let latestStatus = {};
let pillFlushAt = 0;
let pillFlushScheduled = false;
let lastOpen = -1, lastThreshold = -1;

const tracker = new EyeTracker($("webcam"), {
  onStatus: (s) => {
    Object.assign(latestStatus, s);
    const now = performance.now();
    if (now >= pillFlushAt) {
      flushPills();
      pillFlushAt = now + 250;
    } else if (!pillFlushScheduled) {
      pillFlushScheduled = true;
      setTimeout(flushPills, 250);
    }
  },
  onOpenness: ({ open, threshold }) => {
    if (Math.abs(open - lastOpen) >= 0.02) {
      lastOpen = open;
      const fill = $("openness-fill");
      fill.style.width = Math.min(100, (open / 1.1) * 100) + "%";
      fill.classList.toggle("closed", open < threshold);
    }
    if (Math.abs(threshold - lastThreshold) >= 0.02) {
      lastThreshold = threshold;
      $("openness-threshold").style.left = Math.min(100, (threshold / 1.1) * 100) + "%";
    }
  },
  onGaze: (g) => {
    const now = performance.now();
    if (!g) {
      // Gaze momentarily lost: hide the cursor but DON'T reset dwell. Not a
      // fixation, so dwell decays through the grace window (never a hard reset).
      setCursorVisible(false);
      updateDwell(resolveActive(null, null), null, now, false);
      highlightCell(activeEl);
      return;
    }
    setCursorVisible(true);
    // Snap to the nearest cell so gutter/edge gaze never lands in a dead zone;
    // returns null only when gaze is clearly off the board (toolbar/menus).
    const hit = game.nearestCell(g.x, g.y);
    const rawEl = hit ? hit.el : null;
    // One resolved active cell drives cursor, highlight, and dwell so they agree.
    // Dwell only accumulates while `g.fixating` (eyes holding still on a point).
    const active = resolveActive(rawEl, g);
    updateDwell(active, rawEl, now, g.fixating === true);
    const focus = activeEl || rawEl;
    cursorTo(g, focus);
    highlightCell(focus);
  },
  onFlag: () => {
    // ignore gestures while an overlay (calibration / wizard) is up
    if (!$("calibration-overlay").classList.contains("hidden")) return;
    if (!$("wizard").classList.contains("hidden")) return;
    gazeCursor.classList.add("blinking");
    setTimeout(() => gazeCursor.classList.remove("blinking"), 220);
    const el = focusedEl;
    if (el && el.classList.contains("cell")) {
      game.toggleFlag(+el.dataset.r, +el.dataset.c);
      // Arm the post-commit lockout here too: after an un-flag the eye still
      // rests on this cell, and we don't want it to instantly dwell-reveal.
      committedEl = el;
      committedAt = performance.now();
      committedLeft = false;
    }
  },
});

const pillState = new Map();
function setPill(id, text, kind) {
  const key = text + "\0" + kind;
  if (pillState.get(id) === key) return;
  pillState.set(id, key);
  const el = $(id);
  el.textContent = text;
  el.className = "pill " + (kind === "on" ? "pill-on" : kind === "active" ? "pill-active" : "pill-off");
}

function flushPills() {
  const s = latestStatus;
  if (s.cam) setPill("cam-status", s.cam, s.cam === "on" ? "on" : "off");
  if (s.gaze) setPill("gaze-status", s.gaze, s.gaze === "tracking" ? "active" : "off");
  if (s.signal) setPill("signal-status", s.signal,
    s.signal === "good" ? "on" : (s.signal === "warming…" ? "active" : "off"));
  pillFlushScheduled = false;
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
    document.body.classList.add("eye-active");
    eyeToggle.textContent = "Disable eye tracking";
    $("calibrate-btn").disabled = false;
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
  document.body.classList.remove("eye-active");
	  eyeToggle.textContent = "Enable eye tracking";
	  pauseBtn.textContent = "⏸"; pauseBtn.disabled = true;
	  $("calibrate-btn").disabled = true;
	  setCursorVisible(false);
	  clearDwell(); highlightCell(null);
}

pauseBtn.addEventListener("click", () => {
  paused = !paused;
  tracker.setPaused(paused);
  pauseBtn.textContent = paused ? "▶" : "⏸";
  // gaze stops feeding updateDwell while paused, so clear any in-flight dwell ring.
  if (paused) { setCursorVisible(false); clearDwell(); highlightCell(null); }
});

// ---------- Calibration (standalone "recalibrate") ----------
const calOverlay = $("calibration-overlay");
const calRing = $("calibration-ring");
$("calibrate-btn").addEventListener("click", () => runCalibration());

function calibrationPoints() {
  const m = 0.12; // corner/edge inset from the viewport edge
  // 13 well-spread targets for a richer calibration fit: 4 corners, 4 edge
  // midpoints, the center, and 4 inner points around the 0.3 / 0.7 ring.
  return [
    [m, m], [0.5, m], [1 - m, m],          // top: corners + mid
    [m, 0.5],          [1 - m, 0.5],        // sides: mids (center handled below)
    [m, 1 - m], [0.5, 1 - m], [1 - m, 1 - m], // bottom: corners + mid
    [0.5, 0.5],                            // center
    [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7], // inner ring
  ];
}

async function runCalibration() {
  if (!eyeOn) return false;
  if (paused) { paused = false; tracker.setPaused(false); pauseBtn.textContent = "⏸"; }
  tracker.resetCalibration();
  calOverlay.classList.remove("hidden");
  for (const [fx, fy] of calibrationPoints()) {
    const px = fx * window.innerWidth, py = fy * window.innerHeight;
    calRing.style.left = px + "px"; calRing.style.top = py + "px";
    calRing.style.setProperty("--ring-progress", 0);
    sfx.tick();
    // dwell-gated: only advances once the user holds a steady stare
    await tracker.collectPointGated(px, py, {
      holdMs: 700,
      onProgress: (p) => calRing.style.setProperty("--ring-progress", p.toFixed(3)),
    });
    sfx.tick(); // confirm the point landed
  }
  calOverlay.classList.add("hidden");
  const ok = tracker.finalizeCalibration();
  statusLine.textContent = ok
    ? "Calibrated! Look at a cell to aim, dwell to reveal, blink to flag."
    : "Calibration failed — try again with good lighting and a steady head.";
  statusLine.className = "status-line" + (ok ? "" : " lose");
  return ok;
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
let resizeRaf = 0;
function onResize() {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; game.invalidateGeometry(); });
}
window.addEventListener("resize", onResize);
window.addEventListener("scroll", onResize, { passive: true });

applySettings();
renderBestTime();
newGame("Pick a difficulty and start sweeping.");
	// first-time users get the wizard offer
	if (!settings.onboarded) {
	  statusLine.textContent = "New here? Click “Setup wizard” for a guided start.";
	}

const debugPerf = new URLSearchParams(location.search).has("debugPerf");
if (debugPerf) {
  const perfEl = document.createElement("div");
  perfEl.id = "perf-overlay";
  perfEl.style.cssText = "position:fixed; top:8px; right:8px; z-index:10002; font:11px/1.4 ui-monospace,Menlo,monospace; background:rgba(0,0,0,.72); color:#9ff; padding:6px 9px; border-radius:6px; pointer-events:none; white-space:pre;";
  document.body.appendChild(perfEl);
  setInterval(() => {
    if (!tracker.getPerf) return;
    const p = tracker.getPerf();
    perfEl.textContent = "inf " + p.inferenceFPS + "fps\navg " + p.avgDetectMs.toFixed(1) + "ms\ndrop " + p.droppedFrames + "\nrndr " + p.renderFPS + "fps\nstate " + (tracker.state || "?");
  }, 250);
}
