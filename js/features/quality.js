// quality.js - frame quality gating, rolling detection coverage, and rejection tracking

export class QualityGate {
    constructor(options = {}) {
        this.maxFrameAgeMs = options.maxFrameAgeMs || 250; // frames older than 250ms considered stale
        this.rollingWindowMs = options.rollingWindowMs || 5000; // 5-second window for detection coverage

        this.frameHistory = []; // { timestamp, isValid, hasFace, reason }
        this.rejectionCounts = {
            face_lost: 0,
            blink: 0,
            non_finite: 0,
            stale_frame: 0,
            degenerate_geometry: 0,
            insufficient_landmarks: 0,
            detector_error: 0,
            other: 0
        };
        this.totalEvaluatedFrames = 0;
        this.totalValidFrames = 0;
    }

    /** jsdoc
     * evaluate the quality of a frame and its extracted measurements
     * @param {Object} context
     * @param {number} context.frameAge - milliseconds since frame was captured/presented
     * @param {boolean} context.hasFace - whether at least one face was detected
     * @param {boolean} context.isBlinking - whether frame occurred during a blink
     * @param {Object} [context.featureResult] - result from buildGazeFeatureVector
     * @param {number} [context.timestamp] - current timestamp (ms)
     * @param {boolean} [context.detectorError] - whether detector threw an error
     * @param {string} [context.reason] - explicit rejection reason override
     * @returns {{ isValid: boolean, reason: string|null }}
     */
    evaluate(context) {
        const timestamp = context.timestamp || performance.now();
        this.totalEvaluatedFrames++;

        let isValid = true;
        let reason = null;

        if (context.detectorError || context.reason === 'detector_error') {
            isValid = false;
            reason = 'detector_error';
        } else if (context.reason === 'insufficient_landmarks') {
            isValid = false;
            reason = 'insufficient_landmarks';
        } else if (context.frameAge > this.maxFrameAgeMs) {
            isValid = false;
            reason = 'stale_frame';
        } else if (!context.hasFace) {
            isValid = false;
            reason = 'face_lost';
        } else if (context.isBlinking) {
            isValid = false;
            reason = 'blink';
        } else if (context.featureResult && !context.featureResult.valid) {
            isValid = false;
            const subReason = context.featureResult.reason || 'invalid_features';
            if (subReason.includes('non_finite')) {
                reason = 'non_finite';
            } else if (subReason.includes('degenerate')) {
                reason = 'degenerate_geometry';
            } else if (subReason.includes('insufficient') || subReason.includes('missing')) {
                reason = 'insufficient_landmarks';
            } else {
                reason = 'other';
            }
        }

        if (isValid) {
            this.totalValidFrames++;
        } else if (reason) {
            this.rejectionCounts[reason] = (this.rejectionCounts[reason] || 0) + 1;
        }

        // add to rolling history
        this.frameHistory.push({
            timestamp,
            isValid,
            hasFace: !!context.hasFace,
            reason
        });

        // clean rolling window
        this.pruneHistory(timestamp);

        return { isValid, reason };
    }

    pruneHistory(now = performance.now()) {
        const cutoff = now - this.rollingWindowMs;
        while (this.frameHistory.length > 0 && this.frameHistory[0].timestamp < cutoff) {
            this.frameHistory.shift();
        }
    }

    /**
     * get rolling valid sample coverage percentage (0 - 100%)
     */
    getDetectionCoverage(now = performance.now()) {
        this.pruneHistory(now);
        if (this.frameHistory.length === 0) return 0;
        const validCount = this.frameHistory.filter(f => f.isValid).length;
        return Math.round((validCount / this.frameHistory.length) * 100);
    }

    /**
     * get rolling pure face detection coverage percentage (0 - 100%)
     */
    getFaceCoverage(now = performance.now()) {
        this.pruneHistory(now);
        if (this.frameHistory.length === 0) return 0;
        const faceCount = this.frameHistory.filter(f => f.hasFace).length;
        return Math.round((faceCount / this.frameHistory.length) * 100);
    }

    /**
     * get snapshot of diagnostics metrics
     */
    getMetrics(now = performance.now()) {
        this.pruneHistory(now);
        return {
            coveragePercent: this.getDetectionCoverage(now),
            faceCoveragePercent: this.getFaceCoverage(now),
            totalEvaluated: this.totalEvaluatedFrames,
            totalValid: this.totalValidFrames,
            rejections: { ...this.rejectionCounts }
        };
    }

    reset() {
        this.frameHistory = [];
        this.rejectionCounts = {
            face_lost: 0,
            blink: 0,
            non_finite: 0,
            stale_frame: 0,
            degenerate_geometry: 0,
            insufficient_landmarks: 0,
            detector_error: 0,
            other: 0
        };
        this.totalEvaluatedFrames = 0;
        this.totalValidFrames = 0;
    }
}
