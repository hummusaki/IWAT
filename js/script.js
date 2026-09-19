// script.js - startup, camera lifecycle binding, diagnostics HUD, and failure recovery

import { logToUI, setLogContainer } from './logger.js';
import { startCamera, stopCamera, retryCamera, enableNoCameraMode, getCameraState, CameraState, subscribeCameraState } from './camera.js';
import { initDetector, initGazeDataExtract, stopTrackingLoop, drainInference, getDiagnosticsSnapshot, setLandmarkOverlayEnabled, disposeSession, setFaceAdapter, getActiveAdapter } from './gaze-tracker.js';
import { startCalibration, showCalibration, checkExistingCalibration, checkExistingModel, clearAllCalibrationStorage } from './calibration.js';
import { train, loadStoredGazeModel, gazeModel } from './regression_model.js';
import { AdapterBenchmarkRunner } from './tracking/adapter-benchmark.js';

let videoElement = null;
let telemetryInterval = null;
let benchmarkRunner = new AdapterBenchmarkRunner();
let isStartupInProgress = false;

function setControlsDisabled(disabled) {
    const ids = ['run-benchmark-btn', 'reset-calibration-btn', 'retry-camera-btn', 'no-camera-btn'];
    for (const id of ids) {
        const el = document.getElementById(id);
        if (el) el.disabled = disabled;
    }
}

/**
 * setup and orchestrate gaze tracking pipeline with complete failure recovery and decoupled training
 */
async function setupTracking() {
    if (isStartupInProgress) return;
    isStartupInProgress = true;
    setControlsDisabled(true);

    logToUI('Initializing IWAT Testing Environment...', true, 'info');

    videoElement = document.getElementById('webcam-video');
    if (!videoElement) {
        logToUI('Fatal: Webcam video element not found in DOM.', true, 'error');
        isStartupInProgress = false;
        setControlsDisabled(false);
        return;
    }

    // 1. initialize camera with error recovery & timing
    let tCamera = 0;
    try {
        const t0 = performance.now();
        await startCamera(videoElement);
        tCamera = performance.now() - t0;
        logToUI(`Camera connected (${tCamera.toFixed(0)} ms).`, false, 'info');
    } catch (cameraErr) {
        logToUI(`Camera startup stopped: ${cameraErr.message}. You may retry or switch to No-Camera Mode.`, false, 'warn');
        updateCameraUIControls(getCameraState());
        isStartupInProgress = false;
        setControlsDisabled(false);
        return; // halt until user clicks Retry or No-Camera Mode
    }

    updateCameraUIControls(CameraState.STREAMING);

    // 2. initialize face detector adapter with timing
    let detector = null;
    let tDetector = 0;
    try {
        logToUI('Loading face detector adapter...', false, 'info');
        const t0 = performance.now();
        detector = await initDetector();
        tDetector = performance.now() - t0;
        logToUI(`Detector initialized (${tDetector.toFixed(0)} ms).`, false, 'info');
    } catch (detectorErr) {
        logToUI(`Detector failed to load: ${detectorErr.message}. Check network connection or WebGL support.`, true, 'error');
        isStartupInProgress = false;
        setControlsDisabled(false);
        return;
    }

    // 3. Measure cold vs. warm inference before starting live loop (F5.1)
    let tCold = 0;
    let tWarm = 0;
    try {
        const tCold0 = performance.now();
        await detector.estimateFaces(videoElement);
        tCold = performance.now() - tCold0;

        const tWarm0 = performance.now();
        await detector.estimateFaces(videoElement);
        tWarm = performance.now() - tWarm0;

        logToUI(`Startup breakdown: Camera=${tCamera.toFixed(0)}ms | Detector=${tDetector.toFixed(0)}ms | Cold=${tCold.toFixed(0)}ms | Warm=${tWarm.toFixed(0)}ms`, true, 'info');
    } catch (warmupErr) {
        logToUI(`Inference warmup warning: ${warmupErr.message}`, false, 'warn');
    }

    // 4. check existing calibration and model with corrupt storage recovery
    const existingData = checkExistingCalibration();
    const existingModel = await checkExistingModel();

    if (existingData && existingModel) {
        logToUI('Found existing calibration data and model in local storage.', false, 'info');
        const loadedModel = await loadStoredGazeModel();

        if (loadedModel) {
            initGazeDataExtract(videoElement, detector);
            isStartupInProgress = false;
            setControlsDisabled(false);
            return;
        } else {
            logToUI('Stored model could not be loaded. Retraining from calibration (live camera loop paused)...', true, 'warn');
            const [x_train, y_train, meta] = existingData;
            // run training decoupled from live loop to prevent WebGL GPU contention
            await train(x_train, y_train, { targetIds: meta?.targetIds });
            initGazeDataExtract(videoElement, detector);
            isStartupInProgress = false;
            setControlsDisabled(false);
            return;
        }
    }

    if (existingData) {
        logToUI('Found existing calibration data. Retraining model (live camera loop paused)...', true, 'info');
        const [x_train, y_train, meta] = existingData;
        await train(x_train, y_train, { targetIds: meta?.targetIds });
        initGazeDataExtract(videoElement, detector);
        isStartupInProgress = false;
        setControlsDisabled(false);
        return;
    }

    // 5. No existing calibration: run sequential fixation calibration with active feed, then train decoupled
    logToUI('No existing calibration found. Preparing calibration overlay...', true, 'info');
    initGazeDataExtract(videoElement, detector, showCalibration);
    isStartupInProgress = false;
    setControlsDisabled(false);

    const data = await startCalibration();
    if (data) {
        const [x_train, y_train, meta] = data;
        logToUI('Calibration targets complete. Pausing camera loop to train regression model...', true, 'info');
        stopTrackingLoop();
        await drainInference();

        const trainResult = await train(x_train, y_train, { targetIds: meta?.targetIds });
        if (trainResult && trainResult.success) {
            logToUI('Model trained and validated. Resuming gaze tracking.', false, 'success');
        } else {
            logToUI('Coarse gaze gate not passed. Recalibration recommended.', true, 'warn');
        }
        initGazeDataExtract(videoElement, detector);
    }
}

/**
 * update camera UI buttons based on state
 */
function updateCameraUIControls(state) {
    const retryBtn = document.getElementById('retry-camera-btn');
    const noCameraBtn = document.getElementById('no-camera-btn');
    const cameraStatusText = document.getElementById('camera-status-text');

    if (cameraStatusText) {
        cameraStatusText.textContent = `Camera: ${state}`;
    }

    if (state === CameraState.DENIED || state === CameraState.ERROR) {
        if (retryBtn) retryBtn.style.display = 'inline-block';
        if (noCameraBtn) noCameraBtn.style.display = 'inline-block';
    } else if (state === CameraState.NO_CAMERA) {
        if (retryBtn) retryBtn.style.display = 'inline-block';
        if (noCameraBtn) noCameraBtn.style.display = 'none';
    } else {
        if (retryBtn) retryBtn.style.display = 'none';
        if (noCameraBtn) noCameraBtn.style.display = 'none';
    }
}

/**
 * diagnostics HUD real-time telemetry loop (4 Hz)
 */
function startTelemetryLoop() {
    if (telemetryInterval) clearInterval(telemetryInterval);

    telemetryInterval = setInterval(() => {
        const snap = getDiagnosticsSnapshot();

        // update HUD elements
        let stateText = 'Initializing';
        let stateColor = '#888';

        if (snap.stalled) {
            stateText = 'Feed Stalled';
            stateColor = '#ff3b30';
        } else if (snap.hasFace) {
            if (snap.isBlinking) {
                stateText = 'Blinking';
                stateColor = '#ffcc00';
            } else {
                stateText = 'Tracking';
                stateColor = '#34c759';
            }
        } else {
            stateText = 'Face Lost';
            stateColor = '#ff3b30';
        }

        setText('diag-state', stateText);
        const stateEl = document.getElementById('diag-state');
        if (stateEl) stateEl.style.color = stateColor;

        setText('diag-fps', `${snap.videoFps} fps`);
        setText('diag-latency', `${snap.inferenceLatencyMs} ms`);
        setText('diag-frame-age', `${snap.frameAgeMs} ms`);
        setText('diag-coverage', `${snap.detectionCoveragePercent}% (face: ${snap.faceCoveragePercent}%)`);
        setText('diag-ear', snap.ear !== null ? snap.ear.toFixed(2) : '--');
        setText('diag-blinks', `${snap.blinksPerMin}/m`);
        setText('diag-tensors', `${snap.activeTensors}`);
        setText('diag-dropped', `${snap.droppedFrames} (skip: ${snap.skippedFrames})`);
    }, 250);
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

/**
 * run adapter benchmark safely decoupled from production tracking
 */
async function triggerAdapterBenchmark() {
    if (benchmarkRunner.isRunning) {
        logToUI('Benchmark is already in progress.', false, 'warn');
        return;
    }

    const modal = document.getElementById('benchmark-modal');
    const modalBody = document.getElementById('benchmark-modal-body');
    const progressEl = document.getElementById('benchmark-progress');

    if (modal) modal.style.display = 'flex';
    if (progressEl) progressEl.textContent = 'Preparing benchmark suite...';
    if (modalBody) modalBody.innerHTML = '<p>Pausing live tracking to ensure isolated benchmark execution...</p>';

    setControlsDisabled(true);

    // pause production tracking loop and drain pending inference
    stopTrackingLoop();
    await drainInference();

    try {
        const report = await benchmarkRunner.runBenchmark({
            iterationsPerScenario: 10,
            liveVideo: videoElement
        }, (progress) => {
            if (progressEl) progressEl.textContent = `${progress.stage} (${progress.percent}%)`;
        });

        renderBenchmarkReport(report, modalBody);
    } catch (err) {
        if (modalBody) modalBody.innerHTML = `<p style="color: #ff3b30;">Benchmark Error: ${err.message}</p>`;
    } finally {
        setControlsDisabled(false);
        // safely restore production tracking with active adapter
        if (videoElement && getCameraState() === CameraState.STREAMING) {
            initGazeDataExtract(videoElement, getActiveAdapter());
        }
    }
}

function renderBenchmarkReport(report, container) {
    if (!container) return;

    let html = `
        <div style="font-size: 12px; margin-bottom: 12px;">
            <strong>Benchmark Completed:</strong> ${new Date(report.timestamp).toLocaleTimeString()}<br>
            <strong>Note:</strong> ${report.decisionNote}
        </div>
        <table class="benchmark-table">
            <thead>
                <tr>
                    <th>Adapter</th>
                    <th>Init (ms)</th>
                    <th>Mean Latency</th>
                    <th>P95 Latency</th>
                    <th>Tensors Leaked</th>
                    <th>Status</th>
                </tr>
            </thead>
            <tbody>
    `;

    for (const [key, res] of Object.entries(report.results)) {
        html += `
            <tr>
                <td><strong>${res.adapterName}</strong></td>
                <td>${res.initTimeMs} ms</td>
                <td>${res.overallMetrics?.meanLatencyMs != null ? res.overallMetrics.meanLatencyMs + ' ms' : 'N/A'}</td>
                <td>${res.overallMetrics?.p95LatencyMs != null ? res.overallMetrics.p95LatencyMs + ' ms' : 'N/A'}</td>
                <td>${res.overallMetrics?.tensorsLeaked ?? 0}</td>
                <td>${res.initSuccess ? '<span style="color:#34c759">Passed</span>' : '<span style="color:#ff3b30">Init Failed</span>'}</td>
            </tr>
        `;
    }

    html += `
            </tbody>
        </table>
        <div style="margin-top: 15px; text-align: right;">
            <button id="close-benchmark-btn" class="control-action-btn">Close Report</button>
        </div>
    `;

    container.innerHTML = html;

    const closeBtn = document.getElementById('close-benchmark-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            const modal = document.getElementById('benchmark-modal');
            if (modal) modal.style.display = 'none';
        });
    }
}

// dom setup
document.addEventListener('DOMContentLoaded', async () => {
    setLogContainer(document.getElementById('ai-logs'));

    // reset calibration and model
    const resetBtn = document.getElementById('reset-calibration-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', async () => {
            if (confirm('Are you sure you want to reset the calibration and model? This will clear storage and recalibrate.')) {
                await clearAllCalibrationStorage();
                window.location.reload();
            }
        });
    }

    // camera retry button
    const retryBtn = document.getElementById('retry-camera-btn');
    if (retryBtn) {
        retryBtn.addEventListener('click', async () => {
            try {
                await retryCamera(videoElement);
                updateCameraUIControls(CameraState.STREAMING);
                await setupTracking();
            } catch (err) {
                updateCameraUIControls(getCameraState());
            }
        });
    }

    // no-camera mode button
    const noCameraBtn = document.getElementById('no-camera-btn');
    if (noCameraBtn) {
        noCameraBtn.addEventListener('click', () => {
            enableNoCameraMode(videoElement);
            updateCameraUIControls(CameraState.NO_CAMERA);
        });
    }

    // landmark overlay toggle
    const landmarkToggle = document.getElementById('toggle-landmarks-checkbox');
    if (landmarkToggle) {
        landmarkToggle.addEventListener('change', (e) => {
            setLandmarkOverlayEnabled(e.target.checked);
        });
    }

    // benchmark button
    const benchmarkBtn = document.getElementById('run-benchmark-btn');
    if (benchmarkBtn) {
        benchmarkBtn.addEventListener('click', () => {
            triggerAdapterBenchmark();
        });
    }

    // benchmark modal close
    const modalClose = document.getElementById('modal-close-icon');
    if (modalClose) {
        modalClose.addEventListener('click', () => {
            const modal = document.getElementById('benchmark-modal');
            if (modal) modal.style.display = 'none';
        });
    }

    // subscribe to camera state changes
    subscribeCameraState((state) => {
        updateCameraUIControls(state);
    });

    // start diagnostics HUD
    startTelemetryLoop();

    // clean session on window unload
    window.addEventListener('beforeunload', () => {
        disposeSession();
        stopCamera(videoElement);
    });

    // run setup
    await setupTracking();
});
