// calibration.js - quality-gated sequential fixation calibration, two-axis signal validation, and v5 persistence

import { logToUI } from "./logger.js";
import { getCurrentSample, isSampleFresh, getCurrentTrackingQuality } from "./gaze-tracker.js";

export const CALIBRATION_STORAGE_KEY = 'IWAT_calibration_v5';
export const LEGACY_STORAGE_KEYS = [
    'IWAT_calibration_v4',
    'calibration_x_train_v3',
    'calibration_y_train_v3',
    'calibration_x_train',
    'calibration_y_train'
];

// 9-point grid positions (percentages)
const TARGET_GRID = [
    { id: 0, x: 10, y: 10, label: 'Top-Left' },
    { id: 1, x: 50, y: 10, label: 'Top-Center' },
    { id: 2, x: 90, y: 10, label: 'Top-Right' },
    { id: 3, x: 10, y: 50, label: 'Middle-Left' },
    { id: 4, x: 50, y: 50, label: 'Center' },
    { id: 5, x: 90, y: 50, label: 'Middle-Right' },
    { id: 6, x: 10, y: 90, label: 'Bottom-Left' },
    { id: 7, x: 50, y: 90, label: 'Bottom-Center' },
    { id: 8, x: 90, y: 90, label: 'Bottom-Right' }
];

export const CALIBRATION_CONFIG = {
    settlingTimeMs: 400,
    minSamplesPerTarget: 15,
    minTargetDurationMs: 750,
    targetTimeoutMs: 10000,
    varianceFloor: 1e-4
};

let activeCalibrationSession = null;
let overlay = null;

/** jsdoc
 * validate calibration data schema and numeric integrity (supports v5 and legacy v4)
 * @param {any} data
 * @returns {{ valid: boolean, reason?: string, data?: Object }}
 */
export function validateCalibrationData(data) {
    if (!data || typeof data !== 'object') {
        return { valid: false, reason: 'Calibration data is not an object' };
    }

    const version = data.version;
    if (version !== 4 && version !== 5) {
        return { valid: false, reason: `Unsupported schema version: ${version}` };
    }

    if (version === 5 && data.committed !== true) {
        return { valid: false, reason: 'Calibration data is uncommitted or incomplete' };
    }

    const { x_train, y_train, screen } = data;

    if (!Array.isArray(x_train) || !Array.isArray(y_train)) {
        return { valid: false, reason: 'x_train or y_train is not an array' };
    }

    if (x_train.length === 0 || y_train.length === 0) {
        return { valid: false, reason: 'Calibration arrays are empty' };
    }

    if (x_train.length !== y_train.length) {
        return { valid: false, reason: `Mismatched lengths: x_train (${x_train.length}) != y_train (${y_train.length})` };
    }

    if (x_train.length < 18) {
        return { valid: false, reason: `Insufficient sample count (${x_train.length} < 18)` };
    }

    // check numeric integrity
    for (let i = 0; i < x_train.length; i++) {
        const xSample = x_train[i];
        const ySample = y_train[i];

        if (!Array.isArray(xSample) || xSample.length !== 4) {
            return { valid: false, reason: `Invalid x_train sample at index ${i}` };
        }
        for (let j = 0; j < 4; j++) {
            if (!Number.isFinite(xSample[j])) {
                return { valid: false, reason: `Non-finite value in x_train at [${i}][${j}]` };
            }
        }

        if (!Array.isArray(ySample) || ySample.length !== 2) {
            return { valid: false, reason: `Invalid y_train sample at index ${i}` };
        }
        for (let j = 0; j < 2; j++) {
            if (!Number.isFinite(ySample[j]) || ySample[j] < -0.1 || ySample[j] > 1.1) {
                return { valid: false, reason: `Out-of-range value in y_train at [${i}][${j}]` };
            }
        }
    }

    // check screen geometry change if present
    if (screen && typeof window !== 'undefined' && window.innerWidth && window.innerHeight) {
        const widthDiff = Math.abs(screen.width - window.innerWidth) / window.innerWidth;
        const heightDiff = Math.abs(screen.height - window.innerHeight) / window.innerHeight;
        if (widthDiff > 0.25 || heightDiff > 0.25) {
            logToUI('Screen geometry changed significantly since calibration. Recalibration recommended.', false, 'warn');
        }
    }

    return {
        valid: true,
        data: {
            x_train,
            y_train,
            version,
            targetIds: data.targetIds || null,
            frameIds: data.frameIds || null,
            preprocessing: data.preprocessing || null,
            geometry: screen || null,
            validation: data.validation || null,
            id: data.id || null
        }
    };
}

/** jsdoc
 * compute feature spread and verify per-axis signal
 * @param {number[][]} x_train - 4D features
 * @returns {{ varX: number, varY: number, hasSufficientSignal: boolean, spreads: Object[] }}
 */
export function computeFeatureSpread(x_train) {
    if (!x_train || x_train.length === 0) {
        return { varX: 0, varY: 0, hasSufficientSignal: false, spreads: [] };
    }

    const n = x_train.length;
    const spreads = [];

    for (let dim = 0; dim < 4; dim++) {
        let sum = 0;
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < n; i++) {
            const v = x_train[i][dim];
            sum += v;
            if (v < min) min = v;
            if (v > max) max = v;
        }
        const mean = sum / n;
        let sumSq = 0;
        for (let i = 0; i < n; i++) {
            sumSq += Math.pow(x_train[i][dim] - mean, 2);
        }
        const variance = sumSq / n;
        const std = Math.sqrt(variance);
        spreads.push({ dim, mean, variance, std, min, max, range: max - min });
    }

    // X features: dim 0 (rx) and dim 2 (lx)
    // Y features: dim 1 (ry) and dim 3 (ly)
    const varX = Math.max(spreads[0].variance, spreads[2].variance);
    const varY = Math.max(spreads[1].variance, spreads[3].variance);
    const hasSufficientSignal = varX >= CALIBRATION_CONFIG.varianceFloor && varY >= CALIBRATION_CONFIG.varianceFloor;

    return { varX, varY, hasSufficientSignal, spreads };
}

/** jsdoc
 * check and retrieve existing calibration data with corruption recovery
 * @param {string} [storageKey]
 * @returns {[number[][], number[][], Object] | null}
 */
export function checkExistingCalibration(storageKey = CALIBRATION_STORAGE_KEY) {
    try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) {
            cleanLegacyStorage();
            return null;
        }

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (jsonErr) {
            logToUI('Corrupted JSON found in calibration storage. Purging bad data...', true, 'warn');
            localStorage.removeItem(storageKey);
            return null;
        }

        const validation = validateCalibrationData(parsed);
        if (!validation.valid) {
            logToUI(`Invalid calibration data in storage (${validation.reason}). Purging...`, true, 'warn');
            localStorage.removeItem(storageKey);
            return null;
        }

        // Check if old v4 schema needs fresh calibration
        if (validation.data.version === 4 && storageKey === CALIBRATION_STORAGE_KEY) {
            logToUI('Previous v4 calibration detected. Upgrading to v5 contract; fresh calibration recommended.', false, 'info');
        }

        return [validation.data.x_train, validation.data.y_train, validation.data];
    } catch (err) {
        console.error('Error checking calibration storage:', err);
        return null;
    }
}

/**
 * check if a trained gaze model exists in storage
 */
export async function checkExistingModel() {
    if (typeof tf === 'undefined' || !tf.io) return false;
    try {
        const models = await tf.io.listModels();
        return models['localstorage://IWAT-gaze-model-v5'] != null;
    } catch (e) {
        console.warn('Error querying stored models:', e);
        return false;
    }
}

/**
 * purge legacy keys
 */
function cleanLegacyStorage() {
    for (const key of LEGACY_STORAGE_KEYS) {
        try {
            localStorage.removeItem(key);
        } catch (e) { }
    }
    if (typeof tf !== 'undefined' && tf.io) {
        try {
            tf.io.removeModel('localstorage://IWAT-gaze-model-v4').catch(() => { });
            tf.io.removeModel('localstorage://IWAT-gaze-model-v3').catch(() => { });
        } catch (e) { }
    }
}

/**
 * save validated v5 calibration data to storage with commit marker
 */
export function saveCalibrationData(x_train, y_train, metadata = {}, storageKey = CALIBRATION_STORAGE_KEY) {
    const payload = {
        version: 5,
        id: `calib_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        timestamp: Date.now(),
        committed: true,
        screen: {
            width: typeof window !== 'undefined' ? window.innerWidth : 1920,
            height: typeof window !== 'undefined' ? window.innerHeight : 1080,
            devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1
        },
        metadata: {
            sampleCount: x_train.length,
            targetCount: TARGET_GRID.length,
            ...metadata
        },
        x_train,
        y_train,
        targetIds: metadata.targetIds || null,
        frameIds: metadata.frameIds || null,
        preprocessing: metadata.preprocessing || null,
        validation: metadata.validation || null
    };

    try {
        localStorage.setItem(storageKey, JSON.stringify(payload));
        logToUI(`Calibration saved (${x_train.length} fresh samples across 9 fixation targets).`, false, 'success');
        return payload;
    } catch (err) {
        logToUI(`Storage Error: Could not save calibration data (${err.message})`, true, 'error');
        return null;
    }
}

/**
 * clear all stored calibration and model assets
 */
export async function clearAllCalibrationStorage() {
    localStorage.removeItem(CALIBRATION_STORAGE_KEY);
    cleanLegacyStorage();

    if (typeof tf !== 'undefined' && tf.io) {
        try {
            await tf.io.removeModel('localstorage://IWAT-gaze-model-v5');
        } catch (e) { }
        try {
            await tf.io.removeModel('localstorage://IWAT-gaze-model-v4');
        } catch (e) { }
    }
    logToUI('Calibration data and model cleared.', true, 'info');
}

/**
 * interactive sequential fixation calibration session
 */
export async function startCalibration(options = {}) {
    if (activeCalibrationSession) {
        activeCalibrationSession.cancel();
    }

    const config = { ...CALIBRATION_CONFIG, ...options };

    return new Promise((resolve) => {
        overlay = document.getElementById('calibration-overlay');
        if (!overlay) {
            logToUI('Error: Calibration overlay element not found.', true, 'error');
            resolve(null);
            return;
        }

        overlay.innerHTML = '';
        overlay.style.display = 'flex';
        overlay.style.opacity = '1';

        // Top control bar (reachable above overlay)
        const topBar = document.createElement('div');
        topBar.className = 'calibration-top-bar';
        topBar.innerHTML = `
            <div class="calibration-status-header">
                <span id="calib-target-label">Target 1 of 9</span>
                <span id="calib-stage-badge" class="calib-badge">Settling...</span>
            </div>
            <div class="calibration-actions">
                <button id="calib-retry-target-btn" class="calib-ctrl-btn">Retry Target</button>
                <button id="calib-cancel-btn" class="calib-ctrl-btn secondary">Cancel</button>
            </div>
        `;
        overlay.appendChild(topBar);

        // center instructions container
        const instructions = document.createElement('div');
        instructions.className = 'calibration-instructions';
        instructions.innerHTML = `
            <h2>Sequential Fixation Calibration</h2>
            <p id="calib-instruction-text">Look directly at the pulsating dot. Stay steady while samples are collected automatically.</p>
        `;
        overlay.appendChild(instructions);

        // Fixation Target Dot
        const targetDot = document.createElement('div');
        targetDot.className = 'calibration-dot active-target';
        targetDot.innerHTML = '<span id="dot-progress">0/15</span>';
        overlay.appendChild(targetDot);

        let currentTargetIndex = 0;
        let isCancelled = false;
        let isSettling = true;
        let targetStartTime = performance.now();
        let targetSamples = [];
        let targetFrameIds = [];
        let targetTimestamps = [];
        let lastCollectedFrameId = -1;
        let checkTimer = null;

        const allXTrain = [];
        const allYTrain = [];
        const allTargetIds = [];
        const allFrameIds = [];

        function cleanupSession() {
            if (checkTimer) {
                clearInterval(checkTimer);
                checkTimer = null;
            }
            if (overlay) {
                overlay.style.opacity = '0';
                setTimeout(() => {
                    overlay.style.display = 'none';
                    overlay.innerHTML = '';
                }, 300);
            }
            activeCalibrationSession = null;
        }

        function cancel() {
            if (isCancelled) return;
            isCancelled = true;
            cleanupSession();
            logToUI('Calibration cancelled by user.', false, 'warn');
            resolve(null);
        }

        function setupTarget(index) {
            if (isCancelled) return;
            const target = TARGET_GRID[index];
            currentTargetIndex = index;
            isSettling = true;
            targetStartTime = performance.now();
            targetSamples = [];
            targetFrameIds = [];
            targetTimestamps = [];
            lastCollectedFrameId = -1;

            targetDot.style.left = `calc(${target.x}% - 24px)`;
            targetDot.style.top = `calc(${target.y}% - 24px)`;
            targetDot.className = 'calibration-dot active-target settling';

            const targetLabel = document.getElementById('calib-target-label');
            if (targetLabel) targetLabel.textContent = `Target ${index + 1} of ${TARGET_GRID.length} (${target.label})`;

            const stageBadge = document.getElementById('calib-stage-badge');
            if (stageBadge) {
                stageBadge.textContent = 'Focusing...';
                stageBadge.style.color = '#00d2d3';
            }

            const dotProgress = document.getElementById('dot-progress');
            if (dotProgress) dotProgress.textContent = 'Focus';
        }

        function retryCurrentTarget() {
            logToUI(`Retrying target ${currentTargetIndex + 1}...`, false, 'info');
            setupTarget(currentTargetIndex);
        }

        // Control button listeners
        const cancelBtn = topBar.querySelector('#calib-cancel-btn');
        if (cancelBtn) cancelBtn.addEventListener('click', cancel);

        const retryBtn = topBar.querySelector('#calib-retry-target-btn');
        if (retryBtn) retryBtn.addEventListener('click', retryCurrentTarget);

        activeCalibrationSession = { cancel, retry: retryCurrentTarget };

        // Start with first target
        setupTarget(0);

        // Sampling loop (running at ~60 Hz)
        checkTimer = setInterval(() => {
            if (isCancelled) return;

            const now = performance.now();
            const elapsed = now - targetStartTime;

            // 1. Settling Phase
            if (isSettling) {
                if (elapsed >= config.settlingTimeMs) {
                    isSettling = false;
                    targetDot.className = 'calibration-dot active-target collecting';
                    const stageBadge = document.getElementById('calib-stage-badge');
                    if (stageBadge) {
                        stageBadge.textContent = 'Collecting...';
                        stageBadge.style.color = '#34c759';
                    }
                } else {
                    return; // do not sample during settling
                }
            }

            // 2. Timeout check
            if (elapsed > config.targetTimeoutMs) {
                const stageBadge = document.getElementById('calib-stage-badge');
                if (stageBadge) {
                    stageBadge.textContent = 'Timed Out';
                    stageBadge.style.color = '#ff3b30';
                }
                logToUI(`Target ${currentTargetIndex + 1} timed out before collecting ${config.minSamplesPerTarget} samples. Click Retry Target.`, false, 'warn');
                return;
            }

            // 3. Sample evaluation
            const sample = getCurrentSample();
            if (!sample) return;

            // Deduplication: strictly skip identical frame ID
            if (sample.frameId === lastCollectedFrameId) return;
            lastCollectedFrameId = sample.frameId;

            // Quality checks: freshness, face presence, blink exclusion
            if (!sample.valid || !isSampleFresh(sample, 250)) {
                targetDot.style.borderColor = '#ff9f1a';
                return;
            }

            targetDot.style.borderColor = '#34c759';
            targetSamples.push([...sample.features]);
            targetFrameIds.push(sample.frameId);
            targetTimestamps.push(sample.sourceTime);

            const dotProgress = document.getElementById('dot-progress');
            if (dotProgress) {
                dotProgress.textContent = `${targetSamples.length}/${config.minSamplesPerTarget}`;
            }

            // Target completion check
            if (targetSamples.length >= config.minSamplesPerTarget && elapsed >= config.minTargetDurationMs) {
                // Compute actual target normalized screen coordinates
                const rect = targetDot.getBoundingClientRect();
                const targetNormX = (rect.left + rect.width / 2) / window.innerWidth;
                const targetNormY = (rect.top + rect.height / 2) / window.innerHeight;

                for (let i = 0; i < targetSamples.length; i++) {
                    allXTrain.push(targetSamples[i]);
                    allYTrain.push([targetNormX, targetNormY]);
                    allTargetIds.push(currentTargetIndex);
                    allFrameIds.push(targetFrameIds[i]);
                }

                if (currentTargetIndex + 1 < TARGET_GRID.length) {
                    setupTarget(currentTargetIndex + 1);
                } else {
                    // All 9 targets complete!
                    clearInterval(checkTimer);
                    checkTimer = null;

                    // Diagnose two-axis variance before training
                    const spread = computeFeatureSpread(allXTrain);
                    if (!spread.hasSufficientSignal) {
                        logToUI(`Calibration Diagnostic Warning: Pupil variance too low (varX: ${spread.varX.toFixed(6)}, varY: ${spread.varY.toFixed(6)}). Gaze vertical range may be compressed.`, true, 'warn');
                    }

                    saveCalibrationData(allXTrain, allYTrain, {
                        targetIds: allTargetIds,
                        frameIds: allFrameIds,
                        spread
                    });

                    completeCalibration().then(() => {
                        cleanupSession();
                        resolve([allXTrain, allYTrain, { targetIds: allTargetIds, frameIds: allFrameIds, spread }]);
                    });
                }
            }
        }, 16);
    });
}

export function showCalibration() {
    if (overlay && overlay.style.display === 'none') {
        overlay.style.display = 'flex';
        overlay.style.opacity = '1';
    }
}

function completeCalibration() {
    return new Promise((resolve) => {
        logToUI('Sequential fixation complete across all 9 targets. Ready for training.', false, 'success');
        setTimeout(resolve, 400);
    });
}
