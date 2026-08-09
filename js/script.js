import { initWebcam, initDetector, initGazeDataExtract } from './gaze-tracker.js';
import { startCalibration, showCalibration } from './calibration.js';

// Elements
const logsContainer = document.getElementById('ai-logs');

// Helper to log messages to UI instead of the browser console
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
    // Auto-scroll to bottom
    logsContainer.scrollTop = logsContainer.scrollHeight;
}

// Set up gaze-tracking for ML Engine
async function setupTracking() {
    logToUI('Initializing Eye Tracking...', true);

    // initialize video feed
    const videoElement = await initWebcam();
    logToUI('Webcam feed is running.');
    logToUI('Initializing detector...')

    // initialize detector that will be the the main pipeline
    const detector = await initDetector();
    logToUI('Detector loaded.');
    logToUI('Starting to track pupil locations...');

    // initialize MediaPipe gaze tracking with the video feed and detector
    initGazeDataExtract(videoElement, detector, showCalibration);
    startCalibration();
}

// Start
document.addEventListener('DOMContentLoaded', async () => {
    await setupTracking();
});
