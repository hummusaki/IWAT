// tracking-lifecycle.test.js - unit tests for tracking session lifecycle, draining, sample records, and stall watchdog
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    GazeSample,
    isSampleFresh,
    checkStallWatchdog,
    stopTrackingLoop,
    disposeSession,
    initDetector,
    getActiveAdapter
} from '../js/gaze-tracker.js';

test('GazeSample produces immutable sample records with latency and age', () => {
    const sample = new GazeSample({
        sessionId: 1,
        frameId: 42,
        sourceTime: 1000,
        processingStartTime: 1020,
        processingEndTime: 1060,
        features: [0.1, 0.2, 0.3, 0.4],
        valid: true,
        rejectionReason: null
    });

    assert.equal(sample.sessionId, 1);
    assert.equal(sample.frameId, 42);
    assert.equal(sample.sourceTime, 1000);
    assert.equal(sample.latencyMs, 40);
    assert.equal(sample.ageMs, 60);
    assert.equal(sample.valid, true);
    assert.deepEqual(sample.features, [0.1, 0.2, 0.3, 0.4]);

    // immutability checks
    assert.throws(() => { sample.valid = false; });
    assert.throws(() => { sample.features[0] = 999; });
});

test('isSampleFresh checks age threshold against monotonic sourceTime', () => {
    const freshSample = new GazeSample({
        sessionId: 1,
        frameId: 1,
        sourceTime: performance.now() - 50,
        processingStartTime: performance.now() - 30,
        processingEndTime: performance.now() - 10,
        features: [0.1, 0.2, 0.3, 0.4],
        valid: true
    });
    assert.equal(isSampleFresh(freshSample, 250), true);

    const staleSample = new GazeSample({
        sessionId: 1,
        frameId: 2,
        sourceTime: performance.now() - 300,
        processingStartTime: performance.now() - 280,
        processingEndTime: performance.now() - 260,
        features: [0.1, 0.2, 0.3, 0.4],
        valid: true
    });
    assert.equal(isSampleFresh(staleSample, 250), false);

    const invalidSample = new GazeSample({
        sessionId: 1,
        frameId: 3,
        sourceTime: performance.now() - 50,
        processingStartTime: performance.now() - 30,
        processingEndTime: performance.now() - 10,
        features: null,
        valid: false
    });
    assert.equal(isSampleFresh(invalidSample, 250), false);
});

test('disposeSession disposes adapter and resets state cleanly', () => {
    disposeSession();
    assert.equal(getActiveAdapter(), null);
});
