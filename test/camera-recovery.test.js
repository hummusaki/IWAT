// camera-recovery.test.js - Unit tests for camera state machine and failure recovery
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
