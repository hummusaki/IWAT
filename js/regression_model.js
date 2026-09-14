// regression_model.js - regression model with tensor lifecycle, validation evaluation, and corruption recovery

import { logToUI } from "./logger.js";

export let gazeModel = null;
const MODEL_STORAGE_KEY = 'localstorage://IWAT-gaze-model-v4';

export function setGazeModel(model) {
    if (gazeModel && gazeModel !== model) {
        try {
            gazeModel.dispose();
        } catch (e) {
            console.warn('Error disposing previous model:', e);
        }
    }
    gazeModel = model;
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
}

/** jsdoc
 * load saved model with corruption recovery
 * @returns {Promise<tf.LayersModel|null>}
 */
export async function loadStoredGazeModel() {
    if (typeof tf === 'undefined') return null;

    try {
        const model = await tf.loadLayersModel(MODEL_STORAGE_KEY);
        setGazeModel(model);
        logToUI('Loaded existing gaze regression model from storage.', false, 'success');
        return model;
    } catch (err) {
        logToUI(`Model Load Failure: ${err.message}. Cleaning corrupted model entry...`, true, 'warn');
        try {
            await tf.io.removeModel(MODEL_STORAGE_KEY);
        } catch (e) { }
        setGazeModel(null);
        return null;
    }
}

/** jsdoc
 * predict normalized screen coordinates with guaranteed tensor disposal via tf.tidy()
 * @param {number[]} features - 4D iris coordinates [rx, ry, lx, ly]
 * @returns {[number, number]|null} normalized [screenX, screenY] or null if invalid
 */
export function predictGaze(features) {
    if (!gazeModel || !features || features.length !== 4) return null;

    for (let i = 0; i < 4; i++) {
        if (!Number.isFinite(features[i])) return null;
    }

    try {
        // clean up tensors after return
        return tf.tidy(() => {
            const inputTensor = tf.tensor2d([features]);
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
 * train gaze regression model with validation split, tensor cleanup, and failure recovery
 * @param {number[][]} x_train - 4D features
 * @param {number[][]} y_train - 2D normalized screen targets
 * @returns {Promise<boolean>} true if training succeeded
 */
export async function train(x_train, y_train) {
    if (typeof tf === 'undefined') {
        logToUI('TensorFlow.js is not loaded. Cannot train model.', true, 'error');
        return false;
    }

    if (!x_train || !y_train || x_train.length < 10 || x_train.length !== y_train.length) {
        logToUI(`Training Error: Insufficient or mismatched training data (${x_train?.length} samples).`, true, 'error');
        return false;
    }

    // input variance check to avoid training on degenerate data
    let hasVariance = false;
    const firstSample = x_train[0];
    for (let i = 1; i < x_train.length; i++) {
        for (let j = 0; j < 4; j++) {
            if (Math.abs(x_train[i][j] - firstSample[j]) > 1e-4) {
                hasVariance = true;
                break;
            }
        }
        if (hasVariance) break;
    }

    if (!hasVariance) {
        logToUI('Training Error: Training data has zero variance (pupil landmarks did not move). Recalibration needed.', true, 'error');
        return false;
    }

    logToUI(`Training gaze regression model on ${x_train.length} samples (with 20% validation split)...`, true, 'info');

    // create fresh model
    const model = tf.sequential();
    model.add(tf.layers.dense({
        inputShape: [4],
        units: 2,
        activation: 'linear',
        kernelRegularizer: tf.regularizers.l2({ l2: 0.01 })
    }));

    model.compile({
        optimizer: tf.train.adam(0.02),
        loss: 'meanSquaredError',
        metrics: ['mse']
    });

    let xTensor = null;
    let yTensor = null;

    const progressContainer = document.getElementById('training-progress-container');
    const progressBar = document.getElementById('training-progress-bar');
    const progressText = document.getElementById('training-progress-text');

    if (progressContainer) progressContainer.style.display = 'block';

    const epochs = 250; // optimized epoch count with fast convergence
    let lastValLoss = null;

    try {
        xTensor = tf.tensor2d(x_train);
        yTensor = tf.tensor2d(y_train);

        await model.fit(xTensor, yTensor, {
            epochs: epochs,
            batchSize: 16,
            validationSplit: 0.2,
            shuffle: true,
            callbacks: {
                onEpochEnd: (epoch, logs) => {
                    if (logs && logs.val_loss != null) {
                        lastValLoss = logs.val_loss;
                    }
                    if (progressBar && progressText && (epoch % 10 === 0 || epoch === epochs - 1)) {
                        const percent = Math.round(((epoch + 1) / epochs) * 100);
                        progressBar.style.width = `${percent}%`;
                        progressText.textContent = `${percent}% (val_mse: ${lastValLoss ? lastValLoss.toFixed(4) : '...'})`;
                    }
                }
            }
        });

        // set as active model (disposes any old model)
        setGazeModel(model);

        // save model
        await model.save(MODEL_STORAGE_KEY);
        logToUI(`Model trained successfully. Validation MSE: ${lastValLoss ? lastValLoss.toFixed(4) : 'N/A'}. Model saved.`, false, 'success');
        return true;
    } catch (trainErr) {
        logToUI(`Training Failure: ${trainErr.message}`, true, 'error');
        // clean up failed model
        model.dispose();
        return false;
    } finally {
        // guaranteed disposal of training tensors
        if (xTensor) xTensor.dispose();
        if (yTensor) yTensor.dispose();
        if (progressContainer) progressContainer.style.display = 'none';
    }
}