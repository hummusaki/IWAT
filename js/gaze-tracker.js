// gaze-tracker.js - reliable gaze tracking pipeline with aspect ratio preservation,
// single inference in flight, fresh frame scheduling, immutable sample contract, and objective diagnostics

import { logToUI } from "./logger.js";
import { predictGaze, disposeGazeModel } from './regression_model.js';
import { createFaceAdapter } from './tracking/face-adapter.js';
import { computeProcessingCanvasDimensions, getRelativePupilPos, buildGazeFeatureVector } from './features/geometry.js';
import { BlinkDetector } from './features/blink.js';
import { QualityGate } from './features/quality.js';
import { getCameraAspectRatio } from './camera.js';

export const MAX_FRAME_AGE_MS = 250;
export const STALL_THRESHOLD_MS = 800;

export class GazeSample {
    constructor({ sessionId, frameId, sourceTime, processingStartTime, processingEndTime, features, valid, rejectionReason }) {
        this.sessionId = sessionId;
        this.frameId = frameId;
        this.sourceTime = sourceTime;
        this.processingStartTime = processingStartTime;
        this.processingEndTime = processingEndTime;
        this.latencyMs = Math.round(processingEndTime - processingStartTime);
        this.ageMs = Math.round(processingEndTime - sourceTime);
        this.features = features ? Object.freeze([...features]) : null;
        this.valid = !!valid;
        this.rejectionReason = rejectionReason || null;
        Object.freeze(this);
    }
}

export let currentSample = null;
export let currentGaze = null;

// session generation token
let currentSessionId = 0;
let nextFrameId = 1;

// diagnostics state
let activeAdapter = null;
let blinkDetector = new BlinkDetector();
let qualityGate = new QualityGate({ maxFrameAgeMs: MAX_FRAME_AGE_MS });

let isInferenceInFlight = false;
let activeInferencePromise = null;
let isLoopRunning = false;
let animationFrameId = null;
let videoFrameCallbackId = null;

let smoothedGazeX = null;
let smoothedGazeY = null;
const ALPHA = 0.4; // ema smoothing factor

// canvas and overlay references
const aiCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const aiCtx = aiCanvas ? aiCanvas.getContext('2d', { willReadFrequently: true }) : null;

let overlayCanvas = null;
let overlayCtx = null;
let isOverlayEnabled = true;

// performance counters & latency distribution
let observedFramesCount = 0;
let processedFramesCount = 0;
let droppedFramesCount = 0;
let skippedFramesCount = 0;
let lastFrameTime = typeof performance !== 'undefined' ? performance.now() : 0;
let measuredInferenceLatency = 0;
let measuredFrameAge = 0;
let recentLatencies = [];
let videoFps = 0;
let frameCount = 0;
let fpsTimer = typeof performance !== 'undefined' ? performance.now() : 0;
let activeVideoElement = null;
let hasTrackingStarted = false;
let onTrackingStartedCallback = null;

// duplicate frame detection
let lastProcessedVideoTime = -1;
let lastProcessedPresentedFrames = -1;

// detector error recovery & throttling
let consecutiveDetectorErrors = 0;
let lastDetectorErrorLogTime = 0;

let currentTrackingQuality = {
    hasFace: false,
    isBlinking: false,
    frameAge: 0,
    ear: null,
    blinksPerMin: 0,
    stalled: false
};

export function getCurrentTrackingQuality() {
    return { ...currentTrackingQuality };
}

export function getCurrentSample() {
    return currentSample;
}

export function getCurrentGaze() {
    return (currentSample && currentSample.valid) ? currentSample.features : null;
}

export function isSampleFresh(sample, maxAgeMs = MAX_FRAME_AGE_MS) {
    if (!sample || !sample.valid) return false;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return (now - sample.sourceTime) <= maxAgeMs;
}

export function setLandmarkOverlayEnabled(enabled) {
    isOverlayEnabled = enabled;
    if (!enabled && overlayCtx && overlayCanvas) {
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }
}

export function getActiveAdapter() {
    return activeAdapter;
}

/** jsdoc
 * initialize overlay canvas matching webcam display dimensions
 * @param {HTMLVideoElement} videoElement
 */
export function initOverlayCanvas(videoElement) {
    activeVideoElement = videoElement;
    if (typeof document === 'undefined') return;
    overlayCanvas = document.getElementById('webcam-overlay');
    if (!overlayCanvas && videoElement.parentElement) {
        overlayCanvas = document.createElement('canvas');
        overlayCanvas.id = 'webcam-overlay';
        overlayCanvas.className = 'webcam-overlay';
        videoElement.parentElement.appendChild(overlayCanvas);
    }
    if (overlayCanvas) {
        overlayCtx = overlayCanvas.getContext('2d');
        syncOverlayDimensions();
    }
}

function syncOverlayDimensions() {
    if (!overlayCanvas || !activeVideoElement) return;
    const w = activeVideoElement.videoWidth || activeVideoElement.clientWidth || 640;
    const h = activeVideoElement.videoHeight || activeVideoElement.clientHeight || 480;
    if (overlayCanvas.width !== w || overlayCanvas.height !== h) {
        overlayCanvas.width = w;
        overlayCanvas.height = h;
    }
}

/**
 * await drainage of active inference before disposing adapter or restarting loop
 */
export async function drainInference() {
    if (activeInferencePromise) {
        try {
            await activeInferencePromise;
        } catch (e) { }
    }
}

/** jsdoc
 * switch face adapter safely with inference drainage
 * @param {'tfjs' | 'mediapipe-tasks'} type
 */
export async function setFaceAdapter(type = 'tfjs') {
    logToUI(`Switching face adapter to ${type}...`, true, 'info');
    stopTrackingLoop();
    await drainInference();

    if (activeAdapter) {
        try {
            activeAdapter.dispose();
        } catch (e) {
            console.warn('Error disposing previous adapter:', e);
        }
        activeAdapter = null;
    }

    const adapter = createFaceAdapter(type);
    try {
        await adapter.init();
        activeAdapter = adapter;
        logToUI(`Face adapter active: ${adapter.getName()}`, false, 'success');
        return adapter;
    } catch (err) {
        try { adapter.dispose(); } catch (e) { }
        activeAdapter = null;
        logToUI(`Failed to switch adapter: ${err.message}`, true, 'error');
        throw err;
    }
}

/** jsdoc
 * initialize detector safely with local instance before publishing
 * @param {'tfjs' | 'mediapipe-tasks'} type
 * @returns {Promise<BaseFaceAdapter>}
 */
export async function initDetector(type = 'tfjs') {
    if (activeAdapter && activeAdapter.isInitialized) {
        return activeAdapter;
    }

    if (activeAdapter) {
        try { activeAdapter.dispose(); } catch (e) { }
        activeAdapter = null;
    }

    const adapter = createFaceAdapter(type);
    try {
        await adapter.init();
        activeAdapter = adapter;
        consecutiveDetectorErrors = 0;
        return activeAdapter;
    } catch (err) {
        try { adapter.dispose(); } catch (e) { }
        activeAdapter = null;
        logToUI(`Detector Initialization Error: ${err.message}`, true, 'error');
        throw err;
    }
}

/**
 * main tracking entry point with session token
 */
export function initGazeDataExtract(videoElement, detector, onTrackingStarted) {
    if (!videoElement) {
        logToUI('Cannot start tracking: Video element is null.', true, 'error');
        return;
    }

    activeVideoElement = videoElement;
    if (detector) activeAdapter = detector;
    onTrackingStartedCallback = onTrackingStarted || null;

    initOverlayCanvas(videoElement);

    // stop previous loop and increment session generation
    stopTrackingLoop();

    const sessionId = ++currentSessionId;
    isLoopRunning = true;
    hasTrackingStarted = false;
    lastFrameTime = performance.now();
    lastProcessedVideoTime = -1;
    lastProcessedPresentedFrames = -1;
    consecutiveDetectorErrors = 0;

    logToUI('Starting tracking processing loop...', true, 'info');
    scheduleNextFrame(sessionId);
}

/**
 * schedule next frame via requestVideoFrameCallback or requestAnimationFrame
 */
function scheduleNextFrame(sessionId) {
    if (!isLoopRunning || sessionId !== currentSessionId) return;

    if (activeVideoElement && typeof activeVideoElement.requestVideoFrameCallback === 'function') {
        videoFrameCallbackId = activeVideoElement.requestVideoFrameCallback((now, metadata) => {
            processFrameCallback(now, metadata, sessionId);
        });
    } else if (typeof requestAnimationFrame === 'function') {
        animationFrameId = requestAnimationFrame((timestamp) => {
            processFrameRaf(timestamp, sessionId);
        });
    }
}

function processFrameCallback(now, metadata, sessionId) {
    if (!isLoopRunning || sessionId !== currentSessionId) return;

    observedFramesCount++;

    // check duplicate callback frames
    if (metadata && metadata.presentedFrames != null) {
        if (metadata.presentedFrames === lastProcessedPresentedFrames) {
            skippedFramesCount++;
            scheduleNextFrame(sessionId);
            return;
        }
        lastProcessedPresentedFrames = metadata.presentedFrames;
    }

    const presentationTime = metadata?.presentationTime || performance.now();
    const frameAge = Math.max(0, performance.now() - presentationTime);
    dispatchFrame(presentationTime, frameAge, sessionId);
}

function processFrameRaf(timestamp, sessionId) {
    if (!isLoopRunning || sessionId !== currentSessionId) return;

    observedFramesCount++;

    // check whether video time advanced
    if (activeVideoElement && activeVideoElement.currentTime === lastProcessedVideoTime && activeVideoElement.currentTime > 0) {
        skippedFramesCount++;
        scheduleNextFrame(sessionId);
        return;
    }
    if (activeVideoElement) {
        lastProcessedVideoTime = activeVideoElement.currentTime;
    }

    const frameAge = Math.max(0, performance.now() - timestamp);
    dispatchFrame(timestamp, frameAge, sessionId);
}

function dispatchFrame(presentationTimestamp, frameAge, sessionId) {
    const p = handleFrame(presentationTimestamp, frameAge, sessionId);
    activeInferencePromise = p;
}

/**
 * single-frame inference handler
 */
async function handleFrame(presentationTimestamp, frameAge, sessionId) {
    if (!isLoopRunning || sessionId !== currentSessionId || !activeVideoElement || !activeAdapter) {
        scheduleNextFrame(sessionId);
        return;
    }

    // video must have valid dimensions
    const vWidth = activeVideoElement.videoWidth;
    const vHeight = activeVideoElement.videoHeight;
    if (!vWidth || !vHeight || activeVideoElement.readyState < 2) {
        scheduleNextFrame(sessionId);
        return;
    }

    // fps calculation
    frameCount++;
    const now = performance.now();
    if (now - fpsTimer >= 1000) {
        videoFps = frameCount;
        frameCount = 0;
        fpsTimer = now;
    }

    // single inference in flight: drop stale frames if inference is busy
    if (isInferenceInFlight) {
        droppedFramesCount++;
        qualityGate.evaluate({
            frameAge,
            hasFace: false,
            isBlinking: false,
            timestamp: now,
            featureResult: { valid: false, reason: 'dropped_stale_frame' }
        });
        scheduleNextFrame(sessionId);
        return;
    }

    isInferenceInFlight = true;
    const frameId = nextFrameId++;
    lastFrameTime = now;
    const inferenceStart = performance.now();

    let publishedSample = null;

    try {
        // aspect-ratio preservation: dynamically resize processing canvas
        const dims = computeProcessingCanvasDimensions(vWidth, vHeight, 640);
        if (aiCanvas && (aiCanvas.width !== dims.width || aiCanvas.height !== dims.height)) {
            aiCanvas.width = dims.width;
            aiCanvas.height = dims.height;
        }

        // draw video frame to processing canvas
        if (aiCtx) {
            aiCtx.drawImage(activeVideoElement, 0, 0, dims.width, dims.height);
        }

        // run face estimation
        let faces = [];
        try {
            faces = await activeAdapter.estimateFaces(aiCanvas || activeVideoElement, presentationTimestamp);
            consecutiveDetectorErrors = 0;
        } catch (detectorErr) {
            consecutiveDetectorErrors++;
            const tErr = performance.now();
            if (tErr - lastDetectorErrorLogTime > 2000) {
                logToUI(`Detector error: ${detectorErr.message}`, false, 'warn');
                lastDetectorErrorLogTime = tErr;
            }

            qualityGate.evaluate({
                frameAge: Math.max(0, performance.now() - presentationTimestamp),
                hasFace: false,
                isBlinking: false,
                timestamp: now,
                detectorError: true
            });

            publishedSample = new GazeSample({
                sessionId,
                frameId,
                sourceTime: presentationTimestamp,
                processingStartTime: inferenceStart,
                processingEndTime: performance.now(),
                features: null,
                valid: false,
                rejectionReason: 'detector_error'
            });

            currentSample = publishedSample;
            currentGaze = null;
            hideGazePointer();

            if (consecutiveDetectorErrors >= 5) {
                logToUI('Detector encountered persistent errors. Pausing tracking. Click Retry.', true, 'error');
                stopTrackingLoop();
                return;
            }

            return;
        }

        const inferenceEnd = performance.now();
        measuredInferenceLatency = Math.round(inferenceEnd - inferenceStart);
        recordLatency(measuredInferenceLatency);
        measuredFrameAge = Math.round(inferenceEnd - presentationTimestamp);

        // check session validity after await
        if (!isLoopRunning || sessionId !== currentSessionId) {
            return;
        }

        processedFramesCount++;

        // recheck result age at completion
        if (measuredFrameAge > MAX_FRAME_AGE_MS) {
            publishedSample = new GazeSample({
                sessionId,
                frameId,
                sourceTime: presentationTimestamp,
                processingStartTime: inferenceStart,
                processingEndTime: inferenceEnd,
                features: null,
                valid: false,
                rejectionReason: 'stale_frame'
            });
            currentSample = publishedSample;
            currentGaze = null;
            qualityGate.evaluate({
                frameAge: measuredFrameAge,
                hasFace: faces && faces.length > 0,
                isBlinking: false,
                timestamp: now,
                reason: 'stale_frame'
            });
            hideGazePointer();
            return;
        }

        if (!faces || faces.length === 0) {
            // face loss: invalidate gaze immediately
            currentTrackingQuality = {
                hasFace: false,
                isBlinking: false,
                frameAge: measuredFrameAge,
                ear: null,
                blinksPerMin: blinkDetector.getBlinksPerMinute(now),
                stalled: false
            };

            qualityGate.evaluate({
                frameAge: measuredFrameAge,
                hasFace: false,
                isBlinking: false,
                timestamp: now
            });

            publishedSample = new GazeSample({
                sessionId,
                frameId,
                sourceTime: presentationTimestamp,
                processingStartTime: inferenceStart,
                processingEndTime: inferenceEnd,
                features: null,
                valid: false,
                rejectionReason: 'face_lost'
            });

            currentSample = publishedSample;
            currentGaze = null;

            if (overlayCtx && overlayCanvas) {
                overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
            }
            hideGazePointer();
        } else {
            // face detected
            const face = faces[0];
            const kp = face.keypoints;

            // required landmarks: outer/inner/top/bottom for both eyes + both irises
            const requiredIndices = [33, 133, 145, 159, 263, 362, 374, 386, 468, 473];
            const hasRequiredLandmarks = kp && kp.length >= 474 && requiredIndices.every(idx => {
                const pt = kp[idx];
                return pt && Number.isFinite(pt.x) && Number.isFinite(pt.y);
            });

            if (!hasRequiredLandmarks) {
                qualityGate.evaluate({
                    frameAge: measuredFrameAge,
                    hasFace: true,
                    isBlinking: false,
                    timestamp: now,
                    reason: 'insufficient_landmarks'
                });

                publishedSample = new GazeSample({
                    sessionId,
                    frameId,
                    sourceTime: presentationTimestamp,
                    processingStartTime: inferenceStart,
                    processingEndTime: inferenceEnd,
                    features: null,
                    valid: false,
                    rejectionReason: 'insufficient_landmarks'
                });

                currentSample = publishedSample;
                currentGaze = null;
                hideGazePointer();
            } else {
                const leftPupil = kp[468];
                const rightPupil = kp[473];

                const leftOuter = kp[33];
                const leftInner = kp[133];
                const leftTop = kp[159];
                const leftBottom = kp[145];

                const rightInner = kp[362];
                const rightOuter = kp[263];
                const rightTop = kp[386];
                const rightBottom = kp[374];

                // bilateral blink detection
                const blinkResult = blinkDetector.update(
                    { top: leftTop, bottom: leftBottom, inner: leftInner, outer: leftOuter },
                    { top: rightTop, bottom: rightBottom, inner: rightInner, outer: rightOuter },
                    now
                );

                // relative pupil extraction
                const leftRel = getRelativePupilPos(leftPupil, leftOuter, leftInner);
                const rightRel = getRelativePupilPos(rightPupil, rightOuter, rightInner);
                const featureResult = buildGazeFeatureVector(leftRel, rightRel);

                currentTrackingQuality = {
                    hasFace: true,
                    isBlinking: blinkResult.isBlinking,
                    frameAge: measuredFrameAge,
                    ear: blinkResult.avgEAR,
                    blinksPerMin: blinkResult.blinksPerMinute,
                    stalled: false
                };

                const qualityEvaluation = qualityGate.evaluate({
                    frameAge: measuredFrameAge,
                    hasFace: true,
                    isBlinking: blinkResult.isBlinking,
                    timestamp: now,
                    featureResult
                });

                const isSampleValid = qualityEvaluation.isValid && featureResult.valid && !blinkResult.isBlinking;

                publishedSample = new GazeSample({
                    sessionId,
                    frameId,
                    sourceTime: presentationTimestamp,
                    processingStartTime: inferenceStart,
                    processingEndTime: inferenceEnd,
                    features: isSampleValid ? featureResult.features : null,
                    valid: isSampleValid,
                    rejectionReason: isSampleValid ? null : (qualityEvaluation.reason || featureResult.reason || 'invalid_sample')
                });

                currentSample = publishedSample;

                if (isSampleValid) {
                    currentGaze = publishedSample.features;

                    if (!hasTrackingStarted && onTrackingStartedCallback) {
                        hasTrackingStarted = true;
                        onTrackingStartedCallback();
                    }

                    runGazeInference(currentGaze);
                } else {
                    currentGaze = null;
                    if (blinkResult.isBlinking) {
                        visualizeBlinkOnCursor();
                    }
                }

                // render landmarks overlay if enabled
                if (isOverlayEnabled && overlayCtx && overlayCanvas) {
                    renderOverlay(face, dims, vWidth, vHeight, blinkResult.isBlinking);
                }
            }
        }
    } catch (err) {
        console.error('Error in tracking loop handleFrame:', err);
    } finally {
        isInferenceInFlight = false;
        scheduleNextFrame(sessionId);
    }
}

function recordLatency(ms) {
    recentLatencies.push(ms);
    if (recentLatencies.length > 30) {
        recentLatencies.shift();
    }
}

function calculateLatencyPercentile(p) {
    if (recentLatencies.length === 0) return 0;
    const sorted = [...recentLatencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
    return sorted[idx];
}

/** jsdoc
 * predict screen cursor coordinates and apply EMA smoothing
 * @param {Array<number>} features - gaze features vector
 */
function runGazeInference(features) {
    const coords = predictGaze(features);
    if (!coords) return;

    if (typeof window === 'undefined') return;

    const screenX = coords[0] * window.innerWidth;
    const screenY = coords[1] * window.innerHeight;

    if (smoothedGazeX === null) {
        smoothedGazeX = screenX;
        smoothedGazeY = screenY;
    } else {
        smoothedGazeX = (screenX * ALPHA) + (smoothedGazeX * (1 - ALPHA));
        smoothedGazeY = (screenY * ALPHA) + (smoothedGazeY * (1 - ALPHA));
    }

    const gazePointer = document.getElementById('gaze-pointer');
    if (gazePointer) {
        gazePointer.style.display = 'block';
        gazePointer.style.left = `${smoothedGazeX}px`;
        gazePointer.style.top = `${smoothedGazeY}px`;
    }
}

export function hideGazePointer() {
    if (typeof document === 'undefined') return;
    const gazePointer = document.getElementById('gaze-pointer');
    if (gazePointer) {
        gazePointer.style.display = 'none';
    }
    smoothedGazeX = null;
    smoothedGazeY = null;
}

function visualizeBlinkOnCursor() {
    if (typeof document === 'undefined') return;
    const gazePointer = document.getElementById('gaze-pointer');
    if (gazePointer && gazePointer.style.display !== 'none') {
        gazePointer.style.backgroundColor = '#ffcc00';
        setTimeout(() => {
            if (gazePointer) gazePointer.style.backgroundColor = 'rgba(255, 59, 48, 0.8)';
        }, 150);
    }
}

/** jsdoc
 * render visual landmark overlay on webcam feed
 */
function renderOverlay(face, processingDims, vWidth, vHeight, isBlinking) {
    if (!overlayCtx || !overlayCanvas) return;
    syncOverlayDimensions();
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    const scaleX = overlayCanvas.width / processingDims.width;
    const scaleY = overlayCanvas.height / processingDims.height;

    const kp = face.keypoints;

    overlayCtx.lineWidth = 1.5;
    overlayCtx.strokeStyle = isBlinking ? '#ff9f1a' : '#00d2d3';

    // left eye circuit
    const leftEyeIndices = [33, 160, 158, 133, 153, 144, 33];
    drawPath(overlayCtx, kp, leftEyeIndices, scaleX, scaleY);

    // right eye circuit
    const rightEyeIndices = [362, 385, 387, 263, 373, 380, 362];
    drawPath(overlayCtx, kp, rightEyeIndices, scaleX, scaleY);

    // irises
    if (!isBlinking) {
        overlayCtx.fillStyle = '#ff6b6b';
        if (kp[468]) drawPoint(overlayCtx, kp[468], scaleX, scaleY, 3);
        if (kp[473]) drawPoint(overlayCtx, kp[473], scaleX, scaleY, 3);
    }
}

function drawPath(ctx, keypoints, indices, scaleX, scaleY) {
    ctx.beginPath();
    let first = true;
    for (const idx of indices) {
        const pt = keypoints[idx];
        if (!pt) continue;
        const x = pt.x * scaleX;
        const y = pt.y * scaleY;
        if (first) {
            ctx.moveTo(x, y);
            first = false;
        } else {
            ctx.lineTo(x, y);
        }
    }
    ctx.stroke();
}

function drawPoint(ctx, pt, scaleX, scaleY, radius = 2) {
    ctx.beginPath();
    ctx.arc(pt.x * scaleX, pt.y * scaleY, radius, 0, Math.PI * 2);
    ctx.fill();
}

/**
 * stall watchdog: checks whether camera feed has stopped advancing
 */
export function checkStallWatchdog(maxStallMs = STALL_THRESHOLD_MS) {
    if (!isLoopRunning) return false;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - lastFrameTime > maxStallMs) {
        currentGaze = null;
        currentSample = null;
        currentTrackingQuality.hasFace = false;
        currentTrackingQuality.stalled = true;
        hideGazePointer();
        return true;
    }
    return false;
}

/**
 * stop processing loop cleanly
 */
export function stopTrackingLoop() {
    currentSessionId++;
    isLoopRunning = false;

    if (videoFrameCallbackId && activeVideoElement && typeof activeVideoElement.cancelVideoFrameCallback === 'function') {
        try {
            activeVideoElement.cancelVideoFrameCallback(videoFrameCallbackId);
        } catch (e) { }
        videoFrameCallbackId = null;
    }

    if (animationFrameId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }

    hideGazePointer();
}

/**
 * session disposal
 */
export function disposeSession() {
    logToUI('Disposing gaze tracking session resources...', true, 'info');
    stopTrackingLoop();

    // dispose gaze regression model
    disposeGazeModel();

    if (activeAdapter) {
        try {
            activeAdapter.dispose();
        } catch (e) {
            console.warn('Error disposing adapter:', e);
        }
        activeAdapter = null;
    }

    blinkDetector.reset();
    qualityGate.reset();

    currentSample = null;
    currentGaze = null;
    smoothedGazeX = null;
    smoothedGazeY = null;
    droppedFramesCount = 0;
    observedFramesCount = 0;
    processedFramesCount = 0;
    skippedFramesCount = 0;
    recentLatencies = [];

    if (overlayCtx && overlayCanvas) {
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }
}

/**
 * diagnostics snapshot for live telemetry HUD
 */
export function getDiagnosticsSnapshot() {
    checkStallWatchdog();
    const qualityMetrics = qualityGate.getMetrics();
    const tensorCount = (typeof tf !== 'undefined' && tf.memory) ? tf.memory().numTensors : 0;

    return {
        adapter: activeAdapter ? activeAdapter.getName() : 'None',
        videoFps,
        inferenceLatencyMs: measuredInferenceLatency,
        inferenceP50Ms: calculateLatencyPercentile(50),
        inferenceP95Ms: calculateLatencyPercentile(95),
        frameAgeMs: measuredFrameAge,
        detectionCoveragePercent: qualityMetrics.coveragePercent,
        faceCoveragePercent: qualityMetrics.faceCoveragePercent,
        hasFace: currentTrackingQuality.hasFace,
        isBlinking: currentTrackingQuality.isBlinking,
        ear: currentTrackingQuality.ear,
        blinksPerMin: currentTrackingQuality.blinksPerMin,
        stalled: currentTrackingQuality.stalled,
        observedFrames: observedFramesCount,
        processedFrames: processedFramesCount,
        droppedFrames: droppedFramesCount,
        skippedFrames: skippedFramesCount,
        rejections: qualityMetrics.rejections,
        activeTensors: tensorCount
    };
}