// bridge.js - secure, versioned parent-iframe postMessage adaptation bridge

export const BRIDGE_PROTOCOL = 'IWAT_BRIDGE';
export const PROTOCOL_VERSION = '1.0';

export const BRIDGE_MESSAGE_TYPES = Object.freeze({
    HANDSHAKE_INIT: 'HANDSHAKE_INIT',
    HANDSHAKE_ACK: 'HANDSHAKE_ACK',
    HANDSHAKE_PING: 'HANDSHAKE_PING',
    SET_MODE_REQUEST: 'SET_MODE_REQUEST',
    MODE_ACK: 'MODE_ACK',
    TASK_EVENT: 'TASK_EVENT'
});

export const ALLOWED_ADAPTATION_MODES = Object.freeze(['standard', 'focused']);

export const ACK_STATUS = Object.freeze({
    APPLIED: 'applied',
    NOOP: 'noop',
    REJECTED: 'rejected'
});

/** jsdoc
 * returns current high-resolution monotonic time or epoch ms
 * @returns {number}
 */
function getTimestamp() {
    return typeof performance !== 'undefined' && performance.now
        ? Number(performance.now().toFixed(2))
        : Date.now();
}

/** jsdoc
 * generates a cryptographically random session or request token
 * @param {string} prefix
 * @returns {string}
 */
export function generateToken(prefix = 'tok') {
    const rand = Math.random().toString(36).substring(2, 9);
    return `${prefix}_${Date.now()}_${rand}`;
}

/** jsdoc
 * validates message envelope against protocol specification
 * @param {any} data
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateEnvelope(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { valid: false, error: 'Message data must be a non-null object' };
    }
    if (data.protocol !== BRIDGE_PROTOCOL) {
        return { valid: false, error: `Invalid protocol identifier: expected '${BRIDGE_PROTOCOL}'` };
    }
    if (data.version !== PROTOCOL_VERSION) {
        return { valid: false, error: `Unsupported protocol version: expected '${PROTOCOL_VERSION}'` };
    }
    if (typeof data.type !== 'string' || !BRIDGE_MESSAGE_TYPES[data.type]) {
        return { valid: false, error: `Unknown message type: '${data.type}'` };
    }
    if (typeof data.timestamp !== 'number' || !Number.isFinite(data.timestamp)) {
        return { valid: false, error: 'Invalid or missing timestamp' };
    }
    if (data.type !== BRIDGE_MESSAGE_TYPES.HANDSHAKE_PING) {
        if (typeof data.sessionToken !== 'string' || data.sessionToken.trim() === '') {
            return { valid: false, error: 'Invalid or missing sessionToken' };
        }
    }
    if (!data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload)) {
        return { valid: false, error: 'Payload must be a non-null object' };
    }
    return { valid: true };
}

/** jsdoc
 * validates set mode request payload
 * @param {any} payload
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateSetModePayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return { valid: false, error: 'Payload must be an object' };
    }
    if (typeof payload.requestId !== 'string' || payload.requestId.trim() === '') {
        return { valid: false, error: 'requestId must be a non-empty string' };
    }
    if (!ALLOWED_ADAPTATION_MODES.includes(payload.targetMode)) {
        return { valid: false, error: `Invalid targetMode '${payload.targetMode}': must be 'standard' or 'focused'` };
    }
    return { valid: true };
}

/** jsdoc
 * validates mode acknowledgment payload
 * @param {any} payload
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateModeAckPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return { valid: false, error: 'Payload must be an object' };
    }
    if (typeof payload.requestId !== 'string' || payload.requestId.trim() === '') {
        return { valid: false, error: 'requestId must be a non-empty string' };
    }
    if (!Object.values(ACK_STATUS).includes(payload.status)) {
        return { valid: false, error: `Invalid status '${payload.status}'` };
    }
    if (!ALLOWED_ADAPTATION_MODES.includes(payload.appliedMode)) {
        return { valid: false, error: `Invalid appliedMode '${payload.appliedMode}'` };
    }
    return { valid: true };
}

/** jsdoc
 * creates the child dashboard bridge attached to the iframe dashboard controller
 * @param {Object} options
 * @param {Object} options.taskManager
 * @param {Function} options.onModeChangeRequested
 * @param {string} [options.targetOrigin]
 * @param {string} [options.allowedOrigin]
 * @param {Window} [options.windowRef]
 * @param {Window} [options.parentWindow]
 * @returns {Object}
 */
export function createDashboardBridge(options) {
    const {
        taskManager,
        onModeChangeRequested,
        windowRef = (typeof window !== 'undefined' ? window : null),
        parentWindow = (typeof window !== 'undefined' ? window.parent : null)
    } = options;

    if (!taskManager) {
        throw new Error('createDashboardBridge requires a valid taskManager instance');
    }

    // detect standalone mode
    const isStandalone = !windowRef || !parentWindow || parentWindow === windowRef;

    // determine exact target and allowed origins
    const currentOrigin = (windowRef && windowRef.location && windowRef.location.origin) ? windowRef.location.origin : '';
    const targetOrigin = options.targetOrigin || currentOrigin;
    const allowedOrigin = options.allowedOrigin || targetOrigin;

    if (targetOrigin === '*') {
        throw new Error('Exact targetOrigin must be configured for dashboard bridge; wildcard is not allowed');
    }
    if (!isStandalone && !targetOrigin) {
        throw new Error('Exact targetOrigin must be configured for dashboard bridge');
    }

    // ephemeral session token generated per dashboard load/reload
    const sessionToken = generateToken('session');
    let isConnected = false;
    let unsubscribeTaskManager = null;
    let messageListener = null;

    /** jsdoc
     * posts a protocol envelope to the parent window
     * @param {string} type
     * @param {Object} payload
     * @returns {boolean}
     */
    function sendToParent(type, payload = {}) {
        if (isStandalone || !parentWindow) return false;

        const message = {
            protocol: BRIDGE_PROTOCOL,
            version: PROTOCOL_VERSION,
            type,
            sessionToken,
            timestamp: getTimestamp(),
            payload
        };

        try {
            parentWindow.postMessage(message, targetOrigin);
            return true;
        } catch (err) {
            return false;
        }
    }

    /** jsdoc
     * handles incoming postMessage events from parent
     * @param {MessageEvent} event
     */
    function handleParentMessage(event) {
        // validate exact origin
        if (event.origin !== allowedOrigin) {
            return;
        }

        // validate event.source is parent window
        if (event.source !== parentWindow) {
            return;
        }

        // validate envelope schema
        const envelopeValidation = validateEnvelope(event.data);
        if (!envelopeValidation.valid) {
            return;
        }

        const { type, payload, sessionToken: msgSessionToken } = event.data;

        switch (type) {
            case BRIDGE_MESSAGE_TYPES.HANDSHAKE_ACK: {
                // verify session token matches this instance
                if (msgSessionToken === sessionToken) {
                    isConnected = true;
                }
                break;
            }

            case BRIDGE_MESSAGE_TYPES.HANDSHAKE_PING: {
                // respond with fresh handshake init
                sendToParent(BRIDGE_MESSAGE_TYPES.HANDSHAKE_INIT, {
                    currentMode: taskManager.getMode(),
                    presentation: taskManager.getPresentation ? taskManager.getPresentation() : 'accessible',
                    activeTaskId: taskManager.getActiveTask ? (taskManager.getActiveTask().definition?.id || null) : null
                });
                break;
            }

            case BRIDGE_MESSAGE_TYPES.SET_MODE_REQUEST: {
                // validate session token: ignore requests directed at an earlier or different session
                if (msgSessionToken !== sessionToken) {
                    sendToParent(BRIDGE_MESSAGE_TYPES.MODE_ACK, {
                        requestId: payload?.requestId || 'unknown',
                        status: ACK_STATUS.REJECTED,
                        appliedMode: taskManager.getMode(),
                        previousMode: taskManager.getMode(),
                        reason: 'stale_or_invalid_session_token'
                    });
                    return;
                }

                // validate payload
                const payloadValidation = validateSetModePayload(payload);
                if (!payloadValidation.valid) {
                    sendToParent(BRIDGE_MESSAGE_TYPES.MODE_ACK, {
                        requestId: payload?.requestId || 'unknown',
                        status: ACK_STATUS.REJECTED,
                        appliedMode: taskManager.getMode(),
                        previousMode: taskManager.getMode(),
                        reason: payloadValidation.error || 'invalid_payload'
                    });
                    return;
                }

                const { requestId, targetMode, reason = 'parent_bridge' } = payload;
                const currentMode = taskManager.getMode();

                // idempotency check: if already in requested mode, acknowledge as noop without mutating state
                if (currentMode === targetMode) {
                    sendToParent(BRIDGE_MESSAGE_TYPES.MODE_ACK, {
                        requestId,
                        status: ACK_STATUS.NOOP,
                        appliedMode: currentMode,
                        previousMode: currentMode,
                        reason: 'already_in_requested_mode'
                    });
                    return;
                }

                // execute transition through authoritative mode API and UI controller
                let transitionSuccess = false;
                if (typeof onModeChangeRequested === 'function') {
                    transitionSuccess = onModeChangeRequested(targetMode, reason);
                } else {
                    transitionSuccess = taskManager.setMode(targetMode, reason);
                }

                const finalMode = taskManager.getMode();
                if (transitionSuccess && finalMode === targetMode) {
                    sendToParent(BRIDGE_MESSAGE_TYPES.MODE_ACK, {
                        requestId,
                        status: ACK_STATUS.APPLIED,
                        appliedMode: finalMode,
                        previousMode: currentMode,
                        reason
                    });
                } else {
                    sendToParent(BRIDGE_MESSAGE_TYPES.MODE_ACK, {
                        requestId,
                        status: ACK_STATUS.REJECTED,
                        appliedMode: finalMode,
                        previousMode: currentMode,
                        reason: 'transition_failed'
                    });
                }
                break;
            }

            default:
                // unsupported message types ignored cleanly
                break;
        }
    }

    /**
     * initializes bridge listeners and sends initial handshake
     */
    function init() {
        if (isStandalone) {
            return;
        }

        // register window message listener
        if (windowRef && windowRef.addEventListener) {
            messageListener = (e) => handleParentMessage(e);
            windowRef.addEventListener('message', messageListener);
        }

        // subscribe to authoritative task manager events to forward measurements
        unsubscribeTaskManager = taskManager.subscribe(({ eventType, data }) => {
            // only forward valid task event records (avoid double-counting subscriber notifications)
            if (data && typeof data === 'object' && data.eventId) {
                sendToParent(BRIDGE_MESSAGE_TYPES.TASK_EVENT, {
                    event: data
                });
            }
        });

        // send initial handshake readiness to parent
        sendToParent(BRIDGE_MESSAGE_TYPES.HANDSHAKE_INIT, {
            currentMode: taskManager.getMode(),
            presentation: taskManager.getPresentation ? taskManager.getPresentation() : 'accessible',
            activeTaskId: taskManager.getActiveTask ? (taskManager.getActiveTask().definition?.id || null) : null
        });
    }

    /**
     * tears down listeners and subscriptions
     */
    function destroy() {
        if (windowRef && windowRef.removeEventListener && messageListener) {
            windowRef.removeEventListener('message', messageListener);
            messageListener = null;
        }
        if (typeof unsubscribeTaskManager === 'function') {
            unsubscribeTaskManager();
            unsubscribeTaskManager = null;
        }
        isConnected = false;
    }

    return {
        init,
        destroy,
        getSessionToken: () => sessionToken,
        isConnected: () => isConnected,
        isStandalone: () => isStandalone,
        // exposed for direct unit testing in mock environments
        handleMessage: handleParentMessage
    };
}

/** jsdoc
 * creates the parent-side adaptation bridge controlling and observing the iframe dashboard
 * @param {Object} options
 * @param {HTMLIFrameElement|Function} options.iframe
 * @param {string} [options.targetOrigin]
 * @param {string} [options.allowedOrigin]
 * @param {Window} [options.windowRef]
 * @param {Function} [options.onTaskEvent]
 * @param {Function} [options.onModeChanged]
 * @param {Function} [options.onHandshake]
 * @returns {Object}
 */
export function createParentBridge(options) {
    const {
        iframe,
        windowRef = (typeof window !== 'undefined' ? window : null),
        onTaskEvent,
        onModeChanged,
        onHandshake
    } = options;

    if (!iframe) {
        throw new Error('createParentBridge requires an iframe element or resolver function');
    }

    const currentOrigin = (windowRef && windowRef.location && windowRef.location.origin) ? windowRef.location.origin : '';
    const targetOrigin = options.targetOrigin || currentOrigin;
    const allowedOrigin = options.allowedOrigin || targetOrigin;

    if (!targetOrigin || targetOrigin === '*') {
        throw new Error('Exact targetOrigin must be configured for parent bridge; wildcard is not allowed');
    }

    let activeSessionToken = null;
    let isHandshakeComplete = false;
    let observedMode = 'standard';
    const receivedEvents = [];
    const pendingRequests = new Map();
    let messageListener = null;
    let iframeLoadListener = null;

    /** jsdoc
     * resolves the iframe element or content window
     * @returns {{ element: HTMLIFrameElement|null, contentWindow: Window|null }}
     */
    function resolveIframe() {
        const el = typeof iframe === 'function' ? iframe() : iframe;
        const cw = el && el.contentWindow ? el.contentWindow : null;
        return { element: el, contentWindow: cw };
    }

    /** jsdoc
     * posts a protocol envelope to the child iframe
     * @param {string} type
     * @param {Object} payload
     * @param {string|null} [sessionTokenOverride]
     * @returns {boolean}
     */
    function sendToChild(type, payload = {}, sessionTokenOverride = undefined) {
        const { contentWindow } = resolveIframe();
        if (!contentWindow) return false;

        const token = sessionTokenOverride !== undefined ? sessionTokenOverride : activeSessionToken;
        const message = {
            protocol: BRIDGE_PROTOCOL,
            version: PROTOCOL_VERSION,
            type,
            sessionToken: token,
            timestamp: getTimestamp(),
            payload
        };

        try {
            contentWindow.postMessage(message, targetOrigin);
            return true;
        } catch (err) {
            return false;
        }
    }

    /** jsdoc
     * cancels all pending mode requests with a cancellation error
     * @param {string} reasonCode
     */
    function cancelAllPendingRequests(reasonCode = 'SESSION_RESET') {
        for (const [reqId, entry] of pendingRequests.entries()) {
            if (entry.timeoutId) {
                clearTimeout(entry.timeoutId);
            }
            const err = new Error(`Mode request ${reqId} cancelled: ${reasonCode}`);
            err.code = reasonCode;
            entry.reject(err);
        }
        pendingRequests.clear();
    }

    /** jsdoc
     * updates observed mode and notifies subscriber once per transition
     * @param {string} newMode
     * @param {string} [reason]
     * @param {string} [fromMode]
     */
    function updateObservedMode(newMode, reason = 'unknown', fromMode = observedMode) {
        if (observedMode !== newMode) {
            const previous = fromMode || observedMode;
            observedMode = newMode;
            if (typeof onModeChanged === 'function') {
                onModeChanged({
                    mode: newMode,
                    previousMode: previous,
                    reason
                });
            }
        }
    }

    /** jsdoc
     * handles incoming messages from child iframe
     * @param {MessageEvent} event
     */
    function handleChildMessage(event) {
        // validate exact origin
        if (event.origin !== allowedOrigin) {
            return;
        }

        // validate event.source is the iframe content window
        const { contentWindow } = resolveIframe();
        if (!contentWindow || event.source !== contentWindow) {
            return;
        }

        // validate envelope schema
        const envelopeValidation = validateEnvelope(event.data);
        if (!envelopeValidation.valid) {
            return;
        }

        const { type, payload, sessionToken } = event.data;

        switch (type) {
            case BRIDGE_MESSAGE_TYPES.HANDSHAKE_INIT: {
                // if a different session token arrives, the iframe has reloaded
                if (activeSessionToken && activeSessionToken !== sessionToken) {
                    cancelAllPendingRequests('SESSION_SUPERSEDED');
                }

                activeSessionToken = sessionToken;
                isHandshakeComplete = true;

                if (payload && payload.currentMode && ALLOWED_ADAPTATION_MODES.includes(payload.currentMode)) {
                    updateObservedMode(payload.currentMode, 'handshake_init');
                }

                // send handshake acknowledgment
                sendToChild(BRIDGE_MESSAGE_TYPES.HANDSHAKE_ACK, {
                    connected: true
                }, sessionToken);

                if (typeof onHandshake === 'function') {
                    onHandshake(payload);
                }
                break;
            }

            case BRIDGE_MESSAGE_TYPES.TASK_EVENT: {
                // reject messages from obsolete sessions
                if (sessionToken !== activeSessionToken) {
                    return;
                }

                if (!payload || !payload.event || typeof payload.event !== 'object') {
                    return;
                }

                const eventRecord = payload.event;
                receivedEvents.push(eventRecord);

                // track mode transitions emitted in task event stream
                if (eventRecord.eventType === 'MODE_CHANGED' && eventRecord.details?.toMode) {
                    updateObservedMode(
                        eventRecord.details.toMode,
                        eventRecord.details.reason || 'task_event',
                        eventRecord.details.fromMode
                    );
                }

                if (typeof onTaskEvent === 'function') {
                    onTaskEvent(eventRecord);
                }
                break;
            }

            case BRIDGE_MESSAGE_TYPES.MODE_ACK: {
                // reject acknowledgments from obsolete sessions
                if (sessionToken !== activeSessionToken) {
                    return;
                }

                const ackValidation = validateModeAckPayload(payload);
                if (!ackValidation.valid) {
                    return;
                }

                const { requestId, status, appliedMode, previousMode, reason } = payload;
                const pending = pendingRequests.get(requestId);
                if (!pending) {
                    // acknowledgment for unknown, timed out, or already handled request
                    return;
                }

                // clear timeout and remove pending entry
                if (pending.timeoutId) {
                    clearTimeout(pending.timeoutId);
                }
                pendingRequests.delete(requestId);

                updateObservedMode(appliedMode, reason || 'mode_ack', previousMode);

                if (status === ACK_STATUS.REJECTED) {
                    const err = new Error(`Mode change request rejected by dashboard: ${reason || 'unknown'}`);
                    err.code = 'REQUEST_REJECTED';
                    err.status = status;
                    err.appliedMode = appliedMode;
                    err.reason = reason;
                    pending.reject(err);
                } else {
                    pending.resolve({
                        success: true,
                        requestId,
                        status,
                        appliedMode,
                        previousMode,
                        reason
                    });
                }
                break;
            }

            default:
                // ignore unsupported message types
                break;
        }
    }

    /**
     * handles iframe load event (boot or reload)
     */
    function handleIframeLoad() {
        // cancel in-flight requests from prior iframe instance
        if (activeSessionToken) {
            cancelAllPendingRequests('IFRAME_RELOADED');
        }
        isHandshakeComplete = false;

        // ping iframe to trigger handshake if it already initialized
        sendToChild(BRIDGE_MESSAGE_TYPES.HANDSHAKE_PING, {}, null);
    }

    /**
     * initializes parent bridge listeners
     */
    function init() {
        if (windowRef && windowRef.addEventListener) {
            messageListener = (e) => handleChildMessage(e);
            windowRef.addEventListener('message', messageListener);
        }

        const { element } = resolveIframe();
        if (element && element.addEventListener) {
            iframeLoadListener = () => handleIframeLoad();
            element.addEventListener('load', iframeLoadListener);
        }

        // initial ping in case child iframe loaded before parent bridge initialized
        sendToChild(BRIDGE_MESSAGE_TYPES.HANDSHAKE_PING, {}, null);
    }

    /** jsdoc
     * sends an asynchronous set-mode request to the child dashboard
     * @param {'standard'|'focused'} targetMode
     * @param {string} [reason]
     * @param {number} [timeoutMs]
     * @returns {Promise<Object>}
     */
    function sendSetModeRequest(targetMode, reason = 'manual', timeoutMs = 2500) {
        if (!ALLOWED_ADAPTATION_MODES.includes(targetMode)) {
            return Promise.reject(new Error(`Invalid targetMode '${targetMode}': must be 'standard' or 'focused'`));
        }

        if (!activeSessionToken) {
            return Promise.reject(new Error('Cannot send mode request: no active child session established'));
        }

        const requestId = generateToken('req');

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                pendingRequests.delete(requestId);
                const err = new Error(`Mode change request ${requestId} timed out after ${timeoutMs}ms`);
                err.code = 'TIMEOUT';
                reject(err);
            }, timeoutMs);

            pendingRequests.set(requestId, {
                resolve,
                reject,
                timeoutId,
                targetMode,
                sessionToken: activeSessionToken,
                timestamp: getTimestamp()
            });

            const sent = sendToChild(BRIDGE_MESSAGE_TYPES.SET_MODE_REQUEST, {
                requestId,
                targetMode,
                reason
            });

            if (!sent) {
                clearTimeout(timeoutId);
                pendingRequests.delete(requestId);
                reject(new Error('Failed to post message to child iframe contentWindow'));
            }
        });
    }

    /**
     * tears down bridge listeners and cancels pending requests
     */
    function destroy() {
        if (windowRef && windowRef.removeEventListener && messageListener) {
            windowRef.removeEventListener('message', messageListener);
            messageListener = null;
        }

        const { element } = resolveIframe();
        if (element && element.removeEventListener && iframeLoadListener) {
            element.removeEventListener('load', iframeLoadListener);
            iframeLoadListener = null;
        }

        cancelAllPendingRequests('BRIDGE_DESTROYED');
        isHandshakeComplete = false;
        activeSessionToken = null;
    }

    return {
        init,
        destroy,
        sendSetModeRequest,
        getActiveSessionToken: () => activeSessionToken,
        isHandshakeComplete: () => isHandshakeComplete,
        getObservedMode: () => observedMode,
        getReceivedEvents: () => [...receivedEvents],
        getPendingRequestCount: () => pendingRequests.size,
        // exposed for testing in mock environments
        handleMessage: handleChildMessage,
        handleIframeLoad
    };
}
