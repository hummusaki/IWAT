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

    // x features: dim 0 (rx) and dim 2 (lx)
    // y features: dim 1 (ry) and dim 3 (ly)
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

        // check if old v4 schema needs fresh calibration
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

        // top control bar (reachable above overlay)
        const topBar = document.createElement('div');
        topBar.className = 'calibration-top-bar';
        topBar.innerHTML = `
            <div class="calibration-status-header">
                <span id="calib-target-label">Calibration Setup</span>
                <span id="calib-stage-badge" class="calib-badge">Ready</span>
            </div>
            <div class="calibration-actions">
                <button id="calib-retry-target-btn" class="calib-ctrl-btn" style="display: none;">Retry Target</button>
                <button id="calib-cancel-btn" class="calib-ctrl-btn secondary">Cancel</button>
            </div>
        `;
        overlay.appendChild(topBar);

        // center instructions / confirmation prompt card
        const instructions = document.createElement('div');
        instructions.className = 'calibration-instructions';
        instructions.id = 'calib-instructions-card';
        instructions.style.pointerEvents = 'auto';
        instructions.innerHTML = `
            <h2>Eye Tracking Calibration</h2>
            <p style="margin-bottom: 12px;">You will calibrate 9 fixation points across your screen.</p>
            <p style="margin-bottom: 16px; color: #9cdcfe; line-height: 1.5;">Keep your head steady. For each point, look directly at the dot and <strong>click it</strong> (or press <strong>Space</strong>) when your eyes are focused on it. Hold your gaze steady for 1 second while samples are recorded.</p>
            <div style="display: flex; justify-content: center; gap: 12px; margin-top: 18px;">
                <button id="calib-begin-btn" class="calib-ctrl-btn" style="padding: 10px 24px; font-size: 14px; background: #34c759; color: #000; font-weight: bold; cursor: pointer;">Start Calibration</button>
                <button id="calib-cancel-initial-btn" class="calib-ctrl-btn secondary" style="padding: 10px 18px; font-size: 14px; cursor: pointer;">Cancel</button>
            </div>
        `;
        overlay.appendChild(instructions);

        // fixation target dot (initially hidden until user clicks Start Calibration)
        const targetDot = document.createElement('div');
        targetDot.className = 'calibration-dot active-target waiting-click';
        targetDot.style.display = 'none';
        targetDot.innerHTML = '<span id="dot-progress" style="font-size: 10px; font-weight: bold;">CLICK</span>';
        overlay.appendChild(targetDot);

        let currentTargetIndex = 0;
        let isCancelled = false;
        let isWaitingForTrigger = true;
        let isSettling = false;
        let isCollecting = false;
        let targetStartTime = 0;
        let targetSamples = [];
        let targetFrameIds = [];
        let targetTimestamps = [];
        let lastCollectedFrameId = -1;
        let checkTimer = null;

        const allXTrain = [];
        const allYTrain = [];
        const allTargetIds = [];
        const allFrameIds = [];

        function onKeydown(e) {
            if (e.code === 'Space' || e.code === 'Enter') {
                e.preventDefault();
                triggerTargetCollection();
            } else if (e.code === 'Escape') {
                cancel();
            }
        }
        window.addEventListener('keydown', onKeydown);

        function cleanupSession() {
            window.removeEventListener('keydown', onKeydown);
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
            isWaitingForTrigger = true;
            isSettling = false;
            isCollecting = false;
            targetSamples = [];
            targetFrameIds = [];
            targetTimestamps = [];
            lastCollectedFrameId = -1;

            targetDot.style.display = 'flex';
            targetDot.style.left = `calc(${target.x}% - 24px)`;
            targetDot.style.top = `calc(${target.y}% - 24px)`;
            targetDot.className = 'calibration-dot active-target waiting-click';
            targetDot.innerHTML = '<span id="dot-progress" style="font-size: 10px; font-weight: bold;">CLICK</span>';
            targetDot.style.borderColor = '#fff';

            const targetLabel = document.getElementById('calib-target-label');
            if (targetLabel) targetLabel.textContent = `Target ${index + 1} of ${TARGET_GRID.length} (${target.label})`;

            const stageBadge = document.getElementById('calib-stage-badge');
            if (stageBadge) {
                stageBadge.className = 'calib-badge';
                stageBadge.textContent = 'Click Dot or Space';
                stageBadge.style.backgroundColor = '#feca57';
                stageBadge.style.color = '#000';
            }

            const retryBtn = topBar.querySelector('#calib-retry-target-btn');
            if (retryBtn) retryBtn.style.display = 'inline-block';
        }

        function triggerTargetCollection() {
            if (isCancelled || !isWaitingForTrigger) return;
            isWaitingForTrigger = false;
            isSettling = true;
            targetStartTime = performance.now();
            targetSamples = [];
            targetFrameIds = [];
            targetTimestamps = [];
            lastCollectedFrameId = -1;

            targetDot.className = 'calibration-dot active-target settling';
            const dotProgress = document.getElementById('dot-progress');
            if (dotProgress) dotProgress.textContent = 'Hold';

            const stageBadge = document.getElementById('calib-stage-badge');
            if (stageBadge) {
                stageBadge.className = 'calib-badge';
                stageBadge.textContent = 'Settling...';
                stageBadge.style.backgroundColor = '#00d2d3';
                stageBadge.style.color = '#000';
            }
        }

        targetDot.addEventListener('click', (e) => {
            e.stopPropagation();
            triggerTargetCollection();
        });

        function retryCurrentTarget() {
            logToUI(`Retrying target ${currentTargetIndex + 1}...`, false, 'info');
            setupTarget(currentTargetIndex);
        }

        // control button listeners
        const cancelBtn = topBar.querySelector('#calib-cancel-btn');
        if (cancelBtn) cancelBtn.addEventListener('click', cancel);

        const retryBtn = topBar.querySelector('#calib-retry-target-btn');
        if (retryBtn) retryBtn.addEventListener('click', retryCurrentTarget);

        const beginBtn = instructions.querySelector('#calib-begin-btn');
        if (beginBtn) {
            beginBtn.addEventListener('click', () => {
                instructions.style.display = 'none';
                setupTarget(0);
            });
        }

        const cancelInitialBtn = instructions.querySelector('#calib-cancel-initial-btn');
        if (cancelInitialBtn) cancelInitialBtn.addEventListener('click', cancel);

        activeCalibrationSession = { cancel, retry: retryCurrentTarget };

        // sampling loop (running at ~60 Hz)
        checkTimer = setInterval(() => {
            if (isCancelled || isWaitingForTrigger) return;

            const now = performance.now();
            const elapsed = now - targetStartTime;

            // 1. Settling Phase (300ms after user clicks/triggers dot)
            if (isSettling) {
                if (elapsed >= 300) {
                    isSettling = false;
                    isCollecting = true;
                    targetDot.className = 'calibration-dot active-target collecting';
                    const stageBadge = document.getElementById('calib-stage-badge');
                    if (stageBadge) {
                        stageBadge.className = 'calib-badge collecting';
                        stageBadge.textContent = 'Recording...';
                        stageBadge.style.backgroundColor = '#34c759';
                        stageBadge.style.color = '#000';
                    }
                } else {
                    return; // do not sample during settling
                }
            }

            // 2. Timeout check (10s while collecting)
            if (elapsed > config.targetTimeoutMs) {
                const stageBadge = document.getElementById('calib-stage-badge');
                if (stageBadge) {
                    stageBadge.textContent = 'Timed Out';
                    stageBadge.style.backgroundColor = '#ff3b30';
                    stageBadge.style.color = '#fff';
                }
                logToUI(`Target ${currentTargetIndex + 1} timed out before collecting ${config.minSamplesPerTarget} samples. Click Retry Target.`, false, 'warn');
                return;
            }

            // 3. Sample evaluation
            const sample = getCurrentSample();
            if (!sample) return;

            // deduplication: strictly skip identical frame ID
            if (sample.frameId === lastCollectedFrameId) return;
            lastCollectedFrameId = sample.frameId;

            // quality checks: freshness, face presence, blink exclusion
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

            // target completion check
            if (targetSamples.length >= config.minSamplesPerTarget && elapsed >= config.minTargetDurationMs) {
                isCollecting = false;
                targetDot.className = 'calibration-dot active-target completed';
                targetDot.innerHTML = '<span style="font-size: 16px;">✓</span>';

                const stageBadge = document.getElementById('calib-stage-badge');
                if (stageBadge) {
                    stageBadge.className = 'calib-badge complete';
                    stageBadge.textContent = 'Recorded';
                    stageBadge.style.backgroundColor = '#2ed573';
                    stageBadge.style.color = '#000';
                }

                // compute actual target normalized screen coordinates
                const rect = targetDot.getBoundingClientRect();
                const targetNormX = (rect.left + rect.width / 2) / window.innerWidth;
                const targetNormY = (rect.top + rect.height / 2) / window.innerHeight;

                for (let i = 0; i < targetSamples.length; i++) {
                    allXTrain.push(targetSamples[i]);
                    allYTrain.push([targetNormX, targetNormY]);
                    allTargetIds.push(currentTargetIndex);
                    allFrameIds.push(targetFrameIds[i]);
                }

                isWaitingForTrigger = true; // prevent re-entry

                setTimeout(() => {
                    if (isCancelled) return;
                    if (currentTargetIndex + 1 < TARGET_GRID.length) {
                        setupTarget(currentTargetIndex + 1);
                    } else {
                        // all 9 targets complete!
                        clearInterval(checkTimer);
                        checkTimer = null;

                        // diagnose two-axis variance before training
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
                }, 600);
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
