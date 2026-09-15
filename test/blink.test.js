// blink.test.js - Unit tests for EAR calculation and temporal blink state machine
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEyeAspectRatio, BlinkDetector, BlinkState } from '../js/features/blink.js';

test('computeEyeAspectRatio computes normalized aperture', () => {
    // Open eye: width = 50px, height = 15px -> EAR = 0.30
    const top = { x: 25, y: 10 };
    const bottom = { x: 25, y: 25 };
    const inner = { x: 0, y: 17 };
    const outer = { x: 50, y: 17 };

    const ear = computeEyeAspectRatio(top, bottom, inner, outer);
    assert.ok(ear !== null);
    assert.ok(Math.abs(ear - 0.3) < 0.01);
});

test('computeEyeAspectRatio returns null on missing or non-finite keypoints', () => {
    assert.equal(computeEyeAspectRatio(null, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }), null);
    assert.equal(computeEyeAspectRatio({ x: NaN, y: 10 }, { x: 25, y: 25 }, { x: 0, y: 17 }, { x: 50, y: 17 }), null);
    assert.equal(computeEyeAspectRatio({ x: 25, y: 10 }, { x: 25, y: Infinity }, { x: 0, y: 17 }, { x: 50, y: 17 }), null);
});

test('computeEyeAspectRatio returns null on zero eye width', () => {
    const pt = { x: 10, y: 10 };
    const ear = computeEyeAspectRatio(pt, pt, pt, pt);
    assert.equal(ear, null);
});

test('BlinkDetector state machine detects complete blink cycle with duration', () => {
    const detector = new BlinkDetector({
        closedThreshold: 0.18,
        openThreshold: 0.23,
        minDurationMs: 40,
        maxDurationMs: 400
    });

    // Helper to generate keypoints with given EAR
    const makeEye = (ear) => ({
        top: { x: 25, y: 0 },
        bottom: { x: 25, y: 50 * ear },
        inner: { x: 0, y: 25 },
        outer: { x: 50, y: 25 }
    });

    let t = 1000;

    // 1. Initially open (EAR = 0.28)
    let res = detector.update(makeEye(0.28), makeEye(0.28), t);
    assert.equal(res.isBlinking, false);
    assert.equal(res.state, BlinkState.OPEN);

    // 2. Eyes closing (EAR = 0.15)
    t += 30;
    res = detector.update(makeEye(0.15), makeEye(0.15), t);
    assert.equal(res.isBlinking, true);
    assert.equal(res.state, BlinkState.CLOSING);

    // 3. Eyes fully closed (EAR = 0.08)
    t += 40;
    res = detector.update(makeEye(0.08), makeEye(0.08), t);
    assert.equal(res.isBlinking, true);
    assert.equal(res.state, BlinkState.CLOSED);

    // 4. Eyes opening / recovering (EAR = 0.25)
    t += 50;
    res = detector.update(makeEye(0.25), makeEye(0.25), t);
    assert.equal(res.isBlinking, false);
    assert.equal(res.state, BlinkState.RECOVERING);

    // 5. Back to open
    t += 20;
    res = detector.update(makeEye(0.28), makeEye(0.28), t);
    assert.equal(res.isBlinking, false);
    assert.equal(res.state, BlinkState.OPEN);

    // Verify blink count and duration
    assert.equal(res.totalBlinks, 1);
    assert.ok(res.lastBlinkDuration >= 80 && res.lastBlinkDuration <= 120);
    assert.equal(res.blinksPerMinute, 1);
});

test('BlinkDetector ignores aborted noise dips below minDuration', () => {
    const detector = new BlinkDetector({
        closedThreshold: 0.18,
        openThreshold: 0.23,
        minDurationMs: 50
    });

    const makeEye = (ear) => ({
        top: { x: 25, y: 0 },
        bottom: { x: 25, y: 50 * ear },
        inner: { x: 0, y: 25 },
        outer: { x: 50, y: 25 }
    });

    let t = 1000;
    detector.update(makeEye(0.3), makeEye(0.3), t);

    // Instantaneous single-frame dip of 5ms
    t += 5;
    detector.update(makeEye(0.15), makeEye(0.15), t);

    t += 5;
    const res = detector.update(makeEye(0.3), makeEye(0.3), t);

    // Should not count as a full completed blink because duration was < 50ms
    assert.equal(res.totalBlinks, 0);
});

test('BlinkDetector counts single-observation closure when duration exceeds minDuration', () => {
    const detector = new BlinkDetector({
        closedThreshold: 0.18,
        openThreshold: 0.23,
        minDurationMs: 50,
        maxDurationMs: 400
    });

    const makeEye = (ear) => ({
        top: { x: 25, y: 0 },
        bottom: { x: 25, y: 50 * ear },
        inner: { x: 0, y: 25 },
        outer: { x: 50, y: 25 }
    });

    let t = 1000;
    // Frame 1: Open
    detector.update(makeEye(0.3), makeEye(0.3), t);

    // Frame 2 (at 10-15 Hz): Closed observation lasting 70ms
    t += 70;
    const r2 = detector.update(makeEye(0.12), makeEye(0.12), t);
    assert.equal(r2.isBlinking, true);

    // Frame 3: Reopened
    t += 70;
    const r3 = detector.update(makeEye(0.3), makeEye(0.3), t);
    assert.equal(r3.isBlinking, false);
    assert.equal(r3.totalBlinks, 1);
    assert.equal(r3.lastBlinkDuration, 70);
});

test('BlinkDetector resets in-flight episode on face loss or invalid landmarks', () => {
    const detector = new BlinkDetector();

    const makeEye = (ear) => ({
        top: { x: 25, y: 0 },
        bottom: { x: 25, y: 50 * ear },
        inner: { x: 0, y: 25 },
        outer: { x: 50, y: 25 }
    });

    let t = 1000;
    detector.update(makeEye(0.3), makeEye(0.3), t);

    // Closing
    t += 30;
    detector.update(makeEye(0.12), makeEye(0.12), t);

    // Face lost (null keypoints)
    t += 30;
    const res = detector.update(null, null, t);
    assert.equal(res.measurementAvailable, false);
    assert.equal(res.isBlinking, false);
    assert.equal(res.state, BlinkState.OPEN);

    // Reacquired open face after 2 seconds
    t += 2000;
    const res2 = detector.update(makeEye(0.3), makeEye(0.3), t);
    // Must NOT count a spurious 2-second blink
    assert.equal(res2.totalBlinks, 0);
});

test('BlinkDetector resets in-flight episode on excessive time gap', () => {
    const detector = new BlinkDetector({ maxAllowedGapMs: 500 });

    const makeEye = (ear) => ({
        top: { x: 25, y: 0 },
        bottom: { x: 25, y: 50 * ear },
        inner: { x: 0, y: 25 },
        outer: { x: 50, y: 25 }
    });

    let t = 1000;
    detector.update(makeEye(0.3), makeEye(0.3), t);

    t += 30;
    detector.update(makeEye(0.12), makeEye(0.12), t);

    // 2-second gap (e.g. background tab or CPU freeze)
    t += 2000;
    const res = detector.update(makeEye(0.3), makeEye(0.3), t);
    assert.equal(res.totalBlinks, 0);
    assert.equal(res.state, BlinkState.OPEN);
});
