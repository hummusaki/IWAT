import { initWebcam, initDetector, initGazeDataExtract } from './gaze-tracker.js';
import { startCalibration, showCalibration, checkExistingCalibration, checkExistingModel } from './calibration.js';
import { train } from './regression_model.js';

// global element
const logsContainer = document.getElementById('ai-logs');

// helper to log messages to UI instead of the browser console
export function logToUI(message, isAction = false) {
    const time = new Date().toLocaleTimeString();
    const div = document.createElement('div');

    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = `[${time}]`;

    const msgSpan = document.createElement('span');
    if (isAction) {
        msgSpan.className = 'log-action';
        msgSpan.textContent = `ACTION: ${message}`;
    } else {
        msgSpan.textContent = message;
    }

    div.appendChild(timeSpan);
    div.appendChild(msgSpan);

    logsContainer.appendChild(div);
    // auto-scroll to bottom
    logsContainer.scrollTop = logsContainer.scrollHeight;
}

// set up gaze-tracking for ML Engine
async function setupTracking() {
    logToUI('Initializing Eye Tracking...', true);

    // initialize video feed
    const videoElement = await initWebcam();
    logToUI('Webcam feed is running.');

    logToUI('Initializing detector...', true)

    // initialize detector that will be the the main pipeline
    const detector = await initDetector();
    logToUI('Detector loaded.');
    logToUI('Starting to track pupil locations...', true);

    // check if we have saved calibration data & model
    const existingData = checkExistingCalibration();
    const existingModel = await checkExistingModel();

    // if existing calibration data and model exists, start inference loop
    if (existingData && existingModel) {
        try {
            const model = await tf.loadLayersModel('localstorage://IWAT-gaze-model');
            logToUI('Found existing calibration data and model in local storage.');
            // inferenceLoop(model);
            return; // Exit successfully if inference starts
        } catch (error) {
            logToUI('Error: Could not load existing data. Falling back to retraining...', true);
            console.error(error);
        }
    }
    if (existingData) {
        // if data exists, start tracking and run training immediately on first face detection
        initGazeDataExtract(videoElement, detector, () => {
            logToUI('Found existing calibration data in local storage.');
            const [x_train, y_train] = existingData;
            train(x_train, y_train);
        });
    } else {
        // if no data exists, set up tracking to show calibration UI
        initGazeDataExtract(videoElement, detector, showCalibration);
        const data = await startCalibration();
        if (data) {
            const [x_train, y_train] = data;
            train(x_train, y_train);
        }
    }

}

// Start
document.addEventListener('DOMContentLoaded', async () => {
    await setupTracking();
});
