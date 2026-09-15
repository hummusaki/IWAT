// camera.js - camera lifecycle, retry, denial handling, and no-camera operation

import { logToUI } from './logger.js';

export const CameraState = {
    IDLE: 'IDLE',
    REQUESTING: 'REQUESTING',
    STREAMING: 'STREAMING',
    STOPPED: 'STOPPED',
    DENIED: 'DENIED',
    ERROR: 'ERROR',
    NO_CAMERA: 'NO_CAMERA'
};

let currentStream = null;
let currentState = CameraState.IDLE;
let lastError = null;
let currentAspectRatio = 4 / 3;
let currentCameraSessionId = 0;
const stateListeners = new Set();

export function getCameraState() {
    return currentState;
}

export function getCameraAspectRatio() {
    return currentAspectRatio;
}

export function subscribeCameraState(listener) {
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
}

function setState(newState, error = null) {
    currentState = newState;
    lastError = error;
    for (const listener of stateListeners) {
        try {
            listener(newState, error);
        } catch (e) {
            console.error('Error in camera state listener:', e);
        }
    }
}

/** jsdoc
 * starts camera with reliable lifecycle, cancellation, and error categorization
 * @param {HTMLVideoElement} videoElement
 * @param {Object} options - configure camera with facing mode, idealwidth, idealheight, metadataTimeoutMs
 * @returns {Promise<{ videoElement: HTMLVideoElement, stream: MediaStream, width: number, height: number, aspectRatio: number }>}
 */
export async function startCamera(videoElement, options = {}) {
    if (!videoElement) {
        const err = new Error('Camera video element not provided');
        setState(CameraState.ERROR, err);
        logToUI(`Camera Error: ${err.message}`, true, 'error');
        throw err;
    }

    // guard against non-secure contexts
    if (typeof window !== 'undefined' && !window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        const err = new Error('Camera requires a secure context (HTTPS or localhost).');
        setState(CameraState.ERROR, err);
        logToUI(`Camera Security Error: ${err.message}`, true, 'error');
        throw err;
    }

    if (!navigator?.mediaDevices?.getUserMedia) {
        const err = new Error('navigator.mediaDevices.getUserMedia is not supported on this browser.');
        setState(CameraState.ERROR, err);
        logToUI(`Camera Support Error: ${err.message}`, true, 'error');
        throw err;
    }

    // if already streaming the same video element, return current info
    if (currentState === CameraState.STREAMING && currentStream && videoElement.srcObject === currentStream) {
        return {
            videoElement,
            stream: currentStream,
            width: videoElement.videoWidth || 640,
            height: videoElement.videoHeight || 480,
            aspectRatio: currentAspectRatio
        };
    }

    // stop existing stream if any and generate a new session id
    stopCamera(videoElement);
    const sessionId = ++currentCameraSessionId;

    setState(CameraState.REQUESTING);
    logToUI('Requesting camera permissions...', true, 'info');

    const constraints = {
        video: {
            facingMode: options.facingMode || 'user',
            width: { ideal: options.idealWidth || 1280 },
            height: { ideal: options.idealHeight || 720 }
        },
        audio: false
    };

    let stream = null;
    try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);

        // check if session was cancelled or superseded while permission was pending
        if (sessionId !== currentCameraSessionId) {
            stream.getTracks().forEach(track => {
                try { track.stop(); } catch (e) { }
            });
            const cancelErr = new Error('Camera request was cancelled or superseded');
            cancelErr.name = 'AbortError';
            throw cancelErr;
        }

        currentStream = stream;
        videoElement.srcObject = stream;

        // monitor stream disconnection (unplugged camera or system revoke)
        stream.getVideoTracks().forEach(track => {
            track.onended = () => {
                logToUI('Camera stream disconnected by system or hardware.', false, 'warn');
                setState(CameraState.STOPPED);
            };
        });

        const timeoutMs = options.metadataTimeoutMs || 10000;

        return await new Promise((resolve, reject) => {
            let settled = false;
            let timeoutTimer = null;

            const cleanup = () => {
                if (timeoutTimer) {
                    clearTimeout(timeoutTimer);
                    timeoutTimer = null;
                }
                if (typeof videoElement.removeEventListener === 'function') {
                    videoElement.removeEventListener('loadedmetadata', onLoaded);
                } else {
                    videoElement.onloadedmetadata = null;
                }
            };

            const onLoaded = () => {
                if (settled) return;
                settled = true;
                cleanup();

                if (sessionId !== currentCameraSessionId) {
                    stopCamera(videoElement);
                    const err = new Error('Camera session aborted');
                    err.name = 'AbortError';
                    reject(err);
                    return;
                }

                const width = videoElement.videoWidth || 640;
                const height = videoElement.videoHeight || 480;
                currentAspectRatio = height > 0 ? (width / height) : (4 / 3);

                if (typeof videoElement.play === 'function') {
                    videoElement.play().catch(playErr => {
                        logToUI(`Camera autoplay blocked: ${playErr.message}`, false, 'warn');
                    });
                }

                setState(CameraState.STREAMING);
                logToUI(`Camera active (${width}x${height}, aspect ratio ${currentAspectRatio.toFixed(2)})`, false, 'success');

                resolve({
                    videoElement,
                    stream,
                    width,
                    height,
                    aspectRatio: currentAspectRatio
                });
            };

            const onFailure = (err) => {
                if (settled) return;
                settled = true;
                cleanup();
                stopCamera(videoElement);
                setState(CameraState.ERROR, err);
                reject(err);
            };

            if (typeof videoElement.addEventListener === 'function') {
                videoElement.addEventListener('loadedmetadata', onLoaded);
            } else {
                videoElement.onloadedmetadata = onLoaded;
            }

            // in case readyState indicates metadata is already available
            if (videoElement.readyState >= 1 && (videoElement.videoWidth > 0 || videoElement.videoHeight > 0)) {
                onLoaded();
                return;
            }

            timeoutTimer = setTimeout(() => {
                if (settled) return;
                if (videoElement.videoWidth > 0) {
                    onLoaded();
                } else {
                    const timeoutErr = new Error(`Camera metadata load timed out after ${timeoutMs / 1000}s`);
                    onFailure(timeoutErr);
                }
            }, timeoutMs);
        });
    } catch (err) {
        if (err.name === 'AbortError') {
            throw err;
        }
        let classifiedReason = 'Unknown camera failure';
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            setState(CameraState.DENIED, err);
            classifiedReason = 'Permission denied by user or system policy';
            logToUI(`Camera Permission Denied: ${classifiedReason}`, true, 'error');
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
            setState(CameraState.ERROR, err);
            classifiedReason = 'No camera hardware found';
            logToUI(`Camera Not Found: ${classifiedReason}`, true, 'error');
        } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
            setState(CameraState.ERROR, err);
            classifiedReason = 'Camera is already in use by another application or OS error';
            logToUI(`Camera In Use: ${classifiedReason}`, true, 'error');
        } else {
            setState(CameraState.ERROR, err);
            logToUI(`Camera Error: ${err.message}`, true, 'error');
        }
        throw err;
    }
}

/** jsdoc
 * stop camera tracks and release hardware
 * @param {HTMLVideoElement} videoElement
 */
export function stopCamera(videoElement) {
    currentCameraSessionId++;

    if (currentStream) {
        currentStream.getTracks().forEach(track => {
            try {
                track.stop();
            } catch (e) {
                console.warn('Error stopping camera track:', e);
            }
        });
        currentStream = null;
    }

    if (videoElement) {
        videoElement.srcObject = null;
        if (videoElement.onloadedmetadata) videoElement.onloadedmetadata = null;
    }

    if (currentState !== CameraState.NO_CAMERA && currentState !== CameraState.DENIED) {
        setState(CameraState.STOPPED);
        logToUI('Camera stopped.', false, 'info');
    }
}

/** jsdoc
 * retry camera connection
 * @param {HTMLVideoElement} videoElement
 * @param {Object} options
 */
export async function retryCamera(videoElement, options = {}) {
    logToUI('Retrying camera connection...', true, 'info');
    stopCamera(videoElement);
    return await startCamera(videoElement, options);
}

/**
 * switch to camera-free mode
 */
export function enableNoCameraMode(videoElement) {
    stopCamera(videoElement);
    setState(CameraState.NO_CAMERA);
    logToUI('Operating in No-Camera Mode. Gaze tracking disabled.', true, 'warn');
}
