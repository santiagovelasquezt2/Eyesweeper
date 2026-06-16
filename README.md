# 👁️ EyeSweeper

**Minesweeper you play with your eyes.** Look at a cell to aim, *dwell* (hold your
gaze) to reveal it, and *blink* to flag it. No mouse required.

It's a single-page web app — no build step, no install. The board is a complete,
classic Minesweeper; the eye control is a layer on top using your webcam.

## Quick start

Because it uses the webcam and ES modules, serve it over `localhost` (or https) —
opening `index.html` from `file://` won't get camera access.

```bash
# from the repo root, any static server works:
python3 -m http.server 8000
# then open http://localhost:8000
```

1. Pick a difficulty and start sweeping (mouse/keyboard work immediately).
2. Click **Enable eye tracking** and allow the camera.
3. Click **Calibrate gaze** and look at each dot until it fills (9 dots, ~10s).
4. Now play with your eyes.

## Controls

| Action | Eyes | Mouse | Keyboard |
|--------|------|-------|----------|
| Aim | look at a cell | hover | arrow keys |
| Reveal | **dwell** until the ring fills | left click | Enter / Space |
| Flag | **deliberate blink** (slightly long, both eyes) | right click | F |
| New game | click the face 🙂 | click the face | — |

Natural quick blinks are ignored, so you won't flag by accident. A revealed
number can be **chorded** (click/dwell it again when its flags are satisfied) to
open its neighbors.

## How the eye control works

- **Gaze:** [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
  gives iris + eye landmarks each frame. A quick 9-point calibration fits a
  least-squares affine map from iris-in-eye position to screen pixels. Output is
  smoothed and drives a gaze cursor.
- **Blink:** the model's `eyeBlinkLeft`/`eyeBlinkRight` blendshapes feed a small
  state machine that fires only on a *held* blink (≈180–900 ms), not natural
  flickers.
- Everything runs **on-device** — no video leaves your machine.

Tunables in the side panel: **dwell time**, **blink sensitivity**, and **gaze
smoothing**.

## Files

| File | What it does |
|------|--------------|
| `index.html` | Layout + UI |
| `styles.css` | Styling |
| `minesweeper.js` | Pure game logic + board rendering (no eye code) |
| `eyetracking.js` | Webcam → gaze estimation + blink detection (MediaPipe) |
| `app.js` | Glue: calibration, dwell-to-reveal, blink-to-flag, fallbacks |
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
