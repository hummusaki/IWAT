# Interactive Web Accessibility Test (IWAT)

IWAT is an experimental research environment designed to explore adaptive user interfaces that respond to validated indications of interaction difficulty.

## Quick Start & Localhost/HTTPS Requirements

Webcam access via `navigator.mediaDevices.getUserMedia` requires a **Secure Context**. Browsers restrict camera permissions to:
- `http://localhost:<port>` or `http://127.0.0.1:<port>`
- `https://<domain>`

Opening `index.html` via `file:///` directly in the browser will cause camera permission failures in modern browsers.

### Running Locally

Run a local HTTP server from the repository root:

```bash
# Option 1: Python 3 built-in server (recommended, no install needed)
python3 -m http.server 8080

# Option 2: Node npx serve
npx serve . -p 8080

# Option 3: Node http-server
npx http-server . -p 8080
```

Then open your browser to:
`http://localhost:8080`

### HTTPS (Optional / Remote Testing)

If serving across a local area network or remote machine, run behind an HTTPS reverse proxy (e.g. Caddy, mkcert, or ngrok) or generate a self-signed certificate:

```bash
npx local-ssl-proxy --source 8443 --target 8080
```

---

## Phase 1 Architecture: Stabilization & Benchmarking

Phase 1 establishes a robust, leak-free, measurable foundation with predictable failure recovery:

1. **Camera Lifecycle & Cancellation Tokens (`js/camera.js`)**:
   - Safe start, stop, retry, and camera denial recovery with session generation tokens (`currentCameraSessionId`).
   - Late-acquired tracks from pending `getUserMedia` calls are canceled and stopped immediately.
   - Unified settlement path for metadata resolution and timeout branches; handles hardware disconnect cleanly via track `onended`.
   - Dedicated "No-Camera Mode" enabling the application and testing without camera hardware.
   - Aspect-ratio preservation: dynamically preserves native webcam aspect ratio (16:9, 4:3, etc.) without vertical or horizontal stretching.

2. **Decoupled Logging (`js/logger.js`)**:
   - Eliminates circular dependencies between modules.
   - Throttled logging to prevent DOM bloat and UI stalls during extended runs.

3. **Measurable Blink & Eyelid Openness (`js/features/blink.js`)**:
   - Normalized bilateral Eye Aspect Ratio (EAR) invariant to distance from camera.
   - Temporal blink state machine (`OPEN`, `CLOSING`, `CLOSED`, `RECOVERING`).
   - Counts single-observation closures (at 10–15 Hz) exceeding `minDurationMs` (50ms).
   - Aborts noise dips and resets in-flight blink episodes on excessive time gaps (>1000ms) or face loss.
   - Exposes measurable metrics: blink count, blink duration (ms), and instantaneous EAR.

4. **Fresh Frame Scheduling & Immutable Sample Contract (`js/gaze-tracker.js`, `js/features/quality.js`)**:
   - Publishes immutable `GazeSample` records with monotonic timestamps, frame IDs, latency, and freshness checks.
   - Single inference in flight with duplicate callback frame rejection in both `requestVideoFrameCallback` and `requestAnimationFrame`.
   - Landmark integrity check requiring `>= 474` keypoints (including iris indices 468 and 473) with finite coordinates.
   - Rolling coverage pruning at read time, separate error accounting for detector errors and insufficient landmarks, and stall watchdog expiring gaze if callbacks freeze.

5. **Sequential Fixation Calibration & v5 Storage (`js/calibration.js`)**:
   - Sequential fixation targets with 400ms settling phase, 15 unique sample minimum per target, and frame deduplication.
   - Two-axis feature spread check (`computeFeatureSpread`) to detect and warn/reject if vertical or horizontal eye motion is below variance floor (`1e-4`).
   - Normalizes target centers in CSS pixels directly from `getBoundingClientRect()`.
   - Coherent v5 storage schema with atomic `committed: true` marker; rejects partial or uncommitted writes.

6. **Regression Model & Coarse-Gaze Gating (`js/regression_model.js`)**:
   - Standardizes input features (`(x - mean) / std`) with variance floors to prevent vertical weight collapse.
   - Grouped validation partition keeping fixation bursts intact.
   - Provisional coarse-gaze validation gate (median error <= 10% diagonal, p95 <= 20% diagonal, outperforms center baseline on both axes).
   - Decoupled training execution (tracking loop drained during training) to eliminate WebGL GPU contention stalls.

7. **Face Adapter Benchmark (`js/tracking/face-adapter.js`, `js/tracking/adapter-benchmark.js`)**:
   - Safe lifecycle execution: production tracking is paused/drained during benchmarks and restored in `finally`.
   - Accurate residual tensor accounting (`postDisposal - preInit`) instead of pre-disposal math.
   - Honest status reporting (`Passed`, `Failed (Init)`, `Failed (Execution)`).

---

## Pinned Dependencies

All external CDN assets are pinned to exact immutable versions to prevent breaking changes:

| Package | Version | Purpose |
|---|---|---|
| `@tensorflow/tfjs` | `4.22.0` | Core ML execution and tensor backend |
| `@tensorflow-models/face-landmarks-detection` | `1.0.6` | TFJS FaceMesh pipeline (Current adapter) |
| `@mediapipe/tasks-vision` | `0.10.14` | MediaPipe Tasks Vision (Candidate adapter) |

---

## Verification & Validation Status

### Automated Test Suite (Verified)
Run the 43 automated Node.js unit and integration tests:

```bash
npm test
# or: node --test test/*.test.js
```
The automated suite verifies:
- Camera recovery, metadata timeout settlement, late track cancellation, and track disconnect.
- Blink detector state transitions, noise dip filtering, single-frame closure, and face-loss reset.
- Quality gate fresh/stale validation, rolling coverage window expiration, and error accounting.
- Calibration v4/v5 schema validation, uncommitted data rejection, and two-axis variance detection.
- Immutable GazeSample records and session resource disposal.
- Aspect ratio preservation across 16:9, 4:3, and vertical 9:16.

### In-Browser Verification (`test/runner.html`)
To run the browser test suite (with live WebGL tensor allocation, storage isolation, and benchmark execution):
1. Start a local server: `python3 -m http.server 8080`
2. Open in browser: `http://localhost:8080/test/runner.html`

### Manual Validation Required
The following criteria require live browser/hardware testing and cannot be verified solely via automated headless tests:
1. **Live Camera Startup Responsiveness on macOS/Safari**: Confirm cold vs. warm inference timing and verify no UI freezing when camera starts.
2. **15-Minute Steady-State Soak Test**: Verify Safari memory stability and frame rate consistency over 15 minutes of live camera feed.
3. **Physical Gaze Tracking & Vertical Eye Range**: Complete sequential 9-target calibration and verify that pupil motion maps smoothly to both horizontal and vertical axes across the viewport.
4. **Adapter Benchmark on Live Feed**: Run the benchmark suite (`Face Benchmark` button) to compare TFJS and MediaPipe Tasks Vision on real camera input.