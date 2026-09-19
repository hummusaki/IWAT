// dashboard.js - functional and accessible dashboard controller with deterministic tasks
import { createTaskManager, TASK_DEFINITIONS } from './dashboard-task.js';

document.addEventListener('DOMContentLoaded', () => {
    // parse url parameters to detect explicitly selected research fixture
    const urlParams = new URLSearchParams(window.location.search);
    const fixtureParam = urlParams.get('fixture') || urlParams.get('presentation');
    const initialPresentation = fixtureParam === 'difficult' ? 'difficult' : 'accessible';

    // initialize task manager instance
    const taskManager = createTaskManager({
        presentation: initialPresentation,
        activeTaskId: 'task-server-triage'
    });

    // expose task manager to window for programmatic inspection, testing, and parent bridge
    window.dashboardTaskManager = taskManager;
    window.dashboardTaskState = {
        getState: () => taskManager.getState(),
        getEvents: () => taskManager.getEventRecords(),
        reset: () => taskManager.resetTask()
    };

    // dom element cache
    const elements = {
        body: document.body,
        taskSelect: document.getElementById('task-select'),
        presentationSelect: document.getElementById('presentation-select'),
        taskStatusBadge: document.getElementById('task-status-badge'),
        taskObjectiveText: document.getElementById('task-objective-text'),
        taskInstructionsText: document.getElementById('task-instructions-text'),
        taskHintBox: document.getElementById('task-hint-box'),
        taskHintText: document.getElementById('task-hint-text'),
        taskHelpBtn: document.getElementById('task-help-btn'),
        taskResetBtn: document.getElementById('task-reset-btn'),
        // metrics
        metricTime: document.getElementById('metric-time'),
        metricErrors: document.getElementById('metric-errors'),
        metricCorrections: document.getElementById('metric-corrections'),
        metricHelp: document.getElementById('metric-help'),
        metricEvents: document.getElementById('metric-events'),
        // inline feedback
        feedbackContainer: document.getElementById('inline-feedback'),
        feedbackIcon: document.getElementById('feedback-icon'),
        feedbackMessage: document.getElementById('feedback-message'),
        feedbackDismissBtn: document.getElementById('feedback-dismiss-btn'),
        // form elements
        configForm: document.getElementById('config-form'),
        cfgMaxThreads: document.getElementById('cfg-max-threads'),
        cfgMemoryLimit: document.getElementById('cfg-memory-limit'),
        cfgFallbackStrategy: document.getElementById('cfg-fallback-strategy'),
        cfgAggressiveCaching: document.getElementById('cfg-aggressive-caching'),
        cfgSaveBtn: document.getElementById('cfg-save-btn'),
        cfgRevertBtn: document.getElementById('cfg-revert-btn'),
        // sidebar alerts
        sidebarBanner: document.querySelector('.sidebar-status-banner'),
        blinkingAlert: document.querySelector('.blinking-alert'),
        topBarHelp: document.getElementById('top-bar-help')
    };

    let feedbackTimeout = null;
    let timerInterval = null;

    /** jsdoc
     * displays accessible inline feedback notification replacing blocking alerts
     * @param {string} message
     * @param {'info'|'success'|'error'|'warning'} [type]
     * @param {number} [durationMs]
     */
    function showFeedback(message, type = 'info', durationMs = 6000) {
        if (!elements.feedbackContainer || !elements.feedbackMessage) return;

        if (feedbackTimeout) {
            clearTimeout(feedbackTimeout);
            feedbackTimeout = null;
        }

        elements.feedbackContainer.className = `inline-feedback feedback-${type}`;
        elements.feedbackMessage.textContent = message;

        const icons = {
            info: 'ℹ️',
            success: '✅',
            error: '⚠️',
            warning: '⚠️'
        };
        if (elements.feedbackIcon) {
            elements.feedbackIcon.textContent = icons[type] || 'ℹ️';
        }

        if (durationMs > 0) {
            feedbackTimeout = setTimeout(() => {
                elements.feedbackContainer.className = 'inline-feedback feedback-idle';
                elements.feedbackMessage.textContent = 'Ready. Select a task or perform actions to begin.';
                if (elements.feedbackIcon) elements.feedbackIcon.textContent = 'ℹ️';
            }, durationMs);
        }
    }

    /** jsdoc
     * updates presentation fixture styles and selectors
     * @param {'accessible'|'difficult'} presentation
     */
    function applyPresentation(presentation) {
        if (presentation === 'difficult') {
            elements.body.classList.add('fixture-difficult');
            if (elements.blinkingAlert) elements.blinkingAlert.style.display = 'block';
            if (elements.sidebarBanner) elements.sidebarBanner.style.display = 'none';
        } else {
            elements.body.classList.remove('fixture-difficult');
            if (elements.blinkingAlert) elements.blinkingAlert.style.display = 'none';
            if (elements.sidebarBanner) elements.sidebarBanner.style.display = 'block';
        }

        if (elements.presentationSelect) {
            elements.presentationSelect.value = presentation;
        }
    }

    /**
     * synchronizes task guidance display and instructions with active task
     */
    function renderTaskGuidance() {
        const active = taskManager.getActiveTask();
        if (!active || !active.definition) return;

        const { definition, state } = active;

        if (elements.taskSelect) {
            elements.taskSelect.value = definition.id;
        }
        if (elements.taskObjectiveText) {
            elements.taskObjectiveText.textContent = definition.objective;
        }
        if (elements.taskInstructionsText) {
            elements.taskInstructionsText.textContent = definition.instructions;
        }
        if (elements.taskHintText) {
            elements.taskHintText.textContent = definition.helpHint;
        }

        // update status badge
        if (elements.taskStatusBadge) {
            elements.taskStatusBadge.className = `task-badge badge-${state.status}`;
            const statusLabels = {
                idle: 'Status: Idle',
                in_progress: 'Status: In Progress',
                completed: 'Status: Completed'
            };
            elements.taskStatusBadge.textContent = statusLabels[state.status] || state.status;
        }

        updateMetricsDisplay(state);
    }

    /** jsdoc
     * updates live telemetry metrics numbers
     * @param {Object} state
     */
    function updateMetricsDisplay(state) {
        if (!state) {
            const active = taskManager.getActiveTask();
            state = active ? active.state : null;
        }
        if (!state) return;

        if (elements.metricErrors) elements.metricErrors.textContent = state.incorrectChoices;
        if (elements.metricCorrections) elements.metricCorrections.textContent = state.corrections;
        if (elements.metricHelp) elements.metricHelp.textContent = state.helpUsage;
        if (elements.metricEvents) elements.metricEvents.textContent = taskManager.getEventRecords().length;

        if (elements.metricTime) {
            if (state.status === 'completed' && state.completionTimeMs !== null) {
                elements.metricTime.textContent = (state.completionTimeMs / 1000).toFixed(2) + 's';
            } else if (state.status === 'in_progress' && state.startTime) {
                const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
                const elapsed = Math.max(0, (now - state.startTime) / 1000).toFixed(1);
                elements.metricTime.textContent = elapsed + 's';
            } else {
                elements.metricTime.textContent = '--';
            }
        }
    }

    /** 
     * synchronizes form fields from task manager form draft
     */
    function syncFormFromState() {
        const formData = taskManager.getFormData();
        if (elements.cfgMaxThreads) elements.cfgMaxThreads.value = formData.maxThreads || '1024';
        if (elements.cfgMemoryLimit) elements.cfgMemoryLimit.value = formData.memoryLimit || '8192';
        if (elements.cfgFallbackStrategy) elements.cfgFallbackStrategy.value = formData.fallbackStrategy || 'Route to failover';
        if (elements.cfgAggressiveCaching) elements.cfgAggressiveCaching.checked = Boolean(formData.aggressiveCaching);
    }

    /** jsdoc
     * gathers current form input values
     * @returns {Object}
     */
    function readFormValues() {
        return {
            maxThreads: elements.cfgMaxThreads ? elements.cfgMaxThreads.value.trim() : '1024',
            memoryLimit: elements.cfgMemoryLimit ? elements.cfgMemoryLimit.value.trim() : '8192',
            fallbackStrategy: elements.cfgFallbackStrategy ? elements.cfgFallbackStrategy.value : 'Route to failover',
            aggressiveCaching: elements.cfgAggressiveCaching ? elements.cfgAggressiveCaching.checked : false
        };
    }

    // start timer ticker for live elapsed duration
    timerInterval = setInterval(() => {
        const active = taskManager.getActiveTask();
        if (active && active.state && active.state.status === 'in_progress') {
            updateMetricsDisplay(active.state);
        }
    }, 200);

    // event listener: presentation selector
    if (elements.presentationSelect) {
        elements.presentationSelect.addEventListener('change', (e) => {
            const nextPresentation = e.target.value;
            taskManager.setPresentation(nextPresentation);
            applyPresentation(nextPresentation);
            showFeedback(
                nextPresentation === 'difficult'
                    ? 'Research fixture activated: Difficult presentation loaded. Task state and measurements preserved.'
                    : 'Accessible presentation activated: Standard high-contrast, labeled UI restored.',
                'info'
            );
        });
    }

    // event listener: task selector
    if (elements.taskSelect) {
        elements.taskSelect.addEventListener('change', (e) => {
            const selectedTaskId = e.target.value;
            taskManager.setActiveTask(selectedTaskId);
            if (elements.taskHintBox) {
                elements.taskHintBox.style.display = 'none';
            }
            if (elements.taskHelpBtn) {
                elements.taskHelpBtn.setAttribute('aria-expanded', 'false');
                elements.taskHelpBtn.textContent = 'Show Help & Hint';
            }
            renderTaskGuidance();
            showFeedback(`Task changed to: ${TASK_DEFINITIONS[selectedTaskId].title}`, 'info');
        });
    }

    // event listener: task help & hint button
    if (elements.taskHelpBtn) {
        elements.taskHelpBtn.addEventListener('click', () => {
            const active = taskManager.getActiveTask();
            if (!active) return;

            const isExpanded = elements.taskHelpBtn.getAttribute('aria-expanded') === 'true';
            const nextState = !isExpanded;

            elements.taskHelpBtn.setAttribute('aria-expanded', String(nextState));
            elements.taskHelpBtn.textContent = nextState ? 'Hide Help & Hint' : 'Show Help & Hint';

            if (elements.taskHintBox) {
                elements.taskHintBox.style.display = nextState ? 'block' : 'none';
            }

            if (nextState) {
                taskManager.recordHelpUsage(active.definition.id, {
                    trigger: 'help_button_clicked'
                });
                showFeedback(`Hint: ${active.definition.helpHint}`, 'info', 8000);
            }
            updateMetricsDisplay();
        });
    }

    // event listener: top bar help link
    if (elements.topBarHelp) {
        elements.topBarHelp.addEventListener('click', (e) => {
            e.preventDefault();
            const active = taskManager.getActiveTask();
            if (active) {
                taskManager.recordHelpUsage(active.definition.id, { trigger: 'top_bar_help_clicked' });
                showFeedback(`Task Guidance: ${active.definition.instructions}`, 'info', 8000);
                updateMetricsDisplay();
            }
        });
    }

    // event listener: task reset button
    if (elements.taskResetBtn) {
        elements.taskResetBtn.addEventListener('click', () => {
            const active = taskManager.getActiveTask();
            if (!active) return;

            taskManager.resetTask(active.definition.id);
            if (elements.taskHintBox) {
                elements.taskHintBox.style.display = 'none';
            }
            if (elements.taskHelpBtn) {
                elements.taskHelpBtn.setAttribute('aria-expanded', 'false');
                elements.taskHelpBtn.textContent = 'Show Help & Hint';
            }
            renderTaskGuidance();
            showFeedback(`Task ${active.definition.title} has been reset.`, 'info');
        });
    }

    // event listener: feedback dismiss button
    if (elements.feedbackDismissBtn) {
        elements.feedbackDismissBtn.addEventListener('click', () => {
            if (feedbackTimeout) clearTimeout(feedbackTimeout);
            elements.feedbackContainer.className = 'inline-feedback feedback-idle';
            elements.feedbackMessage.textContent = 'Ready. Select a task or perform actions to begin.';
            if (elements.feedbackIcon) elements.feedbackIcon.textContent = 'ℹ️';
        });
    }

    // event listeners: server table action buttons
    const tableButtons = document.querySelectorAll('.action-buttons .btn');
    tableButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const buttonEl = e.currentTarget;
            const action = buttonEl.getAttribute('data-action') || (buttonEl.classList.contains('btn-primary') ? 'restart' : 'isolate');
            const instanceId = buttonEl.getAttribute('data-instance') || buttonEl.closest('tr')?.getAttribute('data-instance') || 'unknown';

            const active = taskManager.getActiveTask();
            const isServerTask = active && active.definition.id === 'task-server-triage';

            if (isServerTask) {
                // target server is srv-cluster-a-02 and target action is restart
                if (instanceId === 'srv-cluster-a-02' && action === 'restart') {
                    const result = taskManager.completeTask('task-server-triage', {
                        instanceId,
                        action
                    });

                    if (result && result.alreadyCompleted) {
                        showFeedback('Task already completed. Reset task if you wish to run it again.', 'info');
                    } else {
                        showFeedback(
                            `Success: Overloaded server srv-cluster-a-02 restart initiated in ${(result.state.completionTimeMs / 1000).toFixed(2)}s! Task completed.`,
                            'success',
                            8000
                        );
                    }
                } else if (instanceId === 'srv-cluster-a-02' && action === 'isolate') {
                    taskManager.recordIncorrectChoice('task-server-triage', {
                        instanceId,
                        action,
                        reason: 'wrong_action_on_target_server'
                    });
                    showFeedback(
                        'Incorrect action: Isolate was triggered on srv-cluster-a-02. The task requires restarting the overloaded server.',
                        'error',
                        7000
                    );
                } else {
                    taskManager.recordIncorrectChoice('task-server-triage', {
                        instanceId,
                        action,
                        reason: 'incorrect_server_selected'
                    });
                    showFeedback(
                        `Incorrect choice: Server ${instanceId} is not the overloaded node. Check CPU % in the utilization matrix.`,
                        'error',
                        7000
                    );
                }
            } else {
                // generic table action feedback
                showFeedback(`Action '${action}' triggered for instance ${instanceId}.`, 'info');
            }

            renderTaskGuidance();
        });
    });

    // event listeners: form inputs to update draft state
    const formInputElements = [
        elements.cfgMaxThreads,
        elements.cfgMemoryLimit,
        elements.cfgFallbackStrategy,
        elements.cfgAggressiveCaching
    ].filter(Boolean);

    formInputElements.forEach(inputEl => {
        const handler = () => {
            const values = readFormValues();
            taskManager.updateFormData(values);
            const active = taskManager.getActiveTask();
            if (active && active.state && active.state.status === 'idle') {
                taskManager.startTask(active.definition.id);
                renderTaskGuidance();
            }
        };
        inputEl.addEventListener('input', handler);
        inputEl.addEventListener('change', handler);
    });

    // event listener: form submission (save configuration)
    if (elements.configForm) {
        elements.configForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const currentValues = readFormValues();
            taskManager.updateFormData(currentValues);

            const active = taskManager.getActiveTask();
            const isConfigTask = active && active.definition.id === 'task-config-update';

            if (isConfigTask) {
                const target = TASK_DEFINITIONS['task-config-update'].targetFormValues;
                const isMemoryCorrect = String(currentValues.memoryLimit).trim() === target.memoryLimit;
                const isStrategyCorrect = currentValues.fallbackStrategy === target.fallbackStrategy;

                if (isMemoryCorrect && isStrategyCorrect) {
                    const result = taskManager.completeTask('task-config-update', {
                        submitted: currentValues
                    });

                    if (result && result.alreadyCompleted) {
                        showFeedback('Task already completed. Reset task if you wish to run it again.', 'info');
                    } else {
                        showFeedback(
                            `Success: Configuration updated to ${currentValues.memoryLimit} MB memory and ${currentValues.fallbackStrategy} in ${(result.state.completionTimeMs / 1000).toFixed(2)}s! Task completed.`,
                            'success',
                            8000
                        );
                    }
                } else {
                    const reasons = [];
                    if (!isMemoryCorrect) reasons.push(`Memory Limit must be set to ${target.memoryLimit} MB (current: ${currentValues.memoryLimit})`);
                    if (!isStrategyCorrect) reasons.push(`Fallback Strategy must be '${target.fallbackStrategy}' (current: '${currentValues.fallbackStrategy}')`);

                    taskManager.recordIncorrectChoice('task-config-update', {
                        submitted: currentValues,
                        expected: target,
                        reasons
                    });

                    showFeedback(`Configuration error: ${reasons.join('; ')}.`, 'error', 8000);
                }
            } else {
                showFeedback('Settings saved successfully.', 'success');
            }

            renderTaskGuidance();
        });
    }

    // event listener: form revert button
    if (elements.cfgRevertBtn) {
        elements.cfgRevertBtn.addEventListener('click', () => {
            const defaults = {
                maxThreads: '1024',
                memoryLimit: '8192',
                fallbackStrategy: 'Route to failover',
                aggressiveCaching: false
            };
            taskManager.updateFormData(defaults);
            syncFormFromState();

            const active = taskManager.getActiveTask();
            if (active && active.definition.id === 'task-config-update') {
                taskManager.recordIncorrectChoice('task-config-update', {
                    reason: 'revert_clicked_during_task'
                });
                showFeedback(
                    'Configuration reverted to defaults. The task requires saving Memory Limit 16384 MB.',
                    'warning',
                    7000
                );
            } else {
                showFeedback('Configuration reverted to defaults.', 'info');
            }

            renderTaskGuidance();
        });
    }

    // initialize presentation & task display
    applyPresentation(taskManager.getPresentation());
    syncFormFromState();
    renderTaskGuidance();

    // subscribe to task manager events to refresh UI metrics
    taskManager.subscribe(() => {
        renderTaskGuidance();
    });
});
