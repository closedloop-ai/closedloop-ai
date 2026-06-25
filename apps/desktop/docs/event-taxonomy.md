# Desktop Product Analytics Event Taxonomy

Living reference of product analytics events captured by the desktop app and
relayed to `symphony-alpha` over the authenticated gateway socket. Electron
does not package, read, or send a PostHog token; `symphony-alpha` validates,
enriches, feature-gates, and forwards accepted events server-side.

> **See also:** for **harness session telemetry** (which session metrics come
> from log parsing vs. event hooks, per harness), see
> [`harness-telemetry-matrix.md`](./harness-telemetry-matrix.md). That is a
> different data layer from the product-analytics / Datadog events below.

## Naming Convention

- Underscore-separated: `command_initiated`, `approval_resolved`
- New events must follow `<domain>_<action>` pattern
- Do not create events without adding them to this document and to `observability.ts`
- All event names (both PostHog and Datadog categories) must use past-tense verbs: `command_initiated` (not `command_initiate`), `connection.established` (not `connection.establish`).

## Events

### Command Funnel

| Event | Properties | Funnel Position |
|-------|-----------|-----------------|
| `command_initiated` | `command_id`, `operation_type`, common properties | 1 |
| `command_started` | `command_id`, `operation_type` | 2 |
| `command_completed` | `command_id`, `operation_type`, `latency_ms`, common properties | 3 (success) |
| `command_failed` | `command_id`, `operation_type`, `error_class` (timeout/cancelled/gateway_error) | 3 (failure) |

### Approval Workflow

| Event | Properties |
|-------|-----------|
| `approval_requested` | `operation_type`, `command_id` (optional) |
| `approval_resolved` | `operation_type`, `outcome` (granted/denied/timed_out), `time_to_resolve_ms`, `command_id` (optional) |

### Connection Lifecycle

| Event | Properties |
|-------|-----------|
| `desktop_connection_established` | `version`, `environment`, common properties |
| `desktop_reconnection_resumed` | `reason`, `replay_command_count` |

### Sandbox

| Event | Properties |
|-------|-----------|
| `sandbox_blocked_operation` | `operation_class` |

## Telemetry Events (Datadog-bound)

Structured events emitted via `TelemetryService` (`src/main/telemetry-service.ts`), transported through the cloud relay socket to Datadog. These are distinct from the product analytics events above because they carry operational diagnostics, not user-behavior analytics. Categories are defined in the `TelemetryCategory` string-literal union type in `src/main/telemetry-protocol.ts`.

### Connection Lifecycle

| Category | Severity | Trigger / Message | Trace Fields | Emitting Method |
|----------|----------|-------------------|--------------|-----------------|
| `connection.established` | info | `"Connection established"` | `computeTargetId` | `Observability.connectionEstablished()` |
| `connection.reconnection_resumed` | info | `"Reconnection resumed"` | _(none)_ — `reason`, `replayCommandCount` in `diagnostics.extra` | `Observability.reconnectionResumed()` |
| `connection.degraded` | warn | _(error string passed by caller)_ | _(none)_ | `Observability.connectionDegraded()` |
| `connection.lost` | warn | `reason` if provided, else `"Connection lost"` | _(none)_ | `Observability.connectionLost()` |

### Command Lifecycle

| Category | Severity | Trigger / Message | Trace Fields | Emitting Method |
|----------|----------|-------------------|--------------|-----------------|
| `command.initiated` | info | `"Command initiated"` | `commandId`, `operationId` | `Observability.commandInitiated()` |
| `command.started` | info | `"Command started"` | `commandId`, `operationId` | `Observability.commandStarted()` |
| `command.completed` | info | `"Command completed"` | `commandId`, `operationId` — `latencyMs` in `diagnostics.extra` | `Observability.commandCompleted()` |
| `command.timeout` | error | `"Command timed out"` | `commandId`, `operationId` | `Observability.commandTimedOut()` |
| `command.cancelled` | warn | `"Command cancelled"` | `commandId`, `operationId` | `Observability.commandCancelled()` |
| `command.gateway_error` | error | _(message string passed by caller)_ | `commandId`, `operationId` | `Observability.commandFailed()` |

### Job Lifecycle

> **WARNING:** `diagnostics.logTail` contains raw subprocess output truncated to 4 KiB by `truncateToBytes()` — NOT sanitized for secrets or PII.

| Category | Severity | Trigger / Message | Trace Fields | Emitting Method |
|----------|----------|-------------------|--------------|-----------------|
| `job.started` | info | `"Job started with pid=<pid>"` | `commandId`, `operationId`, `loopId`, `jobId` | `Observability.jobStarted()` |
| `job.completed` | info | `"Job completed successfully"` | `commandId`, `operationId`, `loopId`, `jobId`, `loopSessionId` | `Observability.jobCompleted()` |
| `job.failed` | error | `"Process exited with code <exitCode>"` | `commandId`, `operationId`, `loopId`, `jobId`, `loopSessionId` — `exitCode` in diagnostics | `Observability.jobFailed()` |
| `job.cancelled` | info | `"Process cancelled (exit code <exitCode>)"` | `commandId`, `operationId`, `loopId`, `jobId`, `loopSessionId` — `exitCode` in diagnostics | `Observability.jobCancelled()` |
| `job.auth_challenge` | error | `"Auth challenge detected (exit code <exitCode>)"` | `commandId`, `operationId`, `loopId`, `jobId`, `loopSessionId` — `exitCode` in diagnostics | `Observability.jobAuthChallenge()` |
| `job.recovery.finalize_replayed` | TBD | _(emitted externally)_ | _(varies)_ | via `Observability.getTelemetryEmitter()` |

### Preflight Checks

| Category | Severity | Trigger / Message | Trace Fields | Emitting Method |
|----------|----------|-------------------|--------------|-----------------|
| `preflight.binary_not_found` | error | `"claude CLI not found in PATH"` | `commandId`, `operationId`, `loopId` | `Observability.preflightBinaryNotFound()` |
| `preflight.script_not_found` | error | `"run-loop.sh not found in plugin cache"` | `commandId`, `operationId`, `loopId` | `Observability.preflightScriptNotFound()` |
| `preflight.spawn_failed` | error | _(message string passed by caller)_ | `commandId`, `operationId`, `loopId` | `Observability.preflightSpawnFailed()` |

### Queue Stats

| Category | Severity | Trigger / Message | Trace Fields | Emitting Method |
|----------|----------|-------------------|--------------|-----------------|
| `queue.stats_changed` | _(reserved)_ | _(no confirmed active call site)_ | _(TBD)_ | _(none — defined in `TelemetryCategory`, no dedicated `Observability` method)_ |

### Common Trace Fields

Every Datadog-bound event emitted by `TelemetryService.enrichEvent()` contains the following fields in its `trace` object, regardless of which `Observability` method triggered it. See `TelemetryTraceContext` in `src/main/telemetry-protocol.ts` for the complete interface definition.

#### Auto-injected by `enrichEvent()`

| Field | Type | Value | Notes |
|-------|------|-------|-------|
| `schemaVersion` | `string` | `"1"` | Always present; hardcoded constant |
| `timestamp` | `string` | `new Date().toISOString()` | ISO-8601 UTC; set at emit time |
| `computeTargetId` | `string` | Relay hello-ack identifier, or `""` | Set via `Observability.setTargetId()` → `TelemetryService.setTargetId()`; empty string until relay handshake completes |
| `gatewaySessionId` | `string` | Cloud socket session identifier | Set via `TelemetryService.setGatewaySessionId()`; **omitted from trace entirely** if not yet set |
| `commandId` | `string` | Caller-provided, or `""` | Defaulted to `""` by `enrichEvent()` before applying caller-provided trace; always present on the wire |
| `operationId` | `string` | Caller-provided, or `""` | Same default behaviour as `commandId`; always present on the wire |

#### Caller-populated only (not auto-injected)

These fields from `TelemetryTraceContext` are **not** added by `enrichEvent()`. They appear only when the calling `Observability` method explicitly sets them — currently limited to job lifecycle events (`job.*`) and preflight events.

| Field | Type | Populated by |
|-------|------|-------------|
| `loopId` | `string` | `Observability.jobStarted()`, `jobCompleted()`, `jobFailed()`, `jobCancelled()`, `jobAuthChallenge()`, preflight methods |
| `jobId` | `string` | `Observability.jobStarted()`, `jobCompleted()`, `jobFailed()`, `jobCancelled()`, `jobAuthChallenge()` |
| `loopSessionId` | `string` | `Observability.jobCompleted()`, `jobFailed()`, `jobCancelled()`, `jobAuthChallenge()` |

> **Privacy warning:** `diagnostics.logTail` contains raw subprocess output truncated to 4 KiB by `truncateToBytes()` for size only — it is **NOT sanitized for secrets or PII** before transmission to Datadog.

## Common Properties

Desktop sends only bounded non-sensitive event properties. `symphony-alpha`
adds the server-owned common properties before forwarding:

- `distinct_id` — gateway-owner Clerk user id from authenticated socket context
- `compute_target_id` — authenticated compute target id from socket/session context
- `organization_id` — gateway-owner organization id from authenticated socket context
- `origin` — always `desktop`
- `desktop_attribution_model` — always `gateway_owner`
- `desktop_client_version` — Electron app version when Desktop supplied it
- `platform` — Node/Electron `process.platform` when Desktop supplied it

Desktop product analytics event names remain underscore-separated and non-namespaced for parity with the existing taxonomy.

### Joining Desktop and Web Events

Web analytics identify users with Clerk user ids. To join Desktop and web behavior for a gateway owner, filter PostHog events where `distinct_id = <gateway-owner-clerk-user-id>` and compare Desktop events such as `command_completed` or `desktop_connection_established` with web events for the same user. Add `compute_target_id = <target-id>` when target-level slicing is needed.

### Shared Gateway Attribution

Desktop-originated product analytics are gateway-owner/device analytics. When a compute target is shared with the organization and another user dispatches a command, events emitted by the owner's Electron gateway still use the owner's Clerk id as server-enriched `distinct_id` and include `desktop_attribution_model = "gateway_owner"`. Per-requester Desktop attribution is not available in this feature because the current `desktop.command` payload does not carry requester Clerk identity; use server-side or web events for requester analytics until a separate per-command attribution feature exists.

### Rollout Control

Server forwarding is controlled by the `desktop-server-analytics-relay` feature
flag in `symphony-alpha`. When disabled, the server returns a feature-disabled
ack and Desktop drops analytics without affecting command/control traffic.

### Manual Validation

1. Ensure the server environment has PostHog configured and the server relay
   flag enabled for the gateway owner.
2. Run Desktop and connect to cloud with a gateway-owner account that has Clerk
   identity.
3. Trigger a command, then quit immediately after the command event.
4. Verify `command_initiated`, `command_completed`, and
   `desktop_connection_established` appear in PostHog within about 60 seconds
   with server-owned `distinct_id`, `compute_target_id`,
   `desktop_client_version`, `platform`, `organization_id`, and
   `desktop_attribution_model = "gateway_owner"`.

## Adding New Events

### Adding a product analytics event

1. Add a typed method to `Observability` class in `src/main/observability.ts`
2. Add tests in `test/observability.test.ts`
3. Update this document

### Adding a TelemetryService (Datadog) event

1. **Add the category to `TelemetryCategory` in `src/main/telemetry-protocol.ts`.** `TelemetryCategory` is a TypeScript string-literal union type alias — not an enum or const object. Append your new category as a new line in the union:

   ```ts
   export type TelemetryCategory =
     | "command.timeout"
     // ... existing members ...
     | "domain.new_action";   // ← add here, one literal per line
   ```

   TypeScript strict mode will reject any string not present in the union when it is passed to `emitTelemetry()`, so the compiler enforces the registry.

2. **Add a static method to `Observability` in `src/main/observability.ts`** that delegates to the private `emitTelemetry(severity, category, message, trace, diagnostics?)` helper. Follow the signature conventions used by existing methods:

   - Job-lifecycle and preflight methods take `commandId: string | undefined, operationId: string | undefined` (because the values may not be available at the call site).
   - Connection-lifecycle methods take concrete string parameters and pass them directly in the `trace` object or in `diagnostics.extra`.

   Example skeleton for a job-scoped event:

   ```ts
   static domainNewAction(commandId: string | undefined, operationId: string | undefined): void {
     Observability.emitTelemetry("info", "domain.new_action", "Action description", {
       commandId,
       operationId,
     });
   }
   ```

3. **Add a test in `apps/desktop/test/observability.test.ts`** using the `node:test` `test()` function and `mock.method` pattern established in the file. At minimum, verify the emitted event's `category`, `severity`, and relevant `trace` fields:

   ```ts
   test("domainNewAction emits telemetry with correct category", () => {
     const telemetryEvents: EnrichedTelemetryEvent[] = [];
     Observability.init({
       telemetrySend: (event) => telemetryEvents.push(event),
     });

     Observability.domainNewAction("cmd-1", "OP_TYPE");

     assert.equal(telemetryEvents.length, 1);
     assert.equal(telemetryEvents[0].category, "domain.new_action");
     assert.equal(telemetryEvents[0].severity, "info");
     assert.equal(telemetryEvents[0].trace?.commandId, "cmd-1");
   });
   ```

4. **Document the event in the "Telemetry Events (Datadog-bound)" section of this file.** Add a row to the appropriate sub-table (or create a new sub-section if it belongs to a new domain) following the existing column layout:

   | Category | Severity | Trigger / Message | Trace Fields | Emitting Method |
   |----------|----------|-------------------|--------------|-----------------|
   | `domain.new_action` | info | `"Action description"` | `commandId`, `operationId` | `Observability.domainNewAction()` |

## End-to-End Telemetry Verification

Manual runbook to confirm that a Datadog-bound telemetry event travels the full path from the desktop process through the cloud relay to Datadog. Uses only connection-lifecycle events to avoid triggering job lifecycle events, which populate `diagnostics.logTail` with raw subprocess output that may contain secrets.

1. **Start the desktop app.**

   ```sh
   just desktop-dev
   ```

2. **Connect to the relay.** Open the desktop UI and authenticate so the cloud socket reaches the connected state. The `connection.established` event fires at this point — it is the event under test. Do NOT trigger any job lifecycle events during this verification step.

3. **Verify cloud socket state.** In the desktop process logs, confirm a line matching `cloud socket connected` (or the equivalent phrasing emitted by your relay client). This confirms the local side fired before checking the remote side.

4. **Verify Datadog receipt.** Within 60 seconds of step 2, query Datadog Logs with the following filter:

   ```
   service:closedloop-desktop category:connection.established
   ```

   Alternatively, use the Datadog Logs UI and search for `@category:connection.established`.

### Pass criteria

The event appears in Datadog within 60 seconds and satisfies all of the following:

- `category` is `connection.established`
- `trace.schemaVersion` is `"1"`
- `trace.computeTargetId` is a non-empty string (populated after the relay hello-ack handshake)

### Fail / Troubleshoot

**(a) Event is missing from Datadog.**
Check the desktop process logs for errors in the `sendTelemetry` callback. A stack trace or `"failed to send telemetry"` message here indicates the event was built but not transmitted.

**(b) Event not received by the relay.**
Check cloud relay logs for received telemetry frames. If the relay never sees the frame, the problem is between the desktop socket client and the relay — inspect the WebSocket connection and any reconnection errors.

**(c) `Observability.init()` called with a no-op sender.**
Running `just desktop-no-auth` calls `initNoOp()`, which discards all telemetry events without transmitting them. Verify that `Observability.init()` was called with a real `telemetrySend` callback (i.e. the app is authenticated and connected to the cloud relay) before concluding that events are lost.
