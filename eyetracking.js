// eyetracking.js — webcam gaze estimation + adaptive blink/wink detection.
// Uses MediaPipe Tasks Vision FaceLandmarker (loaded from CDN as an ES module).
//
// Design goals (pragmatic, glasses-friendly):
//   - Gaze: iris-in-eye position -> affine map fit from a short calibration.
//   - Blink/Wink: ADAPTIVE eye-aspect-ratio (EAR) relative to a per-user open
//     baseline, NOT a fixed blendshape threshold. Glasses glare/reflections wreck
//     absolute thresholds, so we track each eye's own "open" baseline and detect a
//     relative drop. Blendshapes are used only as a soft confirmation when glasses
//     mode is off.

import { FaceLandmarker, FilesetResolver }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

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
    this._raf = null;
    this._lastVideoTime = -1;

    // calibration: affine map feature(hx,hy) -> screen(x,y)
    this.calib = null;
    this.calibSamples = [];
    this._collecting = null;

    // gaze smoothing
    this.smoothing = 0.30;
    this.smoothed = null;

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
    this._leftWinkSince = 0;
    this._rightWinkSince = 0;
    this._lastFlagAt = 0;

    // signal quality
    this._noFaceFrames = 0;
    this._baselineFrames = 0;
  }

  async start() {
    this.cb.onStatus?.({ cam: "starting" });
    const resolver = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );
    this.landmarker = await FaceLandmarker.createFromOptions(resolver, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU",
      },
      outputFaceBlendshapes: true,
      runningMode: "VIDEO",
      numFaces: 1,
    });

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    this.running = true;
    this.paused = false;
    this.cb.onStatus?.({ cam: "on" });
    this._loop();
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.cb.onStatus?.({ cam: "off", gaze: "—", signal: "—" });
  }

  setPaused(p) {
    this.paused = p;
    if (p) this.cb.onGaze?.(null);
    this.cb.onStatus?.({ gaze: p ? "paused" : (this.calib ? "tracking" : "uncalibrated") });
  }

  // glasses mode tweaks: lean harder on relative EAR + smooth more
  setGlassesMode(on) {
    this.glassesMode = on;
    this._earSmoothing = on ? 0.35 : 0.5;
  }

  _loop() {
    if (!this.running) return;
    const now = performance.now();
    if (this.video.currentTime !== this._lastVideoTime && this.video.readyState >= 2) {
      this._lastVideoTime = this.video.currentTime;
      let res = null;
      try {
        res = this.landmarker.detectForVideo(this.video, now);
      } catch (e) { res = null; }

      if (res && res.faceLandmarks && res.faceLandmarks.length) {
        this._noFaceFrames = 0;
        this._handle(res, now);
      } else {
        this._noFaceFrames++;
        if (this._noFaceFrames > 5) {
          this.cb.onStatus?.({ gaze: "no face", signal: "no face" });
          if (!this.paused) this.cb.onGaze?.(null);
        }
      }
    }
    this._raf = requestAnimationFrame(() => this._loop());
  }

  // ---- Gaze feature: normalized iris position within each eye, averaged ----
  _feature(L) {
    const eye = (iris, c1, c2, lidTop, lidBot) => {
      const ax = L[c2].x - L[c1].x;
      const ay = L[lidBot].y - L[lidTop].y;
      if (Math.abs(ax) < 1e-6 || Math.abs(ay) < 1e-6) return null;
      return {
        hx: (L[iris].x - L[c1].x) / ax,
        hy: (L[iris].y - L[lidTop].y) / ay,
      };
    };
    const r = eye(IDX.rightIris, IDX.rightInner, IDX.rightOuter, IDX.rightLid[0][0], IDX.rightLid[0][1]);
    const l = eye(IDX.leftIris, IDX.leftInner, IDX.leftOuter, IDX.leftLid[0][0], IDX.leftLid[0][1]);
    if (!r || !l) return null;
    return { hx: (r.hx + l.hx) / 2, hy: (r.hy + l.hy) / 2 };
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

      // live openness feedback (avg of both eyes, normalized to baseline)
      const openAvg = ((this._earL / bL) + (this._earR / bR)) / 2;
      this.cb.onOpenness?.({ open: Math.max(0, Math.min(1.2, openAvg)), threshold: ratio });

      this._detectFlag(closedL, closedR, now);

      // signal quality
      const ready = this._baselineFrames > 20;
      this.cb.onStatus?.({
        signal: ready ? "good" : "warming…",
        gaze: this.paused ? "paused" : (this.calib ? "tracking" : "uncalibrated"),
      });
    }

    if (this.paused) return;

    // ---- Gaze mapping ----
    const feat = this._feature(L);
    if (!feat) return;
    if (this._collecting) { this._collecting(feat); return; }
    if (!this.calib) return;

    const x = this._apply(this.calib.ax, feat);
    const y = this._apply(this.calib.ay, feat);
    const px = clamp(x, 0, window.innerWidth);
    const py = clamp(y, 0, window.innerHeight);
    if (!this.smoothed) this.smoothed = { x: px, y: py };
    const a = this.smoothing;
    this.smoothed.x = a * px + (1 - a) * this.smoothed.x;
    this.smoothed.y = a * py + (1 - a) * this.smoothed.y;
    this.cb.onGaze?.({ x: this.smoothed.x, y: this.smoothed.y });
  }

  _fire(kind) {
    this._lastFlagAt = performance.now();
    this.cb.onFlag?.(kind);
  }

  _detectFlag(closedL, closedR, now) {
    if (now - this._lastFlagAt < this.cooldownMs) {
      // still reset transient states so we don't fire stale events post-cooldown
      this._bothClosed = closedL && closedR;
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

  _apply(p, feat) { return p[0] * feat.hx + p[1] * feat.hy + p[2]; }

  // ---- Calibration ----
  collectPoint(screenX, screenY, durationMs = 1100) {
    return new Promise((resolve) => {
      const samples = [];
      this._collecting = (feat) => samples.push(feat);
      setTimeout(() => {
        this._collecting = null;
        if (samples.length) {
          const keep = samples.slice(Math.floor(samples.length / 3));
          const avg = keep.reduce((acc, s) => ({ hx: acc.hx + s.hx, hy: acc.hy + s.hy }), { hx: 0, hy: 0 });
          avg.hx /= keep.length; avg.hy /= keep.length;
          this.calibSamples.push({ feat: avg, x: screenX, y: screenY });
        }
        resolve(samples.length);
      }, durationMs);
    });
  }

  resetCalibration() {
    this.calibSamples = [];
    this.calib = null;
    this.smoothed = null;
  }

  finalizeCalibration() {
    const s = this.calibSamples;
    if (s.length < 4) return false;
    const X = s.map((p) => [p.feat.hx, p.feat.hy, 1]);
    const ax = solveLeastSquares(X, s.map((p) => p.x));
    const ay = solveLeastSquares(X, s.map((p) => p.y));
    if (!ax || !ay) return false;
    this.calib = { ax, ay };
    this.smoothed = null;
    return true;
  }

  hasCalibration() { return !!this.calib; }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Solve (X^T X) b = X^T y for b, X is n×3.
function solveLeastSquares(X, y) {
  const n = X.length;
  const A = [[0,0,0],[0,0,0],[0,0,0]];
  const g = [0,0,0];
  for (let i = 0; i < n; i++) {
    const xi = X[i];
    for (let r = 0; r < 3; r++) {
      g[r] += xi[r] * y[i];
      for (let c = 0; c < 3; c++) A[r][c] += xi[r] * xi[c];
    }
  }
  return solve3x3(A, g);
}

function solve3x3(A, g) {
  const M = [
    [A[0][0], A[0][1], A[0][2], g[0]],
    [A[1][0], A[1][1], A[1][2], g[1]],
    [A[2][0], A[2][1], A[2][2], g[2]],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-9) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

// exported for unit testing
export const __test = { solveLeastSquares, solve3x3 };
