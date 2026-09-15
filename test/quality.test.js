// quality.test.js - Unit tests for quality gating and rolling coverage tracking
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
