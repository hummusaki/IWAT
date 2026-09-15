// blink.js - normalized bilateral eyelid measurements and temporal blink state machine

export const BlinkState = {
    OPEN: 'OPEN',
    CLOSING: 'CLOSING',
    CLOSED: 'CLOSED',
    RECOVERING: 'RECOVERING'
};

/** jsdoc
 * compute Eye Aspect Ratio (EAR) for an eye given keypoints
 * @param {{x: number, y: number}} top - upper eyelid keypoint (e.g. 159 left, 386 right)
 * @param {{x: number, y: number}} bottom - lower eyelid keypoint (e.g. 145 left, 374 right)
 * @param {{x: number, y: number}} inner - inner eye corner (e.g. 133 left, 362 right)
 * @param {{x: number, y: number}} outer - outer eye corner (e.g. 33 left, 263 right)
 * @returns {number|null} normalized EAR value or null if invalid
 */
export function computeEyeAspectRatio(top, bottom, inner, outer) {
    //checks
    if (!top || !bottom || !inner || !outer) return null;

    if (!Number.isFinite(top.x) || !Number.isFinite(top.y) ||
        !Number.isFinite(bottom.x) || !Number.isFinite(bottom.y) ||
        !Number.isFinite(inner.x) || !Number.isFinite(inner.y) ||
        !Number.isFinite(outer.x) || !Number.isFinite(outer.y)) {
        return null;
    }

    const horizontalDist = Math.hypot(outer.x - inner.x, outer.y - inner.y);
    if (horizontalDist < 1e-4) return null;

    const verticalDist = Math.hypot(bottom.x - top.x, bottom.y - top.y);
    return verticalDist / horizontalDist;
}

export class BlinkDetector {
    /** jsdoc
     * @param {Object} options
     * @param {number} options.closedThreshold - EAR below this is considered closed (default 0.18)
     * @param {number} options.openThreshold - EAR above this is considered open (default 0.23)
     * @param {number} options.minDurationMs - minimum duration for a valid blink (default 50ms)
     * @param {number} options.maxDurationMs - maximum duration for a normal blink (default 500ms)
     * @param {number} options.maxAllowedGapMs - time gap after which in-flight blink is reset (default 1000ms)
     */
    constructor(options = {}) {
        this.closedThreshold = options.closedThreshold || 0.18;
        this.openThreshold = options.openThreshold || 0.23;
        this.minDurationMs = options.minDurationMs || 50;
        this.maxDurationMs = options.maxDurationMs || 500;
        this.maxAllowedGapMs = options.maxAllowedGapMs || 1000;

        this.state = BlinkState.OPEN;
        this.blinkStartTime = 0;
        this.lastBlinkDuration = 0;
        this.totalBlinkCount = 0;
        this.recentBlinks = []; // timestamps of blinks within rolling window
        this.rollingWindowMs = 60000; // 1 minute window for blink rate
        this.lastTimestamp = 0;
    }

    /** jsdoc
     * update blink state with current bilateral keypoints
     * @param {Object} leftKeypoints - { top, bottom, inner, outer }
     * @param {Object} rightKeypoints - { top, bottom, inner, outer }
     * @param {number} timestamp - current frame timestamp (ms)
     * @returns {{
     *   isBlinking: boolean,
     *   state: string,
     *   leftEAR: number|null,
     *   rightEAR: number|null,
     *   avgEAR: number|null,
     *   measurementAvailable: boolean,
     *   totalBlinks: number,
     *   lastBlinkDuration: number,
     *   blinksPerMinute: number
     * }}
     */
    update(leftKeypoints, rightKeypoints, timestamp = performance.now()) {
        // Detect excessive time gaps between frames (e.g. background tab or camera stall)
        if (this.lastTimestamp > 0 && (timestamp - this.lastTimestamp) > this.maxAllowedGapMs) {
            this.resetInFlightBlink();
        }
        this.lastTimestamp = timestamp;

        const leftEAR = computeEyeAspectRatio(
            leftKeypoints?.top,
            leftKeypoints?.bottom,
            leftKeypoints?.inner,
            leftKeypoints?.outer
        );
        const rightEAR = computeEyeAspectRatio(
            rightKeypoints?.top,
            rightKeypoints?.bottom,
            rightKeypoints?.inner,
            rightKeypoints?.outer
        );

        let avgEAR = null;
        if (leftEAR !== null && rightEAR !== null) {
            avgEAR = (leftEAR + rightEAR) / 2;
        } else if (leftEAR !== null) {
            avgEAR = leftEAR;
        } else if (rightEAR !== null) {
            avgEAR = rightEAR;
        }

        // if eyes cannot be measured (e.g. face loss, landmark failure), reset in-flight episode
        if (avgEAR === null) {
            this.resetInFlightBlink();
            return {
                isBlinking: false,
                state: this.state,
                leftEAR: null,
                rightEAR: null,
                avgEAR: null,
                measurementAvailable: false,
                totalBlinks: this.totalBlinkCount,
                lastBlinkDuration: this.lastBlinkDuration,
                blinksPerMinute: this.getBlinksPerMinute(timestamp)
            };
        }

        // state machine transitions
        switch (this.state) {
            case BlinkState.OPEN:
                if (avgEAR < this.closedThreshold) {
                    this.state = BlinkState.CLOSING;
                    this.blinkStartTime = timestamp;
                }
                break;

            case BlinkState.CLOSING:
                if (avgEAR < this.closedThreshold) {
                    this.state = BlinkState.CLOSED;
                } else if (avgEAR >= this.openThreshold) {
                    // Reopening occurred after a single observation closure (common at 10-15 Hz)
                    const duration = timestamp - this.blinkStartTime;
                    if (duration >= this.minDurationMs && duration <= this.maxDurationMs) {
                        this.totalBlinkCount++;
                        this.lastBlinkDuration = duration;
                        this.recentBlinks.push(timestamp);
                        this.state = BlinkState.RECOVERING;
                    } else {
                        // aborted noise dip or prolonged gap
                        this.state = BlinkState.OPEN;
                    }
                }
                break;

            case BlinkState.CLOSED:
                if (avgEAR >= this.openThreshold) {
                    const duration = timestamp - this.blinkStartTime;
                    if (duration >= this.minDurationMs && duration <= this.maxDurationMs) {
                        this.totalBlinkCount++;
                        this.lastBlinkDuration = duration;
                        this.recentBlinks.push(timestamp);
                    }
                    this.state = BlinkState.RECOVERING;
                }
                break;

            case BlinkState.RECOVERING:
                if (avgEAR >= this.openThreshold) {
                    this.state = BlinkState.OPEN;
                } else if (avgEAR < this.closedThreshold) {
                    this.state = BlinkState.CLOSING;
                    this.blinkStartTime = timestamp;
                }
                break;
        }

        // clean old blinks from rolling window
        const cutoff = timestamp - this.rollingWindowMs;
        while (this.recentBlinks.length > 0 && this.recentBlinks[0] < cutoff) {
            this.recentBlinks.shift();
        }

        const isBlinking = (this.state === BlinkState.CLOSING || this.state === BlinkState.CLOSED);

        return {
            isBlinking,
            state: this.state,
            leftEAR: leftEAR !== null ? parseFloat(leftEAR.toFixed(3)) : null,
            rightEAR: rightEAR !== null ? parseFloat(rightEAR.toFixed(3)) : null,
            avgEAR: parseFloat(avgEAR.toFixed(3)),
            measurementAvailable: true,
            totalBlinks: this.totalBlinkCount,
            lastBlinkDuration: Math.round(this.lastBlinkDuration),
            blinksPerMinute: this.getBlinksPerMinute(timestamp)
        };
    }

    resetInFlightBlink() {
        if (this.state !== BlinkState.OPEN) {
            this.state = BlinkState.OPEN;
        }
        this.blinkStartTime = 0;
    }

    getBlinksPerMinute(timestamp = performance.now()) {
        const cutoff = timestamp - this.rollingWindowMs;
        const count = this.recentBlinks.filter(t => t >= cutoff).length;
        return count;
    }

    reset() {
        this.state = BlinkState.OPEN;
        this.blinkStartTime = 0;
        this.lastBlinkDuration = 0;
        this.totalBlinkCount = 0;
        this.recentBlinks = [];
        this.lastTimestamp = 0;
    }
}
