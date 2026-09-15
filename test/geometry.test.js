// geometry.test.js - Unit tests for aspect ratio scaling, relative projection, and finite validation
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProcessingCanvasDimensions, getRelativePupilPos, buildGazeFeatureVector } from '../js/features/geometry.js';

test('computeProcessingCanvasDimensions preserves 16:9 aspect ratio', () => {
    const dims = computeProcessingCanvasDimensions(1280, 720, 640);
    assert.equal(dims.width, 640);
    assert.equal(dims.height, 360);
    assert.ok(Math.abs(dims.aspectRatio - (16 / 9)) < 0.01);
});

test('computeProcessingCanvasDimensions preserves 4:3 aspect ratio', () => {
    const dims = computeProcessingCanvasDimensions(640, 480, 640);
    assert.equal(dims.width, 640);
    assert.equal(dims.height, 480);
    assert.ok(Math.abs(dims.aspectRatio - (4 / 3)) < 0.01);
});

test('computeProcessingCanvasDimensions preserves vertical 9:16 aspect ratio', () => {
    const dims = computeProcessingCanvasDimensions(720, 1280, 640);
    assert.equal(dims.height, 640);
    assert.equal(dims.width, 360);
});

test('computeProcessingCanvasDimensions handles zero or non-finite inputs safely', () => {
    const dims = computeProcessingCanvasDimensions(0, NaN, 640);
    assert.equal(dims.width, 640);
    assert.equal(dims.height, 480);
});

test('getRelativePupilPos calculates normalized pupil displacement', () => {
    // Eye corners horizontal along x axis from 100 to 200 (width = 100)
    const inner = { x: 100, y: 150 };
    const outer = { x: 200, y: 150 };
    // Pupil dead center between inner and outer
    const pupil = { x: 150, y: 150 };

    const res = getRelativePupilPos(pupil, outer, inner);
    assert.equal(res.valid, true);
    assert.ok(Math.abs(res.x - 0.5) < 0.001);
    assert.ok(Math.abs(res.y - 0.0) < 0.001);
});

test('getRelativePupilPos guards against zero eye width', () => {
    const pt = { x: 100, y: 100 };
    const res = getRelativePupilPos(pt, pt, pt);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'degenerate_eye_width');
});

test('getRelativePupilPos rejects NaN and Infinity coordinates', () => {
    const inner = { x: NaN, y: 150 };
    const outer = { x: 200, y: 150 };
    const pupil = { x: 150, y: 150 };

    const res = getRelativePupilPos(pupil, outer, inner);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'non_finite_coordinates');
});

test('buildGazeFeatureVector builds 4D vector and validates finiteness', () => {
    const left = { valid: true, x: 0.45, y: -0.02 };
    const right = { valid: true, x: 0.48, y: -0.01 };

    const res = buildGazeFeatureVector(left, right);
    assert.equal(res.valid, true);
    assert.deepEqual(res.features, [0.48, -0.01, 0.45, -0.02]);

    // Invalid right eye
    const invalidRight = { valid: false, reason: 'non_finite_coordinates' };
    const failRes = buildGazeFeatureVector(left, invalidRight);
    assert.equal(failRes.valid, false);
});
