// regression_model.js - standardized regression model with tensor lifecycle, validation evaluation, and corruption recovery

import { logToUI } from "./logger.js";

export let gazeModel = null;
export let activeModelMetadata = null;

export const MODEL_STORAGE_KEY = 'localstorage://IWAT-gaze-model-v5';
export const MODEL_META_STORAGE_KEY = 'IWAT-gaze-model-v5-meta';
export const LEGACY_MODEL_STORAGE_KEYS = ['localstorage://IWAT-gaze-model-v4', 'localstorage://IWAT-gaze-model-v3'];

export function setGazeModel(model, metadata = {}) {
    if (gazeModel && gazeModel !== model) {
        try {
            gazeModel.dispose();
        } catch (e) {
            console.warn('Error disposing previous model:', e);
        }
    }
    gazeModel = model;
    activeModelMetadata = metadata || {};
}

export function getActiveModelMetadata() {
    return activeModelMetadata;
}

export function disposeGazeModel() {
    if (gazeModel) {
        try {
            gazeModel.dispose();
        } catch (e) {
            console.warn('Error disposing gaze model:', e);
        }
        gazeModel = null;
    }
    activeModelMetadata = null;
}

/** jsdoc
 * load saved v5 model with shape and weight validation
 * @returns {Promise<tf.LayersModel|null>}
 */
export async function loadStoredGazeModel() {
    if (typeof tf === 'undefined') return null;

    try {
        const rawMeta = localStorage.getItem(MODEL_META_STORAGE_KEY);
        let meta = null;
        if (rawMeta) {
            try { meta = JSON.parse(rawMeta); } catch (e) { }
        }

        const model = await tf.loadLayersModel(MODEL_STORAGE_KEY);

        // Validate model architecture
        if (!model.inputs || model.inputs.length !== 1 || model.inputs[0].shape[1] !== 4) {
            throw new Error('Stored model has invalid input shape');
        }
        if (!model.outputs || model.outputs.length !== 1 || model.outputs[0].shape[1] !== 2) {
            throw new Error('Stored model has invalid output shape');
        }

        // Validate weights finiteness
        const weights = model.getWeights();
        for (const w of weights) {
            const vals = w.dataSync();
            for (let i = 0; i < vals.length; i++) {
                if (!Number.isFinite(vals[i])) {
                    throw new Error('Stored model weights contain non-finite values');
                }
            }
        }

        setGazeModel(model, meta);
        logToUI('Loaded validated gaze regression model from storage.', false, 'success');
        return model;
    } catch (err) {
        logToUI(`Model Load Failure: ${err.message}. Cleaning corrupted model entry...`, true, 'warn');
        try {
            await tf.io.removeModel(MODEL_STORAGE_KEY);
        } catch (e) { }
        localStorage.removeItem(MODEL_META_STORAGE_KEY);
        setGazeModel(null);
        return null;
    }
}

/** jsdoc
 * predict normalized screen coordinates with input standardization and guaranteed tensor disposal
 * @param {number[]} features - 4D iris coordinates [rx, ry, lx, ly]
 * @returns {[number, number]|null} normalized [screenX, screenY] or null if invalid
 */
export function predictGaze(features) {
    if (!gazeModel || !features || features.length !== 4) return null;

    for (let i = 0; i < 4; i++) {
        if (!Number.isFinite(features[i])) return null;
    }

    // Apply feature standardization if model preprocessing metadata is present
    let normalizedFeatures = features;
    const prep = activeModelMetadata?.preprocessing;
    if (prep && Array.isArray(prep.means) && Array.isArray(prep.stds)) {
        normalizedFeatures = [
            (features[0] - prep.means[0]) / prep.stds[0],
            (features[1] - prep.means[1]) / prep.stds[1],
            (features[2] - prep.means[2]) / prep.stds[2],
            (features[3] - prep.means[3]) / prep.stds[3]
        ];
    }

    try {
        return tf.tidy(() => {
            const inputTensor = tf.tensor2d([normalizedFeatures]);
            const prediction = gazeModel.predict(inputTensor);
            const data = prediction.dataSync();

            const x = data[0];
            const y = data[1];

            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                return null;
            }

            // clamp prediction within screen boundaries + small margin
            const clampedX = Math.max(0, Math.min(1, x));
            const clampedY = Math.max(0, Math.min(1, y));

            return [clampedX, clampedY];
        });
    } catch (err) {
        console.error('Error in predictGaze:', err);
        return null;
    }
}

/** jsdoc
 * train gaze regression model with standardization, grouped validation, and coarse-gaze validation gate
 * @param {number[][]} x_train - 4D features
 * @param {number[][]} y_train - 2D normalized screen targets
 * @param {Object} [options]
 * @returns {Promise<{ success: boolean, reason?: string, validation?: Object, model?: tf.LayersModel }>}
 */
export async function train(x_train, y_train, options = {}) {
    if (typeof tf === 'undefined') {
        logToUI('TensorFlow.js is not loaded. Cannot train model.', true, 'error');
        return { success: false, reason: 'tfjs_not_loaded' };
    }

    if (!x_train || !y_train || x_train.length < 18 || x_train.length !== y_train.length) {
        logToUI(`Training Error: Insufficient or mismatched training data (${x_train?.length} samples).`, true, 'error');
        return { success: false, reason: 'insufficient_samples' };
    }

    // 1. Compute training-only means, scales, and per-axis variances
    const n = x_train.length;
    const means = [0, 0, 0, 0];
    const stds = [0, 0, 0, 0];

    for (let j = 0; j < 4; j++) {
        let sum = 0;
        for (let i = 0; i < n; i++) {
            sum += x_train[i][j];
        }
        means[j] = sum / n;

        let sumSq = 0;
        for (let i = 0; i < n; i++) {
            sumSq += Math.pow(x_train[i][j] - means[j], 2);
        }
        const variance = sumSq / n;
        stds[j] = Math.max(Math.sqrt(variance), 1e-4); // variance floor
    }

    const varX = Math.max(Math.pow(stds[0], 2), Math.pow(stds[2], 2));
    const varY = Math.max(Math.pow(stds[1], 2), Math.pow(stds[3], 2));

    if (varX < 1e-4 || varY < 1e-4) {
        logToUI(`Training Error: Insufficient pupil motion signal (varX: ${varX.toFixed(6)}, varY: ${varY.toFixed(6)}). Calibration must capture both horizontal and vertical eye movements.`, true, 'error');
        return { success: false, reason: 'insufficient_axis_variance' };
    }

    // 2. Standardize features
    const x_std = x_train.map(row => [
        (row[0] - means[0]) / stds[0],
        (row[1] - means[1]) / stds[1],
        (row[2] - means[2]) / stds[2],
        (row[3] - means[3]) / stds[3]
    ]);

    // 3. Grouped validation partition (keeping target bursts together)
    const targetIds = options.targetIds;
    const fitIndices = [];
    const valIndices = [];

    if (targetIds && targetIds.length === n) {
        // Hold out targets 4 (Center) and 8 (Bottom-Right) for validation
        const heldOutTargets = new Set([4, 8]);
        for (let i = 0; i < n; i++) {
            if (heldOutTargets.has(targetIds[i])) {
                valIndices.push(i);
            } else {
                fitIndices.push(i);
            }
        }
    }

    // Fallback if no targetIds or insufficient held-out samples
    if (fitIndices.length === 0 || valIndices.length === 0) {
        fitIndices.length = 0;
        valIndices.length = 0;
        const valCount = Math.max(6, Math.floor(n * 0.2));
        for (let i = 0; i < n - valCount; i++) fitIndices.push(i);
        for (let i = n - valCount; i < n; i++) valIndices.push(i);
    }

    const x_fit = fitIndices.map(i => x_std[i]);
    const y_fit = fitIndices.map(i => y_train[i]);
    const x_val = valIndices.map(i => x_std[i]);
    const y_val = valIndices.map(i => y_train[i]);

    // 4. Center-predictor baseline on validation set
    let centerErrSumX = 0;
    let centerErrSumY = 0;
    for (let i = 0; i < y_val.length; i++) {
        centerErrSumX += Math.pow(0.5 - y_val[i][0], 2);
        centerErrSumY += Math.pow(0.5 - y_val[i][1], 2);
    }
    const centerMseX = centerErrSumX / y_val.length;
    const centerMseY = centerErrSumY / y_val.length;

    logToUI(`Training gaze regression on ${x_fit.length} samples (validating on ${x_val.length} held-out samples)...`, true, 'info');

    // 5. Construct fresh model with light regularization (prevent overfitting without zeroing vertical signal)
    const candidateModel = tf.sequential();
    candidateModel.add(tf.layers.dense({
        inputShape: [4],
        units: 2,
        activation: 'linear',
        kernelRegularizer: tf.regularizers.l2({ l2: 0.001 })
    }));

    const learningRate = 0.03;
    const optimizer = tf.train.adam(learningRate);

    candidateModel.compile({
        optimizer,
        loss: 'meanSquaredError',
        metrics: ['mse']
    });

    let xFitTensor = null;
    let yFitTensor = null;
    let xValTensor = null;

    const progressContainer = document.getElementById('training-progress-container');
    const progressBar = document.getElementById('training-progress-bar');
    const progressText = document.getElementById('training-progress-text');

    if (progressContainer) progressContainer.style.display = 'block';

    const epochs = 200;

    try {
        xFitTensor = tf.tensor2d(x_fit);
        yFitTensor = tf.tensor2d(y_fit);

        await candidateModel.fit(xFitTensor, yFitTensor, {
            epochs: epochs,
            batchSize: 16,
            shuffle: true,
            callbacks: {
                onEpochEnd: (epoch, logs) => {
                    if (progressBar && progressText && (epoch % 10 === 0 || epoch === epochs - 1)) {
                        const percent = Math.round(((epoch + 1) / epochs) * 100);
                        progressBar.style.width = `${percent}%`;
                        progressText.textContent = `${percent}%`;
                    }
                }
            }
        });

        // 6. Evaluate candidate model on independent held-out validation set
        xValTensor = tf.tensor2d(x_val);
        const valPredTensor = candidateModel.predict(xValTensor);
        const valPredData = valPredTensor.dataSync();
        valPredTensor.dispose();

        let modelErrSumX = 0;
        let modelErrSumY = 0;
        const pixelErrors = [];

        const viewportWidth = options.geometry?.width || (typeof window !== 'undefined' ? window.innerWidth : 1440);
        const viewportHeight = options.geometry?.height || (typeof window !== 'undefined' ? window.innerHeight : 900);
        const viewportDiagonal = Math.hypot(viewportWidth, viewportHeight);

        for (let i = 0; i < y_val.length; i++) {
            const predX = valPredData[i * 2];
            const predY = valPredData[i * 2 + 1];
            const targetX = y_val[i][0];
            const targetY = y_val[i][1];

            modelErrSumX += Math.pow(predX - targetX, 2);
            modelErrSumY += Math.pow(predY - targetY, 2);

            const pxError = Math.hypot((predX - targetX) * viewportWidth, (predY - targetY) * viewportHeight);
            pixelErrors.push(pxError);
        }

        const modelMseX = modelErrSumX / y_val.length;
        const modelMseY = modelErrSumY / y_val.length;

        pixelErrors.sort((a, b) => a - b);
        const medianPixelError = pixelErrors[Math.floor(pixelErrors.length * 0.5)];
        const p95PixelError = pixelErrors[Math.min(pixelErrors.length - 1, Math.floor(pixelErrors.length * 0.95))];
        const medianErrorFraction = medianPixelError / viewportDiagonal;
        const p95ErrorFraction = p95PixelError / viewportDiagonal;

        const xImprovement = modelMseX < centerMseX;
        const yImprovement = modelMseY < centerMseY;

        // Provisional coarse-gaze validation gate:
        // Median error <= 10% diagonal, p95 <= 20% diagonal, lower error than center on both axes
        const passesCoarseGate = (medianErrorFraction <= 0.10) &&
                                 (p95ErrorFraction <= 0.20) &&
                                 xImprovement &&
                                 yImprovement;

        const validationResult = {
            passed: passesCoarseGate,
            modelMseX,
            modelMseY,
            centerMseX,
            centerMseY,
            xImprovement,
            yImprovement,
            medianPixelError: Math.round(medianPixelError),
            p95PixelError: Math.round(p95PixelError),
            medianErrorFraction: parseFloat(medianErrorFraction.toFixed(4)),
            p95ErrorFraction: parseFloat(p95ErrorFraction.toFixed(4)),
            viewportDiagonal: Math.round(viewportDiagonal)
        };

        if (!passesCoarseGate) {
            logToUI(`Coarse-Gaze Gate Failed: Median ${(medianErrorFraction * 100).toFixed(1)}% (budget 10%), X-improved: ${xImprovement}, Y-improved: ${yImprovement}. Retaining prior valid model.`, true, 'warn');
            candidateModel.dispose();
            return { success: false, reason: 'coarse_gaze_gate_failed', validation: validationResult };
        }

        // 7. Promote validated candidate to active gaze model
        const modelMetadata = {
            id: `model_${Date.now()}`,
            timestamp: Date.now(),
            preprocessing: { means, stds },
            validation: validationResult,
            geometry: { width: viewportWidth, height: viewportHeight }
        };

        setGazeModel(candidateModel, modelMetadata);

        // Save model and metadata with commit marker
        try {
            await candidateModel.save(MODEL_STORAGE_KEY);
            localStorage.setItem(MODEL_META_STORAGE_KEY, JSON.stringify(modelMetadata));
            logToUI(`Model trained & validated successfully (Median error: ${Math.round(medianPixelError)}px, ${(medianErrorFraction * 100).toFixed(1)}% diagonal). Model saved.`, false, 'success');
        } catch (saveErr) {
            logToUI(`Model persistence warning: ${saveErr.message}. Usable in-memory model active for this session.`, false, 'warn');
        }

        return { success: true, validation: validationResult, model: candidateModel };
    } catch (trainErr) {
        logToUI(`Training Failure: ${trainErr.message}`, true, 'error');
        try { candidateModel.dispose(); } catch (e) { }
        return { success: false, reason: trainErr.message };
    } finally {
        if (xFitTensor) xFitTensor.dispose();
        if (yFitTensor) yFitTensor.dispose();
        if (xValTensor) xValTensor.dispose();
        if (progressContainer) progressContainer.style.display = 'none';
    }
}