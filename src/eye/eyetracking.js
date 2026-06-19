// eyetracking.js — webcam gaze estimation + adaptive blink/wink detection.
// Uses MediaPipe Tasks Vision FaceLandmarker (loaded from CDN as an ES module).
//
// Design goals (pragmatic, glasses-friendly):
//   - Gaze: iris-in-eye position -> quadratic map fit from a short calibration,
//     smoothed with a One Euro filter and correctable via recenter().
//   - Blink/Wink: ADAPTIVE eye-aspect-ratio (EAR) relative to a per-user open
//     baseline, NOT a fixed blendshape threshold. Glasses glare/reflections wreck
//     absolute thresholds, so we track each eye's own "open" baseline and detect a
//     relative drop. Blendshapes are used only as a soft confirmation when glasses
//     mode is off.

// MediaPipe Tasks Vision is loaded lazily on first start() so the CDN fetch
// (and WASM init) doesn't block initial game interactivity. The module promise
// is cached at module scope so subsequent starts reuse it.
const MP_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
const MP_WASM =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MP_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

let _mpPromise = null;
let _resolverPromise = null;
function loadMediaPipe() {
  if (!_mpPromise) {
    _mpPromise = import(MP_CDN);
  }
  return _mpPromise;
}

async function loadResolver() {
  if (!_resolverPromise) {
    _resolverPromise = loadMediaPipe().then(({ FilesetResolver }) =>
      FilesetResolver.forVisionTasks(MP_WASM)
    );
  }
  return _resolverPromise;
}

// MediaPipe FaceMesh landmark indices.
const IDX = {
  rightIris: 468, rightOuter: 33, rightInner: 133,
  leftIris: 473, leftInner: 362, leftOuter: 263,
  // eyelid pairs for EAR (top, bottom) — a few pairs per eye for robustness
  rightLid: [[159, 145], [158, 153], [160, 144]], rightH: [33, 133],
  leftLid: [[386, 374], [385, 380], [387, 373]], leftH: [362, 263],
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export class EyeTracker {
  constructor(videoEl, callbacks = {}) {
    this.video = videoEl;
    this.cb = callbacks; // { onGaze, onFlag, onStatus, onFace, onOpenness }
    this.landmarker = null;
    this.stream = null;
    this.running = false;
    this.paused = false;
    this.state = "idle"; // idle | loading | running | paused | stopping | error
    this._startPromise = null;
    this._raf = null;
    this._rvfc = null;
    this._pauseTimer = null;
    this._lastVideoTime = -1;

    // inference throttle (~20 FPS target) + loop scheduling
    this._detectIntervalMs = 50;
    this._lastDetectAt = 0;

    // perf instrumentation (see getPerf)
    this._detectsLastSec = [];
    this._rendersLastSec = [];
    this._detectMsList = [];
    this._droppedFrames = 0;
    this._status = {};
    this._pendingStatus = null;
    this._statusTimer = null;
    this._lastStatusAt = 0;

    // calibration: ridge-regularized least-squares map from the rich gaze
    // feature {bgx,bgy,hx,hy,yaw,pitch} -> screen(x,y). this.calib = {ax, ay, full}
    // where `full` selects the 10-term (quadratic) vs 7-term (linear) basis.
    this.calib = null;
    this.calibSamples = [];
    this._collecting = null;

    // gaze smoothing — One Euro filter (adaptive low-pass, one per axis)
    this.smoothing = 0.30;
    this._euroX = null;
    this._euroY = null;
    this._initEuro();

    // drift correction: constant output offset applied to the mapped point
    this._offset = { x: 0, y: 0 };
    // last MAPPED, pre-offset, pre-smoothing point (for recenter)
    this._lastRaw = null;

    // I-DT fixation detection: rolling window of recent smoothed points. When
    // dispersion stays low for long enough we freeze the cursor on the window
    // centroid (a "lock-on") and report fixating=true on onGaze.
    this.FIX_WINDOW_MS = 200;   // points older than this are dropped
    this.MIN_FIX_MS = 100;      // window must span at least this to count
    this.DISP_FACTOR = 0.06;    // dispersion threshold = factor * min(viewport)
    this._fixWindow = [];       // [{ x, y, t }]

    // blink/wink config
    this.flagGesture = "blink";  // "blink" | "wink"
    this.glassesMode = false;
    this.sensitivity = 0.5;      // 0..1, higher = easier to trigger
    this.minBlinkMs = 160;       // ignore micro/natural blinks shorter than this
    this.maxBlinkMs = 1100;      // longer than this = resting, ignore
    this.cooldownMs = 650;

    // per-eye adaptive EAR baselines (open-eye reference)
    this._baseL = null;
    this._baseR = null;
    this._earL = null;           // smoothed EAR
    this._earR = null;
    this._earSmoothing = 0.5;

    // blink/wink state machines
    this._bothClosedSince = 0;
    this._bothClosed = false;
    // instantaneous "both eyes closed this frame" — used to hold the cursor while
    // the iris estimate is garbage (distinct from the _bothClosed blink latch).
    this._bothClosedNow = false;
    this._leftWinkSince = 0;
    this._rightWinkSince = 0;
    this._lastFlagAt = 0;

    // signal quality
    this._noFaceFrames = 0;
    this._gazeLost = false;
    this._lastLostGazeAt = 0;
    this._lostGazeIntervalMs = 150;
    this._baselineFrames = 0;
  }

  // (Re)create the One Euro filters. beta/dCutoff are fixed gaze-friendly
  // defaults; minCutoff is derived live from `this.smoothing` in _handle so
  // the existing slider stays meaningful.
  _initEuro() {
    this._euroX = new OneEuroFilter({ minCutoff: 1.0, beta: 0.007, dCutoff: 1.0 });
    this._euroY = new OneEuroFilter({ minCutoff: 1.0, beta: 0.007, dCutoff: 1.0 });
    this._lastFixating = false; // saccade-gated smoothing: relax cutoff until settled
  }

  // Map the smoothing slider (0..1) to One Euro minCutoff (Hz).
  // Higher slider => steadier => LOWER cutoff (more low-pass). We span a
  // perceptually useful range: slider 0 -> ~2.2 Hz (snappy), slider 1 -> ~0.4 Hz
  // (very steady). beta is fixed so fast saccades still cut through.
  _minCutoff() { return 2.2 - 1.8 * clamp(this.smoothing, 0, 1); }

  _trackRecent(list, now) {
    list.push(now);
    const cutoff = now - 1000;
    while (list.length && list[0] < cutoff) list.shift();
  }

  _emitStatus(next, { force = false } = {}) {
    const changed = {};
    for (const [key, value] of Object.entries(next)) {
      if (this._status[key] !== value) {
        this._status[key] = value;
        changed[key] = value;
      }
    }
    if (!Object.keys(changed).length) return;

    const now = performance.now();
    const flush = (payload) => {
      this._lastStatusAt = performance.now();
      this.cb.onStatus?.(payload);
    };

    if (force || now - this._lastStatusAt >= 250) {
      if (this._statusTimer) {
        clearTimeout(this._statusTimer);
        this._statusTimer = null;
      }
      const payload = this._pendingStatus ? { ...this._pendingStatus, ...changed } : changed;
      this._pendingStatus = null;
      flush(payload);
      return;
    }

    this._pendingStatus = { ...(this._pendingStatus || {}), ...changed };
    if (!this._statusTimer) {
      const wait = Math.max(0, 250 - (now - this._lastStatusAt));
      this._statusTimer = setTimeout(() => {
        this._statusTimer = null;
        const payload = this._pendingStatus;
        this._pendingStatus = null;
        if (payload) flush(payload);
      }, wait);
    }
  }

  async start() {
    // Already running: no-op. Paused: just resume.
    if (this.state === "running" || this.state === "loading") {
      return this._startPromise;
    }
    if (this.state === "paused") {
      this.setPaused(false);
      return this._startPromise;
    }
    // Dedupe concurrent calls.
    if (this._startPromise) return this._startPromise;

    this._startPromise = (async () => {
      this.state = "loading";
      this._emitStatus({ cam: "starting" }, { force: true });
      try {
        const [{ FaceLandmarker }, resolver] = await Promise.all([
          loadMediaPipe(),
          loadResolver(),
        ]);

        // GPU first, fall back to CPU if creation throws.
        try {
          this.landmarker = await FaceLandmarker.createFromOptions(resolver, {
            baseOptions: { modelAssetPath: MP_MODEL, delegate: "GPU" },
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: true,
            runningMode: "VIDEO",
            numFaces: 1,
          });
        } catch (gpuErr) {
          this._emitStatus({ signal: "GPU failed, trying CPU" }, { force: true });
          this.landmarker = await FaceLandmarker.createFromOptions(resolver, {
            baseOptions: { modelAssetPath: MP_MODEL, delegate: "CPU" },
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: true,
            runningMode: "VIDEO",
            numFaces: 1,
          });
          this._emitStatus({ signal: "CPU fallback" }, { force: true });
        }

        this.stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: 1280, min: 640 },
            height: { ideal: 720, min: 480 },
            frameRate: { ideal: 30, min: 15 },
          },
          audio: false,
        });
        this.video.srcObject = this.stream;
        await this.video.play();

        // reset perf + loop state
        this._lastVideoTime = -1;
        this._lastDetectAt = 0;
        this._detectsLastSec = [];
        this._rendersLastSec = [];
        this._detectMsList = [];
        this._droppedFrames = 0;
        this._gazeLost = false;
        this._lastLostGazeAt = 0;

        this.running = true;
        this.paused = false;
        this.state = "running";
        this._emitStatus({ cam: "on" }, { force: true });
        this._loop();
      } catch (err) {
        this.state = "error";
        this.running = false;
        this._startPromise = null;
        try { this.landmarker?.close?.(); } catch {}
        this.landmarker = null;
        this._emitStatus({ cam: "error", signal: String(err?.message || err) }, { force: true });
        throw err;
      } finally {
        // allow future start attempts after a clean run; the promise itself
        // is only used to dedupe concurrent calls during loading.
        if (this.state !== "loading") this._startPromise = null;
      }
    })();
    return this._startPromise;
  }

  stop() {
    this.state = "stopping";
    this.running = false;
    this.paused = false;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    if (this._pauseTimer) { clearTimeout(this._pauseTimer); this._pauseTimer = null; }
    if (this._statusTimer) { clearTimeout(this._statusTimer); this._statusTimer = null; }
    this._pendingStatus = null;
    if (this._rvfc) {
      // requestVideoFrameCallback has no universal cancel; best-effort via
      // the running flag check inside _loop.
      this._rvfc = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
    try { this.landmarker?.close?.(); } catch {}
    this.landmarker = null;
    this._startPromise = null;
    this.state = "idle";
    this._gazeLost = false;
    this._emitStatus({ cam: "off", gaze: "—", signal: "—" }, { force: true });
  }

  setPaused(p) {
    this.paused = p;
    if (p) {
      this.state = "paused";
      this._fixWindow = [];
      this.cb.onGaze?.(null);
    } else if (this.landmarker && this.running) {
      this.state = "running";
      if (this._pauseTimer) {
        clearTimeout(this._pauseTimer);
        this._pauseTimer = null;
        this._loop();
      }
    }
    this._emitStatus({ gaze: p ? "paused" : (this.calib ? "tracking" : "uncalibrated") }, { force: true });
  }

  // glasses mode tweaks: lean harder on relative EAR + smooth more
  setGlassesMode(on) {
    this.glassesMode = on;
    this._earSmoothing = on ? 0.35 : 0.5;
  }

  _loop() {
    if (!this.running) return;
    const now = performance.now();

    // When paused: keep the loop alive (so resume is instant) but do no work.
    if (this.paused) {
      this._scheduleLoop(250);
      return;
    }

    const newFrame = this.video.currentTime !== this._lastVideoTime
      && this.video.readyState >= 2;
    const throttleOk = now - this._lastDetectAt >= this._detectIntervalMs;

    if (newFrame && throttleOk) {
      this._lastVideoTime = this.video.currentTime;
      this._lastDetectAt = now;
      const t0 = now;
      let res = null;
      try {
        res = this.landmarker.detectForVideo(this.video, now);
      } catch (e) {
        this._droppedFrames++;
      }
      const dt = performance.now() - t0;
      this._trackRecent(this._detectsLastSec, now);
      this._detectMsList.push(dt);
      if (this._detectMsList.length > 30) this._detectMsList.shift();

      if (res && res.faceLandmarks && res.faceLandmarks.length) {
        this._noFaceFrames = 0;
        this._gazeLost = false;
        this._handle(res, now);
      } else {
        this._noFaceFrames++;
        if (this._noFaceFrames > 5) {
          this._emitStatus({ gaze: "no face", signal: "no face" });
          if (!this.paused && (!this._gazeLost || now - this._lastLostGazeAt >= this._lostGazeIntervalMs)) {
            this._gazeLost = true;
            this._lastLostGazeAt = now;
            this.cb.onGaze?.(null);
          }
        }
      }
    } else if (newFrame && !throttleOk) {
      // We have a fresh frame but throttled — count as a dropped opportunity.
      this._droppedFrames++;
    }

    this._scheduleLoop();
  }

  _scheduleLoop(delayMs = 0) {
    if (!this.running) return;
    if (delayMs > 0) {
      if (!this._pauseTimer) {
        this._pauseTimer = setTimeout(() => {
          this._pauseTimer = null;
          this._loop();
        }, delayMs);
      }
      this._raf = null;
      this._rvfc = null;
      return;
    }
    // Prefer per-decoded-frame callbacks (naturally camera-FPS bound).
    if (this.video && typeof this.video.requestVideoFrameCallback === "function") {
      const cb = () => this._loop();
      this._rvfc = this.video.requestVideoFrameCallback(cb);
      this._raf = null;
    } else {
      this._raf = requestAnimationFrame(() => this._loop());
      this._rvfc = null;
    }
  }

  getPerf() {
    const now = performance.now();
    // prune to last 1s
    const cutoffD = now - 1000;
    while (this._detectsLastSec.length && this._detectsLastSec[0] < cutoffD) this._detectsLastSec.shift();
    const cutoffR = now - 1000;
    while (this._rendersLastSec.length && this._rendersLastSec[0] < cutoffR) this._rendersLastSec.shift();
    const inferenceFPS = this._detectsLastSec.length;
    const avgDetectMs = this._detectMsList.length
      ? this._detectMsList.reduce((a, b) => a + b, 0) / this._detectMsList.length
      : 0;
    return {
      inferenceFPS,
      avgDetectMs,
      droppedFrames: this._droppedFrames,
      renderFPS: this._rendersLastSec.length,
    };
  }

  // ---- Gaze feature ----
  // Returns a rich feature object { bgx, bgy, hx, hy, yaw, pitch }:
  //   bgx/bgy  : blendshape gaze (head-normalized; PRIMARY signal, robust to head
  //              movement). Built from eyeLookIn/Out/Up/Down per eye.
  //   hx/hy    : iris pupil-center-minus-eye-corner vector, normalized by the
  //              eye-corner span and averaged across both eyes (SECONDARY; gives
  //              the fine resolution the blendshapes lack).
  //   yaw/pitch: head pose (radians) from the facial transformation matrix, so
  //              calibration can learn head-pose-dependent corrections.
  // Graceful fallback: missing blendshapes -> bgx=bgy=0; missing matrix ->
  // yaw=pitch=0. Never throws (an older model degrades to iris-only).
  _feature(L, blend, mat) {
    // --- iris PC-EC vector, averaged across both eyes (always available) ---
    // pupil-center minus eye-corner midpoint, normalized by the eye-corner span.
    const eye = (iris, c1, c2) => {
      const ax = L[c2].x - L[c1].x;       // eye-corner span (x)
      const ay = L[c2].y - L[c1].y;       // eye-corner span (y)
      const span = Math.hypot(ax, ay);
      if (span < 1e-6) return null;
      const cx = (L[c1].x + L[c2].x) / 2; // eye center = corner midpoint
      const cy = (L[c1].y + L[c2].y) / 2;
      return { hx: (L[iris].x - cx) / span, hy: (L[iris].y - cy) / span };
    };
    const r = eye(IDX.rightIris, IDX.rightInner, IDX.rightOuter);
    const l = eye(IDX.leftIris, IDX.leftInner, IDX.leftOuter);
    if (!r || !l) return null;
    const hx = (r.hx + l.hx) / 2;
    const hy = (r.hy + l.hy) / 2;

    // --- blendshape gaze (head-normalized, PRIMARY) ---
    let bgx = 0, bgy = 0;
    const cats = blend && blend.categories;
    if (cats && cats.length) {
      let lookInR = 0, lookOutR = 0, lookInL = 0, lookOutL = 0;
      let lookUpR = 0, lookDownR = 0, lookUpL = 0, lookDownL = 0;
      for (const c of cats) {
        switch (c.categoryName) {
          case "eyeLookInRight": lookInR = c.score; break;
          case "eyeLookOutRight": lookOutR = c.score; break;
          case "eyeLookInLeft": lookInL = c.score; break;
          case "eyeLookOutLeft": lookOutL = c.score; break;
          case "eyeLookUpRight": lookUpR = c.score; break;
          case "eyeLookDownRight": lookDownR = c.score; break;
          case "eyeLookUpLeft": lookUpL = c.score; break;
          case "eyeLookDownLeft": lookDownL = c.score; break;
        }
      }
      // consistent rightward signal across both eyes; up minus down for vertical.
      // (Absolute sign/scale is irrelevant — calibration fits it.)
      bgx = ((lookOutR - lookInR) + (lookInL - lookOutL)) / 2;
      bgy = ((lookUpR + lookUpL) - (lookDownR + lookDownL)) / 2;
    }

    // --- head pose from the column-major 4x4 transformation matrix ---
    // R[row][col] = m[col*4 + row].
    let yaw = 0, pitch = 0;
    const m = mat && mat.data;
    if (m && m.length >= 16) {
      const R00 = m[0], R10 = m[1], R20 = m[2];
      const R21 = m[6], R22 = m[10];
      const cy = Math.hypot(R00, R10);
      if (cy < 1e-6) {
        // gimbal lock: yaw is ill-defined; keep a stable (zeroed-yaw) estimate.
        pitch = Math.atan2(R21, R22);
        yaw = Math.atan2(-R20, cy);
      } else {
        pitch = Math.atan2(R21, R22);
        yaw = Math.atan2(-R20, cy);
        // roll = Math.atan2(R10, R00); // available but unused in the basis
      }
    }

    return { bgx, bgy, hx, hy, yaw, pitch };
  }

  // ---- EAR per eye: mean(vertical lid gaps) / horizontal eye width ----
  _ear(L, lids, h) {
    const w = dist(L[h[0]], L[h[1]]);
    if (w < 1e-6) return null;
    let v = 0;
    for (const [t, b] of lids) v += dist(L[t], L[b]);
    return (v / lids.length) / w;
  }

  // Update adaptive open-baseline: drift slowly toward EAR only when eye looks open.
  _updateBaseline(which, ear) {
    const base = which === "L" ? this._baseL : this._baseR;
    if (base == null) {
      if (which === "L") this._baseL = ear; else this._baseR = ear;
      return ear;
    }
    // only raise/track baseline from open-ish frames so blinks don't drag it down
    if (ear > base * 0.85) {
      const nb = base * 0.97 + ear * 0.03;
      if (which === "L") this._baseL = nb; else this._baseR = nb;
      return nb;
    }
    // gentle upward recovery if baseline somehow sank
    if (ear > base) {
      const nb = base * 0.9 + ear * 0.1;
      if (which === "L") this._baseL = nb; else this._baseR = nb;
      return nb;
    }
    return base;
  }

  // closeRatio: fraction of baseline below which the eye counts as "closed".
  // sensitivity 0..1 -> ratio 0.45..0.72 (higher sensitivity = easier trigger).
  _closeRatio() {
    const lo = 0.45, hi = 0.72;
    let r = lo + (hi - lo) * this.sensitivity;
    if (this.glassesMode) r += 0.05; // glasses dampen EAR swing -> be a bit more lenient
    return Math.min(0.8, r);
  }

  _handle(res, now) {
    const L = res.faceLandmarks[0];
    this._trackRecent(this._rendersLastSec, now);
    this.cb.onFace?.(L);

    // ---- EAR + baselines ----
    let earL = this._ear(L, IDX.leftLid, IDX.leftH);
    let earR = this._ear(L, IDX.rightLid, IDX.rightH);
    if (earL != null) this._earL = this._earL == null ? earL : this._earL * (1 - this._earSmoothing) + earL * this._earSmoothing;
    if (earR != null) this._earR = this._earR == null ? earR : this._earR * (1 - this._earSmoothing) + earR * this._earSmoothing;

    if (this._earL != null && this._earR != null) {
      const bL = this._updateBaseline("L", this._earL);
      const bR = this._updateBaseline("R", this._earR);
      this._baselineFrames++;
      const ratio = this._closeRatio();
      const closedL = this._earL < bL * ratio;
      const closedR = this._earR < bR * ratio;
      // full blink: both irises unreliable -> hold the cursor (see gaze section)
      this._bothClosedNow = closedL && closedR;

      // live openness feedback (avg of both eyes, normalized to baseline)
      const openAvg = ((this._earL / bL) + (this._earR / bR)) / 2;
      this.cb.onOpenness?.({ open: Math.max(0, Math.min(1.2, openAvg)), threshold: ratio });

      this._detectFlag(closedL, closedR, now);

      // signal quality
      const ready = this._baselineFrames > 20;
      this._emitStatus({
        signal: ready ? "good" : "warming…",
        gaze: this.paused ? "paused" : (this.calib ? "tracking" : "uncalibrated"),
      });
    } else {
      this._bothClosedNow = false; // no EAR -> can't claim a full blink
    }

    if (this.paused) return;

    // ---- Gaze mapping ----
    const blend = res.faceBlendshapes && res.faceBlendshapes[0];
    const mat = res.facialTransformationMatrixes && res.facialTransformationMatrixes[0];
    const feat = this._feature(L, blend, mat);
    if (!feat) return;
    if (this._collecting) { this._collecting(feat); return; }
    if (!this.calib) return;

    // Full blink: the iris feature is unreliable, so hold the last cursor —
    // don't map, smooth, or push into the fixation window with garbage. Flag
    // detection + EAR bookkeeping already ran above, so a wink still works.
    if (this._bothClosedNow) return;

    const x = this._apply(this.calib.ax, feat);
    const y = this._apply(this.calib.ay, feat);
    // remember the mapped, pre-offset, pre-smoothing point for recenter()
    this._lastRaw = { x, y };
    // drift correction before clamping/smoothing
    const ox = x + this._offset.x;
    const oy = y + this._offset.y;
    const px = clamp(ox, 0, window.innerWidth);
    const py = clamp(oy, 0, window.innerHeight);
    // adaptive smoothing: steady when fixating, low-latency on saccades.
    // While not fixating (a saccade is underway) floor the cutoff high so the
    // filter tracks fast moves snappily; settle back to the slider value once
    // the previous frame reported a fixation.
    const mc = this._lastFixating ? this._minCutoff() : Math.max(this._minCutoff(), 3.0);
    const sx = this._euroX.filter(px, now, mc);
    const sy = this._euroY.filter(py, now, mc);

    // ---- I-DT fixation detection / cursor lock-on ----
    const pt = this._fixate(sx, sy, now);
    this._lastFixating = pt.fixating;
    this.cb.onGaze?.({ x: pt.x, y: pt.y, fixating: pt.fixating });
  }

  // Dispersion-threshold (I-DT) fixation detector. Maintains a rolling window of
  // recent smoothed points; when their dispersion stays small for long enough we
  // "lock on" by returning the window centroid (freezing the cursor) and flag
  // fixating=true. Otherwise returns the live smoothed point.
  _fixate(sx, sy, now) {
    const win = this._fixWindow;
    win.push({ x: sx, y: sy, t: now });
    // drop points older than the window span
    while (win.length && now - win[0].t > this.FIX_WINDOW_MS) win.shift();

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let sumX = 0, sumY = 0;
    for (const p of win) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      sumX += p.x; sumY += p.y;
    }
    const dispersion = (maxX - minX) + (maxY - minY);
    const span = win.length ? now - win[0].t : 0;
    const threshold = this.DISP_FACTOR * Math.min(window.innerWidth, window.innerHeight);

    if (win.length >= 2 && dispersion <= threshold && span >= this.MIN_FIX_MS) {
      // fixation: freeze on the centroid of the stable window
      return { x: sumX / win.length, y: sumY / win.length, fixating: true };
    }
    return { x: sx, y: sy, fixating: false };
  }

  _fire(kind) {
    this._lastFlagAt = performance.now();
    this.cb.onFlag?.(kind);
  }

  _detectFlag(closedL, closedR, now) {
    if (now - this._lastFlagAt < this.cooldownMs) {
      // keep transient states in sync so no stale event fires after cooldown
      this._bothClosed = closedL && closedR;
      this._leftWinkSince = 0;
      this._rightWinkSince = 0;
      return;
    }

    if (this.flagGesture === "blink") {
      const both = closedL && closedR;
      if (both && !this._bothClosed) { this._bothClosed = true; this._bothClosedSince = now; }
      else if (!both && this._bothClosed) {
        this._bothClosed = false;
        const dur = now - this._bothClosedSince;
        if (dur >= this.minBlinkMs && dur <= this.maxBlinkMs) this._fire("blink");
      }
    } else { // wink: exactly one eye closed, held briefly, then reopened
      // left wink
      if (closedL && !closedR) {
        if (!this._leftWinkSince) this._leftWinkSince = now;
      } else {
        if (this._leftWinkSince) {
          const dur = now - this._leftWinkSince;
          this._leftWinkSince = 0;
          if (dur >= this.minBlinkMs && dur <= this.maxBlinkMs) { this._fire("wink-left"); return; }
        }
      }
      // right wink
      if (closedR && !closedL) {
        if (!this._rightWinkSince) this._rightWinkSince = now;
      } else {
        if (this._rightWinkSince) {
          const dur = now - this._rightWinkSince;
          this._rightWinkSince = 0;
          if (dur >= this.minBlinkMs && dur <= this.maxBlinkMs) { this._fire("wink-right"); return; }
        }
      }
    }
  }

  // Evaluate the fitted model: basis(feat) dotted with the coefficient vector.
  // The term-set (full quadratic vs. linear) is taken from this.calib.full.
  _apply(p, feat) {
    const b = basis(feat, this.calib.full);
    const { mean, std } = this.calib;
    let s = 0;
    // same column standardization the fit used: intercept (i=0) stays raw.
    for (let i = 0; i < b.length; i++) {
      const bi = i === 0 ? 1 : (b[i] - mean[i]) / std[i];
      s += p[i] * bi;
    }
    return s;
  }

  // ---- Calibration ----
  collectPoint(screenX, screenY, durationMs = 1100) {
    return new Promise((resolve) => {
      const samples = [];
      this._collecting = (feat) => samples.push(feat);
      setTimeout(() => {
        this._collecting = null;
        if (samples.length) {
          const keep = samples.slice(Math.floor(samples.length / 3));
          const avg = keep.reduce((acc, s) => ({
            bgx: acc.bgx + s.bgx, bgy: acc.bgy + s.bgy,
            hx: acc.hx + s.hx, hy: acc.hy + s.hy,
            yaw: acc.yaw + s.yaw, pitch: acc.pitch + s.pitch,
          }), { bgx: 0, bgy: 0, hx: 0, hy: 0, yaw: 0, pitch: 0 });
          const k = keep.length;
          avg.bgx /= k; avg.bgy /= k; avg.hx /= k; avg.hy /= k;
          avg.yaw /= k; avg.pitch /= k;
          this.calibSamples.push({ feat: avg, x: screenX, y: screenY });
        }
        resolve(samples.length);
      }, durationMs);
    });
  }

  resetCalibration() {
    this.calibSamples = [];
    this.calib = null;
    this._offset = { x: 0, y: 0 };
    this._lastRaw = null;
    this._fixWindow = [];
    this._initEuro();
  }

  finalizeCalibration() {
    const s = this.calibSamples;
    if (s.length < 4) return false;
    // Full 10-term basis (with quadratic/cross terms) needs >=10 points;
    // otherwise drop to the 7-term linear basis to avoid overfitting.
    const full = s.length >= 10;
    const X = s.map((p) => basis(p.feat, full));
    const n = X.length, m = X[0].length;

    // Standardize the basis COLUMNS (z-score) so a single ridge fairly regularizes
    // mixed-scale terms (bgx^2 tiny vs pitch radians vs hx ~±0.1). Leave column 0
    // (the intercept) untouched. _apply applies the same transform at inference.
    const mean = new Array(m).fill(0);
    const std = new Array(m).fill(1);
    for (let j = 1; j < m; j++) {
      let mu = 0;
      for (let i = 0; i < n; i++) mu += X[i][j];
      mu /= n;
      let v = 0;
      for (let i = 0; i < n; i++) { const d = X[i][j] - mu; v += d * d; }
      v /= n;
      mean[j] = mu;
      const sd = Math.sqrt(v);
      std[j] = sd > 1e-9 ? sd : 1; // guard near-constant columns
    }
    const Xs = X.map((row) => {
      const out = new Array(m);
      out[0] = 1;
      for (let j = 1; j < m; j++) out[j] = (row[j] - mean[j]) / std[j];
      return out;
    });

    const ax = solveLeastSquares(Xs, s.map((p) => p.x));
    const ay = solveLeastSquares(Xs, s.map((p) => p.y));
    if (!ax || !ay) return false;
    if (!ax.every(Number.isFinite) || !ay.every(Number.isFinite)) return false;
    this.calib = { ax, ay, full, mean, std };
    this._initEuro();
    return true;
  }

  // Drift correction: shift output so the most recent gaze direction maps to
  // (targetX, targetY). Returns false if not calibrated / no recent sample.
  recenter(targetX, targetY) {
    if (!this.calib || !this._lastRaw) return false;
    this._offset = { x: targetX - this._lastRaw.x, y: targetY - this._lastRaw.y };
    return true;
  }

  // Gentle, bounded EMA version of recenter(): called when the user COMMITS a
  // selection on a known cell (high-confidence "looking here" label). Capped so a
  // mis-selection can't yank calibration.
  nudgeRecenter(targetX, targetY, alpha = 0.15) {
    if (!this.calib || !this._lastRaw) return false;
    const cur = this._offset || { x: 0, y: 0 };
    const desiredX = targetX - this._lastRaw.x;
    const desiredY = targetY - this._lastRaw.y;
    let nx = cur.x + (desiredX - cur.x) * alpha;
    let ny = cur.y + (desiredY - cur.y) * alpha;
    const cap = 0.08 * Math.min(window.innerWidth, window.innerHeight);
    nx = clamp(nx, cur.x - cap, cur.x + cap);
    ny = clamp(ny, cur.y - cap, cur.y + cap);
    this._offset = { x: nx, y: ny };
    return true;
  }

  hasCalibration() { return !!this.calib; }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Term vector for the gaze map, built from the rich feature object.
// Blendshape gaze (bgx,bgy) is the primary regressor (quadratic when enough
// data); iris (hx,hy) adds fine resolution and head pose (yaw,pitch) lets the
// fit correct for head-movement-induced shift.
//   full=true  (>=10 pts): [1, bgx, bgy, bgx^2, bgy^2, bgx*bgy, hx, hy, yaw, pitch] -> 10 terms
//   full=false (<10 pts):  [1, bgx, bgy, hx, hy, yaw, pitch]                          -> 7 terms
function basis(feat, full) {
  const { bgx, bgy, hx, hy, yaw, pitch } = feat;
  if (full) {
    return [1, bgx, bgy, bgx * bgx, bgy * bgy, bgx * bgy, hx, hy, yaw, pitch];
  }
  return [1, bgx, bgy, hx, hy, yaw, pitch];
}

// Ridge regularization added to the normal-matrix diagonal. Meaningful now that
// columns are standardized: each standardized column's X^T X diagonal ≈ n (~12),
// so a lambda of order 1 actually regularizes (1e-4 would be negligible).
const RIDGE = 1.0;

// Solve (X^T X + lambda I) b = X^T y for b. X is n×m (m = number of basis terms).
function solveLeastSquares(X, y) {
  const n = X.length;
  if (!n) return null;
  const m = X[0].length;
  const A = Array.from({ length: m }, () => new Array(m).fill(0));
  const g = new Array(m).fill(0);
  for (let i = 0; i < n; i++) {
    const xi = X[i];
    const yi = y[i];
    for (let r = 0; r < m; r++) {
      g[r] += xi[r] * yi;
      for (let c = 0; c < m; c++) A[r][c] += xi[r] * xi[c];
    }
  }
  // skip A[0][0]: never penalize the intercept (it carries the screen-center offset)
  for (let r = 1; r < m; r++) A[r][r] += RIDGE;
  return solveLinear(A, g);
}

// Solve A b = g for b. A is n×n. Gaussian elimination with partial pivoting.
// Returns null if the system is (near-)singular.
function solveLinear(A, g) {
  const n = A.length;
  // augmented matrix [A | g]
  const M = A.map((row, i) => [...row, g[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const pivVal = M[col][col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / pivVal;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const b = new Array(n);
  for (let r = 0; r < n; r++) b[r] = M[r][n] / M[r][r];
  return b;
}

// One Euro filter: adaptive low-pass for noisy interactive signals.
// Heavy smoothing when the value is nearly still, light smoothing on fast
// motion. See Casiez, Roussel & Vogel (CHI 2012).
class OneEuroFilter {
  constructor({ minCutoff = 1.0, beta = 0.007, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this._x = null;   // last filtered value
    this._dx = 0;     // last filtered derivative
    this._t = null;   // last timestamp (ms)
  }

  _alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  // value: raw sample. tMs: timestamp in milliseconds. minCutoff: optional
  // live override of the steadiness parameter (Hz).
  filter(value, tMs, minCutoff) {
    if (minCutoff != null) this.minCutoff = minCutoff;
    if (this._t == null || this._x == null) {
      this._t = tMs;
      this._x = value;
      this._dx = 0;
      return value;
    }
    let dt = (tMs - this._t) / 1000; // seconds
    if (!(dt > 0) || !Number.isFinite(dt)) dt = 1 / 60; // guard bad/zero dt
    this._t = tMs;

    // filter the derivative, then adapt the cutoff to the motion speed
    const dValue = (value - this._x) / dt;
    const aD = this._alpha(this.dCutoff, dt);
    this._dx = aD * dValue + (1 - aD) * this._dx;
    const cutoff = this.minCutoff + this.beta * Math.abs(this._dx);

    const a = this._alpha(cutoff, dt);
    this._x = a * value + (1 - a) * this._x;
    return this._x;
  }
}

// exported for unit testing
export const __test = { solveLeastSquares, solveLinear, basis, OneEuroFilter };
