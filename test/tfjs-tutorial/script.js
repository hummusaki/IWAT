/**
 * get the car data reduced to just the variables we are interested
 * and cleaned of missing data.
 */
async function getData() {
    const carsDataResponse = await fetch('https://storage.googleapis.com/tfjs-tutorials/carsData.json');
    const carsData = await carsDataResponse.json();
    const cleaned = carsData.map(car => ({
        mpg: car.Miles_per_Gallon,
        horsepower: car.Horsepower,
    }))
        .filter(car => (car.mpg != null && car.horsepower != null));

    return cleaned;
}

function createModel() {
    // create a sequential model
    const model = tf.sequential();

    // add a single input layer and a sigmoid layer
    model.add(tf.layers.dense({ inputShape: [1], units: 1, useBias: true }));
    model.add(tf.layers.dense({ units: 100, activation: 'sigmoid' }));

    // add an output layer
    model.add(tf.layers.dense({ units: 1, useBias: true }));

    return model;
}

/**
 * convert the input data to tensors that we can use for machine
 * learning. We will also do the important best practices of _shuffling_
 * the data and _normalizing_ the data
 * MPG on the y-axis.
 */
function convertToTensor(data) {
    // wrapping these calculations in a tidy will dispose any
    // intermediate tensors.

    return tf.tidy(() => {
        // step 1. shuffle the data
        tf.util.shuffle(data);

        // step 2. convert data to Tensor
        const inputs = data.map(d => d.horsepower)
        const labels = data.map(d => d.mpg);

        const inputTensor = tf.tensor2d(inputs, [inputs.length, 1]);
        const labelTensor = tf.tensor2d(labels, [labels.length, 1]);

        // step 3. normalize the data to the range 0 - 1 using min-max scaling
        const inputMax = inputTensor.max();
        const inputMin = inputTensor.min();
        const labelMax = labelTensor.max();
        const labelMin = labelTensor.min();

        const normalizedInputs = inputTensor.sub(inputMin).div(inputMax.sub(inputMin));
        const normalizedLabels = labelTensor.sub(labelMin).div(labelMax.sub(labelMin));

        return {
            inputs: normalizedInputs,
            labels: normalizedLabels,
            // return the min/max bounds so we can use them later.
            inputMax,
            inputMin,
            labelMax,
            labelMin,
        }
    });
}

async function trainModel(model, inputs, labels) {
    // prepare the model for training.
    model.compile({
        optimizer: tf.train.adam(),
        loss: tf.losses.meanSquaredError,
        metrics: ['mse'],
    });

    const batchSize = 32;
    const epochs = 500;

    return await model.fit(inputs, labels, {
        batchSize,
        epochs,
        shuffle: true,
        callbacks: tfvis.show.fitCallbacks(
            { name: 'Training Performance' },
            ['loss', 'mse'],
            { height: 200, callbacks: ['onEpochEnd'] }
        )
    });
}

function testModel(model, inputData, normalizationData) {
    const { inputMax, inputMin, labelMin, labelMax } = normalizationData;

    // generate predictions for a uniform range of numbers between 0 and 1;
    // we un-normalize the data by doing the inverse of the min-max scaling
    // that we did earlier.
    const [xs, preds] = tf.tidy(() => {

        const xsNorm = tf.linspace(0, 1, 100);
        const predictions = model.predict(xsNorm.reshape([100, 1]));

        const unNormXs = xsNorm
            .mul(inputMax.sub(inputMin))
            .add(inputMin);

        const unNormPreds = predictions
            .mul(labelMax.sub(labelMin))
            .add(labelMin);

        // un-normalize the data
        return [unNormXs.dataSync(), unNormPreds.dataSync()];
    });


    const predictedPoints = Array.from(xs).map((val, i) => {
        return { x: val, y: preds[i] }
    });

    const originalPoints = inputData.map(d => ({
        x: d.horsepower, y: d.mpg,
    }));


    tfvis.render.scatterplot(
        { name: 'Model Predictions vs Original Data' },
        { values: [originalPoints, predictedPoints], series: ['original', 'predicted'] },
        {
            xLabel: 'Horsepower',
            yLabel: 'MPG',
            height: 300
        }
    );
}

async function run() {
    // load and plot the original input data that we are going to train on.
    const data = await getData();
    const values = data.map(d => ({
        x: d.horsepower,
        y: d.mpg,
    }));

    tfvis.render.scatterplot(
        { name: 'Horsepower v MPG' },
        { values },
        {
            xLabel: 'Horsepower',
            yLabel: 'MPG',
            height: 300
        }
    );

    // more code will be added below
    // create the model
    const model = createModel();
    tfvis.show.modelSummary({ name: 'Model Summary' }, model);
    // convert the data to a form we can use for training.
    const tensorData = convertToTensor(data);
    const { inputs, labels } = tensorData;

    // train the model
    await trainModel(model, inputs, labels);
    console.log('Done Training');

    // make some predictions using the model and compare them to the
    // original data
    testModel(model, data, tensorData);
}

document.addEventListener('DOMContentLoaded', run);