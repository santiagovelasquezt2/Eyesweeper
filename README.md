# 👁️ EyeSweeper

**Minesweeper you play with your eyes.** Look at a cell to aim, *dwell* (hold your
gaze) to reveal it, and *blink* to flag it. No mouse required.

It's a single-page web app — no build step, no install. The board is a complete,
classic Minesweeper; the eye control is a layer on top using your webcam.

## Quick start

Because it uses the webcam and ES modules, serve it over `localhost` (or https) —
opening `index.html` from `file://` won't get camera access.

```bash
git clone https://github.com/santiagovelasquezt2/Eyesweeper.git
cd Eyesweeper
npm start        # one command — runs `python3 -m http.server 8000` (no install needed)
# then open http://localhost:8000
```

`npm run qa` does the same thing — both just spin up python3's built-in static
server (no dependencies, no `npm install`).

1. Pick a difficulty and start sweeping (mouse/keyboard work immediately).
2. Click **Enable eye tracking** and allow the camera.
3. Click **Calibrate gaze** and look at each dot until it fills (13 dots, ~15s).
4. Now play with your eyes.

First time? Hit **Setup wizard** — it walks you through glasses mode, camera,
calibration, and a quick gesture test in about a minute.

## Controls

| Action | Eyes | Mouse | Keyboard |
|--------|------|-------|----------|
| Aim | look at a cell (cursor snaps to it) | hover | arrow keys |
| Reveal | **dwell** until the ring fills | left click | Enter / Space |
| Flag | **blink** (both eyes) or **wink** (one eye) | right click | F |
| Pause/resume | ⏸ button | — | — |
| New game | click the face 🙂 | click the face | — |

Natural quick blinks are ignored, so you won't flag by accident. A revealed
number can be **chorded** (click/dwell it again when its flags are satisfied) to
open its neighbors.

## Built for glasses + good UX

- **Glasses mode** — instead of a fixed eye-closed threshold (which glare and
  lens reflections break), blink/wink detection tracks each eye's *own* open
  baseline and fires on a **relative drop**. Toggle it on for glasses or harsh
  lighting; it also smooths gaze a bit more.
- **Wink-to-flag** — an alternative to blinking for anyone who finds deliberate
  blinks awkward or unreliable.
- **Setup wizard** — guided first-run onboarding.
- **Snap-to-cell cursor** — the gaze dot snaps to the cell you're near, so
  imprecise webcam gaze still lands cleanly.
- **Live feedback** — an "eye openness" bar shows your blink registering, plus
  camera/signal/gaze status pills.
- **Sound + visual cues** for reveal, flag, win, and lose (toggleable).
- **Persisted settings** and **best times per difficulty** (localStorage).
- **Pause/resume**, and `prefers-reduced-motion` support.

## How the eye control works

- **Gaze:** [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
  gives iris + eye landmarks each frame. A quick 13-point calibration fits a
  least-squares affine map from iris-in-eye position to screen pixels. Output is
  smoothed and drives a gaze cursor.
- **Blink/Wink:** an **adaptive eye-aspect-ratio** signal — per-eye eyelid
  openness measured against each eye's own rolling "open" baseline — feeds a state
  machine that fires only on a *held* gesture (≈160–1100 ms), not natural
  flickers. This relative approach is what makes it robust for glasses/glare.
  Blendshapes are used only as a soft confirmation when glasses mode is off.
- Everything runs **on-device** — no video leaves your machine.

Tunables in the side panel: **dwell time**, **blink sensitivity**, and **gaze
smoothing**.

## Files

| File | What it does |
|------|--------------|
| `index.html` | Layout + UI (entry point) |
| `src/app.js` | Glue: calibration, dwell-to-reveal, blink/wink-to-flag, settings, fallbacks |
| `src/game/minesweeper.js` | Pure game logic + board rendering (no eye code) |
| `src/eye/eyetracking.js` | Webcam → gaze estimation + adaptive blink/wink detection (MediaPipe) |
| `src/ui/wizard.js` | Guided onboarding wizard |
| `src/ui/sound.js` | Synthesized WebAudio sound effects (no asset files) |
| `src/styles/styles.css` | Styling |
| `package.json` | `npm start` — serves the app on http://localhost:8000 (no install needed) |
| `RESEARCH.md` | Survey of eye-tracking libraries and why MediaPipe was chosen |

## Eye-tracking library choice

Short version: **MediaPipe Face Landmarker** — it's the only free, on-device,
actively-maintained option that gives *both* iris-gaze landmarks and a clean
blink signal in one library. Full comparison (WebGazer, TensorFlow.js,
commercial/Tobii, etc.) in **[RESEARCH.md](RESEARCH.md)**.

## Limitations

Webcam gaze is approximate (lighting, glasses, and head movement affect it) — so
EyeSweeper leans on dwell, a generous gaze cursor, smoothing, and re-calibration,
and keeps mouse/keyboard fallbacks. For accuracy-critical accessibility use,
dedicated IR hardware (e.g. Tobii) is still the benchmark.
