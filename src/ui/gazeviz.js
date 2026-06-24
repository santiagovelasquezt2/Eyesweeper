// gazeviz.js — the live gaze "heat blob": a soft, warm blob that smoothly drags
// across the screen toward the latest gaze point, leaving a short, decaying heat
// trail behind it. This is the PRIMARY "where am I looking" indicator.
//
// Why this exists: the gaze samples arrive at ~20 Hz and, when snapped to grid
// cells, a slightly noisy signal looks like the cursor is teleporting — which
// reads as "broken." A blob that interpolates between samples in its own
// requestAnimationFrame loop glides at display refresh, so the motion stays
// smooth and you can actually SEE the tracker responding to your eyes. It never
// blocks: if no fresh samples arrive, the trail just fades out and the loop
// idles down.
//
// Rendering is additive ("lighter") radial gradients on a full-screen canvas
// with a per-frame alpha decay (destination-out). Overlapping recent points glow
// hotter — the classic webcam-eye-tracking heatmap aesthetic — without the cost
// of per-pixel colour-mapping.

export class GazeHeatmap {
  constructor() {
    const c = document.createElement("canvas");
    c.id = "gaze-heat";
    c.setAttribute("aria-hidden", "true");
    document.body.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext("2d");

    this.target = null;   // latest gaze point in CSS px {x, y}
    this.pos = null;      // interpolated render position (the "drag")
    this.fixating = false;
    this.heat = 0;        // 0..1 "temperature": climbs while fixating, cools on move
    this._on = false;     // should the blob currently be steered/shown
    this._raf = null;
    this._lastT = 0;
    this._idleFrames = 0; // frames since gaze was lost (lets the trail finish fading)

    this.reducedMotion =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;

    this._resize = this._resize.bind(this);
    this._tick = this._tick.bind(this);
    this._resize();
    window.addEventListener("resize", this._resize);
  }

  _resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth, h = window.innerHeight;
    this.w = w; this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    // draw in CSS pixels; the transform handles HiDPI scaling
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // Feed a new gaze point. `fixating` makes the blob hotter and tighter.
  push(x, y, fixating) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.target = { x, y };
    this.fixating = !!fixating;
    if (!this.pos || this.reducedMotion) this.pos = { x, y };
    this._on = true;
    this._idleFrames = 0;
    this._start();
  }

  // Gaze lost: stop steering. The trail fades on its own, then the loop stops.
  hide() {
    this._on = false;
    this.target = null;
  }

  // Hard reset (teardown / pause / calibration): wipe the canvas immediately.
  clear() {
    this._on = false;
    this.target = null;
    this.pos = null;
    this.heat = 0;
    if (this.ctx) this.ctx.clearRect(0, 0, this.w, this.h);
  }

  _start() {
    if (this._raf == null) {
      this._lastT = 0;
      this._raf = requestAnimationFrame(this._tick);
    }
  }

  _tick(t) {
    const ctx = this.ctx;
    const dt = this._lastT ? Math.min(64, t - this._lastT) : 16;
    this._lastT = t;
    const s = dt / 1000;

    // 1) Decay the existing heat trail. destination-out pulls every pixel's
    //    alpha down by `fade` this frame; a longer trail when motion is steady.
    const decayPerSec = this.reducedMotion ? 0.00002 : 0.0025;
    const fade = 1 - Math.pow(decayPerSec, s);
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = `rgba(0,0,0,${fade})`;
    ctx.fillRect(0, 0, this.w, this.h);

    // 2) Glide the render position toward the latest gaze (exponential approach).
    let speed = 0;
    if (this.pos && this.target) {
      const k = this.reducedMotion ? 1 : 1 - Math.pow(0.0008, s);
      const nx = this.pos.x + (this.target.x - this.pos.x) * k;
      const ny = this.pos.y + (this.target.y - this.pos.y) * k;
      speed = Math.hypot(nx - this.pos.x, ny - this.pos.y);
      this.pos = { x: nx, y: ny };
    }

    // 3) Temperature: rises while fixating/steady, cools while moving.
    const targetHeat = this._on ? (this.fixating ? 1 : 0.4) : 0;
    this.heat += (targetHeat - this.heat) * (1 - Math.pow(0.02, s));

    // 4) Stamp the warm blob + bright core at the current render position.
    if (this.pos && (this._on || this._idleFrames < 90)) {
      const moving = Math.min(1, speed / 6);
      const r = 24 + 28 * moving - 6 * this.heat; // tighter when hot, looser when moving
      const a = 0.14 + 0.12 * this.heat;
      this._stamp(this.pos.x, this.pos.y, Math.max(14, r), a);
      this._core(this.pos.x, this.pos.y, 8 + 5 * this.heat);
    }

    // Keep the loop alive while visible; once gaze is lost, run a few more frames
    // so the trail finishes fading, then stop and clear.
    if (this._on) {
      this._idleFrames = 0;
      this._raf = requestAnimationFrame(this._tick);
    } else if (this._idleFrames++ < 90) {
      this._raf = requestAnimationFrame(this._tick);
    } else {
      this._raf = null;
      this.pos = null;
      ctx.clearRect(0, 0, this.w, this.h);
    }
  }

  _stamp(x, y, r, a) {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = "lighter";
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    // heat ramp: white-hot center → amber → red → transparent
    g.addColorStop(0,    `rgba(255, 244, 214, ${a})`);
    g.addColorStop(0.35, `rgba(255, 176, 64, ${a * 0.68})`);
    g.addColorStop(0.7,  `rgba(255, 78, 36, ${a * 0.34})`);
    g.addColorStop(1,    "rgba(255, 40, 30, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  _core(x, y, r) {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = "lighter";
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0,   "rgba(255, 255, 255, 0.92)");
    g.addColorStop(0.5, "rgba(255, 236, 188, 0.5)");
    g.addColorStop(1,   "rgba(255, 200, 120, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  destroy() {
    if (this._raf != null) cancelAnimationFrame(this._raf);
    this._raf = null;
    window.removeEventListener("resize", this._resize);
    this.canvas.remove();
  }
}
