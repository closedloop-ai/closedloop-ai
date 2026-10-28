# Desktop Product Analytics Event Taxonomy

Living reference of product analytics events captured by the desktop app and
sent to `closedloop-ai`'s `POST /desktop/analytics` route over HTTP. Electron
does not package, read, or send a PostHog token; `closedloop-ai` validates,
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

Structured events emitted via `TelemetryService` (`src/main/telemetry-service.ts`), sent to the API's `POST /desktop/telemetry` route and logged to Datadog. These are distinct from the product analytics events above because they carry operational diagnostics, not user-behavior analytics. Categories are defined in the `TelemetryCategory` string-literal union type in `src/main/telemetry-protocol.ts`.

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

> **Privacy warning:** `diagnostics.logTail` contains raw subprocess output truncated to 4 KiB by `truncateToBytes()` for size only — it is **NOT sanitized for secrets or PII** before transmission to Datadog.

## Common Properties

Desktop sends only bounded non-sensitive event properties. `closedloop-ai`
adds the server-owned common properties before forwarding:

- `distinct_id` — gateway-owner Clerk user id from the authenticated request
- `compute_target_id` — compute target id, ownership-checked against the authenticated request
- `organization_id` — gateway-owner organization id from the authenticated request
- `origin` — always `desktop`
- `desktop_attribution_model` — always `gateway_owner`
- `desktop_client_version` — Electron app version when Desktop supplied it
- `platform` — Node/Electron `process.platform` when Desktop supplied it

Desktop product analytics event names remain underscore-separated and non-namespaced for parity with the existing taxonomy.

### Joining Desktop and Web Events

Web analytics identify users with Clerk user ids. To join Desktop and web behavior for a gateway owner, filter PostHog events where `distinct_id = <gateway-owner-clerk-user-id>` and compare Desktop events such as `command_completed` or `desktop_connection_established` with web events for the same user. Add `compute_target_id = <target-id>` when target-level slicing is needed.

### Gateway Owner Attribution

Desktop-originated product analytics are gateway-owner/device analytics: events emitted by the owner's Electron gateway use the owner's Clerk id as server-enriched `distinct_id` and include `desktop_attribution_model = "gateway_owner"`. Compute targets are no longer shared with the organization (ISS-12617), so the requester of a command is the gateway owner. The `desktop.command` payload does not carry requester Clerk identity; use server-side or web events for requester analytics.

### Rollout Control

Server forwarding is always on: PRD-736 P1 retired the
`desktop-server-analytics-relay` feature flag (100% rollout since 2026-05-18).
Two Vercel Firewall rules match the `/desktop/analytics` path as a prefix,
managed by OpenTofu in example-org/infrastructure (`stage/vercel/api` and
`prod/vercel/api`; platform-portable to AWS WAF if the API moves to ECS): an
active rate limit of 600 requests per minute per IP that answers 429, and the
kill switch for Desktop's transport, an edge-WAF deny rule that is present but
off by default.
Desktop's only analytics transport is that HTTP lane,
and it treats the deny rule's uncoded 403 as a silent drop without affecting
command/control traffic.

### Manual Validation

1. Ensure the server environment has PostHog configured.
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

   - Command-scoped methods that may not have the values at the call site take `commandId: string | undefined, operationId: string | undefined`.
   - Connection-lifecycle methods take concrete string parameters and pass them directly in the `trace` object or in `diagnostics.extra`.

   Example skeleton for a command-scoped event:

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

Manual runbook to confirm that a Datadog-bound telemetry event travels the full path from the desktop process through the API's `POST /desktop/telemetry` route to Datadog. Uses only connection-lifecycle events, so no event carries `diagnostics.logTail` raw subprocess output that may contain secrets.

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

**(b) Event not received by the API.**
Check the API logs for `POST /desktop/telemetry` requests. If none arrive, the problem is between the desktop HTTP telemetry lane and the API — the lane sends only while a first-party session is signed in and the cloud socket has resolved the compute-target identity, so confirm both before inspecting the HTTP request itself.

**(c) `Observability.init()` called with a no-op sender.**
Running `just desktop-no-auth` calls `initNoOp()`, which discards all telemetry events without transmitting them. Verify that `Observability.init()` was called with a real `telemetrySend` callback (i.e. the app is authenticated and connected to the cloud relay) before concluding that events are lost.


## Failed account-step attempts (ISS-11127)

`onboarding_step_failed` is the generic failed-step event. Browser sign-in emits
it at most once per unsuccessful run, with `step: account`, the standard funnel
properties, and the closed `failure_reason`. It always uses that run's pre-auth
`flow_id` identity. It does not imply account creation or completion.

| Evidence | `account_mode` |
| --- | --- |
| Creation received in the matching callback, login failed | `["created", "logged_out"]` |
| Browser opened, no creation observed | `["creation_unconfirmed"]` |
| Browser never opened | `["creation_unattempted"]` |
| Older or unrecognized outcome | `["unknown"]` |

An authenticated run emits no failure. A browser closed without a callback is
reported by the existing timeout or cancellation; there is no browser-closed
reason. A received creation fact survives cancellation during exchange.

The optional case 2 join registers the existing PKCE challenge directly with
`/desktop/analytics/sign-in/register`; the web server reports the validated run
cookie's challenge to `/desktop/analytics/sign-in/report`. No flow ID goes on a
URL, and no challenge (raw or hashed) goes to PostHog. The store expires after
20 minutes; conditional consumption and Clerk creation-time verification happen
server-side. Neither HTTP operation is awaited by sign-in.

### Release verification

Deploy the reader-contract PR before the emitter PR. The September 30 privacy
ruling permits case 2 (ISS-11606); the ISS-10682 edge deny and 600 requests/min/IP
rules must still be verified for the entire `/desktop/analytics` prefix before
registration ships. Apply the generated migration and verify Prisma dev drift
and seed on a throwaway PostgreSQL database. Never use a shared database for
that verification.

The case 2 monitoring insight is the person-joined funnel `User Created` →
`onboarding_step_failed` filtered to `step = account` and
`account_mode contains creation_unconfirmed`, excluding flows with
`onboarding_step_completed[account]`. Use the event's `flow_id` to distinguish
attempts and weekly buckets at the current low traffic volume. Compare its
count against new desktop-initiated sign-ups; a sustained zero after nonzero
sign-ups needs investigation of registration validation, the 1,000-row live
cap (API warn `registration_cap_reached`), lookup expiry and Clerk report
delivery, including after PKCE-format changes. Configure and verify
this insight in PostHog before rollout; a local test cannot establish delivery
to the production analytics sink.
