// gaze-tracker.js - reliable gaze tracking pipeline with aspect ratio preservation,
// single inference in flight, fresh frame scheduling, and objective diagnostics

import { logToUI } from "./logger.js";
import { predictGaze } from './regression_model.js';
import { createFaceAdapter } from './tracking/face-adapter.js';
import { computeProcessingCanvasDimensions, getRelativePupilPos, buildGazeFeatureVector } from './features/geometry.js';
import { BlinkDetector } from './features/blink.js';
import { QualityGate } from './features/quality.js';
import { getCameraAspectRatio } from './camera.js';

export let currentGaze = null;

// diagnostics state
let activeAdapter = null;
let blinkDetector = new BlinkDetector();
let qualityGate = new QualityGate();

let isInferenceInFlight = false;
let isLoopRunning = false;
let animationFrameId = null;
let videoFrameCallbackId = null;

let smoothedGazeX = null;
let smoothedGazeY = null;
const ALPHA = 0.4; // EMA smoothing factor

// canvas and overlay references
const aiCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const aiCtx = aiCanvas ? aiCanvas.getContext('2d', { willReadFrequently: true }) : null;

let overlayCanvas = null;
let overlayCtx = null;
let isOverlayEnabled = true;

// performance counters
let droppedFramesCount = 0;
let lastFrameTime = performance.now();
let measuredInferenceLatency = 0;
let measuredFrameAge = 0;
let videoFps = 0;
let frameCount = 0;
let fpsTimer = performance.now();
let activeVideoElement = null;
let hasTrackingStarted = false;
let onTrackingStartedCallback = null;

let currentTrackingQuality = {
    hasFace: false,
    isBlinking: false,
    frameAge: 0,
    ear: null,
    blinksPerMin: 0
};

export function getCurrentTrackingQuality() {
    return { ...currentTrackingQuality };
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

/** jsdoc
 * switch face adapter
 * @param {'tfjs' | 'mediapipe-tasks'} type
 */
export async function setFaceAdapter(type = 'tfjs') {
    logToUI(`Switching face adapter to ${type}...`, true, 'info');
    if (activeAdapter) {
        activeAdapter.dispose();
        activeAdapter = null;
    }

    const adapter = createFaceAdapter(type);
    await adapter.init();
    activeAdapter = adapter;
    logToUI(`Face adapter active: ${adapter.getName()}`, false, 'success');
    return adapter;
}

/** jsdoc
 * initialize detector (default TFJS)
 * @returns {Promise<BaseFaceAdapter>}
 */
export async function initDetector() {
    try {
        if (!activeAdapter) {
            activeAdapter = createFaceAdapter('tfjs');
            await activeAdapter.init();
        }
        return activeAdapter;
    } catch (err) {
        logToUI(`Detector Initialization Error: ${err.message}`, true, 'error');
        throw err;
    }
}

/**
 * main tracking entry point
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

    // stop previous loop if running
    stopTrackingLoop();

    isLoopRunning = true;
    isInferenceInFlight = false;
    hasTrackingStarted = false;

    logToUI('Starting tracking processing loop...', true, 'info');
    scheduleNextFrame();
}

/**
 * schedule next frame via requestVideoFrameCallback (preferred for camera) or requestAnimationFrame
 */
function scheduleNextFrame() {
    if (!isLoopRunning) return;

    if (activeVideoElement && typeof activeVideoElement.requestVideoFrameCallback === 'function') {
        videoFrameCallbackId = activeVideoElement.requestVideoFrameCallback(processFrameCallback);
    } else {
        animationFrameId = requestAnimationFrame(processFrameRaf);
    }
}

function processFrameCallback(now, metadata) {
    const presentationTime = metadata?.presentationTime || performance.now();
    const frameAge = Math.max(0, performance.now() - presentationTime);
    handleFrame(presentationTime, frameAge);
}

function processFrameRaf(timestamp) {
    const frameAge = Math.max(0, performance.now() - timestamp);
    handleFrame(timestamp, frameAge);
}

/**
 * single-frame inference handler
 */
async function handleFrame(presentationTimestamp, frameAge) {
    if (!isLoopRunning || !activeVideoElement || !activeAdapter) {
        scheduleNextFrame();
        return;
    }

    // video must have valid dimensions
    const vWidth = activeVideoElement.videoWidth;
    const vHeight = activeVideoElement.videoHeight;
    if (!vWidth || !vHeight || activeVideoElement.readyState < 2) {
        scheduleNextFrame();
        return;
    }

    // FPS calculation
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
        scheduleNextFrame();
        return;
    }

    isInferenceInFlight = true;
    measuredFrameAge = Math.round(frameAge);

    const inferenceStart = performance.now();

    try {
        // aspect-ratio preservation: dynamically resize processing canvas
        const dims = computeProcessingCanvasDimensions(vWidth, vHeight, 640);
        if (aiCanvas.width !== dims.width || aiCanvas.height !== dims.height) {
            aiCanvas.width = dims.width;
            aiCanvas.height = dims.height;
        }

        // draw video frame to processing canvas
        aiCtx.drawImage(activeVideoElement, 0, 0, dims.width, dims.height);

        // run face estimation
        const faces = await activeAdapter.estimateFaces(aiCanvas, presentationTimestamp);
        measuredInferenceLatency = Math.round(performance.now() - inferenceStart);

        if (!faces || faces.length === 0) {
            // face loss: invalidate gaze immediately
            currentGaze = null;
            currentTrackingQuality = {
                hasFace: false,
                isBlinking: false,
                frameAge: measuredFrameAge,
                ear: null,
                blinksPerMin: blinkDetector.getBlinksPerMinute(now)
            };

            qualityGate.evaluate({
                frameAge: measuredFrameAge,
                hasFace: false,
                isBlinking: false,
                timestamp: now
            });

            // clear overlay
            if (overlayCtx && overlayCanvas) {
                overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
            }

            // hide gaze pointer on face loss
            hideGazePointer();
        } else {
            // face detected
            const face = faces[0];
            const kp = face.keypoints;

            if (!kp || kp.length < 468) {
                currentGaze = null;
                qualityGate.evaluate({
                    frameAge: measuredFrameAge,
                    hasFace: false,
                    isBlinking: false,
                    timestamp: now,
                    featureResult: { valid: false, reason: 'insufficient_landmarks' }
                });
                hideGazePointer();
            } else {
                // keypoints: 468 Left Iris, 473 Right Iris (MediaPipe standard)
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

                // measurable bilateral blink detection
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
                    blinksPerMin: blinkResult.blinksPerMinute
                };

                const qualityEvaluation = qualityGate.evaluate({
                    frameAge: measuredFrameAge,
                    hasFace: true,
                    isBlinking: blinkResult.isBlinking,
                    timestamp: now,
                    featureResult
                });

                if (qualityEvaluation.isValid && featureResult.valid) {
                    currentGaze = featureResult.features;

                    if (!hasTrackingStarted && onTrackingStartedCallback) {
                        hasTrackingStarted = true;
                        onTrackingStartedCallback();
                    }

                    // run gaze inference if model loaded
                    runGazeInference(currentGaze);
                } else {
                    // blink or invalid feature: invalidate current gaze sample
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
        scheduleNextFrame();
    }
}

/** jsdoc
 * predict screen cursor coordinates and apply EMA smoothing
 * @param {Array<number>} features - gaze features vector
 */
function runGazeInference(features) {
    const coords = predictGaze(features);
    if (!coords) return;

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

function hideGazePointer() {
    const gazePointer = document.getElementById('gaze-pointer');
    if (gazePointer) {
        gazePointer.style.display = 'none';
    }
    smoothedGazeX = null;
    smoothedGazeY = null;
}

function visualizeBlinkOnCursor() {
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
 * @param {object} face - face detection result with keypoints
 * @param {object} processingDims - processing canvas dimensions
 * @param {number} vWidth - video width
 * @param {number} vHeight - video height
 * @param {boolean} isBlinking - whether eyes are detected as blinking
 */
function renderOverlay(face, processingDims, vWidth, vHeight, isBlinking) {
    syncOverlayDimensions();
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    const scaleX = overlayCanvas.width / processingDims.width;
    const scaleY = overlayCanvas.height / processingDims.height;

    const kp = face.keypoints;

    // draw eye boundaries
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

/** jsdoc
 * draw path
 * @param {object} ctx - canvas context
 * @param {Array<object>} keypoints - face keypoints
 * @param {Array<number>} indices - indices to draw
 * @param {number} scaleX - x-axis scaling factor
 * @param {number} scaleY - y-axis scaling factor
 */
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
 * stop processing loop cleanly
 */
export function stopTrackingLoop() {
    isLoopRunning = false;
    isInferenceInFlight = false;

    if (videoFrameCallbackId && activeVideoElement && typeof activeVideoElement.cancelVideoFrameCallback === 'function') {
        try {
            activeVideoElement.cancelVideoFrameCallback(videoFrameCallbackId);
        } catch (e) { }
        videoFrameCallbackId = null;
    }

    if (animationFrameId) {
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

    if (activeAdapter) {
        activeAdapter.dispose();
        activeAdapter = null;
    }

    blinkDetector.reset();
    qualityGate.reset();

    currentGaze = null;
    smoothedGazeX = null;
    smoothedGazeY = null;
    droppedFramesCount = 0;

    if (overlayCtx && overlayCanvas) {
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }
}

/**
 * diagnostics snapshot for live telemetry HUD
 */
export function getDiagnosticsSnapshot() {
    const qualityMetrics = qualityGate.getMetrics();
    const tensorCount = (typeof tf !== 'undefined' && tf.memory) ? tf.memory().numTensors : 0;

    return {
        adapter: activeAdapter ? activeAdapter.getName() : 'None',
        videoFps,
        inferenceLatencyMs: measuredInferenceLatency,
        frameAgeMs: measuredFrameAge,
        detectionCoveragePercent: qualityMetrics.coveragePercent,
        hasFace: currentTrackingQuality.hasFace,
        isBlinking: currentTrackingQuality.isBlinking,
        ear: currentTrackingQuality.ear,
        blinksPerMin: currentTrackingQuality.blinksPerMin,
        droppedFrames: droppedFramesCount,
        rejections: qualityMetrics.rejections,
        activeTensors: tensorCount
    };
}