// geometry.js - geometric computations, aspect ratio preservation, and finite validation

/** jsdoc
 * calculate scaled dimensions that preserve native video aspect ratio
 * @param {number} srcWidth - video natural width
 * @param {number} srcHeight - video natural height
 * @param {number} maxDimension - max width or height constraint (default 640)
 * @returns {{ width: number, height: number, aspectRatio: number }}
 */
export function computeProcessingCanvasDimensions(srcWidth, srcHeight, maxDimension = 640) {
    if (!Number.isFinite(srcWidth) || !Number.isFinite(srcHeight) || srcWidth <= 0 || srcHeight <= 0) {
        return { width: 640, height: 480, aspectRatio: 4 / 3 };
    }

    const aspectRatio = srcWidth / srcHeight;

    let width, height;
    if (srcWidth >= srcHeight) {
        width = Math.min(srcWidth, maxDimension);
        height = Math.round(width / aspectRatio);
    } else {
        height = Math.min(srcHeight, maxDimension);
        width = Math.round(height * aspectRatio);
    }

    return { width, height, aspectRatio };
}

/** jsdoc
 * extract normalized pupil position relative to stable eye corners with strict finite guarantees
 * @param {{x: number, y: number}} pupil
 * @param {{x: number, y: number}} outerCorner
 * @param {{x: number, y: number}} innerCorner
 * @returns {{ valid: boolean, x?: number, y?: number, reason?: string }}
 */
export function getRelativePupilPos(pupil, outerCorner, innerCorner) {
    if (!pupil || !outerCorner || !innerCorner) {
        return { valid: false, reason: 'missing_keypoints' };
    }

    const px = pupil.x;
    const py = pupil.y;
    const ox = outerCorner.x;
    const oy = outerCorner.y;
    const ix = innerCorner.x;
    const iy = innerCorner.y;

    if (!Number.isFinite(px) || !Number.isFinite(py) ||
        !Number.isFinite(ox) || !Number.isFinite(oy) ||
        !Number.isFinite(ix) || !Number.isFinite(iy)) {
        return { valid: false, reason: 'non_finite_coordinates' };
    }

    // eye vector
    const dx = ox - ix;
    const dy = oy - iy;
    const eyeWidth = Math.hypot(dx, dy);

    // guard against degenerate eye landmarks or zero-width division
    if (eyeWidth < 1e-4) {
        return { valid: false, reason: 'degenerate_eye_width' };
    }

    // eye unit axes
    const ex = dx / eyeWidth;
    const ey = dy / eyeWidth;
    const nx = -ey;
    const ny = ex;

    // vector from inner corner to pupil
    const vx = px - ix;
    const vy = py - iy;

    // project onto local coordinate system and normalize by eye width
    const localX = (vx * ex + vy * ey) / eyeWidth;
    const localY = (vx * nx + vy * ny) / eyeWidth;

    if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
        return { valid: false, reason: 'non_finite_projection' };
    }

    return { valid: true, x: localX, y: localY };
}

/** jsdoc
 * validate and assemble the 4D feature vector [normRX, normRY, normLX, normLY]
 * @param {{ valid: boolean, x?: number, y?: number }} left
 * @param {{ valid: boolean, x?: number, y?: number }} right
 * @returns {{ valid: boolean, features?: number[], reason?: string }}
 */
export function buildGazeFeatureVector(left, right) {
    if (!left.valid) {
        return { valid: false, reason: `left_eye_${left.reason}` };
    }
    if (!right.valid) {
        return { valid: false, reason: `right_eye_${right.reason}` };
    }

    const vector = [right.x, right.y, left.x, left.y];
    for (const val of vector) {
        if (!Number.isFinite(val)) {
            return { valid: false, reason: 'non_finite_feature_vector' };
        }
    }

    return { valid: true, features: vector };
}
