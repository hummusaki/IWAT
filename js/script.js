import { initEngine } from './gaze-tracker.js';

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
        msgSpan.textContent = `⚡ ACTION: ${message}`;
    } else {
        msgSpan.textContent = message;
    }

    div.appendChild(timeSpan);
    div.appendChild(msgSpan);

    logsContainer.appendChild(div);
    // Auto-scroll to bottom
    logsContainer.scrollTop = logsContainer.scrollHeight;
}

import { initWebcam } from './gaze-tracker.js';

// Set up the gaze-tracking ML Engine
async function setupEngine() {
    logToUI('Initializing Eye Tracker...');

    // initialize video feed
    const videoElement = await initWebcam();
    logToUI('Webcam feed is running.');
    logToUI('Initializing ML model...')

    // initialize detector that will be the the main pipeline
    const detector = await initDetector();
    logToUI('Model loaded.');
    logToUI('Starting to track...');

    // initialize the ML engine with the video feed and detector
    initEngine(videoElement, detector);
}

// Start
document.addEventListener('DOMContentLoaded', async () => {
    await setupEngine();
});
