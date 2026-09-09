// logger.js - decoupled and throttled logging system for IWAT

let logsContainer = null;
const MAX_DOM_LOGS = 150; // cap DOM elements to prevent memory leaks during 15+ minute runs
const throttledMessages = new Map(); // key -> lastTimestamp
const listeners = new Set();

export function setLogContainer(container) {
    logsContainer = container;
}

export function subscribeLogs(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
}

/** jsdoc
 * logs a message to the UI log console with optional throttling
 * @param {string} message - message text
 * @param {boolean} isAction - highlight as system action
 * @param {string} level - 'info' | 'warn' | 'error' | 'success'
 * @param {number} throttleMs - minimum ms between identical messages (0 = unthrottled)
 */
export function logToUI(message, isAction = false, level = 'info', throttleMs = 0) {
    const now = Date.now();
    const key = `${level}:${message}`;

    if (throttleMs > 0) {
        const lastTime = throttledMessages.get(key) || 0;
        if (now - lastTime < throttleMs) {
            return; // throttled
        }
        throttledMessages.set(key, now);
    }

    // clean old throttle keys periodically
    if (throttledMessages.size > 200) {
        for (const [k, timestamp] of throttledMessages.entries()) {
            if (now - timestamp > 10000) {
                throttledMessages.delete(k);
            }
        }
    }

    const time = new Date().toLocaleTimeString();
    const logEntry = { time, message, isAction, level, timestamp: now };

    // notify listeners
    for (const listener of listeners) {
        try {
            listener(logEntry);
        } catch (e) {
            console.error('Error in log listener:', e);
        }
    }

    if (!logsContainer && typeof document !== 'undefined') {
        logsContainer = document.getElementById('ai-logs'); // get log container
    }

    if (logsContainer) {
        // build log html
        const div = document.createElement('div');
        div.className = `log-entry log-${level}`;

        const timeSpan = document.createElement('span');
        timeSpan.className = 'log-time';
        timeSpan.textContent = `[${time}]`;

        const msgSpan = document.createElement('span');
        if (isAction) {
            msgSpan.className = 'log-action';
            msgSpan.textContent = ` ACTION: ${message}`;
        } else {
            msgSpan.textContent = ` ${message}`;
        }

        if (level === 'error') {
            msgSpan.style.color = '#ff6b6b';
        } else if (level === 'warn') {
            msgSpan.style.color = '#feca57';
        } else if (level === 'success') {
            msgSpan.style.color = '#1dd1a1';
        }

        div.appendChild(timeSpan);
        div.appendChild(msgSpan);

        logsContainer.appendChild(div);

        // cap DOM nodes to avoid monotonic DOM growth during extended runs
        while (logsContainer.children.length > MAX_DOM_LOGS) {
            logsContainer.removeChild(logsContainer.firstChild);
        }

        // auto scroll
        logsContainer.scrollTop = logsContainer.scrollHeight;
    }

    // also mirror to console with appropriate level
    if (level === 'error') {
        console.error(`[IWAT] ${message}`);
    } else if (level === 'warn') {
        console.warn(`[IWAT] ${message}`);
    } else {
        console.log(`[IWAT] ${message}`);
    }
}

export function clearLogs() {
    if (logsContainer) {
        logsContainer.innerHTML = '';
    }
}
