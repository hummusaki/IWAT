// dashboard-task.js - task state manager and measurement logging for dashboard tasks

/** jsdoc
 * creates a frozen task event object
 * @param {string} eventType
 * @param {string} taskId
 * @param {string} presentation
 * @param {Object} details
 * @returns {Object}
 */
export function createTaskEvent(eventType, taskId, presentation, details = {}) {
    const timestamp = typeof performance !== 'undefined' && performance.now
        ? Number(performance.now().toFixed(2))
        : Date.now();

    return Object.freeze({
        eventId: 'evt_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now(),
        timestamp,
        isoTimestamp: new Date().toISOString(),
        eventType,
        taskId,
        presentation,
        details: Object.freeze({ ...details })
    });
}

/**
 * task definitions with explicit success criteria and instructions
 */
export const TASK_DEFINITIONS = Object.freeze({
    'task-server-triage': Object.freeze({
        id: 'task-server-triage',
        title: 'Triage Overloaded Server',
        objective: 'Identify the overloaded server instance and initiate restart remediation.',
        instructions: 'Examine the Global Server Utilization Matrix. Locate the server experiencing critical utilization (srv-cluster-a-02 at 99.9% CPU) and click its Restart action.',
        helpHint: 'Inspect the CPU % and Status indicators. Server srv-cluster-a-02 is critically overloaded. Click the Restart button for srv-cluster-a-02.',
        targetServer: 'srv-cluster-a-02',
        targetAction: 'restart',
        steps: Object.freeze([
            Object.freeze({
                id: 'step-locate',
                title: 'Identify Overloaded Server',
                description: 'Locate srv-cluster-a-02 exhibiting 99.9% CPU utilization in the matrix.'
            }),
            Object.freeze({
                id: 'step-action',
                title: 'Initiate Restart',
                description: 'Click the Restart action button for srv-cluster-a-02.'
            }),
            Object.freeze({
                id: 'step-verify',
                title: 'Verify Remediation',
                description: 'Confirm remediation success and check live metrics.'
            })
        ])
    }),
    'task-config-update': Object.freeze({
        id: 'task-config-update',
        title: 'Update Configuration Override',
        objective: 'Adjust configuration overrides to mitigate memory exhaustion and route failover.',
        instructions: 'In the Configuration Overrides panel, update Memory Limit (MB) to 16384 and set Fallback Strategy to "Route to failover", then click Save Configuration.',
        helpHint: 'Enter 16384 in Memory Limit (MB), select "Route to failover" from the Fallback Strategy menu, and click Save Configuration.',
        targetFormValues: Object.freeze({
            memoryLimit: '16384',
            fallbackStrategy: 'Route to failover'
        }),
        steps: Object.freeze([
            Object.freeze({
                id: 'step-memory',
                title: 'Set Memory Limit',
                description: 'Set Memory Limit (MB) to 16384.'
            }),
            Object.freeze({
                id: 'step-fallback',
                title: 'Set Fallback Strategy',
                description: 'Select "Route to failover" from the strategy menu.'
            }),
            Object.freeze({
                id: 'step-save',
                title: 'Save Configuration',
                description: 'Click Save Configuration to apply changes.'
            })
        ])
    })
});

/** jsdoc
 * creates a new task manager instance
 * @param {Object} [initialOptions]
 * @returns {Object}
 */
export function createTaskManager(initialOptions = {}) {
    // default presentation is accessible unless explicitly specified
    let presentation = initialOptions.presentation === 'difficult' ? 'difficult' : 'accessible';
    // default mode is standard unless explicitly specified
    let mode = initialOptions.mode === 'focused' ? 'focused' : 'standard';
    let activeTaskId = initialOptions.activeTaskId || 'task-server-triage';

    // draft form values preserved across mode and presentation switches
    let formData = {
        maxThreads: '1024',
        memoryLimit: '8192',
        fallbackStrategy: 'Route to failover',
        aggressiveCaching: false,
        ...(initialOptions.formData || {})
    };

    // per-task execution state
    const taskStates = {};
    for (const taskId of Object.keys(TASK_DEFINITIONS)) {
        taskStates[taskId] = {
            id: taskId,
            status: 'idle', // 'idle' | 'in_progress' | 'completed'
            startTime: null,
            endTime: null,
            completionTimeMs: null,
            incorrectChoices: 0,
            incorrectDetails: [],
            corrections: 0,
            helpUsage: 0,
            hasPendingError: false
        };
    }

    // append any pre-existing task state overrides
    if (initialOptions.taskStates) {
        for (const [id, state] of Object.entries(initialOptions.taskStates)) {
            if (taskStates[id]) {
                taskStates[id] = { ...taskStates[id], ...state };
            }
        }
    }

    // appendable event stream
    const events = Array.isArray(initialOptions.events) ? [...initialOptions.events] : [];
    const subscribers = new Set();

    // helper to notify subscribers
    function notify(eventType, data) {
        for (const sub of subscribers) {
            try {
                sub({ eventType, data, state: getState() });
            } catch (err) {
                // ignore subscriber errors
            }
        }
    }

    // helper to emit and record event
    function recordEvent(eventType, taskId, details = {}) {
        const event = createTaskEvent(eventType, taskId, presentation, details);
        events.push(event);
        notify(eventType, event);
        return event;
    }

    // helper to get current monotonic time
    function nowMs() {
        return typeof performance !== 'undefined' && performance.now
            ? Number(performance.now().toFixed(2))
            : Date.now();
    }

    /** jsdoc
     * returns current active task definition and state
     * @returns {Object}
     */
    function getActiveTask() {
        return {
            definition: TASK_DEFINITIONS[activeTaskId] || null,
            state: taskStates[activeTaskId] ? { ...taskStates[activeTaskId] } : null
        };
    }

    /** jsdoc
     * sets active task by id
     * @param {string} taskId
     * @returns {boolean}
     */
    function setActiveTask(taskId) {
        if (!TASK_DEFINITIONS[taskId]) {
            return false;
        }
        activeTaskId = taskId;
        notify('ACTIVE_TASK_CHANGED', { activeTaskId });
        return true;
    }

    /** jsdoc
     * starts active task timing if not started
     * @param {string} [taskId]
     * @returns {Object}
     */
    function startTask(taskId = activeTaskId) {
        const state = taskStates[taskId];
        if (!state) return null;

        if (state.status === 'idle') {
            state.status = 'in_progress';
            state.startTime = nowMs();
            recordEvent('TASK_START', taskId, {
                startTime: state.startTime
            });
        }
        return { ...state };
    }

    /** jsdoc
     * records an incorrect choice/action
     * @param {string} taskId
     * @param {Object} details
     * @returns {Object}
     */
    function recordIncorrectChoice(taskId = activeTaskId, details = {}) {
        const state = taskStates[taskId];
        if (!state) return null;

        // ensure task is started if not already
        if (state.status === 'idle') {
            startTask(taskId);
        }

        // if task is already completed, ignore actions
        if (state.status === 'completed') {
            return { alreadyCompleted: true, state: { ...state } };
        }

        state.incorrectChoices += 1;
        state.hasPendingError = true;
        state.incorrectDetails.push({
            timestamp: nowMs(),
            ...details
        });

        const evt = recordEvent('INCORRECT_CHOICE', taskId, {
            incorrectChoices: state.incorrectChoices,
            ...details
        });

        return { event: evt, state: { ...state } };
    }

    /** jsdoc
     * records help usage
     * @param {string} taskId
     * @param {Object} details
     * @returns {Object}
     */
    function recordHelpUsage(taskId = activeTaskId, details = {}) {
        const state = taskStates[taskId];
        if (!state) return null;

        if (state.status === 'idle') {
            startTask(taskId);
        }

        state.helpUsage += 1;
        const evt = recordEvent('HELP_REQUESTED', taskId, {
            helpUsage: state.helpUsage,
            ...details
        });

        return { event: evt, state: { ...state } };
    }

    /** jsdoc
     * records a correction action
     * @param {string} taskId
     * @param {Object} details
     * @returns {Object|null}
     */
    function recordCorrection(taskId = activeTaskId, details = {}) {
        const state = taskStates[taskId];
        if (!state) return null;

        if (state.hasPendingError) {
            state.corrections += 1;
            state.hasPendingError = false;
            const evt = recordEvent('CORRECTION', taskId, {
                corrections: state.corrections,
                ...details
            });
            return { event: evt, state: { ...state } };
        }
        return null;
    }

    /** jsdoc
     * completes task with verification against duplicate completions
     * @param {string} taskId
     * @param {Object} details
     * @returns {Object}
     */
    function completeTask(taskId = activeTaskId, details = {}) {
        const state = taskStates[taskId];
        if (!state) return null;

        // prevent duplicate completion events
        if (state.status === 'completed') {
            return {
                alreadyCompleted: true,
                state: { ...state }
            };
        }

        // ensure start time exists
        if (!state.startTime) {
            state.startTime = nowMs();
        }

        // if there was a pending error, this success counts as a correction
        if (state.hasPendingError) {
            recordCorrection(taskId, { reason: 'corrected_at_completion', ...details });
        }

        state.status = 'completed';
        state.endTime = nowMs();
        state.completionTimeMs = Number((state.endTime - state.startTime).toFixed(2));

        const evt = recordEvent('TASK_COMPLETED', taskId, {
            completionTimeMs: state.completionTimeMs,
            incorrectChoices: state.incorrectChoices,
            corrections: state.corrections,
            helpUsage: state.helpUsage,
            ...details
        });

        return {
            event: evt,
            state: { ...state }
        };
    }

    /** jsdoc
     * resets task to idle state
     * @param {string} taskId
     * @returns {Object}
     */
    function resetTask(taskId = activeTaskId) {
        const state = taskStates[taskId];
        if (!state) return null;

        state.status = 'idle';
        state.startTime = null;
        state.endTime = null;
        state.completionTimeMs = null;
        state.incorrectChoices = 0;
        state.incorrectDetails = [];
        state.corrections = 0;
        state.helpUsage = 0;
        state.hasPendingError = false;

        const evt = recordEvent('TASK_RESET', taskId);
        return { event: evt, state: { ...state } };
    }

    /** jsdoc
     * updates presentation fixture ('accessible' | 'difficult')
     * @param {string} newPresentation
     * @returns {string}
     */
    function setPresentation(newPresentation) {
        const normalized = newPresentation === 'difficult' ? 'difficult' : 'accessible';
        if (presentation !== normalized) {
            presentation = normalized;
            recordEvent('PRESENTATION_CHANGED', activeTaskId, { presentation });
        }
        return presentation;
    }

    /** jsdoc
     * gets current presentation fixture
     * @returns {string}
     */
    function getPresentation() {
        return presentation;
    }

    /** jsdoc
     * updates adaptation mode ('standard' | 'focused')
     * @param {string} newMode
     * @param {string} [reason]
     * @returns {boolean}
     */
    function setMode(newMode, reason = 'manual') {
        if (newMode !== 'standard' && newMode !== 'focused') {
            return false;
        }
        if (mode === newMode) {
            return false;
        }
        const fromMode = mode;
        mode = newMode;
        recordEvent('MODE_CHANGED', activeTaskId, {
            fromMode,
            toMode: mode,
            reason
        });
        notify('MODE_CHANGED', { mode, fromMode, reason });
        return true;
    }

    /** jsdoc
     * gets current adaptation mode
     * @returns {string}
     */
    function getMode() {
        return mode;
    }

    /** jsdoc
     * evaluates step progress for specified task
     * @param {string} [taskId]
     * @returns {Array<Object>}
     */
    function getTaskStepsProgress(taskId = activeTaskId) {
        const def = TASK_DEFINITIONS[taskId];
        if (!def || !def.steps) return [];
        const state = taskStates[taskId];

        return def.steps.map((step, idx) => {
            let isComplete = false;
            let isCurrent = false;

            if (taskId === 'task-server-triage') {
                if (state.status === 'completed') {
                    isComplete = true;
                } else if (idx === 0) {
                    isCurrent = state.status === 'idle';
                    isComplete = state.status === 'in_progress';
                } else if (idx === 1) {
                    isCurrent = state.status === 'in_progress';
                } else if (idx === 2) {
                    isCurrent = false;
                }
            } else if (taskId === 'task-config-update') {
                if (state.status === 'completed') {
                    isComplete = true;
                } else {
                    const memOk = String(formData.memoryLimit).trim() === '16384';
                    const stratOk = formData.fallbackStrategy === 'Route to failover';

                    if (idx === 0) {
                        isComplete = memOk;
                        isCurrent = !memOk;
                    } else if (idx === 1) {
                        isComplete = stratOk;
                        isCurrent = memOk && !stratOk;
                    } else if (idx === 2) {
                        isComplete = false;
                        isCurrent = memOk && stratOk;
                    }
                }
            }

            return {
                id: step.id,
                title: step.title,
                description: step.description,
                isComplete,
                isCurrent: isComplete ? false : isCurrent
            };
        });
    }

    /** jsdoc
     * updates form draft data to preserve input across mode switches
     * @param {Object} updates
     * @returns {Object}
     */
    function updateFormData(updates = {}) {
        formData = {
            ...formData,
            ...updates
        };
        recordEvent('INPUT_CHANGED', activeTaskId, {
            updatedFields: Object.keys(updates)
        });
        return { ...formData };
    }

    /** jsdoc
     * gets current form draft data
     * @returns {Object}
     */
    function getFormData() {
        return { ...formData };
    }

    /** jsdoc
     * returns deep snapshot of entire task manager state
     * @returns {Object}
     */
    function getState() {
        const clonedTaskStates = {};
        for (const [id, state] of Object.entries(taskStates)) {
            clonedTaskStates[id] = {
                ...state,
                incorrectDetails: [...state.incorrectDetails]
            };
        }

        return {
            activeTaskId,
            presentation,
            mode,
            formData: { ...formData },
            taskStates: clonedTaskStates,
            events: [...events]
        };
    }

    /** jsdoc
     * restores task manager state from a saved snapshot
     * @param {Object} savedState
     * @returns {boolean}
     */
    function restoreState(savedState) {
        if (!savedState || typeof savedState !== 'object') {
            return false;
        }

        if (savedState.presentation) {
            presentation = savedState.presentation === 'difficult' ? 'difficult' : 'accessible';
        }
        if (savedState.mode) {
            mode = savedState.mode === 'focused' ? 'focused' : 'standard';
        }
        if (savedState.activeTaskId && TASK_DEFINITIONS[savedState.activeTaskId]) {
            activeTaskId = savedState.activeTaskId;
        }
        if (savedState.formData && typeof savedState.formData === 'object') {
            formData = { ...formData, ...savedState.formData };
        }
        if (savedState.taskStates && typeof savedState.taskStates === 'object') {
            for (const [id, st] of Object.entries(savedState.taskStates)) {
                if (taskStates[id]) {
                    taskStates[id] = {
                        ...taskStates[id],
                        ...st,
                        incorrectDetails: Array.isArray(st.incorrectDetails) ? [...st.incorrectDetails] : []
                    };
                }
            }
        }
        if (Array.isArray(savedState.events)) {
            events.length = 0;
            events.push(...savedState.events);
        }

        notify('STATE_RESTORED', { state: getState() });
        return true;
    }

    /** jsdoc
     * returns all recorded event records
     * @returns {Array<Object>}
     */
    function getEventRecords() {
        return [...events];
    }

    /** jsdoc
     * registers a state change listener
     * @param {Function} callback
     * @returns {Function} unsubscribe function
     */
    function subscribe(callback) {
        subscribers.add(callback);
        return () => subscribers.delete(callback);
    }

    return {
        definitions: TASK_DEFINITIONS,
        getActiveTask,
        setActiveTask,
        startTask,
        recordIncorrectChoice,
        recordCorrection,
        recordHelpUsage,
        completeTask,
        resetTask,
        setPresentation,
        getPresentation,
        setMode,
        getMode,
        getTaskStepsProgress,
        updateFormData,
        getFormData,
        getState,
        restoreState,
        getEventRecords,
        subscribe
    };
}
