// quality.test.js - unit tests for quality gating and rolling coverage tracking
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QualityGate } from '../js/features/quality.js';

test('QualityGate validates normal fresh frame with face', () => {
    const gate = new QualityGate({ maxFrameAgeMs: 200 });

    const evalResult = gate.evaluate({
        frameAge: 25,
        hasFace: true,
        isBlinking: false,
        featureResult: { valid: true, features: [0.1, 0.2, 0.3, 0.4] }
    });

    assert.equal(evalResult.isValid, true);
    assert.equal(evalResult.reason, null);
});

test('QualityGate rejects stale frames beyond threshold', () => {
    const gate = new QualityGate({ maxFrameAgeMs: 150 });

    const evalResult = gate.evaluate({
        frameAge: 280,
        hasFace: true,
        isBlinking: false
    });

    assert.equal(evalResult.isValid, false);
    assert.equal(evalResult.reason, 'stale_frame');
});

test('QualityGate rejects frames during face loss', () => {
    const gate = new QualityGate();

    const evalResult = gate.evaluate({
        frameAge: 30,
        hasFace: false,
        isBlinking: false
    });

    assert.equal(evalResult.isValid, false);
    assert.equal(evalResult.reason, 'face_lost');
});

test('QualityGate rejects frames during blinks', () => {
    const gate = new QualityGate();

    const evalResult = gate.evaluate({
        frameAge: 30,
        hasFace: true,
        isBlinking: true
    });

    assert.equal(evalResult.isValid, false);
    assert.equal(evalResult.reason, 'blink');
});

test('QualityGate computes rolling detection coverage percentage', () => {
    const gate = new QualityGate();
    const now = 10000;

    // 8 valid frames, 2 face-lost frames = 80% coverage
    for (let i = 0; i < 8; i++) {
        gate.evaluate({ frameAge: 20, hasFace: true, isBlinking: false, timestamp: now + i * 100 });
    }
    for (let i = 0; i < 2; i++) {
        gate.evaluate({ frameAge: 20, hasFace: false, isBlinking: false, timestamp: now + 800 + i * 100 });
    }

    assert.equal(gate.getDetectionCoverage(), 80);

    const metrics = gate.getMetrics();
    assert.equal(metrics.totalEvaluated, 10);
    assert.equal(metrics.totalValid, 8);
    assert.equal(metrics.rejections.face_lost, 2);
});

test('QualityGate rolling window expires when read after time passes without new frames', () => {
    const gate = new QualityGate({ rollingWindowMs: 2000 });
    const t0 = 10000;

    // 5 valid frames at t0
    for (let i = 0; i < 5; i++) {
        gate.evaluate({ frameAge: 20, hasFace: true, isBlinking: false, timestamp: t0 + i * 50 });
    }

    assert.equal(gate.getDetectionCoverage(t0 + 200), 100);

    // after 3 seconds of no frames (stall)
    assert.equal(gate.getDetectionCoverage(t0 + 3000), 0);
});

test('QualityGate tracks detector errors and insufficient landmarks separately', () => {
    const gate = new QualityGate();

    const r1 = gate.evaluate({ detectorError: true, timestamp: 1000 });
    assert.equal(r1.isValid, false);
    assert.equal(r1.reason, 'detector_error');

    const r2 = gate.evaluate({ reason: 'insufficient_landmarks', timestamp: 1100 });
    assert.equal(r2.isValid, false);
    assert.equal(r2.reason, 'insufficient_landmarks');

    const metrics = gate.getMetrics(1200);
    assert.equal(metrics.rejections.detector_error, 1);
    assert.equal(metrics.rejections.insufficient_landmarks, 1);
});

test('QualityGate differentiates pure face coverage from valid sample coverage during blinks', () => {
    const gate = new QualityGate();
    const now = 10000;

    // 5 open frames (valid face + valid sample), 5 blink frames (valid face, but invalid sample)
    for (let i = 0; i < 5; i++) {
        gate.evaluate({ frameAge: 20, hasFace: true, isBlinking: false, timestamp: now + i * 50 });
    }
    for (let i = 0; i < 5; i++) {
        gate.evaluate({ frameAge: 20, hasFace: true, isBlinking: true, timestamp: now + 250 + i * 50 });
    }

    const metrics = gate.getMetrics(now + 500);
    assert.equal(metrics.faceCoveragePercent, 100); // 100% of frames had a face
    assert.equal(metrics.coveragePercent, 50);     // only 50% passed sample quality gates
});
