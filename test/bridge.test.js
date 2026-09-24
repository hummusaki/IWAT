// bridge.test.js - automated unit and integration tests for parent-iframe adaptation bridge
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BRIDGE_PROTOCOL,
    PROTOCOL_VERSION,
    BRIDGE_MESSAGE_TYPES,
    ALLOWED_ADAPTATION_MODES,
    ACK_STATUS,
    generateToken,
    validateEnvelope,
    validateSetModePayload,
    validateModeAckPayload,
    createDashboardBridge,
    createParentBridge
} from '../js/adaptation/bridge.js';
import { createTaskManager } from '../js/dashboard-task.js';

/** jsdoc
 * creates a mock window object supporting message event dispatching
 * @param {string} [origin]
 * @returns {Object}
 */
function createMockWindow(origin = 'http://localhost:8080') {
    const listeners = new Map();
    const win = {
        location: { origin, protocol: 'http:' },
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
            if (!listeners.has(type)) return;
            const list = listeners.get(type);
            const idx = list.indexOf(fn);
            if (idx >= 0) list.splice(idx, 1);
        },
        dispatchMessage(data, eventOrigin, source) {
            const list = listeners.get('message') || [];
            for (const fn of [...list]) {
                fn({ data, origin: eventOrigin, source });
            }
        }
    };
    return win;
}

/** jsdoc
 * creates a paired mock environment linking parent and child iframe windows
 * @param {Object} [options]
 * @param {string} [options.parentOrigin]
 * @param {string} [options.childOrigin]
 * @returns {Object}
 */
function createBridgePair(options = {}) {
    const parentOrigin = options.parentOrigin || 'http://localhost:8080';
    const childOrigin = options.childOrigin || 'http://localhost:8080';

    const parentWin = createMockWindow(parentOrigin);
    const childWin = createMockWindow(childOrigin);

    // mock iframe element
    const iframeElement = {
        contentWindow: childWin,
        addEventListener: (event, fn) => {},
        removeEventListener: (event, fn) => {}
    };

    // cross-wire postMessage
    parentWin.postMessage = (data, targetOrigin) => {
        // drop if wildcard is attempted
        if (targetOrigin === '*') {
            throw new Error('Wildcard targetOrigin forbidden');
        }
        // delivery to parentWin with sender childWin
        if (targetOrigin === parentOrigin) {
            parentWin.dispatchMessage(data, childOrigin, childWin);
        }
    };

    childWin.postMessage = (data, targetOrigin) => {
        if (targetOrigin === '*') {
            throw new Error('Wildcard targetOrigin forbidden');
        }
        // delivery to childWin with sender parentWin
        if (targetOrigin === childOrigin) {
            childWin.dispatchMessage(data, parentOrigin, parentWin);
        }
    };

    childWin.parent = parentWin;

    return { parentWin, childWin, iframeElement, parentOrigin, childOrigin };
}

// 1. envelope & payload schema validation tests
test('validateEnvelope accepts valid protocol messages', () => {
    const valid = {
        protocol: BRIDGE_PROTOCOL,
        version: PROTOCOL_VERSION,
        type: BRIDGE_MESSAGE_TYPES.HANDSHAKE_INIT,
        sessionToken: 'session_123',
        timestamp: 100.5,
        payload: { test: true }
    };
    const res = validateEnvelope(valid);
    assert.equal(res.valid, true);
});

test('validateEnvelope rejects null, arrays, or non-objects', () => {
    assert.equal(validateEnvelope(null).valid, false);
    assert.equal(validateEnvelope(undefined).valid, false);
    assert.equal(validateEnvelope([]).valid, false);
    assert.equal(validateEnvelope('string').valid, false);
    assert.equal(validateEnvelope(123).valid, false);
});

test('validateEnvelope rejects incorrect protocol identifier', () => {
    const invalid = {
        protocol: 'WRONG_PROTOCOL',
        version: PROTOCOL_VERSION,
        type: BRIDGE_MESSAGE_TYPES.HANDSHAKE_INIT,
        sessionToken: 'session_123',
        timestamp: 100,
        payload: {}
    };
    const res = validateEnvelope(invalid);
    assert.equal(res.valid, false);
    assert.match(res.error, /Invalid protocol identifier/);
});

test('validateEnvelope rejects unsupported protocol version', () => {
    const invalid = {
        protocol: BRIDGE_PROTOCOL,
        version: '2.0',
        type: BRIDGE_MESSAGE_TYPES.HANDSHAKE_INIT,
        sessionToken: 'session_123',
        timestamp: 100,
        payload: {}
    };
    const res = validateEnvelope(invalid);
    assert.equal(res.valid, false);
    assert.match(res.error, /Unsupported protocol version/);
});

test('validateEnvelope rejects unknown message types', () => {
    const invalid = {
        protocol: BRIDGE_PROTOCOL,
        version: PROTOCOL_VERSION,
        type: 'NON_EXISTENT_TYPE',
        sessionToken: 'session_123',
        timestamp: 100,
        payload: {}
    };
    const res = validateEnvelope(invalid);
    assert.equal(res.valid, false);
    assert.match(res.error, /Unknown message type/);
});

test('validateEnvelope rejects missing or non-finite timestamp', () => {
    const invalid = {
        protocol: BRIDGE_PROTOCOL,
        version: PROTOCOL_VERSION,
        type: BRIDGE_MESSAGE_TYPES.HANDSHAKE_INIT,
        sessionToken: 'session_123',
        timestamp: NaN,
        payload: {}
    };
    assert.equal(validateEnvelope(invalid).valid, false);
});

test('validateEnvelope rejects missing sessionToken except for PING', () => {
    const missingToken = {
        protocol: BRIDGE_PROTOCOL,
        version: PROTOCOL_VERSION,
        type: BRIDGE_MESSAGE_TYPES.SET_MODE_REQUEST,
        sessionToken: '',
        timestamp: 100,
        payload: {}
    };
    assert.equal(validateEnvelope(missingToken).valid, false);

    const pingMessage = {
        protocol: BRIDGE_PROTOCOL,
        version: PROTOCOL_VERSION,
        type: BRIDGE_MESSAGE_TYPES.HANDSHAKE_PING,
        sessionToken: null,
        timestamp: 100,
        payload: {}
    };
    assert.equal(validateEnvelope(pingMessage).valid, true);
});

test('validateSetModePayload validates requestId and targetMode strictly', () => {
    assert.equal(validateSetModePayload({ requestId: 'req_1', targetMode: 'standard' }).valid, true);
    assert.equal(validateSetModePayload({ requestId: 'req_2', targetMode: 'focused' }).valid, true);

    // missing requestId
    assert.equal(validateSetModePayload({ targetMode: 'standard' }).valid, false);
    assert.equal(validateSetModePayload({ requestId: '', targetMode: 'standard' }).valid, false);

    // invalid modes
    assert.equal(validateSetModePayload({ requestId: 'req_3', targetMode: 'turbo' }).valid, false);
    assert.equal(validateSetModePayload({ requestId: 'req_4', targetMode: null }).valid, false);
    assert.equal(validateSetModePayload({ requestId: 'req_5', targetMode: 123 }).valid, false);
});

test('validateModeAckPayload validates status and appliedMode strictly', () => {
    assert.equal(validateModeAckPayload({ requestId: 'req_1', status: 'applied', appliedMode: 'focused' }).valid, true);
    assert.equal(validateModeAckPayload({ requestId: 'req_2', status: 'noop', appliedMode: 'standard' }).valid, true);
    assert.equal(validateModeAckPayload({ requestId: 'req_3', status: 'rejected', appliedMode: 'standard' }).valid, true);

    // invalid status
    assert.equal(validateModeAckPayload({ requestId: 'req_4', status: 'pending', appliedMode: 'standard' }).valid, false);
    // invalid appliedMode
    assert.equal(validateModeAckPayload({ requestId: 'req_5', status: 'applied', appliedMode: 'unknown' }).valid, false);
});

// 2. handshake and readiness tests
test('handshake completes with bidirectional readiness confirmation', () => {
    const pair = createBridgePair();
    const taskManager = createTaskManager({ mode: 'standard' });

    let parentHandshakePayload = null;
    const parentBridge = createParentBridge({
        iframe: () => pair.iframeElement,
        targetOrigin: pair.childOrigin,
        allowedOrigin: pair.childOrigin,
        windowRef: pair.parentWin,
        onHandshake: (payload) => {
            parentHandshakePayload = payload;
        }
    });

    const childBridge = createDashboardBridge({
        taskManager,
        targetOrigin: pair.parentOrigin,
        allowedOrigin: pair.parentOrigin,
        windowRef: pair.childWin,
        parentWindow: pair.parentWin
    });

    parentBridge.init();
    childBridge.init();

    assert.equal(childBridge.isConnected(), true);
    assert.equal(parentBridge.isHandshakeComplete(), true);
    assert.equal(parentBridge.getActiveSessionToken(), childBridge.getSessionToken());
    assert.equal(parentBridge.getObservedMode(), 'standard');
    assert.equal(parentHandshakePayload?.currentMode, 'standard');

    parentBridge.destroy();
    childBridge.destroy();
});

// 3. set-mode requests and correlated acknowledgments
test('parent can reliably request mode change and receives correlated applied acknowledgment', async () => {
    const pair = createBridgePair();
    const taskManager = createTaskManager({ mode: 'standard' });

    let parentModeChangedCall = null;
    const parentBridge = createParentBridge({
        iframe: () => pair.iframeElement,
        targetOrigin: pair.childOrigin,
        allowedOrigin: pair.childOrigin,
        windowRef: pair.parentWin,
        onModeChanged: (info) => {
            parentModeChangedCall = info;
        }
    });

    let uiTransitionCalled = false;
    const childBridge = createDashboardBridge({
        taskManager,
        targetOrigin: pair.parentOrigin,
        allowedOrigin: pair.parentOrigin,
        windowRef: pair.childWin,
        parentWindow: pair.parentWin,
        onModeChangeRequested: (targetMode, reason) => {
            uiTransitionCalled = true;
            return taskManager.setMode(targetMode, reason);
        }
    });

    parentBridge.init();
    childBridge.init();

    assert.equal(taskManager.getMode(), 'standard');
    assert.equal(parentBridge.getObservedMode(), 'standard');

    // request transition to focused
    const result = await parentBridge.sendSetModeRequest('focused', 'workload_adaptation');

    assert.equal(result.success, true);
    assert.equal(result.status, 'applied');
    assert.equal(result.appliedMode, 'focused');
    assert.equal(result.previousMode, 'standard');
    assert.equal(result.reason, 'workload_adaptation');

    // authoritative state updated
    assert.equal(taskManager.getMode(), 'focused');
    assert.equal(parentBridge.getObservedMode(), 'focused');
    assert.equal(uiTransitionCalled, true);
    assert.equal(parentModeChangedCall?.mode, 'focused');

    parentBridge.destroy();
    childBridge.destroy();
});

// 4. duplicate request handling and idempotency
test('duplicate mode requests return noop acknowledgment without duplicate transitions or events', async () => {
    const pair = createBridgePair();
    const taskManager = createTaskManager({ mode: 'focused' });

    const parentBridge = createParentBridge({
        iframe: () => pair.iframeElement,
        targetOrigin: pair.childOrigin,
        allowedOrigin: pair.childOrigin,
        windowRef: pair.parentWin
    });

    let transitionCallCount = 0;
    const childBridge = createDashboardBridge({
        taskManager,
        targetOrigin: pair.parentOrigin,
        allowedOrigin: pair.parentOrigin,
        windowRef: pair.childWin,
        parentWindow: pair.parentWin,
        onModeChangeRequested: (targetMode, reason) => {
            transitionCallCount++;
            return taskManager.setMode(targetMode, reason);
        }
    });

    parentBridge.init();
    childBridge.init();

    assert.equal(taskManager.getMode(), 'focused');
    const initialEventCount = taskManager.getEventRecords().length;

    // request focused while already in focused
    const result = await parentBridge.sendSetModeRequest('focused', 'duplicate_trigger');

    assert.equal(result.success, true);
    assert.equal(result.status, 'noop');
    assert.equal(result.appliedMode, 'focused');
    assert.equal(result.reason, 'already_in_requested_mode');

    // verify no state transition occurred
    assert.equal(transitionCallCount, 0);
    assert.equal(taskManager.getEventRecords().length, initialEventCount);

    parentBridge.destroy();
    childBridge.destroy();
});

// 5. task event forwarding without double-counting
test('task events are forwarded to parent and recorded without double-counting', () => {
    const pair = createBridgePair();
    const taskManager = createTaskManager({ mode: 'standard' });

    const receivedEvents = [];
    const parentBridge = createParentBridge({
        iframe: () => pair.iframeElement,
        targetOrigin: pair.childOrigin,
        allowedOrigin: pair.childOrigin,
        windowRef: pair.parentWin,
        onTaskEvent: (evt) => {
            receivedEvents.push(evt);
        }
    });

    const childBridge = createDashboardBridge({
        taskManager,
        targetOrigin: pair.parentOrigin,
        allowedOrigin: pair.parentOrigin,
        windowRef: pair.childWin,
        parentWindow: pair.parentWin
    });

    parentBridge.init();
    childBridge.init();

    // trigger task actions
    taskManager.startTask('task-server-triage');
    taskManager.recordIncorrectChoice('task-server-triage', { instanceId: 'srv-01' });
    taskManager.recordCorrection('task-server-triage');
    taskManager.completeTask('task-server-triage', { srv: 'srv-cluster-a-02' });

    const authoritativeEvents = taskManager.getEventRecords();
    assert.equal(receivedEvents.length, authoritativeEvents.length);
    assert.equal(parentBridge.getReceivedEvents().length, authoritativeEvents.length);

    for (let i = 0; i < authoritativeEvents.length; i++) {
        assert.equal(receivedEvents[i].eventId, authoritativeEvents[i].eventId);
        assert.equal(receivedEvents[i].eventType, authoritativeEvents[i].eventType);
    }

    parentBridge.destroy();
    childBridge.destroy();
});

// 6. security: origin and source validation
test('messages from wrong origins are rejected without effect on both sides', async () => {
    const pair = createBridgePair();
    const taskManager = createTaskManager({ mode: 'standard' });

    const parentBridge = createParentBridge({
        iframe: () => pair.iframeElement,
        targetOrigin: pair.childOrigin,
        allowedOrigin: pair.childOrigin,
        windowRef: pair.parentWin
    });

    const childBridge = createDashboardBridge({
        taskManager,
        targetOrigin: pair.parentOrigin,
        allowedOrigin: pair.parentOrigin,
        windowRef: pair.childWin,
        parentWindow: pair.parentWin
    });

    parentBridge.init();
    childBridge.init();

    // malicious origin sending message to child
    const maliciousOrigin = 'https://attacker.example.com';
    const fakeModeRequest = {
        protocol: BRIDGE_PROTOCOL,
        version: PROTOCOL_VERSION,
        type: BRIDGE_MESSAGE_TYPES.SET_MODE_REQUEST,
        sessionToken: childBridge.getSessionToken(),
        timestamp: 200,
        payload: {
            requestId: 'malicious_req',
            targetMode: 'focused'
        }
    };

    pair.childWin.dispatchMessage(fakeModeRequest, maliciousOrigin, pair.parentWin);
    // mode must remain standard
    assert.equal(taskManager.getMode(), 'standard');

    // malicious origin sending message to parent
    const fakeAck = {
        protocol: BRIDGE_PROTOCOL,
        version: PROTOCOL_VERSION,
        type: BRIDGE_MESSAGE_TYPES.MODE_ACK,
        sessionToken: childBridge.getSessionToken(),
        timestamp: 200,
        payload: {
            requestId: 'fake_ack',
            status: 'applied',
            appliedMode: 'focused'
        }
    };

    pair.parentWin.dispatchMessage(fakeAck, maliciousOrigin, pair.childWin);
    assert.equal(parentBridge.getObservedMode(), 'standard');

    parentBridge.destroy();
    childBridge.destroy();
});

test('messages from wrong event.source are rejected without effect', () => {
    const pair = createBridgePair();
    const taskManager = createTaskManager({ mode: 'standard' });

    const parentBridge = createParentBridge({
        iframe: () => pair.iframeElement,
        targetOrigin: pair.childOrigin,
        allowedOrigin: pair.childOrigin,
        windowRef: pair.parentWin
    });

    const childBridge = createDashboardBridge({
        taskManager,
        targetOrigin: pair.parentOrigin,
        allowedOrigin: pair.parentOrigin,
        windowRef: pair.childWin,
        parentWindow: pair.parentWin
    });

    parentBridge.init();
    childBridge.init();

    const rogueWindow = createMockWindow(pair.parentOrigin);

    const rogueRequest = {
        protocol: BRIDGE_PROTOCOL,
        version: PROTOCOL_VERSION,
        type: BRIDGE_MESSAGE_TYPES.SET_MODE_REQUEST,
        sessionToken: childBridge.getSessionToken(),
        timestamp: 300,
        payload: {
            requestId: 'rogue_req',
            targetMode: 'focused'
        }
    };

    // message dispatched from rogue window source
    pair.childWin.dispatchMessage(rogueRequest, pair.parentOrigin, rogueWindow);
    assert.equal(taskManager.getMode(), 'standard');

    parentBridge.destroy();
    childBridge.destroy();
});

test('bridge construction strictly rejects wildcard origin configuration', () => {
    const pair = createBridgePair();
    const taskManager = createTaskManager();

    assert.throws(() => {
        createParentBridge({
            iframe: () => pair.iframeElement,
            targetOrigin: '*'
        });
    }, /wildcard is not allowed/i);

    assert.throws(() => {
        createDashboardBridge({
            taskManager,
            targetOrigin: '*',
            parentWindow: pair.parentWin
        });
    }, /wildcard is not allowed/i);
});

// 7. malformed payloads and invalid modes
test('invalid mode in set-mode request is rejected cleanly', async () => {
    const pair = createBridgePair();
    const taskManager = createTaskManager({ mode: 'standard' });

    const parentBridge = createParentBridge({
        iframe: () => pair.iframeElement,
        targetOrigin: pair.childOrigin,
        allowedOrigin: pair.childOrigin,
        windowRef: pair.parentWin
    });

    const childBridge = createDashboardBridge({
        taskManager,
        targetOrigin: pair.parentOrigin,
        allowedOrigin: pair.parentOrigin,
        windowRef: pair.childWin,
        parentWindow: pair.parentWin
    });

    parentBridge.init();
    childBridge.init();

    // parentBridge immediately rejects client-side if invalid mode provided
    await assert.rejects(
        async () => {
            await parentBridge.sendSetModeRequest('invalid_mode');
        },
        /Invalid targetMode/
    );

    // manual raw postMessage with invalid mode sent to child
    const invalidRequest = {
        protocol: BRIDGE_PROTOCOL,
        version: PROTOCOL_VERSION,
        type: BRIDGE_MESSAGE_TYPES.SET_MODE_REQUEST,
        sessionToken: childBridge.getSessionToken(),
        timestamp: 400,
        payload: {
            requestId: 'bad_mode_req',
            targetMode: 'invalid_mode'
        }
    };

    pair.childWin.dispatchMessage(invalidRequest, pair.parentOrigin, pair.parentWin);
    assert.equal(taskManager.getMode(), 'standard');

    parentBridge.destroy();
    childBridge.destroy();
});

// 8. iframe reload recovery and stale message rejection
test('iframe reload invalidates in-flight requests and rejects stale messages', async () => {
    const pair = createBridgePair();
    const taskManager1 = createTaskManager({ mode: 'standard' });

    const parentBridge = createParentBridge({
        iframe: () => pair.iframeElement,
        targetOrigin: pair.childOrigin,
        allowedOrigin: pair.childOrigin,
        windowRef: pair.parentWin
    });

    const childBridge1 = createDashboardBridge({
        taskManager: taskManager1,
        targetOrigin: pair.parentOrigin,
        allowedOrigin: pair.parentOrigin,
        windowRef: pair.childWin,
        parentWindow: pair.parentWin
    });

    parentBridge.init();
    childBridge1.init();

    const session1 = childBridge1.getSessionToken();
    assert.equal(parentBridge.getActiveSessionToken(), session1);

    // simulate child iframe reloading: childBridge1 destroyed, childBridge2 created
    childBridge1.destroy();

    const taskManager2 = createTaskManager({ mode: 'standard' });
    const childBridge2 = createDashboardBridge({
        taskManager: taskManager2,
        targetOrigin: pair.parentOrigin,
        allowedOrigin: pair.parentOrigin,
        windowRef: pair.childWin,
        parentWindow: pair.parentWin
    });

    // childBridge2 initializes with a fresh session token
    childBridge2.init();
    const session2 = childBridge2.getSessionToken();

    assert.notEqual(session1, session2);
    assert.equal(parentBridge.getActiveSessionToken(), session2);

    // late message arriving with obsolete session1 token is ignored by parent
    const staleTaskEvent = {
        protocol: BRIDGE_PROTOCOL,
        version: PROTOCOL_VERSION,
        type: BRIDGE_MESSAGE_TYPES.TASK_EVENT,
        sessionToken: session1,
        timestamp: 500,
        payload: {
            event: { eventId: 'stale_evt', eventType: 'TASK_START' }
        }
    };

    const initialEventsCount = parentBridge.getReceivedEvents().length;
    pair.parentWin.dispatchMessage(staleTaskEvent, pair.childOrigin, pair.childWin);
    assert.equal(parentBridge.getReceivedEvents().length, initialEventsCount);

    // late request directed to obsolete session1 is rejected by childBridge2
    const staleModeRequest = {
        protocol: BRIDGE_PROTOCOL,
        version: PROTOCOL_VERSION,
        type: BRIDGE_MESSAGE_TYPES.SET_MODE_REQUEST,
        sessionToken: session1,
        timestamp: 505,
        payload: {
            requestId: 'stale_req_1',
            targetMode: 'focused'
        }
    };

    pair.childWin.dispatchMessage(staleModeRequest, pair.parentOrigin, pair.parentWin);
    assert.equal(taskManager2.getMode(), 'standard');

    // valid request to session2 succeeds normally
    const result = await parentBridge.sendSetModeRequest('focused', 'session2_switch');
    assert.equal(result.success, true);
    assert.equal(taskManager2.getMode(), 'focused');

    parentBridge.destroy();
    childBridge2.destroy();
});

// 9. timeout handling on unacknowledged requests
test('mode requests time out explicitly if child does not acknowledge', async () => {
    const pair = createBridgePair();
    const parentBridge = createParentBridge({
        iframe: () => pair.iframeElement,
        targetOrigin: pair.childOrigin,
        allowedOrigin: pair.childOrigin,
        windowRef: pair.parentWin
    });

    parentBridge.init();

    // artificially establish handshake with dummy session token without active child receiver
    const dummySession = 'session_dummy_123';
    pair.parentWin.dispatchMessage({
        protocol: BRIDGE_PROTOCOL,
        version: PROTOCOL_VERSION,
        type: BRIDGE_MESSAGE_TYPES.HANDSHAKE_INIT,
        sessionToken: dummySession,
        timestamp: 100,
        payload: { currentMode: 'standard' }
    }, pair.childOrigin, pair.childWin);

    assert.equal(parentBridge.isHandshakeComplete(), true);

    // send request with small timeout
    await assert.rejects(
        async () => {
            await parentBridge.sendSetModeRequest('focused', 'timeout_test', 50);
        },
        /timed out after 50ms/
    );

    assert.equal(parentBridge.getPendingRequestCount(), 0);
    parentBridge.destroy();
});

// 10. standalone dashboard operation
test('createDashboardBridge detects standalone mode and operates cleanly without errors', () => {
    const taskManager = createTaskManager({ mode: 'standard' });
    const standaloneWin = createMockWindow();
    // in standalone mode, parent is self
    standaloneWin.parent = standaloneWin;

    const bridge = createDashboardBridge({
        taskManager,
        windowRef: standaloneWin,
        parentWindow: standaloneWin
    });

    assert.equal(bridge.isStandalone(), true);
    // init does not throw or post messages
    bridge.init();
    assert.equal(bridge.isConnected(), false);

    // taskManager functions normally
    assert.equal(taskManager.setMode('focused', 'standalone_user'), true);
    assert.equal(taskManager.getMode(), 'focused');

    bridge.destroy();
});
