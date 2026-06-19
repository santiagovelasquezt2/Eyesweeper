# Eye-tracking libraries for the web — research notes

EyeSweeper needs two signals from a plain laptop webcam, in the browser, with no
special hardware:

1. **Gaze point** — where on screen is the user looking (to pick a cell).
2. **Blink** — a deliberate eye-close event (to flag a cell).

This doc surveys the realistic options, ranks them, and explains the pick.

## TL;DR ranking (webcam-only, browser, free)

| Rank | Library | Gaze | Blink | Maintenance | Why |
|------|---------|------|-------|-------------|-----|
| 🥇 1 | **MediaPipe Face Landmarker (Tasks Vision)** | iris landmarks → custom map | blendshapes (`eyeBlinkLeft/Right`) | Actively maintained by Google | Best blink signal, dense iris landmarks, fast WASM/GPU, on-device. **What EyeSweeper uses.** |
| 🥈 2 | **WebGazer.js** | built-in, calibrates from clicks | none built-in | Functional but "updates no longer guaranteed" (Brown HCI, Feb 2026) | Easiest turnkey *gaze*, but you'd bolt on blink yourself. |
| 🥉 3 | **TensorFlow.js + FaceMesh/`face-landmarks-detection`** | iris landmarks → custom map | derive from eyelid landmarks | Maintained, but Tasks Vision is the newer path | Same idea as #1 with more wiring; superseded by MediaPipe Tasks. |
| 4 | **Commercial cloud/SDK (GazeCloudAPI, Tobii, EyeWare/Beam)** | high accuracy | yes | Vendor-maintained | Accurate but paid, and cloud variants send video off-device — wrong trade-off for a toy game. |

## The options in detail

### 1. MediaPipe Face Landmarker — the pick ✅
Google's on-device face model (the successor to the standalone FaceMesh/Iris
solutions, now shipped as **Tasks Vision**). For each frame it returns:

- **478 3D landmarks**, including **10 iris points** (5 per eye) — enough to
  estimate gaze direction from where the iris sits inside the eye opening.
- **52 blendshape coefficients**, including `eyeBlinkLeft` and `eyeBlinkRight`
  in the 0–1 range — a clean, calibration-free blink signal.

**Why it wins for this app:**
- **Blink is first-class.** The blendshape scores give a robust, per-eye
  closure value. EyeSweeper turns this into a *deliberate-blink* state machine
  (close → hold 180–900 ms → open) so natural blinks don't accidentally flag.
- **Runs fully on-device** (WASM + optional GPU/WebGL delegate). No video leaves
  the machine — important for a webcam app.
- **Fast** enough for real-time on a laptop, loadable straight from a CDN as an
  ES module — no build step.
- **Actively maintained** by Google, unlike WebGazer.

**Cost:** it doesn't *give* you a screen-space gaze point — it gives landmarks.
You build the gaze map yourself. EyeSweeper does this with a quick 9-point
calibration that fits a least-squares affine map from the normalized iris
position (iris offset within the eye box) to screen pixels. That's exactly what
`src/eye/eyetracking.js` implements.

### 2. WebGazer.js — easiest turnkey gaze
Brown University's classic webcam eye-tracker. It self-calibrates from natural
mouse clicks/moves and outputs a screen gaze prediction with a couple lines of
code. It even uses MediaPipe FaceMesh internally for face detection.

- ➕ Truly plug-and-play *gaze*; great for heatmaps/research.
- ➖ **No blink detection** — you'd add it on top anyway (likely via MediaPipe),
  at which point you might as well own the whole pipeline.
- ➖ Accuracy drifts with head movement and lighting; click-calibration assumes
  a pointer, which a hands-free game doesn't have.
- ➖ Per the Brown HCI repo (Feb 2026) it's *functional but no longer guaranteed
  to receive updates*.

Good fit if you only need gaze and want zero math. Not ideal when blink is half
the interaction.

### 3. TensorFlow.js + FaceMesh / `face-landmarks-detection`
Essentially the DIY version of #1: iris landmarks via TF.js, and you derive both
gaze (iris-in-eye) and blink (eyelid-distance / eye-aspect-ratio) yourself.
Perfectly viable and well-documented, but MediaPipe Tasks Vision is the newer,
better-packaged route to the same landmarks, with blendshapes handed to you for
free. Choose this only if you're already invested in the TF.js ecosystem.

### 4. Commercial / hardware (Tobii, EyeWare Beam, GazeCloudAPI)
- **Tobii / dedicated IR eye trackers:** best-in-class accuracy and the gold
  standard for accessibility, but require a hardware device.
- **EyeWare Beam:** webcam-based, good accuracy, but a paid desktop app/SDK, not
  a drop-in browser lib.
- **GazeCloudAPI:** webcam gaze as a service — but cloud processing means frames
  leave the device, and it's a paid/limited API.

All overkill (and wrong on privacy/cost) for a browser game, but the right call
if you were shipping a real accessibility product where accuracy is safety-
critical.

## Why MediaPipe for EyeSweeper, concretely
1. **One library covers both signals** (iris gaze + blink blendshapes).
2. **Privacy:** 100% on-device.
3. **No build step / no key:** loads from CDN, runs anywhere with a webcam over
   https or localhost.
4. **Tunable:** EyeSweeper exposes dwell time, blink sensitivity, and gaze
   smoothing so the rough edges of webcam gaze are adjustable per user.

## Honest limitations of webcam gaze (any library)
- Accuracy is ~cell-cluster, not pixel-perfect; lighting, glasses, and head
  movement all degrade it. That's why EyeSweeper uses **dwell + a large gaze
  cursor + smoothing**, and keeps **mouse/keyboard fallbacks**.
- Calibration drifts; re-running it after moving helps.
- For real assistive-tech use, dedicated IR hardware (Tobii) remains the
  accuracy/reliability benchmark.

## Sources
- [WebGazer.js — Brown HCI](https://webgazer.cs.brown.edu/)
- [WebGazer GitHub (Brown HCI)](https://github.com/brownhci/WebGazer)
- [MediaPipe Face Landmarker — Web guide (Google AI Edge)](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js)
- [MediaPipe Face Landmarker overview](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
- [Iris landmark tracking in the browser with MediaPipe + TensorFlow.js](https://blog.tensorflow.org/2020/11/iris-landmark-tracking-in-browser-with-MediaPipe-and-TensorFlowJS.html)
- [MediaPipe Face Mesh — all 478 landmark points](https://www.sanderdesnaijer.com/blog/mediapipe-face-mesh-landmarks)
- [Build real-time eye tracking in the browser (Roboflow)](https://blog.roboflow.com/build-eye-tracking-in-browser/)
