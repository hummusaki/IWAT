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

1. **Camera Lifecycle (`js/camera.js`)**:
   - Safe start, stop, retry, and camera denial recovery.
   - Zero-hang promises: camera denial or missing hardware rejects cleanly.
   - Dedicated "No-Camera Mode" enabling the application and testing without camera hardware.
   - Aspect-ratio preservation: dynamically preserves native webcam aspect ratio (16:9, 4:3, etc.) without vertical or horizontal stretching.

2. **Decoupled Logging (`js/logger.js`)**:
   - Eliminates circular dependencies between modules.
   - Throttled logging to prevent DOM bloat and UI stalls during extended runs.

3. **Measurable Blink & Eyelid Openness (`js/features/blink.js`)**:
   - Normalized bilateral Eye Aspect Ratio (EAR) invariant to distance from camera.
   - Temporal blink state machine (`OPEN`, `CLOSING`, `CLOSED`, `RECOVERING`).
   - Rejects blink samples prior to calibration/inference.
   - Exposes measurable metrics: blink count, blink duration (ms), and instantaneous EAR.

4. **Robust Quality Gate & Fresh Frames (`js/features/quality.js`)**:
   - Single inference in flight: drops stale queued frames when inference is active.
   - Fresh frame timing via `requestVideoFrameCallback` (with `requestAnimationFrame` fallback).
   - Frame age tracking (capture timestamp vs processing timestamp).
   - Non-finite coordinate rejection (`NaN`, `Infinity` guards).
   - Immediate face-loss invalidation: `currentGaze` is set to `null` immediately when face is lost.

5. **Calibration & Storage Self-Healing (`js/calibration.js`)**:
   - Schema validation and versioning (`v4`).
   - Guards against corrupted JSON, non-finite values, and mismatched sample lengths.
   - Self-healing recovery: clears corrupt local storage entries and prompts recalibration cleanly.

6. **Tensor Memory Management (`js/regression_model.js`, `js/gaze-tracker.js`)**:
   - Strict `tf.tidy()` and `try / finally` disposal of all input, target, and intermediate tensors.
   - Replaced models and training tensors are cleanly disposed.
   - Monitored via real-time active tensor telemetry (`tf.memory().numTensors`).

7. **Face Adapter Benchmark (`js/tracking/face-adapter.js`, `js/tracking/adapter-benchmark.js`)**:
   - Pluggable interface comparing:
     - `TfjsFaceMeshAdapter` (repaired current MediaPipe FaceMesh runtime `tfjs`)
     - `MediaPipeVisionFaceAdapter` (candidate MediaPipe Tasks Vision FaceLandmarker)
   - Benchmark runner measuring latency (p50, p95), jitter, face loss recovery, and memory stability.

---

## Pinned Dependencies

All external CDN assets are pinned to exact immutable versions to prevent breaking changes:

| Package | Version | Purpose |
|---|---|---|
| `@tensorflow/tfjs` | `4.22.0` | Core ML execution and tensor backend |
| `@tensorflow-models/face-landmarks-detection` | `1.0.6` | TFJS FaceMesh pipeline (Current adapter) |
| `@mediapipe/tasks-vision` | `0.10.14` | MediaPipe Tasks Vision (Candidate adapter) |

---

## Running Verification Tests

Automated tests can be executed via Node.js:

```bash
# Run all automated unit & integration tests
npm test
# or
node --test test/*.test.js
```

To run the browser-based test suite with WebGL and active TFJS tensor checks, serve the repo and visit:
`http://localhost:8080/test/runner.html`