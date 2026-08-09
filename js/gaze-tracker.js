import { logToUI } from "./script.js";

// create a hidden lower quality webcam feed canvas 
// to help the model process the data
const aiCanvas = document.createElement('canvas');
aiCanvas.width = 640;
aiCanvas.height = 480;
const ctx = aiCanvas.getContext('2d');


export async function initWebcam() {
    return new Promise(async (resolve, reject) => {
        const videoElement = document.getElementById('webcam-video');

        if (!videoElement) {
            logToUI('Error: Could not find webcam video element.');
            return;
        }

        try {
            logToUI('Requesting camera permissions...');
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'user'
                }
            });

            videoElement.srcObject = stream;

            // Wait for the video to be loaded and ready to play
            videoElement.onloadedmetadata = () => {
                videoElement.play();
                resolve(videoElement);
            };
        } catch (err) {
            logToUI(`Camera Error: ${err.message}`);
            console.error(err);
        }
    });

}

export async function initDetector() {
    try {
        // selecting the model architecture
        const model = faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh;

        // configuring the model
        const detectorConfig = {
            runtime: 'tfjs',
            maxFaces: 1,
            refineLandmarks: true
        };

        // downloading and initializing the model
        return await faceLandmarksDetection.createDetector(model, detectorConfig);

    } catch (err) {
        logToUI(`Detector Error: ${err.message}`);
        console.error(err);
    }
}

export function initGazeDataExtract(videoElement, detector, onTrackingStarted) {
    let hasTrackingStarted = false;

    // animation loop
    async function trackingLoop() {
        // draw image onto smaller canvas to help with processing
        ctx.drawImage(videoElement, 0, 0, aiCanvas.width, aiCanvas.height);

        // feed canvas to model
        const faces = await detector.estimateFaces(aiCanvas);

        if (faces.length > 0) {
            // placeholder log message
            const rightPupil = faces[0].keypoints[468];
            const leftPupil = faces[0].keypoints[473];

            // avg and normalize 0.0 to 1.0;
            const normalizedRX = rightPupil.x / aiCanvas.width;
            const normalizedRY = rightPupil.y / aiCanvas.height;
            const normalizedLX = leftPupil.x / aiCanvas.width;
            const normalizedLY = leftPupil.y / aiCanvas.height;
            
            if (!hasTrackingStarted && onTrackingStarted) {
                hasTrackingStarted = true;
                onTrackingStarted();
            }
        }

        requestAnimationFrame(trackingLoop);
    }

    trackingLoop();
}