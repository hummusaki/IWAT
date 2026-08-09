import { logToUI } from "./script.js";

// screen positions for dots
const xPositions = [10, 36.6, 63.3, 90];
const yPositions = [10, 50, 90];

let overlay;
let completedDots = 0;
const totalDots = 12;

export function setupCalibration() {
    overlay = document.getElementById('calibration-overlay');

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
            dot.addEventListener('click', function () {
                if (!this.classList.contains('completed')) {
                    clickCount++;
                    this.textContent = clickCount;

                    // reduce opacity slightly with each click
                    this.style.opacity = 1 - (clickCount * 0.15);

                    if (clickCount >= 5) {
                        this.classList.add('completed');
                        this.style.opacity = 1; // restore opacity for completed state
                        this.textContent = '✓';
                        completedDots++;

                        if (completedDots === totalDots) {
                            completeCalibration();
                        }
                    }
                }
            });

            // assemble html element before placing it in the page
            overlay.appendChild(dot);
        }
    }
}

// displays the dots
export function showCalibration() {
    if (overlay && overlay.style.display === 'none') {
        overlay.style.display = 'flex';
        logToUI('Starting calibration...', true);
    }
}

function completeCalibration() {
    setTimeout(() => {
        if (overlay) {
            overlay.style.opacity = '0';
            setTimeout(() => {
                overlay.style.display = 'none';
                logToUI('Calibration complete.', true);
            }, 500); // match transition time in css
        }
    }, 500); // slight delay before disappearing
}
