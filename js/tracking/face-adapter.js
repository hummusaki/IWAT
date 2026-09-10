// face-adapter.js - standardized interface for current (TFJS) and candidate (MediaPipe Tasks) face adapters

import { logToUI } from '../logger.js';

/** jsdoc
 * common FaceAdapter Interface
 * @typedef {Object} FaceKeypoint
 * @property {number} x
 * @property {number} y
 * @property {number} [z]
 * @property {string} [name]
 * 
 * @typedef {Object} NormalizedFaceResult
 * @property {FaceKeypoint[]} keypoints - 468 or 478 keypoints
 * @property {Object} [box] - bounding box { xMin, yMin, width, height }
 * @property {Object} [blendshapes] - optional blendshape scores
 * @property {number} [confidence]
 */

export class FaceAdapter {
    async init() {
        throw new Error('init() must be implemented');
    }
    /** jsdoc
     * @param {HTMLCanvasElement|HTMLVideoElement|ImageData} input
     * @param {number} timestamp
     * @returns {Promise<NormalizedFaceResult[]>}
     */
    async estimateFaces(input, timestamp) {
        throw new Error('estimateFaces() must be implemented');
    }
    dispose() { }
    getName() {
        return 'BaseAdapter';
    }
}

/**
 * repaired current adapter: TensorFlow.js FaceLandmarksDetection
 */
export class TfjsFaceMeshAdapter extends FaceAdapter {
    constructor() {
        super();
        this.detector = null;
        this.isInitialized = false;
    }

    getName() {
        return 'TFJS-MediaPipeFaceMesh (Current)';
    }

    async init() {
        if (this.isInitialized && this.detector) return;

        if (typeof faceLandmarksDetection === 'undefined') {
            const err = new Error('faceLandmarksDetection library is not loaded');
            logToUI(`Detector Error: ${err.message}`, true, 'error');
            throw err;
        }

        try {
            logToUI('Initializing TFJS Face Landmarks detector...', true, 'info');
            const model = faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh;
            const detectorConfig = {
                runtime: 'tfjs',
                maxFaces: 1,
                refineLandmarks: true
            };

            this.detector = await faceLandmarksDetection.createDetector(model, detectorConfig);
            this.isInitialized = true;
            logToUI('TFJS Face Landmarks detector initialized successfully.', false, 'success');
        } catch (err) {
            this.isInitialized = false;
            this.detector = null;
            logToUI(`TFJS Detector Init Error: ${err.message}`, true, 'error');
            throw err;
        }
    }

    async estimateFaces(input, timestamp = performance.now()) {
        if (!this.detector) {
            throw new Error('TfjsFaceMeshAdapter not initialized');
        }

        try {
            const faces = await this.detector.estimateFaces(input, { flipHorizontal: false });
            if (!faces || faces.length === 0) return [];

            return faces.map(face => ({
                keypoints: face.keypoints.map(kp => ({
                    x: kp.x,
                    y: kp.y,
                    z: kp.z || 0,
                    name: kp.name
                })),
                box: face.box,
                confidence: face.score || 1.0
            }));
        } catch (err) {
            console.error('Error during TFJS face estimation:', err);
            return [];
        }
    }

    dispose() {
        if (this.detector && typeof this.detector.dispose === 'function') {
            try {
                this.detector.dispose();
            } catch (e) {
                console.warn('Error disposing TFJS detector:', e);
            }
        }
        this.detector = null;
        this.isInitialized = false;
    }
}

/**
 * candidate adapter: MediaPipe Tasks Vision FaceLandmarker
 */
export class MediaPipeVisionFaceAdapter extends FaceAdapter {
    constructor(options = {}) {
        super();
        this.landmarker = null;
        this.isInitialized = false;
        this.delegate = options.delegate || 'GPU'; // 'GPU' | 'CPU'
        this.wasmPath = options.wasmPath || 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
        this.modelAssetPath = options.modelAssetPath || 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
    }

    getName() {
        return `MediaPipe-Tasks-Vision (${this.delegate}) (Candidate)`;
    }

    async init() {
        if (this.isInitialized && this.landmarker) return;

        try {
            logToUI(`Initializing MediaPipe Vision Face Landmarker (${this.delegate})...`, true, 'info');

            // check if TasksVision is available globally or needs import
            let tasksVision = window.TasksVision || window.tasksVision;
            if (!tasksVision) {
                // try dynamic import from CDN if not already in window
                try {
                    tasksVision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14');
                } catch (e) {
                    throw new Error(`Failed to load MediaPipe Tasks Vision module: ${e.message}`);
                }
            }

            const { FaceLandmarker, FilesetResolver } = tasksVision;
            const filesetResolver = await FilesetResolver.forVisionTasks(this.wasmPath);

            try {
                this.landmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
                    baseOptions: {
                        modelAssetPath: this.modelAssetPath,
                        delegate: this.delegate
                    },
                    runningMode: 'VIDEO',
                    numFaces: 1,
                    outputFaceBlendshapes: true,
                    outputFacialTransformationMatrixes: true
                });
            } catch (gpuErr) {
                // if GPU delegate fails, fall back to CPU
                if (this.delegate === 'GPU') {
                    logToUI('GPU delegate failed for MediaPipe Landmarker. Falling back to CPU...', false, 'warn');
                    this.delegate = 'CPU';
                    this.landmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
                        baseOptions: {
                            modelAssetPath: this.modelAssetPath,
                            delegate: 'CPU'
                        },
                        runningMode: 'VIDEO',
                        numFaces: 1,
                        outputFaceBlendshapes: true,
                        outputFacialTransformationMatrixes: true
                    });
                } else {
                    throw gpuErr;
                }
            }

            this.isInitialized = true;
            logToUI('MediaPipe Vision Face Landmarker initialized successfully.', false, 'success');
        } catch (err) {
            this.isInitialized = false;
            this.landmarker = null;
            logToUI(`MediaPipe Landmarker Init Error: ${err.message}`, true, 'error');
            throw err;
        }
    }

    async estimateFaces(input, timestamp = performance.now()) {
        if (!this.landmarker) {
            throw new Error('MediaPipeVisionFaceAdapter not initialized');
        }

        try {
            // detectForVideo requires integer timestamp in milliseconds
            const result = this.landmarker.detectForVideo(input, Math.round(timestamp));
            if (!result || !result.faceLandmarks || result.faceLandmarks.length === 0) {
                return [];
            }

            const inputWidth = input.width || input.videoWidth || 640;
            const inputHeight = input.height || input.videoHeight || 480;

            // adapter pattern
            return result.faceLandmarks.map((landmarks, idx) => {
                // convert normalized landmarks [0, 1] to pixel coords matching TFJS keypoints
                const keypoints = landmarks.map(lm => ({
                    x: lm.x * inputWidth,
                    y: lm.y * inputHeight,
                    z: lm.z,
                    normalizedX: lm.x,
                    normalizedY: lm.y
                }));

                // map MediaPipe facial expression coefficients
                const blendshapes = result.faceBlendshapes && result.faceBlendshapes[idx]
                    ? result.faceBlendshapes[idx].categories.reduce((acc, cat) => {
                        acc[cat.categoryName] = cat.score;
                        return acc;
                    }, {})
                    : null;

                return {
                    keypoints,
                    blendshapes,
                    confidence: 1.0
                };
            });
        } catch (err) {
            console.error('Error during MediaPipe face estimation:', err);
            return [];
        }
    }

    dispose() {
        if (this.landmarker && typeof this.landmarker.close === 'function') {
            try {
                this.landmarker.close();
            } catch (e) {
                console.warn('Error closing MediaPipe landmarker:', e);
            }
        }
        this.landmarker = null;
        this.isInitialized = false;
    }
}

/**
 * adapter factory
 */
export function createFaceAdapter(type = 'tfjs', options = {}) {
    if (type === 'mediapipe-tasks' || type === 'mediapipe') {
        return new MediaPipeVisionFaceAdapter(options);
    }
    return new TfjsFaceMeshAdapter();
}
