## 1. Architectural Principles & Requirements

1. **Single Authoritative Source of Truth**:
   The dashboard's internal task manager (`js/dashboard-task.js`) remains the single authoritative source of truth for task state, events, and UI adaptation mode (`standard` vs. `focused`). The bridge transmits requests and observes events; it never introduces a secondary or divergent state.

2. **Strict Security Boundaries**:
   - **Origin Validation**: Both sender and receiver explicitly validate message origins. Wildcard target origins (`'*'`) are strictly forbidden.
   - **Source Validation**: Parent verifies `event.source === iframeElement.contentWindow`. Child verifies `event.source === window.parent`.
   - **Cross-Origin Configuration**: When deployed cross-origin in future setups, both sides must explicitly configure expected origins. Messages from unexpected origins are silently dropped or logged as rejections without throwing.
   - **Schema & Payload Validation**: All incoming messages are validated against a strict schema. Unknown types, unsupported versions, or invalid mode identifiers are rejected without mutating state.

3. **Predictable Session Lifecycle & Reload Isolation**:
   - Every dashboard instance generates an ephemeral, unique `sessionToken` upon initialization.
   - The parent binds its bridge state to the child's active `sessionToken`.
   - If the iframe reloads or navigates, a new session begins. The parent discards in-flight requests and stale acknowledgments belonging to prior sessions.

4. **Correlated Asynchronous Mode Requests**:
   - Mode change requests carry a unique `requestId`.
   - Acknowledgments reference this `requestId`, reporting the operation status (`applied`, `noop`, or `rejected`) and the actual authoritative `appliedMode`.
   - Requests time out deterministically if unacknowledged.

5. **Idempotency & Measurement Integrity**:
   - Duplicate mode requests for the currently active mode produce a `noop` acknowledgment and cause no repeated transitions, DOM reflows, or duplicate telemetry events.
   - Telemetry events from `dashboard-task.js` are forwarded once per event. No double-counting occurs.

6. **Standalone Graceful Degradation**:
   - When `dashboard.html` is run standalone (i.e. `window.parent === window`), the bridge remains dormant, and all dashboard controls continue to function independently.

---

## 2. Protocol Identification & Envelope

All messages transmitted over `window.postMessage` must conform to the following envelope structure:

```json
{
  "protocol": "IWAT_BRIDGE",
  "version": "1.0",
  "type": "<MESSAGE_TYPE>",
  "sessionToken": "<SESSION_TOKEN>",
  "timestamp": 123456.78,
  "payload": {}
}
```

| Field | Type | Description |
|---|---|---|
| `protocol` | `string` | Constant identifier: `"IWAT_BRIDGE"`. |
| `version` | `string` | Protocol version string: `"1.0"`. |
| `type` | `string` | One of the whitelisted message types listed below. |
| `sessionToken` | `string` | Unique instance identifier of the child iframe session. |
| `timestamp` | `number` | Monotonic timestamp (`performance.now()`) or epoch milliseconds. |
| `payload` | `object` | Type-specific data payload. |

---

## 3. Message Types & Schemas

### 3.1 Handshake Messages

#### `HANDSHAKE_INIT` (Child → Parent)
Sent by the dashboard when initialized or reloaded to notify the parent environment.

```json
{
  "protocol": "IWAT_BRIDGE",
  "version": "1.0",
  "type": "HANDSHAKE_INIT",
  "sessionToken": "session_1726700000000_a1b2c3d",
  "timestamp": 105.2,
  "payload": {
    "currentMode": "standard",
    "presentation": "accessible",
    "activeTaskId": "task-server-triage"
  }
}
```

#### `HANDSHAKE_ACK` (Parent → Child)
Sent by the parent in response to `HANDSHAKE_INIT` or `HANDSHAKE_PING` to confirm the channel is established.

```json
{
  "protocol": "IWAT_BRIDGE",
  "version": "1.0",
  "type": "HANDSHAKE_ACK",
  "sessionToken": "session_1726700000000_a1b2c3d",
  "timestamp": 110.5,
  "payload": {
    "connected": true,
    "parentSessionId": "parent_1726700000000_xyz"
  }
}
```

#### `HANDSHAKE_PING` (Parent → Child)
Sent by the parent if the iframe has already loaded before the parent bridge listener was registered. The child responds with `HANDSHAKE_INIT`.

```json
{
  "protocol": "IWAT_BRIDGE",
  "version": "1.0",
  "type": "HANDSHAKE_PING",
  "sessionToken": null,
  "timestamp": 50.1,
  "payload": {}
}
```

---

### 3.2 Mode Adaptation Messages

#### `SET_MODE_REQUEST` (Parent → Child)
Sent by the parent to request a UI adaptation mode change (`standard` or `focused`).

```json
{
  "protocol": "IWAT_BRIDGE",
  "version": "1.0",
  "type": "SET_MODE_REQUEST",
  "sessionToken": "session_1726700000000_a1b2c3d",
  "timestamp": 2500.0,
  "payload": {
    "requestId": "req_1726700002500_01",
    "targetMode": "focused",
    "reason": "manual_parent"
  }
}
```

- `payload.requestId`: Required non-empty string.
- `payload.targetMode`: Must be strictly `'standard'` or `'focused'`.
- `payload.reason`: Optional descriptive string (defaults to `'parent_bridge'`).

#### `MODE_ACK` (Child → Parent)
Sent by the child in response to `SET_MODE_REQUEST`.

```json
{
  "protocol": "IWAT_BRIDGE",
  "version": "1.0",
  "type": "MODE_ACK",
  "sessionToken": "session_1726700000000_a1b2c3d",
  "timestamp": 2502.4,
  "payload": {
    "requestId": "req_1726700002500_01",
    "status": "applied",
    "appliedMode": "focused",
    "previousMode": "standard",
    "reason": "manual_parent"
  }
}
```

- `status` values:
  - `"applied"`: Mode was updated from `previousMode` to `appliedMode`.
  - `"noop"`: Dashboard was already in `targetMode`; no change or duplicate transition occurred.
  - `"rejected"`: Request was invalid (e.g. unknown mode, mismatched session token, or malformed schema).

---

### 3.3 Task & Telemetry Event Forwarding

#### `TASK_EVENT` (Child → Parent)
Forwarded automatically whenever `dashboard-task.js` records an event into its immutable measurement stream.

```json
{
  "protocol": "IWAT_BRIDGE",
  "version": "1.0",
  "type": "TASK_EVENT",
  "sessionToken": "session_1726700000000_a1b2c3d",
  "timestamp": 3100.8,
  "payload": {
    "event": {
      "eventId": "evt_abc123_1726700003100",
      "timestamp": 3100.5,
      "isoTimestamp": "2026-09-19T04:26:40.500Z",
      "eventType": "TASK_START",
      "taskId": "task-server-triage",
      "presentation": "accessible",
      "details": {
        "startTime": 3100.5
      }
    }
  }
}
```

---

## 4. Lifecycle & Sequence Flow

### 4.1 Handshake Sequence

```text
Parent (index.html)                               Child Iframe (dashboard.html)
        |                                                     |
        |  [Iframe loads / DOM ready]                         |
        |<---------------- HANDSHAKE_INIT -------------------|  (sessionToken: S1)
        |                  (mode: standard)                   |
        |                                                     |
        |----------------- HANDSHAKE_ACK -------------------->|  (sessionToken: S1)
        |                  (connected: true)                  |
        |                                                     |
    Channel Ready                                         Channel Ready
```

### 4.2 Mode Request & Acknowledgment Sequence

```text
Parent (index.html)                               Child Iframe (dashboard.html)
        |                                                     |
        |--- SET_MODE_REQUEST (req_1, targetMode: focused) -->|
        |                                                     |
        |                                             taskManager.setMode('focused')
        |                                             applyMode('focused')
        |<-- TASK_EVENT (eventType: MODE_CHANGED) ------------|
        |<-- MODE_ACK (req_1, status: applied, mode: focused)-|
        |                                                     |
  Resolve req_1 Promise
```

### 4.3 Duplicate Request Handling (Idempotency)

```text
Parent (index.html)                               Child Iframe (dashboard.html)
        |                                                     |
        |--- SET_MODE_REQUEST (req_2, targetMode: focused) -->|
        |                                                     |
        |                                             Already in 'focused'
        |                                             (No setMode call, no event)
        |<-- MODE_ACK (req_2, status: noop, mode: focused) ---|
        |                                                     |
  Resolve req_2 Promise (noop)
```

### 4.4 Iframe Reload & Stale Message Rejection

```text
Parent (index.html)                               Child Iframe (dashboard.html)
        |                                                     |
        |  [Pending req_3 sent with sessionToken S1]          |
        |                                                     |
        |  [Iframe reloads]                                   |
        |  Old session S1 destroyed                           |
        |  New session S2 created                             |
        |<---------------- HANDSHAKE_INIT -------------------|  (sessionToken: S2)
        |                                                     |
  Invalidate S1 requests (req_3 fails with SESSION_SUPERSEDED)|
  Update active session to S2                                 |
        |----------------- HANDSHAKE_ACK -------------------->|  (sessionToken: S2)
        |                                                     |
  [Late message arrives from S1]                              |
  Parent drops message (sessionToken S1 != active S2)         |
```

---

## 5. Security & Origin Validation Specification

1. **Explicit Origin Matching**:
   ```javascript
   // origin validation predicate
   function isAllowedOrigin(eventOrigin, configuredOrigin) {
       if (!configuredOrigin || !eventOrigin) return false;
       return eventOrigin === configuredOrigin;
   }
   ```
2. **Same-Origin Default**:
   In local development and same-origin hosting, `configuredOrigin` defaults to `window.location.origin`.
3. **Cross-Origin Configuration**:
   When embedded across different origins, the parent specifies `childOrigin` (e.g. `'https://dashboard.example.com'`), and the child specifies `parentOrigin` (e.g. `'https://app.example.com'`). Wildcard origins (`'*'`) are rejected by the validator.
4. **Window Source Verification**:
   - Parent validates `event.source === iframeElement.contentWindow`.
   - Child validates `event.source === window.parent`.
