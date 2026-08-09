import { logToUI } from "./script.js";

export async function train(x_train, y_train) {
    logToUI('Training model...', true);
    const model = tf.sequential();

    // input layer
    model.add(tf.layers.dense({ inputShape: [4], units: 64, activation: 'relu' }));
    // hidden dense layer
    model.add(tf.layers.dense({ units: 32, activation: 'relu' }));
    // output layer
    model.add(tf.layers.dense({ units: 2, activation: 'linear' }));

    // compile the model
    model.compile({
        optimizer: tf.train.adam(),
        loss: 'meanSquaredError'
    });

    const x_trainTensor = tf.tensor2d(x_train);
    const y_trainTensor = tf.tensor2d(y_train);

    const epochs = 200;
    const progressContainer = document.getElementById('training-progress-container');
    const progressBar = document.getElementById('training-progress-bar');
    const progressText = document.getElementById('training-progress-text');

    if (progressContainer) progressContainer.style.display = 'block';

    await model.fit(x_trainTensor, y_trainTensor, {
        epochs: epochs,
        batchSize: 16,
        callbacks: {
            onEpochEnd: (epoch, logs) => {
                if (progressBar && progressText) {
                    const percent = Math.round(((epoch + 1) / epochs) * 100);
                    progressBar.style.width = `${percent}%`;
                    progressText.textContent = `${percent}%`;
                }
            }
        }
    });

    if (progressContainer) progressContainer.style.display = 'none';

    logToUI('Model trained.');
    await model.save('localstorage://IWAT-gaze-model');
}