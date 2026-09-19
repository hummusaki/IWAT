// storage.test.js - unit tests for calibration storage validation and corruption recovery
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCalibrationData } from '../js/calibration.js';

test('validateCalibrationData accepts valid v4 calibration data', () => {
    const validData = {
        version: 4,
        timestamp: Date.now(),
        screen: { width: 1920, height: 1080 },
        x_train: Array.from({ length: 45 }, () => [0.12, -0.05, 0.14, -0.04]),
        y_train: Array.from({ length: 45 }, () => [0.5, 0.5])
    };

    const result = validateCalibrationData(validData);
    assert.equal(result.valid, true);
    assert.equal(result.data.x_train.length, 45);
});

test('validateCalibrationData rejects non-object or null input', () => {
    assert.equal(validateCalibrationData(null).valid, false);
    assert.equal(validateCalibrationData("corrupt string").valid, false);
    assert.equal(validateCalibrationData(12345).valid, false);
});

test('validateCalibrationData rejects unsupported schema versions', () => {
    const oldData = { version: 3, x_train: [], y_train: [] };
    const result = validateCalibrationData(oldData);
    assert.equal(result.valid, false);
    assert.match(result.reason, /Unsupported schema version/);
});

test('validateCalibrationData rejects mismatched array lengths', () => {
    const mismatched = {
        version: 4,
        x_train: Array.from({ length: 20 }, () => [0.1, 0.2, 0.3, 0.4]),
        y_train: Array.from({ length: 15 }, () => [0.5, 0.5])
    };
    const result = validateCalibrationData(mismatched);
    assert.equal(result.valid, false);
    assert.match(result.reason, /Mismatched lengths/);
});

test('validateCalibrationData rejects insufficient samples', () => {
    const sparse = {
        version: 4,
        x_train: Array.from({ length: 5 }, () => [0.1, 0.2, 0.3, 0.4]),
        y_train: Array.from({ length: 5 }, () => [0.5, 0.5])
    };
    const result = validateCalibrationData(sparse);
    assert.equal(result.valid, false);
    assert.match(result.reason, /Insufficient sample count/);
});

test('validateCalibrationData rejects NaN and Infinity values in x_train', () => {
    const nanData = {
        version: 4,
        x_train: Array.from({ length: 20 }, (_, i) => i === 3 ? [0.1, NaN, 0.3, 0.4] : [0.1, 0.2, 0.3, 0.4]),
        y_train: Array.from({ length: 20 }, () => [0.5, 0.5])
    };
    const result = validateCalibrationData(nanData);
    assert.equal(result.valid, false);
    assert.match(result.reason, /Non-finite value in x_train/);

    const infData = {
        version: 4,
        x_train: Array.from({ length: 20 }, (_, i) => i === 5 ? [0.1, Infinity, 0.3, 0.4] : [0.1, 0.2, 0.3, 0.4]),
        y_train: Array.from({ length: 20 }, () => [0.5, 0.5])
    };
    const infResult = validateCalibrationData(infData);
    assert.equal(infResult.valid, false);
    assert.match(infResult.reason, /Non-finite value in x_train/);
});

test('validateCalibrationData rejects out-of-range y_train coordinates', () => {
    const outOfBounds = {
        version: 4,
        x_train: Array.from({ length: 20 }, () => [0.1, 0.2, 0.3, 0.4]),
        y_train: Array.from({ length: 20 }, (_, i) => i === 2 ? [1.8, 0.5] : [0.5, 0.5])
    };
    const result = validateCalibrationData(outOfBounds);
    assert.equal(result.valid, false);
    assert.match(result.reason, /Out-of-range value in y_train/);
});

test('validateCalibrationData accepts valid committed v5 calibration data', () => {
    const validV5 = {
        version: 5,
        id: 'calib_12345',
        timestamp: Date.now(),
        committed: true,
        screen: { width: 1440, height: 900, devicePixelRatio: 2 },
        x_train: Array.from({ length: 135 }, () => [0.12, -0.05, 0.14, -0.04]),
        y_train: Array.from({ length: 135 }, () => [0.5, 0.5]),
        targetIds: Array.from({ length: 135 }, (_, i) => Math.floor(i / 15))
    };

    const result = validateCalibrationData(validV5);
    assert.equal(result.valid, true);
    assert.equal(result.data.version, 5);
    assert.equal(result.data.x_train.length, 135);
});

test('validateCalibrationData rejects uncommitted v5 calibration data', () => {
    const uncommittedV5 = {
        version: 5,
        id: 'calib_incomplete',
        timestamp: Date.now(),
        committed: false,
        x_train: Array.from({ length: 45 }, () => [0.1, 0.2, 0.3, 0.4]),
        y_train: Array.from({ length: 45 }, () => [0.5, 0.5])
    };

    const result = validateCalibrationData(uncommittedV5);
    assert.equal(result.valid, false);
    assert.match(result.reason, /uncommitted or incomplete/);
});

test('computeFeatureSpread accurately detects presence or absence of two-axis variance', async () => {
    const { computeFeatureSpread } = await import('../js/calibration.js');

    // data with variance on both axes
    const goodData = [
        [0.10, 0.20, 0.11, 0.21],
        [0.15, 0.25, 0.16, 0.26],
        [0.20, 0.30, 0.21, 0.31]
    ];
    const goodSpread = computeFeatureSpread(goodData);
    assert.equal(goodSpread.hasSufficientSignal, true);
    assert.ok(goodSpread.varX > 1e-4);
    assert.ok(goodSpread.varY > 1e-4);

    // data with zero vertical variance (y values identical)
    const flatYData = [
        [0.10, 0.20, 0.11, 0.20],
        [0.15, 0.20, 0.16, 0.20],
        [0.20, 0.20, 0.21, 0.20]
    ];
    const flatYSpread = computeFeatureSpread(flatYData);
    assert.equal(flatYSpread.hasSufficientSignal, false);
    assert.ok(flatYSpread.varY < 1e-5);
});
