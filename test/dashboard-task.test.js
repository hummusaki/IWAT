// dashboard-task.test.js - unit tests for dashboard task state, timing, and measurement logging
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskManager, createTaskEvent, TASK_DEFINITIONS } from '../js/dashboard-task.js';

test('createTaskEvent constructs frozen event record with monotonic timestamp and id', () => {
    const evt = createTaskEvent('TASK_START', 'task-server-triage', 'accessible', { test: 123 });
    assert.ok(evt.eventId.startsWith('evt_'));
    assert.equal(evt.eventType, 'TASK_START');
    assert.equal(evt.taskId, 'task-server-triage');
    assert.equal(evt.presentation, 'accessible');
    assert.equal(evt.details.test, 123);
    assert.ok(typeof evt.timestamp === 'number');
    assert.ok(typeof evt.isoTimestamp === 'string');
    assert.throws(() => {
        evt.eventType = 'MUTATED';
    });
});

test('createTaskManager initializes with accessible presentation and server triage task by default', () => {
    const mgr = createTaskManager();
    assert.equal(mgr.getPresentation(), 'accessible');
    const active = mgr.getActiveTask();
    assert.equal(active.definition.id, 'task-server-triage');
    assert.equal(active.state.status, 'idle');
    assert.equal(active.state.incorrectChoices, 0);
    assert.equal(active.state.corrections, 0);
    assert.equal(active.state.helpUsage, 0);
});

test('createTaskManager honors explicit difficult fixture presentation parameter', () => {
    const mgr = createTaskManager({ presentation: 'difficult' });
    assert.equal(mgr.getPresentation(), 'difficult');
    mgr.startTask('task-server-triage');
    const events = mgr.getEventRecords();
    assert.equal(events[0].presentation, 'difficult');
});

test('task server triage records start, incorrect choice, correction, and completion', () => {
    const mgr = createTaskManager();
    mgr.setActiveTask('task-server-triage');

    // start task
    const started = mgr.startTask();
    assert.equal(started.status, 'in_progress');
    assert.ok(started.startTime > 0);

    // incorrect choice: user clicked healthy server
    const errRes = mgr.recordIncorrectChoice('task-server-triage', {
        instanceId: 'srv-cluster-a-01',
        action: 'restart'
    });
    assert.equal(errRes.state.incorrectChoices, 1);
    assert.equal(errRes.state.hasPendingError, true);

    // help usage
    const helpRes = mgr.recordHelpUsage('task-server-triage', { action: 'show_hint' });
    assert.equal(helpRes.state.helpUsage, 1);

    // correct action: user identified srv-cluster-a-02
    const compRes = mgr.completeTask('task-server-triage', {
        instanceId: 'srv-cluster-a-02',
        action: 'restart'
    });

    assert.equal(compRes.state.status, 'completed');
    assert.equal(compRes.state.incorrectChoices, 1);
    assert.equal(compRes.state.corrections, 1); // auto-records correction for pending error
    assert.equal(compRes.state.helpUsage, 1);
    assert.ok(compRes.state.completionTimeMs >= 0);

    // check events emitted
    const events = mgr.getEventRecords();
    const eventTypes = events.map(e => e.eventType);
    assert.deepEqual(eventTypes, [
        'TASK_START',
        'INCORRECT_CHOICE',
        'HELP_REQUESTED',
        'CORRECTION',
        'TASK_COMPLETED'
    ]);
});

test('completeTask rejects duplicate completion events without mutating timestamps or counts', () => {
    const mgr = createTaskManager();
    mgr.setActiveTask('task-server-triage');
    mgr.startTask();

    const first = mgr.completeTask('task-server-triage', { instanceId: 'srv-cluster-a-02' });
    assert.equal(first.state.status, 'completed');
    const firstEndTime = first.state.endTime;
    const firstDuration = first.state.completionTimeMs;
    const eventsBefore = mgr.getEventRecords().length;

    // duplicate completion attempt
    const second = mgr.completeTask('task-server-triage', { instanceId: 'srv-cluster-a-02' });
    assert.equal(second.alreadyCompleted, true);
    assert.equal(second.state.endTime, firstEndTime);
    assert.equal(second.state.completionTimeMs, firstDuration);

    // verify no duplicate event was added
    const eventsAfter = mgr.getEventRecords().length;
    assert.equal(eventsBefore, eventsAfter);
});

test('task config update tracks form drafts and verifies explicit target criteria', () => {
    const mgr = createTaskManager();
    mgr.setActiveTask('task-config-update');

    // default form draft
    const initialForm = mgr.getFormData();
    assert.equal(initialForm.memoryLimit, '8192');

    // update draft fields
    mgr.updateFormData({ memoryLimit: '4096' });
    assert.equal(mgr.getFormData().memoryLimit, '4096');

    // submitting wrong memory limit yields incorrect choice
    const target = TASK_DEFINITIONS['task-config-update'].targetFormValues;
    const current = mgr.getFormData();
    assert.notEqual(current.memoryLimit, target.memoryLimit);

    mgr.recordIncorrectChoice('task-config-update', {
        reason: 'mismatched_target_values',
        submitted: { ...current },
        expected: { ...target }
    });
    assert.equal(mgr.getActiveTask().state.incorrectChoices, 1);

    // update to correct target criteria
    mgr.updateFormData({ memoryLimit: '16384', fallbackStrategy: 'Route to failover' });
    const correctedForm = mgr.getFormData();
    assert.equal(correctedForm.memoryLimit, target.memoryLimit);
    assert.equal(correctedForm.fallbackStrategy, target.fallbackStrategy);

    // complete task
    const comp = mgr.completeTask('task-config-update', { submitted: correctedForm });
    assert.equal(comp.state.status, 'completed');
    assert.equal(comp.state.corrections, 1);
});

test('resetTask resets active task metrics cleanly', () => {
    const mgr = createTaskManager();
    mgr.startTask('task-server-triage');
    mgr.recordIncorrectChoice('task-server-triage');
    mgr.recordHelpUsage('task-server-triage');

    const resetRes = mgr.resetTask('task-server-triage');
    assert.equal(resetRes.state.status, 'idle');
    assert.equal(resetRes.state.startTime, null);
    assert.equal(resetRes.state.endTime, null);
    assert.equal(resetRes.state.incorrectChoices, 0);
    assert.equal(resetRes.state.corrections, 0);
    assert.equal(resetRes.state.helpUsage, 0);
});

test('presentation switching updates presentation and logs event', () => {
    const mgr = createTaskManager();
    assert.equal(mgr.getPresentation(), 'accessible');

    mgr.setPresentation('difficult');
    assert.equal(mgr.getPresentation(), 'difficult');

    const events = mgr.getEventRecords();
    const lastEvent = events[events.length - 1];
    assert.equal(lastEvent.eventType, 'PRESENTATION_CHANGED');
    assert.equal(lastEvent.details.presentation, 'difficult');
});

test('state serialization and hydration preserves form inputs and task progress', () => {
    const mgr1 = createTaskManager();
    mgr1.setActiveTask('task-config-update');
    mgr1.startTask('task-config-update');
    mgr1.updateFormData({
        maxThreads: '2048',
        memoryLimit: '16384',
        fallbackStrategy: 'Route to failover',
        aggressiveCaching: true
    });
    mgr1.recordIncorrectChoice('task-config-update', { reason: 'test_error' });
    mgr1.recordHelpUsage('task-config-update');

    // take snapshot
    const snapshot = mgr1.getState();

    // instantiate fresh manager and restore
    const mgr2 = createTaskManager();
    assert.equal(mgr2.getFormData().memoryLimit, '8192');

    const success = mgr2.restoreState(snapshot);
    assert.equal(success, true);
    assert.equal(mgr2.getActiveTask().definition.id, 'task-config-update');
    assert.equal(mgr2.getActiveTask().state.incorrectChoices, 1);
    assert.equal(mgr2.getActiveTask().state.helpUsage, 1);

    // form values preserved
    const restoredForm = mgr2.getFormData();
    assert.equal(restoredForm.maxThreads, '2048');
    assert.equal(restoredForm.memoryLimit, '16384');
    assert.equal(restoredForm.fallbackStrategy, 'Route to failover');
    assert.equal(restoredForm.aggressiveCaching, true);
});
