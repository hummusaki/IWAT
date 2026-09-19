// camera-recovery.test.js - unit tests for camera state machine and failure recovery
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CameraState, getCameraState, subscribeCameraState, enableNoCameraMode } from '../js/camera.js';

test('Camera states enum contains required recovery states', () => {
    assert.equal(CameraState.IDLE, 'IDLE');
    assert.equal(CameraState.REQUESTING, 'REQUESTING');
    assert.equal(CameraState.STREAMING, 'STREAMING');
    assert.equal(CameraState.STOPPED, 'STOPPED');
    assert.equal(CameraState.DENIED, 'DENIED');
    assert.equal(CameraState.ERROR, 'ERROR');
    assert.equal(CameraState.NO_CAMERA, 'NO_CAMERA');
});

test('enableNoCameraMode transitions state to NO_CAMERA cleanly without throwing', () => {
    let capturedState = null;
    const unsubscribe = subscribeCameraState((state) => {
        capturedState = state;
    });

    enableNoCameraMode(null);

    assert.equal(getCameraState(), CameraState.NO_CAMERA);
    assert.equal(capturedState, CameraState.NO_CAMERA);

    unsubscribe();
});

test('startCamera resolves when metadata timeout fires but videoWidth is valid', async () => {
    const { startCamera, stopCamera } = await import('../js/camera.js');

    let stopped = false;
    const mockTrack = {
        stop: () => { stopped = true; },
        onended: null
    };
    const mockStream = {
        getVideoTracks: () => [mockTrack],
        getTracks: () => [mockTrack]
    };

    Object.defineProperty(globalThis, 'navigator', {
        value: {
            mediaDevices: {
                getUserMedia: async () => mockStream
            }
        },
        configurable: true,
        writable: true
    });

    const listeners = {};
    const mockVideo = {
        srcObject: null,
        readyState: 0,
        videoWidth: 640,
        videoHeight: 480,
        play: async () => {},
        addEventListener: (event, handler) => {
            listeners[event] = handler;
        },
        removeEventListener: (event) => {
            delete listeners[event];
        }
    };

    // fast timeout of 50ms to trigger the timeout handler with videoWidth > 0
    const res = await startCamera(mockVideo, { metadataTimeoutMs: 50 });
    assert.equal(res.width, 640);
    assert.equal(res.height, 480);
    assert.equal(getCameraState(), CameraState.STREAMING);

    stopCamera(mockVideo);
    assert.equal(stopped, true);
    assert.equal(getCameraState(), CameraState.STOPPED);
});

test('startCamera rejects with timeout error when metadata never arrives and video has no dimensions', async () => {
    const { startCamera, stopCamera } = await import('../js/camera.js');

    let stopped = false;
    const mockTrack = {
        stop: () => { stopped = true; },
        onended: null
    };
    const mockStream = {
        getVideoTracks: () => [mockTrack],
        getTracks: () => [mockTrack]
    };

    Object.defineProperty(globalThis, 'navigator', {
        value: {
            mediaDevices: {
                getUserMedia: async () => mockStream
            }
        },
        configurable: true,
        writable: true
    });

    const mockVideo = {
        srcObject: null,
        readyState: 0,
        videoWidth: 0,
        videoHeight: 0,
        play: async () => {},
        addEventListener: () => {},
        removeEventListener: () => {}
    };

    await assert.rejects(
        async () => {
            await startCamera(mockVideo, { metadataTimeoutMs: 50 });
        },
        /Camera metadata load timed out/
    );

    assert.equal(getCameraState(), CameraState.ERROR);
    assert.equal(stopped, true);
    stopCamera(mockVideo);
});

test('stopCamera during pending getUserMedia cancels and stops late-acquired tracks', async () => {
    const { startCamera, stopCamera } = await import('../js/camera.js');

    let tracksStopped = false;
    const mockTrack = {
        stop: () => { tracksStopped = true; },
        onended: null
    };
    const mockStream = {
        getVideoTracks: () => [mockTrack],
        getTracks: () => [mockTrack]
    };

    let resolveGetUserMedia;
    Object.defineProperty(globalThis, 'navigator', {
        value: {
            mediaDevices: {
                getUserMedia: () => new Promise((resolve) => {
                    resolveGetUserMedia = () => resolve(mockStream);
                })
            }
        },
        configurable: true,
        writable: true
    });

    const mockVideo = {
        srcObject: null,
        readyState: 0,
        videoWidth: 640,
        videoHeight: 480,
        play: async () => {},
        addEventListener: () => {},
        removeEventListener: () => {}
    };

    const startPromise = startCamera(mockVideo);

    // cancel while permission is still pending
    stopCamera(mockVideo);

    // now resolve the pending getUserMedia
    resolveGetUserMedia();

    await assert.rejects(
        async () => { await startPromise; },
        /AbortError/
    );

    assert.equal(tracksStopped, true);
    assert.equal(mockVideo.srcObject, null);
});

test('track.onended event transitions camera state to STOPPED', async () => {
    const { startCamera, stopCamera } = await import('../js/camera.js');

    let trackEndedHandler = null;
    const mockTrack = {
        stop: () => {},
        set onended(fn) { trackEndedHandler = fn; },
        get onended() { return trackEndedHandler; }
    };
    const mockStream = {
        getVideoTracks: () => [mockTrack],
        getTracks: () => [mockTrack]
    };

    Object.defineProperty(globalThis, 'navigator', {
        value: {
            mediaDevices: {
                getUserMedia: async () => mockStream
            }
        },
        configurable: true,
        writable: true
    });

    const mockVideo = {
        srcObject: null,
        readyState: 2,
        videoWidth: 640,
        videoHeight: 480,
        play: async () => {},
        addEventListener: (evt, cb) => { if (evt === 'loadedmetadata') cb(); },
        removeEventListener: () => {}
    };

    await startCamera(mockVideo);
    assert.equal(getCameraState(), CameraState.STREAMING);

    // simulate system disconnecting the camera track
    assert.ok(trackEndedHandler != null);
    trackEndedHandler();

    assert.equal(getCameraState(), CameraState.STOPPED);
    stopCamera(mockVideo);
});
