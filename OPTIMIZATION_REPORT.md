# EyeSweeper Performance and UX Optimization Report

Date: 2026-06-18

## Executive Summary

EyeSweeper is not laggy because it uses a heavy app framework. The current stack is a plain static ES-module app served by `python3 -m http.server`, with no React, Vite, bundler, or runtime dependency tree in `package.json`.

The lag is coming from the combination of:

- Real-time MediaPipe face/iris inference on the browser main thread.
- Hundreds of expensive CSS `backdrop-filter` surfaces, especially in expert mode.
- Per-frame DOM reads/writes in the gaze loop.
- A fixed-size expert board that physically overflows and overlaps the control panel.
- Camera/model lifecycle work that is not throttled, cached, or truly paused.

This stack can be made fast enough for the game, but the app needs a performance pass before feature work continues.

## Verification Performed

- Inspected the current source files in `src/`, `index.html`, `package.json`, `README.md`, and `RESEARCH.md`.
- Started the app locally on `http://localhost:8001` because port `8000` was already occupied.
- Loaded the page in a browser and checked console health: no page-load errors or warnings were observed.
- Measured DOM/layout facts in beginner, expert, desktop, and mobile-sized layouts.
- Did not accept camera permission or run a real webcam session in the browser. The eye-tracking path below is based on source inspection of the active MediaPipe loop.

## Applied Pass: 2026-06-18

Implemented a focused performance pass across the current static app:

- Bounded tracker perf arrays to one-second windows so long sessions no longer grow `_detectsLastSec` / `_rendersLastSec` indefinitely.
- Added tracker-side status dedupe/throttling and lower-allocation blendshape reads.
- Made pause use a low-frequency timer instead of waking on every decoded video frame.
- Cached MediaPipe resolver setup across starts.
- Removed computed-style reads and hot `getBoundingClientRect()` calls from normal gaze cell resolution.
- Skipped sub-pixel cursor writes and tiny dwell-ring progress writes.
- Batched board cell creation through a `DocumentFragment`.
- Added `body.eye-active` performance mode and disabled repeated backdrop filters/transitions on hot UI surfaces.
- Lowered the global glass blur intensity while preserving the app's visual language.

Current browser measurements after this pass:

- Desktop expert mode (`1280 x 720`): `480` cells, `0` cells with `backdrop-filter`, `5` live backdrop surfaces total, no board/control-panel overlap, page scroll width remains `1280px`.
- Mobile expert mode (`390 x 844`): `480` cells, `0` cells with `backdrop-filter`, board scrolls inside `.board-scroll`, page scroll width remains `390px`.
- Console check: no warnings or errors observed on load or expert-mode switch.
- Automated tests: `npm test` passes `7/7`.

## Stack Assessment

Current runtime:

- `index.html` loads `src/app.js` as a browser ES module.
- `package.json` has only static-server scripts.
- `src/eye/eyetracking.js` imports MediaPipe Tasks Vision from CDN.
- Game rendering is direct DOM manipulation, not canvas.
- Board styling relies heavily on CSS blur, shadows, and glass effects.

Verdict: keep the static stack for now. Do not move to React just to fix lag. If the project grows, Vite would help with local vendoring, cache control, and tooling, but it is not required for runtime speed.

## Baseline Findings Before This Pass

The following measurements are the baseline that motivated the applied pass above.

### Beginner Mode

- Board cells: `81`
- Total DOM nodes: `183`
- Elements with live `backdrop-filter`: `102`
- Cell elements with live `backdrop-filter`: `81`

Even beginner mode gives every cell its own blur surface.

### Expert Mode

- Board cells: `480`
- Total DOM nodes: `582`
- Elements with live `backdrop-filter`: `501`
- Cell elements with live `backdrop-filter`: `480`
- Board size at default desktop viewport: `978px x 530px`

This is the largest confirmed visual-performance problem. A 480-cell Minesweeper board is fine; 480 blurred glass surfaces are not.

### Desktop Layout Bug

At a `1280 x 720` viewport in expert mode:

- Game panel width: `722px`
- Expert board width: `978px`
- Board overflows the game panel.
- Board overlaps the control panel horizontally.

This can make the app feel broken, not just slow. Depending on paint order, part of the board can sit underneath the side panel, and pointer/gaze hit testing can become unreliable.

### Mobile Layout Bug

At a `390 x 844` viewport in expert mode:

- Game panel width: `350px`
- Expert board width: `978px`
- Board extends far beyond the viewport.
- `overflow-x: hidden` on `body` hides/clips the board instead of making it usable.

Expert mode is not currently mobile-safe.

### Dev-Server Reliability

`npm start` hardcodes port `8000`, but that port was already occupied by a Python server during verification. The app could not start on its documented default port without manually choosing another port.

## Required Changes

### 1. Fix Board Sizing and Layout First

Affected files:

- `src/styles/styles.css`
- `src/game/minesweeper.js`
- `src/app.js`

Current issues:

- `--cell-size` is fixed at `32px`.
- Expert mode always renders 30 columns at 32px plus board padding, producing a `978px` board.
- The app uses `overflow-x: hidden`, so overflow becomes clipping instead of a usable layout.

Required changes:

- Add a CSS variable for current column count, for example `--cols`.
- Set `--cols` from `Minesweeper._render()` when difficulty changes.
- Make `--cell-size` responsive to available board width.
- Ensure the expert board fits inside the game panel and viewport.
- Add a minimum usable cell size for gaze interaction, likely around `20px`.
- If the board cannot fit comfortably, prefer a dedicated board viewport with deliberate scaling over accidental clipping.
- Test beginner, intermediate, and expert at `390px`, `768px`, `1280px`, and wide desktop.

Suggested target:

- No board/control-panel overlap.
- No hidden horizontal clipping.
- Expert mode remains fully playable without page-level horizontal scroll.

### 2. Remove Per-Cell `backdrop-filter`

Affected file:

- `src/styles/styles.css`

Current issue:

- `.cell` applies `backdrop-filter: saturate(190%) contrast(108%) blur(10px)`.
- Expert mode creates 480 cell-level blur surfaces.
- The board and surrounding panels also use blur, so the compositor is doing repeated expensive backdrop sampling.

Required changes:

- Remove `backdrop-filter` from `.cell`.
- Keep glass effects only on a small number of large containers, if any.
- Replace cell glass with flat fills, borders, inset shadows, or precomputed gradients.
- Remove `will-change: backdrop-filter` from `.game-panel` and `.board`.
- Reduce or remove fixed full-screen decorative overlays that use noise, blend, blur, or large inset shadows.

Suggested target:

- Expert mode should have fewer than 25 live `backdrop-filter` elements, ideally fewer than 10.

### 3. Throttle the MediaPipe Inference Loop

Affected file:

- `src/eye/eyetracking.js`

Current issue:

- `_loop()` runs on every `requestAnimationFrame`.
- When video time changes, it calls synchronous `landmarker.detectForVideo(...)`.
- This competes with rendering, CSS effects, cursor movement, and DOM updates on the main thread.

Required changes:

- Cap inference to a fixed target, likely `15-24 FPS`.
- Use `requestVideoFrameCallback` where available, with a fallback timer/RAF loop.
- Skip inference entirely when paused.
- Consider adaptive throttling when frame processing exceeds budget.
- Track and expose inference FPS and average inference time for debugging.

Suggested target:

- Eye tracking remains stable without trying to process every display frame.
- Rendering remains responsive while inference is active.

### 4. Make Pause Actually Reduce Work

Affected file:

- `src/eye/eyetracking.js`

Current issue:

- `setPaused(true)` stops gaze callbacks, but the MediaPipe loop still keeps detecting faces.
- `_handle()` still computes EAR, baselines, status, and blink state before returning from paused mode.

Required changes:

- When paused, do not run `detectForVideo`.
- Keep the video stream alive only if fast resume is important.
- Update the UI to show paused state without continuing full inference.

Suggested target:

- Pausing should drop eye-tracking CPU/GPU work near zero.

### 5. Reduce Camera and Model Work

Affected file:

- `src/eye/eyetracking.js`

Current issues:

- Camera requests `640 x 480`.
- `outputFaceBlendshapes: true` is enabled, but the current blink code uses EAR landmarks and does not read blendshape output.
- GPU delegate is forced without a fallback path.

Required changes:

- Test lower camera sizes such as `320 x 240` or `426 x 320`.
- Disable `outputFaceBlendshapes` unless it is actually used.
- Add GPU-to-CPU fallback if FaceLandmarker creation fails or performs poorly.
- Consider a quality setting: battery saver, balanced, high accuracy.

Suggested target:

- Default mode should prioritize stable interaction over maximum landmark fidelity.

### 6. Lazy-Load and Cache MediaPipe

Affected file:

- `src/eye/eyetracking.js`

Current issue:

- MediaPipe is imported from CDN at module load time.
- The app pays the cost of resolving the remote module before eye tracking is even enabled.
- `start()` creates the resolver and landmarker each time instead of using a cached initialization path.

Required changes:

- Move the MediaPipe import behind the "Enable eye tracking" action.
- Cache the resolver/model initialization promise.
- Show a clear loading state while the model loads.
- Consider vendoring MediaPipe assets locally or introducing Vite so assets are pinned and cacheable.
- Add `preconnect` or controlled preloading only after the main game is interactive.

Suggested target:

- Mouse/keyboard Minesweeper should become interactive immediately even if MediaPipe is slow to download.

### 7. Stop Per-Frame Status DOM Writes

Affected files:

- `src/app.js`
- `src/eye/eyetracking.js`

Current issues:

- `onStatus` can fire from `_handle()` every processed frame.
- `setPill()` writes `textContent` and `className` even if nothing changed.
- `onOpenness` writes width/threshold styles every processed frame.

Required changes:

- Deduplicate status updates before touching DOM.
- Throttle status pill updates to around `4 Hz`.
- Update the openness meter only when the value changes meaningfully, for example by at least `1-2%`.
- Batch DOM writes inside a single animation frame.

Suggested target:

- The tracker can process face data without forcing unnecessary style recalculation every frame.

### 8. Replace Per-Frame DOM Hit Testing With Board Geometry Math

Affected files:

- `src/app.js`
- `src/game/minesweeper.js`

Current issues:

- Gaze handling calls `document.elementFromPoint(...)`.
- `resolveActive()` and `cursorTo()` call `getBoundingClientRect()` during gaze updates.
- These reads happen in the same loop as DOM writes to cursor transform, classes, and dwell progress.

Required changes:

- Cache board geometry: board rect, cell size, rows, cols.
- Recompute geometry on reset, difficulty change, resize, and scroll.
- Convert gaze `x/y` to row/col with math instead of DOM hit testing.
- Use one active-cell state object instead of reading dataset values from DOM every frame.

Suggested target:

- No layout reads in the hot gaze frame unless geometry is dirty.

### 9. Simplify Cursor and Dwell Rendering

Affected files:

- `src/app.js`
- `src/styles/styles.css`

Current issues:

- The gaze cursor animates `transform` with transitions, adding visible latency.
- Snapped and unsnapped cursor states change size and margins.
- Dwell rings are created and removed as DOM children when focus changes.

Required changes:

- Remove transform transitions from the live cursor movement path.
- Use one stable cursor size and animate with `scale()` if needed.
- Coalesce cursor updates into one `requestAnimationFrame`.
- Replace per-cell dwell-ring DOM creation with either one reusable overlay element or a class/CSS variable on the active cell.

Suggested target:

- Cursor motion feels immediate, and dwell feedback does not churn DOM nodes.

### 10. Use Event Delegation for Board Interactions

Affected file:

- `src/game/minesweeper.js`

Current issue:

- `_render()` attaches two event listeners per cell.
- Expert mode creates 960 cell listeners on every reset.

Required changes:

- Attach one `click` listener and one `contextmenu` listener to `boardEl`.
- Use `event.target.closest(".cell")` to find the cell.
- Keep row/col in dataset or map DOM elements to cell state.

Suggested target:

- Board reset creates cells, not hundreds of new listeners.

### 11. Batch Large Reveal Paints

Affected file:

- `src/game/minesweeper.js`

Current issue:

- Flood reveal calls `_paint()` cell-by-cell synchronously.
- Large empty reveals can cause a burst of DOM writes in one input frame.

Required changes:

- Collect changed cells during `_floodReveal()` and `_chord()`.
- Paint them in a batch.
- For very large batches, consider yielding to the next frame after state updates.

Suggested target:

- Large openings do not freeze the UI.

### 12. Clean Up Eye-Tracking Lifecycle

Affected file:

- `src/eye/eyetracking.js`

Current issues:

- `stop()` cancels RAF and stops tracks, but does not visibly dispose the landmarker.
- Re-enabling eye tracking recreates resolver/model work.
- Start/stop/restart paths should guard against duplicate starts and stale callbacks.

Required changes:

- Add an initialization state machine: idle, loading, running, paused, stopping, error.
- Reuse one model instance when appropriate.
- Dispose the model when fully disabling eye tracking if the API supports it.
- Reset `video.srcObject` on stop.
- Guard against repeated clicks while startup is in flight.

Suggested target:

- Repeated enable/disable cycles do not leak GPU/WASM resources or stack loops.

### 13. Clear Stale Gaze State on Game Reset

Affected file:

- `src/app.js`

Current issue:

- `newGame()` resets the game but does not clear dwell/focus state.
- `activeEl` and `focusedEl` can temporarily point at detached cell elements after a reset or difficulty change.

Required changes:

- Call `clearDwell()` and `highlightCell(null)` during `newGame()`.
- Recompute cached board geometry after reset.
- Reset cursor snapped state if the old active cell disappears.

Suggested target:

- Reset/difficulty changes never leave ghost focus or stale dwell progress.

### 14. Add Performance Instrumentation

Affected files:

- `src/eye/eyetracking.js`
- `src/app.js`
- New optional dev-only file

Required changes:

- Track inference FPS, average detection time, dropped/skipped frames, and render update rate.
- Add a dev-only overlay or console table behind a query flag like `?debugPerf=1`.
- Add a browser smoke script that checks layout geometry for all difficulties.

Suggested target:

- Future lag can be measured in the app instead of guessed from feel.

### 15. Improve Dev Server Robustness

Affected file:

- `package.json`

Current issue:

- `npm start` always tries port `8000`.

Required changes:

- Allow a configurable port.
- Either document `python3 -m http.server 8001` fallback or switch to a dev server that auto-selects the next free port.
- If Vite is introduced, keep the production app static and small.

Suggested target:

- A developer can run the app without manually diagnosing port conflicts.

## Suggested Implementation Order

1. Fix board sizing/overflow and remove per-cell blur. This should immediately improve perceived speed and eliminate obvious layout bugs.
2. Throttle/pause the MediaPipe loop and reduce camera/model workload.
3. Deduplicate per-frame DOM writes and replace gaze hit testing with cached board geometry.
4. Clean up tracker lifecycle and stale reset state.
5. Add instrumentation and automated layout smoke checks.
6. Consider Vite/local asset vendoring only after the runtime hot paths are fixed.

## Acceptance Criteria

- Beginner, intermediate, and expert boards fit without overlap at `390px`, `768px`, `1280px`, and wide desktop.
- Expert mode has no per-cell `backdrop-filter`.
- Eye tracking pause stops inference work, not only callbacks.
- The tracker runs at a controlled FPS and exposes basic performance counters in debug mode.
- Cursor movement does not use transition-based lag during live gaze tracking.
- Reset/difficulty changes clear stale gaze and dwell state.
- Page load remains console-clean.
- `npm start` or documented dev startup works when port `8000` is occupied.

## Bottom Line

The app is fixable without changing the whole stack. The biggest wins are not a framework migration; they are removing the hundreds of glass blur layers, making the board responsive, throttling MediaPipe, and taking DOM layout reads/writes out of the gaze hot path.
