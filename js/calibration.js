import { logToUI } from "./script.js";
import { currentGaze } from "./gaze-tracker.js";

// screen positions for dots
const xPositions = [10, 36.6, 63.3, 90];
const yPositions = [10, 50, 90];

let overlay;
let completedDots = 0;
const totalDots = 12;

export function checkExistingCalibration() {
    const x = localStorage.getItem('calibration_x_train');
    const y = localStorage.getItem('calibration_y_train');
    if (x && y) {
        return [JSON.parse(x), JSON.parse(y)];
    }
    return null;
}

export async function checkExistingModel() {
    const models = await tf.io.listModels();
    return models['localstorage://IWAT-gaze-model'] != null;
}

export async function startCalibration() {
    return new Promise(async (resolve, reject) => {
        overlay = document.getElementById('calibration-overlay');
        let x_train = [] // iris coords
        let y_train = [] // screen coords

        // if overlay is not present stop code from running
        if (!overlay) {
            console.error('Calibration overlay not found.');
            return;
        }
        // creates dots
        for (let y of yPositions) {
            for (let x of xPositions) {
                const dot = document.createElement('div');
                dot.className = 'calibration-dot';
                dot.style.left = `calc(${x}% - 20px)`; // adjust for center of 40x40 dot
                dot.style.top = `calc(${y}% - 20px)`;
                dot.textContent = 0;

                let clickCount = 0;

                // handle click event for each dot
                dot.addEventListener('click', async function () {
                    if (!this.classList.contains('completed')) {
                        clickCount++;
                        this.textContent = clickCount;

                        // latest frame gaze data
                        if (currentGaze) {
                            x_train.push([...currentGaze]); // pass by value to not reference updated gaze frame
                            y_train.push([x / 100, y / 100]); // normalized target screen coords
                        }

                        // reduce opacity slightly with each click
                        this.style.opacity = 1 - (clickCount * 0.15);

                        if (clickCount >= 5) {
                            this.classList.add('completed');
                            this.style.opacity = 1; // restore opacity for completed state
                            this.textContent = '✓';
                            completedDots++;

                            if (completedDots === totalDots) {
                                console.log("Collected Calibration Data:");
                                console.log("X_Train (Iris Coords):", x_train);
                                console.log("Y_Train (Screen %):", y_train);

                                // save to local storage
                                localStorage.setItem('calibration_x_train', JSON.stringify(x_train));
                                localStorage.setItem('calibration_y_train', JSON.stringify(y_train));

                                await completeCalibration();
                                resolve([x_train, y_train]); // correctly resolve here with the populated arrays
                            }
                        }
                    }
                });

                // assemble html element before placing it in the page
                overlay.appendChild(dot);
            }
        }
    })

}

// displays the dots
export function showCalibration() {
    if (overlay && overlay.style.display === 'none') {
        overlay.style.display = 'flex';
        logToUI('Starting calibration...', true);
    }
}

function completeCalibration() {
    return new Promise((resolveTimer) => {
        setTimeout(() => {
            if (overlay) {
                overlay.style.opacity = '0';
                setTimeout(() => {
                    overlay.style.display = 'none';
                    logToUI('Calibration complete.');
                    resolveTimer();
                }, 500); // match transition time in css
            } else {
                resolveTimer();
            }
        }, 500); // slight delay before disappearing
    });
}
