// calibration.js - quality-gated calibration data collection

import { logToUI } from "./logger.js";
import { currentGaze, getCurrentTrackingQuality } from "./gaze-tracker.js";

const CALIBRATION_STORAGE_KEY = 'IWAT_calibration_v4';
const LEGACY_STORAGE_KEYS = ['calibration_x_train_v3', 'calibration_y_train_v3', 'calibration_x_train', 'calibration_y_train'];

// 9-point grid
const xPositions = [10, 50, 90];
const yPositions = [10, 50, 90];
const SAMPLES_PER_DOT = 5;

let overlay = null;
let completedDots = 0;
const totalDots = 9;

/** jsdoc
 * validate calibration data schema and numeric integrity
 * @param {any} data
 * @returns {{ valid: boolean, reason?: string, data?: { x_train: number[][], y_train: number[][] } }}
 */
export function validateCalibrationData(data) {
    if (!data || typeof data !== 'object') {
        return { valid: false, reason: 'Calibration data is not an object' };
    }

    if (data.version !== 4) {
        return { valid: false, reason: `Unsupported schema version: ${data.version}` };
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
        data: { x_train, y_train }
    };
}

/** jsdoc
 * check and safely retrieve existing calibration data with corruption recovery
 * @returns {[number[][], number[][]] | null}
 */
export function checkExistingCalibration() {
    try {
        const raw = localStorage.getItem(CALIBRATION_STORAGE_KEY);
        if (!raw) {
            // check if legacy data exists and clean it up
            cleanLegacyStorage();
            return null;
        }

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (jsonErr) {
            logToUI('Corrupted JSON found in calibration storage. Purging bad data...', true, 'warn');
            localStorage.removeItem(CALIBRATION_STORAGE_KEY);
            return null;
        }

        const validation = validateCalibrationData(parsed);
        if (!validation.valid) {
            logToUI(`Invalid calibration data in storage (${validation.reason}). Purging...`, true, 'warn');
            localStorage.removeItem(CALIBRATION_STORAGE_KEY);
            return null;
        }

        return [validation.data.x_train, validation.data.y_train];
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
        return models['localstorage://IWAT-gaze-model-v4'] != null;
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
            tf.io.removeModel('localstorage://IWAT-gaze-model-v3').catch(() => { });
        } catch (e) { }
    }
}

/**
 * save validated calibration data to storage
 */
export function saveCalibrationData(x_train, y_train) {
    const payload = {
        version: 4,
        timestamp: Date.now(),
        screen: {
            width: typeof window !== 'undefined' ? window.innerWidth : 1920,
            height: typeof window !== 'undefined' ? window.innerHeight : 1080
        },
        metadata: {
            sampleCount: x_train.length,
            dotCount: totalDots
        },
        x_train,
        y_train
    };

    try {
        localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(payload));
        logToUI(`Calibration saved (${x_train.length} quality-gated samples).`, false, 'success');
    } catch (err) {
        logToUI(`Storage Error: Could not save calibration data (${err.message})`, true, 'error');
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
            await tf.io.removeModel('localstorage://IWAT-gaze-model-v4');
        } catch (e) { }
    }
    logToUI('Calibration data and model cleared.', true, 'info');
}

/**
 * interactive calibration session with quality-gated fixation capture
 */
export async function startCalibration() {
    return new Promise((resolve) => {
        overlay = document.getElementById('calibration-overlay');
        if (!overlay) {
            logToUI('Error: Calibration overlay element not found.', true, 'error');
            resolve(null);
            return;
        }

        // clean existing dots
        const existingDots = overlay.querySelectorAll('.calibration-dot');
        existingDots.forEach(d => d.remove());

        const x_train = [];
        const y_train = [];
        completedDots = 0;

        overlay.style.display = 'flex';
        overlay.style.opacity = '1';
        logToUI('Starting calibration session. Click each dot 5 times while looking at it.', true, 'info');

        // create dots
        for (const y of yPositions) {
            for (const x of xPositions) {
                const dot = document.createElement('div');
                dot.className = 'calibration-dot';
                dot.style.left = `calc(${x}% - 20px)`;
                dot.style.top = `calc(${y}% - 20px)`;
                dot.textContent = '0';

                let validClicksOnThisDot = 0;

                dot.addEventListener('click', function onDotClick() {
                    if (this.classList.contains('completed')) return;

                    // quality gate check: only accept sample if gaze feature is fresh, valid, and user not blinking
                    const quality = getCurrentTrackingQuality();
                    if (!quality.hasFace) {
                        logToUI('Sample rejected: No face detected. Look directly at camera.', false, 'warn', 1000);
                        this.style.borderColor = '#ff3838';
                        setTimeout(() => { this.style.borderColor = ''; }, 300);
                        return;
                    }

                    if (quality.isBlinking) {
                        logToUI('Sample rejected: Blink detected. Keep eyes open while clicking.', false, 'warn', 1000);
                        this.style.borderColor = '#ff9f1a';
                        setTimeout(() => { this.style.borderColor = ''; }, 300);
                        return;
                    }

                    if (!currentGaze || currentGaze.some(v => !Number.isFinite(v))) {
                        logToUI('Sample rejected: Invalid gaze coordinates.', false, 'warn', 1000);
                        return;
                    }

                    // record quality-gated sample
                    x_train.push([...currentGaze]);
                    y_train.push([x / 100, y / 100]); // screen ratio (0 - 1)
                    validClicksOnThisDot++;

                    this.textContent = validClicksOnThisDot;
                    this.style.opacity = 1 - (validClicksOnThisDot * 0.15);

                    if (validClicksOnThisDot >= SAMPLES_PER_DOT) {
                        this.classList.add('completed');
                        this.style.opacity = '1';
                        this.textContent = '✓';
                        completedDots++;

                        if (completedDots === totalDots) {
                            saveCalibrationData(x_train, y_train);
                            completeCalibration().then(() => {
                                resolve([x_train, y_train]);
                            });
                        }
                    }
                });

                overlay.appendChild(dot);
            }
        }
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
        setTimeout(() => {
            if (overlay) {
                overlay.style.opacity = '0';
                setTimeout(() => {
                    overlay.style.display = 'none';
                    logToUI('Calibration dots complete. Ready for training.', false, 'success');
                    resolve();
                }, 400);
            } else {
                resolve();
            }
        }, 300);
    });
}
