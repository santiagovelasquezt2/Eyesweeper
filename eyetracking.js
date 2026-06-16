// eyetracking.js — webcam gaze estimation + deliberate-blink detection.
// Uses MediaPipe Tasks Vision FaceLandmarker (loaded from CDN as an ES module).
//
// Pipeline:
//   webcam -> FaceLandmarker.detectForVideo() -> iris/eye landmarks + blendshapes
//   gaze feature (iris position within eye box) -> affine map (from calibration) -> screen px
//   blink blendshapes -> deliberate-blink state machine -> onBlink()

import { FaceLandmarker, FilesetResolver }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

// MediaPipe FaceMesh landmark indices we rely on.
const IDX = {
  rightIris: 468, rightOuter: 33, rightInner: 133, rightTop: 159, rightBottom: 145,
  leftIris: 473, leftInner: 362, leftOuter: 263, leftTop: 386, leftBottom: 374,
};

export class EyeTracker {
  constructor(videoEl, callbacks = {}) {
    this.video = videoEl;
    this.cb = callbacks; // { onGaze, onBlink, onStatus, onFace }
    this.landmarker = null;
    this.stream = null;
    this.running = false;
    this._raf = null;
    this._lastVideoTime = -1;

    // calibration: affine map feature(hx,hy) -> screen(x,y)
    this.calib = null;          // { ax, ay } param vectors length 3
    this.calibSamples = [];

    // gaze smoothing
    this.smoothing = 0.30;
    this.smoothed = null;

    // blink detection
    this.blinkThreshold = 0.5;  // blendshape value above which eyes are "closed"
    this.minBlinkMs = 180;      // ignore micro/natural blinks shorter than this
    this.maxBlinkMs = 900;      // longer than this = probably resting, ignore
    this._eyesClosed = false;
    this._closeStart = 0;
    this._lastBlinkAt = 0;
    this.blinkCooldownMs = 700;
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
    this.cb.onStatus?.({ cam: "on" });
    this._loop();
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.cb.onStatus?.({ cam: "off", gaze: "—", blink: "—" });
  }

  _loop() {
    if (!this.running) return;
    const now = performance.now();
    if (this.video.currentTime !== this._lastVideoTime && this.video.readyState >= 2) {
      this._lastVideoTime = this.video.currentTime;
      let res;
      try {
        res = this.landmarker.detectForVideo(this.video, now);
      } catch (e) {
        // transient frame errors are fine; keep looping
        res = null;
      }
      if (res && res.faceLandmarks && res.faceLandmarks.length) {
        this._handle(res, now);
        this.cb.onStatus?.({ gaze: this.calib ? "tracking" : "uncalibrated" });
      } else {
        this.cb.onStatus?.({ gaze: "no face" });
        this.cb.onGaze?.(null);
      }
    }
    this._raf = requestAnimationFrame(() => this._loop());
  }

  // Extract the gaze feature (normalized iris position within each eye, averaged).
  _feature(landmarks) {
    const L = landmarks;
    const eye = (iris, c1, c2, top, bot) => {
      const ax = L[c2].x - L[c1].x;
      const ay = L[bot].y - L[top].y;
      if (Math.abs(ax) < 1e-6 || Math.abs(ay) < 1e-6) return null;
      return {
        hx: (L[iris].x - L[c1].x) / ax,
        hy: (L[iris].y - L[top].y) / ay,
      };
    };
    const r = eye(IDX.rightIris, IDX.rightInner, IDX.rightOuter, IDX.rightTop, IDX.rightBottom);
    const l = eye(IDX.leftIris, IDX.leftInner, IDX.leftOuter, IDX.leftTop, IDX.leftBottom);
    if (!r || !l) return null;
    return { hx: (r.hx + l.hx) / 2, hy: (r.hy + l.hy) / 2 };
  }

  _blinkValue(res) {
    const bs = res.faceBlendshapes?.[0]?.categories;
    if (!bs) return 0;
    let left = 0, right = 0;
    for (const c of bs) {
      if (c.categoryName === "eyeBlinkLeft") left = c.score;
      else if (c.categoryName === "eyeBlinkRight") right = c.score;
    }
    return (left + right) / 2;
  }

  _handle(res, now) {
    const lm = res.faceLandmarks[0];
    this.cb.onFace?.(lm);
    const feat = this._feature(lm);

    // ---- Blink state machine ----
    const blink = this._blinkValue(res);
    const closed = blink > this.blinkThreshold;
    if (closed && !this._eyesClosed) {
      this._eyesClosed = true;
      this._closeStart = now;
    } else if (!closed && this._eyesClosed) {
      this._eyesClosed = false;
      const dur = now - this._closeStart;
      if (dur >= this.minBlinkMs && dur <= this.maxBlinkMs &&
          now - this._lastBlinkAt > this.blinkCooldownMs) {
        this._lastBlinkAt = now;
        this.cb.onBlink?.();
        this.cb.onStatus?.({ blink: "flag!" });
      }
    }
    this.cb.onStatus?.({ blink: closed ? "closed" : "open" });

    // ---- Gaze mapping ----
    if (!feat) return;
    if (this._collecting) {
      this._collecting(feat);
      return;
    }
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

  _apply(p, feat) {
    return p[0] * feat.hx + p[1] * feat.hy + p[2];
  }

  // Calibration: caller drives dots; we collect samples for the current target.
  // Returns a promise resolving to a sample average for the held point.
  collectPoint(screenX, screenY, durationMs = 1100) {
    return new Promise((resolve) => {
      const samples = [];
      this._collecting = (feat) => samples.push(feat);
      setTimeout(() => {
        this._collecting = null;
        if (samples.length) {
          // drop first third (saccade settling), average the rest
          const keep = samples.slice(Math.floor(samples.length / 3));
          const avg = keep.reduce(
            (acc, s) => ({ hx: acc.hx + s.hx, hy: acc.hy + s.hy }),
            { hx: 0, hy: 0 }
          );
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

  // Fit two least-squares affine maps from collected calibration samples.
  finalizeCalibration() {
    const s = this.calibSamples;
    if (s.length < 4) return false;
    // design rows: [hx, hy, 1]
    const X = s.map((p) => [p.feat.hx, p.feat.hy, 1]);
    const ax = solveLeastSquares(X, s.map((p) => p.x));
    const ay = solveLeastSquares(X, s.map((p) => p.y));
    if (!ax || !ay) return false;
    this.calib = { ax, ay };
    this.smoothed = null;
    return true;
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Solve (X^T X) b = X^T y for b, where X is n×3. Returns length-3 vector or null.
function solveLeastSquares(X, y) {
  const n = X.length;
  // A = X^T X (3×3), g = X^T y (3)
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

// Gaussian elimination with partial pivoting for a 3×3 system A b = g.
function solve3x3(A, g) {
  const M = [
    [A[0][0], A[0][1], A[0][2], g[0]],
    [A[1][0], A[1][1], A[1][2], g[1]],
    [A[2][0], A[2][1], A[2][2], g[2]],
  ];
  for (let col = 0; col < 3; col++) {
    // pivot
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-9) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    // eliminate
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}
