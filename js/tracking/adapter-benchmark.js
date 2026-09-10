// adapter-benchmark.js - face adapter benchmark suite

import { TfjsFaceMeshAdapter, MediaPipeVisionFaceAdapter } from './face-adapter.js';
import { logToUI } from '../logger.js';
import { computeEyeAspectRatio } from '../features/blink.js';

/** jsdoc
 * generate synthetic canvas frame scenarios for controlled benchmarking
 * @param {number} width
 * @param {number} height
 * @param {string} scenario - 'standard' | 'blink' | 'head_turn' | 'no_face' | 'low_contrast'
 * @returns {HTMLCanvasElement}
 */
export function createSyntheticTestFrame(width = 640, height = 480, scenario = 'standard') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // background
    ctx.fillStyle = scenario === 'low_contrast' ? '#444444' : '#222222';
    ctx.fillRect(0, 0, width, height);

    if (scenario === 'no_face') {
        return canvas; // blank background for face loss testing
    }

    const centerX = width / 2 + (scenario === 'head_turn' ? width * 0.15 : 0);
    const centerY = height / 2;
    const faceRadius = Math.min(width, height) * 0.3;

    // face oval
    ctx.fillStyle = '#f1c27d';
    ctx.beginPath();
    ctx.ellipse(centerX, centerY, faceRadius * 0.8, faceRadius, 0, 0, Math.PI * 2);
    ctx.fill();

    // eyes
    const eyeOffsetX = faceRadius * 0.4;
    const eyeOffsetY = -faceRadius * 0.15;
    const eyeWidth = faceRadius * 0.25;
    const isBlinking = (scenario === 'blink');
    const eyeHeight = isBlinking ? 2 : faceRadius * 0.12;

    // left eye
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(centerX - eyeOffsetX, centerY + eyeOffsetY, eyeWidth, eyeHeight, 0, 0, Math.PI * 2);
    ctx.fill();
    if (!isBlinking) {
        ctx.fillStyle = '#4a2c11'; // iris
        ctx.beginPath();
        ctx.arc(centerX - eyeOffsetX, centerY + eyeOffsetY, eyeHeight * 0.8, 0, Math.PI * 2);
        ctx.fill();
    }

    // right eye
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(centerX + eyeOffsetX, centerY + eyeOffsetY, eyeWidth, eyeHeight, 0, 0, Math.PI * 2);
    ctx.fill();
    if (!isBlinking) {
        ctx.fillStyle = '#4a2c11';
        ctx.beginPath();
        ctx.arc(centerX + eyeOffsetX, centerY + eyeOffsetY, eyeHeight * 0.8, 0, Math.PI * 2);
        ctx.fill();
    }

    // nose
    ctx.strokeStyle = '#d4a373';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY - faceRadius * 0.05);
    ctx.lineTo(centerX - faceRadius * 0.05, centerY + faceRadius * 0.15);
    ctx.lineTo(centerX + faceRadius * 0.05, centerY + faceRadius * 0.15);
    ctx.stroke();

    // mouth
    ctx.fillStyle = '#c56c86';
    ctx.beginPath();
    ctx.ellipse(centerX, centerY + faceRadius * 0.45, faceRadius * 0.25, faceRadius * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();

    return canvas;
}

/** jsdoc
 * benchmark runner comparing two or more adapters across standard scenarios
 */
export class AdapterBenchmarkRunner {
    constructor() {
        this.isRunning = false;
    }

    /** jsdoc
     * run full benchmark suite
     * @param {Object} options
     * @param {number} options.iterationsPerScenario - iterations per test frame (default 15)
     * @param {HTMLVideoElement} [options.liveVideo] - optional live video element to include live frames
     * @param {(progress: { stage: string, percent: number }) => void} [onProgress]
     * @returns {Promise<Object>} detailed comparison report
     */
    async runBenchmark(options = {}, onProgress = null) {
        if (this.isRunning) throw new Error('Benchmark is already in progress');
        this.isRunning = true;

        const iterations = options.iterationsPerScenario || 15;
        const liveVideo = options.liveVideo || null;

        logToUI('Starting Face Adapter Benchmark Suite...', true, 'info');

        const adaptersToTest = [
            { id: 'tfjs', name: 'TFJS FaceMesh (Current)', create: () => new TfjsFaceMeshAdapter() },
            { id: 'mediapipe-gpu', name: 'MediaPipe Vision Tasks (GPU)', create: () => new MediaPipeVisionFaceAdapter({ delegate: 'GPU' }) },
            { id: 'mediapipe-cpu', name: 'MediaPipe Vision Tasks (CPU)', create: () => new MediaPipeVisionFaceAdapter({ delegate: 'CPU' }) }
        ];

        // prepare test scenarios
        const scenarios = [
            { id: 'aspect_16_9', desc: '16:9 Standard Face (640x360)', canvas: createSyntheticTestFrame(640, 360, 'standard') },
            { id: 'aspect_4_3', desc: '4:3 Standard Face (640x480)', canvas: createSyntheticTestFrame(640, 480, 'standard') },
            { id: 'aspect_1_1', desc: '1:1 Square Face (480x480)', canvas: createSyntheticTestFrame(480, 480, 'standard') },
            { id: 'head_turn', desc: 'Head Turn / Off-Center (640x480)', canvas: createSyntheticTestFrame(640, 480, 'head_turn') },
            { id: 'eyes_closed', desc: 'Eyes Closed / Blink (640x480)', canvas: createSyntheticTestFrame(640, 480, 'blink') },
            { id: 'no_face', desc: 'Face Loss / No Face (640x480)', canvas: createSyntheticTestFrame(640, 480, 'no_face') }
        ];

        if (liveVideo && liveVideo.readyState >= 2) {
            scenarios.push({ id: 'live_camera', desc: 'Live Camera Feed', source: liveVideo });
        }

        const results = {};
        const totalSteps = adaptersToTest.length * scenarios.length * iterations;
        let completedSteps = 0;

        for (const adapterConfig of adaptersToTest) {
            logToUI(`Benchmarking ${adapterConfig.name}...`, false, 'info');
            const adapterResults = {
                adapterId: adapterConfig.id,
                adapterName: adapterConfig.name,
                initTimeMs: 0,
                initSuccess: false,
                initError: null,
                scenarios: {},
                overallMetrics: {
                    totalInferences: 0,
                    latencies: [],
                    facesDetected: 0,
                    faceLossCorrectlyDetected: 0,
                    tensorsLeaked: 0
                }
            };

            let adapterInstance = null;
            const initStart = performance.now();
            const initialTensors = (typeof tf !== 'undefined' && tf.memory) ? tf.memory().numTensors : 0;

            try {
                adapterInstance = adapterConfig.create();
                await adapterInstance.init();
                adapterResults.initTimeMs = Math.round(performance.now() - initStart);
                adapterResults.initSuccess = true;
            } catch (initErr) {
                adapterResults.initTimeMs = Math.round(performance.now() - initStart);
                adapterResults.initSuccess = false;
                adapterResults.initError = initErr.message;
                logToUI(`${adapterConfig.name} failed initialization: ${initErr.message}`, false, 'warn');
                results[adapterConfig.id] = adapterResults;
                continue;
            }

            // warmup inference
            try {
                await adapterInstance.estimateFaces(scenarios[0].canvas, performance.now());
            } catch (e) {
                console.warn('Warmup error:', e);
            }

            // run scenarios
            for (const scenario of scenarios) {
                const scenarioResult = {
                    id: scenario.id,
                    description: scenario.desc,
                    latencies: [],
                    detectionCount: 0,
                    detectedEARs: []
                };

                const inputSource = scenario.source || scenario.canvas;

                for (let i = 0; i < iterations; i++) {
                    const t0 = performance.now();
                    let faces = [];
                    try {
                        faces = await adapterInstance.estimateFaces(inputSource, t0);
                    } catch (infErr) {
                        console.error('Inference error in benchmark:', infErr);
                    }
                    const t1 = performance.now();
                    const latency = t1 - t0;

                    scenarioResult.latencies.push(latency);
                    adapterResults.overallMetrics.latencies.push(latency);
                    adapterResults.overallMetrics.totalInferences++;

                    const hasFace = (faces && faces.length > 0);
                    if (hasFace) {
                        scenarioResult.detectionCount++;
                        adapterResults.overallMetrics.facesDetected++;

                        // test landmark EAR if keypoints present
                        const kp = faces[0].keypoints;
                        if (kp && kp.length >= 468) {
                            const leftEar = computeEyeAspectRatio(kp[159], kp[145], kp[133], kp[33]);
                            if (leftEar !== null) scenarioResult.detectedEARs.push(leftEar);
                        }
                    } else if (scenario.id === 'no_face') {
                        adapterResults.overallMetrics.faceLossCorrectlyDetected++;
                    }

                    completedSteps++;
                    if (onProgress) {
                        onProgress({
                            stage: `${adapterConfig.name} - ${scenario.desc} (${i + 1}/${iterations})`,
                            percent: Math.round((completedSteps / totalSteps) * 100)
                        });
                    }

                    // yield thread for browser responsiveness
                    await new Promise(r => setTimeout(r, 4));
                }

                // compute scenario latency stats
                scenarioResult.meanLatencyMs = Math.round(mean(scenarioResult.latencies) * 10) / 10;
                scenarioResult.p50LatencyMs = Math.round(percentile(scenarioResult.latencies, 50) * 10) / 10;
                scenarioResult.p95LatencyMs = Math.round(percentile(scenarioResult.latencies, 95) * 10) / 10;
                scenarioResult.detectionRatePercent = Math.round((scenarioResult.detectionCount / iterations) * 100);

                adapterResults.scenarios[scenario.id] = scenarioResult;
            }

            // tensor check after test runs
            const finalTensors = (typeof tf !== 'undefined' && tf.memory) ? tf.memory().numTensors : 0;
            adapterResults.overallMetrics.tensorsLeaked = Math.max(0, finalTensors - initialTensors);

            // compute overall latency distribution
            const allLats = adapterResults.overallMetrics.latencies;
            adapterResults.overallMetrics.meanLatencyMs = Math.round(mean(allLats) * 10) / 10;
            adapterResults.overallMetrics.p50LatencyMs = Math.round(percentile(allLats, 50) * 10) / 10;
            adapterResults.overallMetrics.p95LatencyMs = Math.round(percentile(allLats, 95) * 10) / 10;
            adapterResults.overallMetrics.minLatencyMs = Math.round(Math.min(...allLats) * 10) / 10;
            adapterResults.overallMetrics.maxLatencyMs = Math.round(Math.max(...allLats) * 10) / 10;

            // dispose adapter
            adapterInstance.dispose();
            results[adapterConfig.id] = adapterResults;
        }

        this.isRunning = false;
        logToUI('Face Adapter Benchmark complete. Results generated.', false, 'success');

        const report = {
            timestamp: new Date().toISOString(),
            iterationsPerScenario: iterations,
            environment: {
                userAgent: navigator.userAgent,
                devicePixelRatio: window.devicePixelRatio || 1,
                hasWebGL: !!document.createElement('canvas').getContext('webgl2')
            },
            results,
            decisionNote: 'Per IMPLEMENTATION_PLAN.md: Adapter selection requires empirical benchmark verification. Do not switch adapters without verified reliability.'
        };

        return report;
    }
}

// math helpers
function mean(arr) {
    if (!arr || arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function percentile(arr, p) {
    if (!arr || arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    if (upper === lower) return sorted[lower];
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
