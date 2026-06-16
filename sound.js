// sound.js — tiny WebAudio sound effects, no asset files, no network.
// Synthesized blips so the whole game stays self-contained and offline-friendly.

class Sfx {
  constructor() {
    this.enabled = true;
    this.ctx = null;
  }

  _ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    return this.ctx;
  }

  // call from a user gesture to satisfy autoplay policies
  resume() {
    const ctx = this._ensure();
    if (ctx && ctx.state === "suspended") ctx.resume();
  }

  _beep(freq, dur = 0.08, type = "sine", gain = 0.06, when = 0) {
    if (!this.enabled) return;
    const ctx = this._ensure();
    if (!ctx) return;
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  reveal() { this._beep(420, 0.05, "triangle", 0.04); }
  tick() { this._beep(660, 0.04, "square", 0.03); }
  flag(on = true) { this._beep(on ? 720 : 360, 0.07, "square", 0.05); }
  win() {
    [523, 659, 784, 1047].forEach((f, i) => this._beep(f, 0.16, "triangle", 0.06, i * 0.12));
  }
  lose() {
    this._beep(220, 0.25, "sawtooth", 0.06);
    this._beep(140, 0.4, "sawtooth", 0.06, 0.12);
  }
}

export const sfx = new Sfx();
