// dashboard-mode.test.js - unit tests for standard and focused adaptation modes
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskManager, TASK_DEFINITIONS } from '../js/dashboard-task.js';

test('task manager initializes with standard adaptation mode by default', () => {
    const mgr = createTaskManager();
    assert.equal(mgr.getMode(), 'standard');
    const state = mgr.getState();
    assert.equal(state.mode, 'standard');
});

test('task manager honors explicit focused initial mode parameter', () => {
    const mgr = createTaskManager({ mode: 'focused' });
    assert.equal(mgr.getMode(), 'focused');
    const state = mgr.getState();
    assert.equal(state.mode, 'focused');
});

test('setMode validates allowed modes and rejects invalid mode values', () => {
    const mgr = createTaskManager();
    assert.equal(mgr.getMode(), 'standard');

    // invalid values
    assert.equal(mgr.setMode('invalid_mode'), false);
    assert.equal(mgr.setMode(''), false);
    assert.equal(mgr.setMode(null), false);
    assert.equal(mgr.setMode(undefined), false);
    assert.equal(mgr.setMode(123), false);

    // mode remains unchanged
    assert.equal(mgr.getMode(), 'standard');

    // no events recorded for invalid calls
    const events = mgr.getEventRecords();
    const modeEvents = events.filter(e => e.eventType === 'MODE_CHANGED');
    assert.equal(modeEvents.length, 0);
});

test('setMode is idempotent and repeated requests do not duplicate events', () => {
    const mgr = createTaskManager();
    assert.equal(mgr.getMode(), 'standard');

    // switch to focused
    const changed1 = mgr.setMode('focused', 'user_toggle');
    assert.equal(changed1, true);
    assert.equal(mgr.getMode(), 'focused');

    const eventsAfterFirst = mgr.getEventRecords();
    const modeEventsFirst = eventsAfterFirst.filter(e => e.eventType === 'MODE_CHANGED');
    assert.equal(modeEventsFirst.length, 1);
    assert.equal(modeEventsFirst[0].details.fromMode, 'standard');
    assert.equal(modeEventsFirst[0].details.toMode, 'focused');
    assert.equal(modeEventsFirst[0].details.reason, 'user_toggle');

    // repeated request for current mode
    const changed2 = mgr.setMode('focused', 'duplicate_call');
    assert.equal(changed2, false);
    assert.equal(mgr.getMode(), 'focused');

    const eventsAfterSecond = mgr.getEventRecords();
    const modeEventsSecond = eventsAfterSecond.filter(e => e.eventType === 'MODE_CHANGED');
    assert.equal(modeEventsSecond.length, 1); // no duplicate event added
});

test('actual mode transitions record timestamps, reasons, and presentation tags', () => {
    const mgr = createTaskManager({ presentation: 'accessible' });
    mgr.setActiveTask('task-server-triage');

    mgr.setMode('focused', 'automated_adaptation');
    const events = mgr.getEventRecords();
    const lastEvent = events[events.length - 1];

    assert.equal(lastEvent.eventType, 'MODE_CHANGED');
    assert.equal(lastEvent.taskId, 'task-server-triage');
    assert.equal(lastEvent.presentation, 'accessible');
    assert.equal(lastEvent.details.fromMode, 'standard');
    assert.equal(lastEvent.details.toMode, 'focused');
    assert.equal(lastEvent.details.reason, 'automated_adaptation');
    assert.ok(typeof lastEvent.timestamp === 'number');
    assert.ok(typeof lastEvent.isoTimestamp === 'string');
    assert.ok(lastEvent.eventId.startsWith('evt_'));

    // switch back to standard
    mgr.setMode('standard', 'user_restore');
    const events2 = mgr.getEventRecords();
    const returnEvent = events2[events2.length - 1];
    assert.equal(returnEvent.eventType, 'MODE_CHANGED');
    assert.equal(returnEvent.details.fromMode, 'focused');
    assert.equal(returnEvent.details.toMode, 'standard');
    assert.equal(returnEvent.details.reason, 'user_restore');
});

test('mode switching preserves partially completed task progress and measurements', () => {
    const mgr = createTaskManager();
    mgr.setActiveTask('task-server-triage');

    // start task and record partial progress in standard mode
    mgr.startTask('task-server-triage');
    mgr.recordIncorrectChoice('task-server-triage', { instanceId: 'srv-cluster-a-01' });
    mgr.recordHelpUsage('task-server-triage');

    const stateBeforeSwitch = mgr.getActiveTask().state;
    const initialStartTime = stateBeforeSwitch.startTime;
    assert.equal(stateBeforeSwitch.status, 'in_progress');
    assert.equal(stateBeforeSwitch.incorrectChoices, 1);
    assert.equal(stateBeforeSwitch.helpUsage, 1);
    assert.equal(stateBeforeSwitch.corrections, 0);

    // switch mode to focused during task
    mgr.setMode('focused', 'workload_detected');

    // verify task state, timing, and metrics are completely preserved
    const stateAfterSwitch = mgr.getActiveTask().state;
    assert.equal(stateAfterSwitch.status, 'in_progress');
    assert.equal(stateAfterSwitch.startTime, initialStartTime);
    assert.equal(stateAfterSwitch.incorrectChoices, 1);
    assert.equal(stateAfterSwitch.helpUsage, 1);
    assert.equal(stateAfterSwitch.corrections, 0);

    // complete task in focused mode
    const completion = mgr.completeTask('task-server-triage', { instanceId: 'srv-cluster-a-02' });
    assert.equal(completion.state.status, 'completed');
    assert.equal(completion.state.corrections, 1);
    assert.ok(completion.state.completionTimeMs > 0);

    // switch back to standard mode
    mgr.setMode('standard', 'task_done');
    const finalState = mgr.getActiveTask().state;
    assert.equal(finalState.status, 'completed');
    assert.equal(finalState.completionTimeMs, completion.state.completionTimeMs);
});

test('mode switching preserves user form draft values', () => {
    const mgr = createTaskManager();
    mgr.setActiveTask('task-config-update');

    // enter custom form drafts in standard mode
    mgr.updateFormData({
        maxThreads: '4096',
        memoryLimit: '16384',
        fallbackStrategy: 'Drop packets',
        aggressiveCaching: true
    });

    // switch to focused mode
    mgr.setMode('focused', 'test_switch');

    // verify form draft data is strictly preserved
    const draftInFocused = mgr.getFormData();
    assert.equal(draftInFocused.maxThreads, '4096');
    assert.equal(draftInFocused.memoryLimit, '16384');
    assert.equal(draftInFocused.fallbackStrategy, 'Drop packets');
    assert.equal(draftInFocused.aggressiveCaching, true);

    // update another field in focused mode
    mgr.updateFormData({ fallbackStrategy: 'Route to failover' });

    // switch back to standard mode
    mgr.setMode('standard', 'test_switch_back');
    const draftInStandard = mgr.getFormData();
    assert.equal(draftInStandard.fallbackStrategy, 'Route to failover');
    assert.equal(draftInStandard.memoryLimit, '16384');
});

test('state snapshot and restoration preserves mode state', () => {
    const mgr1 = createTaskManager();
    mgr1.setMode('focused', 'initial_setup');
    mgr1.updateFormData({ memoryLimit: '32768' });

    const snapshot = mgr1.getState();
    assert.equal(snapshot.mode, 'focused');

    const mgr2 = createTaskManager();
    assert.equal(mgr2.getMode(), 'standard');

    const success = mgr2.restoreState(snapshot);
    assert.equal(success, true);
    assert.equal(mgr2.getMode(), 'focused');
    assert.equal(mgr2.getFormData().memoryLimit, '32768');
});

test('getTaskStepsProgress returns task-relevant step guidance', () => {
    const mgr = createTaskManager();

    // server triage step progress
    mgr.setActiveTask('task-server-triage');
    const triageStepsIdle = mgr.getTaskStepsProgress('task-server-triage');
    assert.equal(triageStepsIdle.length, 3);
    assert.equal(triageStepsIdle[0].isCurrent, true);
    assert.equal(triageStepsIdle[0].isComplete, false);

    // complete server triage
    mgr.completeTask('task-server-triage');
    const triageStepsDone = mgr.getTaskStepsProgress('task-server-triage');
    assert.equal(triageStepsDone.every(s => s.isComplete), true);

    // config update step progress
    mgr.setActiveTask('task-config-update');
    const configStepsInitial = mgr.getTaskStepsProgress('task-config-update');
    assert.equal(configStepsInitial.length, 3);
    // memory limit is initially 8192, so step 0 is incomplete and current
    assert.equal(configStepsInitial[0].isComplete, false);
    assert.equal(configStepsInitial[0].isCurrent, true);

    // update memory limit to 16384
    mgr.updateFormData({ memoryLimit: '16384' });
    const configStepsMemDone = mgr.getTaskStepsProgress('task-config-update');
    assert.equal(configStepsMemDone[0].isComplete, true);
    // fallback strategy is 'Route to failover' by default, so step 1 is also satisfied
    assert.equal(configStepsMemDone[1].isComplete, true);
    assert.equal(configStepsMemDone[2].isCurrent, true);
});

test('adaptation modes remain strictly separate from difficult research fixture', () => {
    const mgr = createTaskManager({ presentation: 'difficult' });
    assert.equal(mgr.getPresentation(), 'difficult');
    assert.equal(mgr.getMode(), 'standard');

    // switch mode in difficult fixture
    mgr.setMode('focused', 'fixture_test');
    assert.equal(mgr.getMode(), 'focused');
    assert.equal(mgr.getPresentation(), 'difficult');

    const events = mgr.getEventRecords();
    const modeEvent = events[events.length - 1];
    assert.equal(modeEvent.eventType, 'MODE_CHANGED');
    assert.equal(modeEvent.presentation, 'difficult');
    assert.equal(modeEvent.details.toMode, 'focused');

    // change presentation does not affect mode
    mgr.setPresentation('accessible');
    assert.equal(mgr.getPresentation(), 'accessible');
    assert.equal(mgr.getMode(), 'focused');
});
