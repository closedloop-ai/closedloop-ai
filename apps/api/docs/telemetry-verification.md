# Source of truth for TelemetryCategory values: packages/observability/telemetry/telemetry-category.ts — update this document when categories are added or removed.

This document is the authoritative verification guide for structured telemetry events in the Closedloop relay pipeline.

## Contents

- [Prerequisites — Datadog Pipeline](#prerequisites--datadog-pipeline)
- [Local Setup](#local-setup)
- [Trigger Scenarios](#trigger-scenarios)
- [Expected Datadog Queries](#expected-datadog-queries)
- [Expected Field Values](#expected-field-values)
- [Dependencies and Scope](#dependencies-and-scope)

## Prerequisites — Datadog Pipeline

`log.ts` batches `DatadogLogEntry[]` and flushes them to `https://http-intake.logs.{DD_SITE}/api/v2/logs`. For events emitted through `emitter.ts`, `logAtSeverity()` dispatches to `log.error`, `log.warn`, or `log.info` based on the event's `severity` — the resulting Datadog `level` attribute reflects that choice. In all three cases the event is emitted as a stringified JSON payload, so the telemetry fields (`category`, `severity`, `schemaVersion`, `trace`, etc.) land inside the `message` string rather than as top-level Datadog attributes. `origin` is the exception **on the agentless intake only** — `buildEntry()` in `log.ts` sets it as a top-level `DatadogLogEntry` attribute, so `@origin:` is facet-queryable there without the pipeline rule regardless of emission path. Nothing puts `origin` on the console line: `makeLogFn()` calls `buildEntry()` only inside `if (DD.target)`, and `writeConsole()` serializes `stampSeverity()` (`{ ...meta, message, level, status }`), which has no `origin`. On either console-drain sink below, `@origin:` matches nothing.

### Which sink you are querying

Three sinks carry these logs, and they do not answer the same queries. Pick the row that matches the service you are verifying before you trust a query in this document — `resolveStructuredConsole()` (`packages/observability/log.ts`) decides between the two console forms.

| Sink | When | `@category:` | `@origin:` | Raw `@message:*<category>*` |
|---|---|---|---|---|
| Agentless HTTP intake | `DD_API_KEY` set | top-level for metadata-shaped calls; needs the pipeline rule for `emitter.ts` payloads | yes — `buildEntry()` | only for `emitter.ts` payloads |
| Structured console → platform drain | `DD_LOGS_JSON=1`, or auto-on under Vercel | same as above | **no** | same as above |
| Readable console → platform drain | the default everywhere else — including the relay's Fargate container, which sets neither (`apps/relay/Dockerfile:135-142`) | **no** — `util.inspect` renders the meta into the drained text | **no** | **yes — this is the working route here** |

Every query in this document is written for the agentless intake, which is what the [Local Setup](#local-setup) and [Trigger Scenarios](#trigger-scenarios) sections configure. On a readable-console deployment, drop the `@origin:` term and use the fallback column.

### Pipeline rule required

Faceted queries like `@category:"command.queued"` only work after Datadog parses the `message` field as JSON. Configure a **Grok Parser** or **JSON Parser** pipeline rule:

| Setting | Value |
|---|---|
| Rule type | JSON Parser (or Grok with `%{data::json}`) |
| Source attribute | `message` |
| Target index (placeholder) | `main` |

Without the pipeline rule, fall back to **raw-text searches** against the unparsed `message` string:

```
*command.queued*
*command.acknowledged*
*job.started*
*electron_update.failed*
*desktop.shutdown_failed*
*telemetry.validation_failed*
```

Raw-text searches are slower and cannot filter by structured facets, but they confirm events are reaching Datadog before the pipeline is configured.

`*telemetry.validation_failed*` is the odd one out: `handleTelemetryEvent()` logs that category as metadata rather than a stringified payload (`apps/api/lib/desktop-telemetry-handler.ts:63`, `:76`), so on the agentless intake or a structured console drain the token is a top-level facet and never enters `message` — query `@category:"telemetry.validation_failed"` instead. It only behaves like the other five on the readable-console drain.

## Local Setup

Set the following variables in `apps/api/.env.local`:

| Variable | Description | Example |
|---|---|---|
| `DD_API_KEY` | Logs Write API key — Datadog Organization Settings → API Keys | `abc123...` |
| `DD_SITE` | Your Datadog intake site | `datadoghq.com` |
| `DD_ENV` | Environment label applied to `ddtags` | `local` |

`DD_SERVICE` must also be set to `api` so `origin` resolves correctly (see [Expected Field Values](#expected-field-values)). The relay service sets `DD_SERVICE=relay`.

## Trigger Scenarios

All five scenarios require `DD_API_KEY`, `DD_SITE`, and `DD_ENV` to be set. Scenarios (a), (b), (c), and (d) additionally use `$CLOSEDLOOP_API_KEY` — an org-issued API key; replace it with the value from your local env. Scenario (e) needs no credential beyond a connected desktop worker.

### (a) API-native command lifecycle

Post a command to the API's `/compute-targets/<id>/commands` route to trigger `command.queued` → `command.dispatched` telemetry (origin: `api`). Both events are emitted from within this API route — `command.queued` from `desktop-command-store.ts` when the command row is created, and `command.dispatched` from the route handler after the relay HTTP call returns. Hitting the relay's `/dispatch` endpoint directly bypasses these emission sites and produces no telemetry.

```sh
curl -X POST http://localhost:3002/compute-targets/<your-compute-target-id>/commands \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLOSEDLOOP_API_KEY" \
  -d '{
    "operationId": "test-op-001",
    "method": "GET",
    "path": "/api/gateway/health-check"
  }'
```

Expected: `command.queued` telemetry is emitted once the DB row is created, followed by `command.dispatched` after the API forwards the envelope to the relay. Both are emitted regardless of whether a desktop worker is connected (the relay-delivered/undelivered distinction is captured in `command.dispatched` meta, not in whether it is emitted).

### (b) Desktop-forwarded telemetry event

Post a Desktop telemetry event for `TelemetryCategory.JobStarted = "job.started"` to the write-lane route Desktop uses, `POST /desktop/telemetry`. The compute target must belong to the API key's user. This hits `handleTelemetryEvent()` in `apps/api/lib/desktop-telemetry-handler.ts`, which sets `origin = Origin.Desktop`:

```sh
curl -X POST "http://localhost:3002/desktop/telemetry?computeTargetId=<your-compute-target-id>" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLOSEDLOOP_API_KEY" \
  -d '{
    "schemaVersion": "1",
    "category": "job.started",
    "severity": "info",
    "timestamp": "2024-01-01T00:00:00.000Z",
    "trace": {
      "commandId": "test-cmd-001",
      "operationId": "test-op-001",
      "computeTargetId": "<your-compute-target-id>",
      "gatewaySessionId": "00000000-0000-0000-0000-000000000001",
      "schemaVersion": "1"
    }
  }'
```

Expected: structured log entry in Datadog with `category: "job.started"` and `origin: "desktop"`.

### (c) Desktop update and shutdown failure telemetry

Post critical Desktop failure events to the same `POST /desktop/telemetry` route. These events are intentionally bounded diagnostics only; raw log content is not part of the accepted schema, and unknown raw-log fields are stripped before Datadog logging.

```sh
curl -X POST "http://localhost:3002/desktop/telemetry?computeTargetId=<your-compute-target-id>" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLOSEDLOOP_API_KEY" \
  -d '{
    "schemaVersion": "1",
    "category": "electron_update.failed",
    "severity": "error",
    "timestamp": "2024-01-01T00:00:00.000Z",
    "trace": {
      "commandId": "",
      "operationId": "desktop-update-test-001",
      "computeTargetId": "<your-compute-target-id>",
      "gatewaySessionId": "00000000-0000-0000-0000-000000000001",
      "schemaVersion": "1"
    },
    "diagnostics": {
      "desktopUpdate": {
        "trigger": "apply-before-downloaded",
        "status": "available",
        "downloaded": false,
        "readyToInstall": false,
        "error": "Update not downloaded"
      }
    }
  }'
```

```sh
curl -X POST "http://localhost:3002/desktop/telemetry?computeTargetId=<your-compute-target-id>" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLOSEDLOOP_API_KEY" \
  -d '{
    "schemaVersion": "1",
    "category": "desktop.shutdown_failed",
    "severity": "error",
    "timestamp": "2024-01-01T00:00:00.000Z",
    "trace": {
      "commandId": "",
      "operationId": "desktop-shutdown-test-001",
      "computeTargetId": "<your-compute-target-id>",
      "gatewaySessionId": "00000000-0000-0000-0000-000000000001",
      "schemaVersion": "1"
    },
    "diagnostics": {
      "desktopShutdown": {
        "trigger": "outer-hard-exit",
        "result": "timed_out",
        "phase": "server.stop",
        "duringUpdate": true,
        "outerHardExit": true,
        "elapsedMs": 12000,
        "error": "Shutdown exceeded hard exit timeout"
      }
    }
  }'
```

Expected: each Datadog log has top-level `origin: "desktop"` and top-level `category` set to the submitted category, so `@origin:"desktop" @category:"electron_update.failed"` and `@origin:"desktop" @category:"desktop.shutdown_failed"` resolve without the JSON pipeline rule. `diagnostics.desktopUpdate` and `diagnostics.desktopShutdown` contain only schema-bounded fields; no raw log upload is accepted.

### (d) Validation failure trigger

Same endpoint as (b), but with an intentionally invalid payload (missing required `schemaVersion` field). This triggers `telemetry.validation_failed`:

```sh
curl -X POST "http://localhost:3002/desktop/telemetry?computeTargetId=<your-compute-target-id>" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLOSEDLOOP_API_KEY" \
  -d '{
    "category": "job.started",
    "severity": "info",
    "timestamp": "2024-01-01T00:00:00.000Z",
    "trace": {
      "commandId": "test-cmd-001",
      "operationId": "test-op-001",
      "computeTargetId": "<your-compute-target-id>"
    }
  }'
```

Expected: a 400 response with `code: "validation_failed"`, and a log entry with `category: "telemetry.validation_failed"` and an `issues` array describing the missing `schemaVersion`.

### (e) Connection lifecycle events

Connection lifecycle events require an actual Socket.IO connection from a desktop worker to the relay. They split by origin:

- **Relay-origin** (`connection.socket_accepted`, `connection.reconnecting`, `connection.degraded`, `connection.disconnected`, `connection.stale_heartbeat`) — emitted directly by `apps/relay/src/index.ts`, `apps/relay/src/worker-heartbeat.ts`, and `apps/relay/src/registry-ownership.ts` via `log.*(message, { category, ... })`, bypassing the structured `emitter.ts` pipeline. That call shape matters for how you query them: `stampSeverity()` in `packages/observability/log.ts` spreads the caller's metadata at the TOP LEVEL of the entry (`{ ...meta, message, level, status }`), which both the agentless `buildEntry()` payload and the STRUCTURED console line are built from. On those two sinks `@category:` and `@registryOperation:` are first-class Datadog attributes and are facet-queryable **without** the JSON-message pipeline rule — the opposite of the `emitter.ts` path, where the payload IS the message string and the fields only become facets after parsing. On the READABLE console line — the relay's own default in its Fargate container — none of that holds: `writeConsole()` falls through to `consoleFn(message, ...args)` and the drain sees `util.inspect` text, so use the fallback column. Origin resolves to `relay` via `DD_SERVICE`, but is stamped onto the entry only by `buildEntry()`, so `@origin:"relay"` is an agentless-intake term (see [Which sink you are querying](#which-sink-you-are-querying)). Severity is mixed: `connection.socket_accepted`, `connection.reconnecting`, and `connection.disconnected` use `log.info` and land with `level:"info"`; `connection.degraded` uses `log.warn` and lands with `level:"warn"`. `connection.stale_heartbeat` spans two levels — `log.warn` for the routine stale/heal/rollback signals, and `log.error` for a registry reclaim that FAILED against its backing store (ISS-6213), which leaves a connected target undiscoverable to every other relay instance. Scoping a Datadog query with `level:info` would silently drop the degradation signals, and scoping with `level:warn` would drop the reclaim failure.
- **API-origin** (`connection.registered`, `connection.resumed`) — emitted from `apps/api/app/internal/relay/socket-event/service.ts` via `emitConnectionStateEvent()` through `emitter.ts`. Origin resolves to `api`.

To trigger them: start the relay (`pnpm turbo dev --filter=relay`) and connect a desktop worker. The relay emits its categories on socket accept, disconnect, heartbeat-stale detection, and reconnect; the API emits its categories when acknowledging the worker's hello.

## Expected Datadog Queries

The pipeline rule requirement varies by emission path:

- **`emitter.ts`-produced events** — emitted as `log.*(JSON.stringify(payload))` via `logAtSeverity()`. `category`, `severity`, `trace`, etc. live inside the stringified `message` field and require the pipeline rule to be facet-queryable. Without it, use the raw-text fallbacks from the Prerequisites section. This is the shape of the API-origin events in the table below, but **not of every event the API emits** — see the exception directly below.
- **API-origin events that bypass `emitter.ts`** — `handleTelemetryEvent()` (`apps/api/lib/desktop-telemetry-handler.ts:63`, `:76`) logs its own validation failures as `log.warn("<sentence>", { category: TelemetryCategory.TelemetryValidationFailed, ... })`. That is metadata, not a stringified payload, so `telemetry.validation_failed` is already a top-level facet with no pipeline rule — and the `*telemetry.validation_failed*` raw-text search listed under [Prerequisites](#prerequisites--datadog-pipeline) will NOT find it on a JSON-parsed sink, because the token never enters `message`.
- **Relay-origin connection lifecycle events** — emitted as `log.*("<sentence>", { category, ... })` directly from `apps/relay`, which never calls `emitter.ts`. `category` and friends are top-level attributes, so they need no pipeline rule. `origin` is NOT among them — it is added only by `buildEntry()`, so `@origin:"relay"` resolves on the agentless intake and misses every record on either console drain. See [Relay connection events](#relay-connection-events-origin-relay).
- **Desktop-origin events** — emitted via `handleTelemetryEvent()` using `log.info("message", { meta })`. `log.ts` spreads the meta object into top-level `DatadogLogEntry` attributes, so `@category:` resolves without the pipeline rule; `@origin:` carries the same agentless-only caveat as above.

`@origin:` is top-level and queryable without the pipeline rule regardless of emission path, but **only on the agentless intake** (see [Which sink you are querying](#which-sink-you-are-querying)).

For desktop target traceability, prefer `@computeTargetId:"<compute-target-id>"` on API/app logs and `@trace.computeTargetId:"<compute-target-id>"` on structured telemetry. `targetId` may still appear in relay protocol payloads, path params, and older log rows, but new logs should expose `computeTargetId` as the stable Datadog field.

### API-origin events (origin: `api`)

| Query | Category |
|---|---|
| `@category:"command.queued" @origin:"api"` | `TelemetryCategory.CommandQueued` — minted in the commands route |
| `@category:"command.dispatched" @origin:"api"` | `TelemetryCategory.CommandDispatched` — after relay HTTP call |
| `@category:"command.acknowledged" @origin:"api"` | `TelemetryCategory.CommandAcknowledged` — desktop ACK received |
| `@category:"command.completed" @origin:"api"` | `TelemetryCategory.CommandCompleted` |
| `@category:"command.failed" @origin:"api"` | `TelemetryCategory.CommandFailed` |
| `@category:"command.timed_out" @origin:"api"` | `TelemetryCategory.CommandTimedOut` |
| `@category:"command.replayed" @origin:"api"` | `TelemetryCategory.CommandReplayed` |
| `@category:"connection.registered" @origin:"api"` | `TelemetryCategory.ConnectionRegistered` — emitted from `apps/api/app/internal/relay/socket-event/service.ts` via `emitConnectionStateEvent()` on hello-ACK |
| `@category:"connection.resumed" @origin:"api"` | `TelemetryCategory.ConnectionResumed` — emitted from `apps/api/app/internal/relay/socket-event/service.ts` via `emitConnectionStateEvent()` on hello-ACK resume |
| `@category:"telemetry.validation_failed"` | `TelemetryCategory.TelemetryValidationFailed` — any origin |

### Desktop-origin events (origin: `desktop`)

These arrive via `handleTelemetryEvent()` which sets `origin = Origin.Desktop`. `category` and `origin` are emitted as top-level `DatadogLogEntry` attributes (via `log.info("msg", { meta })`), so the queries below resolve **without** the JSON pipeline rule:

| Query | Category |
|---|---|
| `@category:"job.started" @origin:"desktop"` | `TelemetryCategory.JobStarted` |
| `@category:"job.plan_source_resolved" @origin:"desktop" @trace.loopId:"<loop-id>"` | `TelemetryCategory.JobPlanSourceResolved` — EXECUTE plan staging source plus safe plan hashes/lengths in `diagnostics.planSource` |
| `@category:"job.decision_table_verification" @origin:"desktop" @trace.loopId:"<loop-id>"` | `TelemetryCategory.JobDecisionTableVerification` — EXECUTE decision-table verifier status plus safe counters in `diagnostics.decisionTableVerification`; Desktop event prose is exposed as `telemetryMessage` |
| `@category:"job.completed" @origin:"desktop"` | `TelemetryCategory.JobCompleted` |
| `@category:"job.failed" @origin:"desktop"` | `TelemetryCategory.JobFailed` |
| `@category:"command.timeout" @origin:"desktop"` | `TelemetryCategory.CommandTimeout` |
| `@category:"command.cancelled" @origin:"desktop"` | `TelemetryCategory.CommandCancelled` |
| `@category:"command.gateway_error" @origin:"desktop"` | `TelemetryCategory.CommandGatewayError` |
| `@category:"preflight.binary_not_found" @origin:"desktop"` | `TelemetryCategory.PreflightBinaryNotFound` |
| `@category:"preflight.script_not_found" @origin:"desktop"` | `TelemetryCategory.PreflightScriptNotFound` |
| `@category:"preflight.spawn_failed" @origin:"desktop"` | `TelemetryCategory.PreflightSpawnFailed` |
| `@category:"electron_update.initiated" @origin:"desktop"` | `TelemetryCategory.ElectronUpdateInitiated` |
| `@category:"electron_update.succeeded" @origin:"desktop"` | `TelemetryCategory.ElectronUpdateSucceeded` |
| `@category:"electron_update.failed" @origin:"desktop"` | `TelemetryCategory.ElectronUpdateFailed` |
| `@category:"desktop.shutdown_failed" @origin:"desktop"` | `TelemetryCategory.DesktopShutdownFailed` |

Desktop update and shutdown failure diagnostics are logged under `diagnostics.desktopUpdate` and `diagnostics.desktopShutdown` respectively. Accepted fields are bounded and intentionally operational:

| Diagnostic path | Values | Notes |
|---|---|---|
| `diagnostics.desktopUpdate.trigger` | `"updater-error"` \| `"check-for-updates"` \| `"manual-check"` \| `"apply-before-downloaded"` \| `"renderer-apply-update"` \| `"unknown"` | Why Desktop emitted the update telemetry; newer unrecognized trigger strings are normalized to `"unknown"` |
| `diagnostics.desktopUpdate.status` | string up to 64 chars | Current packaged updater status |
| `diagnostics.desktopUpdate.version` | string up to 64 chars | Downloaded or available version when known |
| `diagnostics.desktopUpdate.percent` | number `0..100` | Download progress when known |
| `diagnostics.desktopUpdate.downloaded` | boolean | Whether the package was downloaded before apply |
| `diagnostics.desktopUpdate.readyToInstall` | boolean | Whether the renderer should expose `Update & restart` |
| `diagnostics.desktopUpdate.error` | string up to 512 chars | Sanitized error summary only |
| `diagnostics.desktopShutdown.trigger` | `"before-quit"` \| `"shutdown-sequence"` \| `"shutdown-rejected"` \| `"outer-hard-exit"` \| `"unknown"` | Where shutdown failure was observed; newer unrecognized trigger strings are normalized to `"unknown"` |
| `diagnostics.desktopShutdown.result` | `"timed_out"` \| `"failed"` | Shutdown result classification |
| `diagnostics.desktopShutdown.phase` | string up to 128 chars | Failing shutdown phase |
| `diagnostics.desktopShutdown.duringUpdate` | boolean | Whether failure happened during update apply |
| `diagnostics.desktopShutdown.outerHardExit` | boolean | Whether the outer hard-exit timeout fired |
| `diagnostics.desktopShutdown.elapsedMs` | non-negative integer | Time from shutdown start to failure report |
| `diagnostics.desktopShutdown.error` | string up to 512 chars | Sanitized error summary only |

### Relay connection events (origin: `relay`)

The relay emits the connection lifecycle events below via `log.*(message, { category, ... })` **directly** — not through `emitter.ts`. The structured fields therefore travel as log METADATA, which `stampSeverity()` (`packages/observability/log.ts`) spreads at the top level of the entry, so `@category:` and friends are already Datadog attributes here and do NOT depend on the JSON-message pipeline rule. The hello-ACK categories (`connection.registered`, `connection.resumed`) are NOT emitted from the relay — they are emitted from `apps/api` when the API acknowledges a worker's hello, and are listed in the [API-origin events table](#api-origin-events-origin-api) above.

| Query | Fallback raw query | Category |
|---|---|---|
| `@category:"connection.socket_accepted" @origin:"relay"` | `@message:*connection.socket_accepted*` (readable-console drain only) | `TelemetryCategory.ConnectionSocketAccepted` |
| `@category:"connection.reconnecting" @origin:"relay"` | `@message:*connection.reconnecting*` (readable-console drain only) | `TelemetryCategory.ConnectionReconnecting` |
| `@category:"connection.degraded" @origin:"relay"` | `@message:*connection.degraded*` (readable-console drain only) | `TelemetryCategory.ConnectionDegraded` — emitted via `log.warn` (`level:"warn"`) |
| `@category:"connection.disconnected" @origin:"relay"` | `@message:*connection.disconnected*` (readable-console drain only) | `TelemetryCategory.ConnectionDisconnected` |
| `@category:"connection.stale_heartbeat" @origin:"relay"` | `@message:*connection.stale_heartbeat*` (readable-console drain only) | `TelemetryCategory.ConnectionStaleHeartbeat` — `log.warn` (`level:"warn"`) for stale/heal/rollback; `log.error` (`level:"error"`) when a registry reclaim failed against its store. Isolate that one with `@category:"connection.stale_heartbeat" @origin:"relay" @registryOperation:"reclaim" status:error` |

**Note:** All `emitter.ts`-path events call `log.*(JSON.stringify(payload))` through `logAtSeverity()`, which picks the level from the event's `severity` — the payload IS the message string, so the structured fields land in `message` as stringified JSON and faceted queries require the pipeline rule. The relay-origin connection events above do NOT follow that pattern: they pass their fields as log metadata, which `stampSeverity()` spreads at the top level of the entry.

**Which half of each row you need depends on the sink** ([table above](#which-sink-you-are-querying)):

- **Agentless intake** (`DD_API_KEY` set) — the Query column works as written, pipeline rule or not.
- **Structured console drain** (`DD_LOGS_JSON=1` / Vercel) — `@category:` works; drop `@origin:"relay"`, which is never stamped onto the console line.
- **Readable console drain** — the relay's own default in its Fargate container, which sets neither `DD_LOGS_JSON` nor `VERCEL` (`apps/relay/Dockerfile:135-142`). `writeConsole()` falls through to `consoleFn(message, ...args)`, so the drain receives `util.inspect` text and neither `@category:` nor `@origin:` resolves. The fallback column is the only route here.

One property of that fallback is worth knowing before you rely on it: `util.inspect` pretty-prints a multi-key meta object across **several lines**, so a drain without multi-line aggregation records one event as several logs. Verified by running the exact `apps/relay/src/index.ts:437` call shape through `console.info`:

```
Connection socket accepted {
  category: 'connection.socket_accepted',
  socketId: 'AbCdEf0123456789',
  organizationId: '0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f'
}
```

`@message:*connection.socket_accepted*` matches — but it matches the `category:` fragment line, which does not carry the human sentence; and a search for the sentence (`"Connection socket accepted"`) matches a different line, which does not carry the category. Neither text search returns a record holding the whole event. Use the fallback to confirm the event is arriving, then read the surrounding lines for its fields.

## Expected Field Values

These fields are set by `buildEntry()` in `log.ts` (line 166) and by the telemetry schemas.

### `DatadogLogEntry` top-level fields

| Field | Value | Source |
|---|---|---|
| `origin` | `"desktop"` \| `"api"` \| `"relay"` \| `"unknown"` | `Origin` const in `packages/observability/telemetry/origin.ts`; resolved from `DD_SERVICE` at module load; `handleTelemetryEvent()` overrides to `Origin.Desktop` for forwarded events |
| `ddsource` | `"nodejs"` | Hard-coded in `buildEntry()` |
| `service` | Value of `DD_SERVICE` env var | `buildEntry()` reads `DD.service` |
| `ddtags` | `env:{DD_ENV},version:{RELEASE_VERSION},git_sha:{VERCEL_GIT_COMMIT_SHA}` | `buildEntry()` line 166: `env:${DD.env},version:${DD.version},git_sha:${DD.gitSha}` |
| `level` | `"info"` \| `"warn"` \| `"error"` | Set by `logAtSeverity()` based on event severity |
| `status` | Same value as `level` | Datadog's reserved severity attribute (ISS-6341); stamped by `stampSeverity()` on both the intake payload and the structured console line. Query severity with `status:error`, not `@level:error` |
| `callerStatus` | Whatever the call site passed as `status` | Present only when a `log.*` call's meta carried its own `status` (usually an HTTP code); relocated so it cannot be read as the log's severity |
| `timestamp` | ISO 8601 UTC string | Set by `buildEntry()` at emit time |

### Telemetry payload fields (inside `message`)

These fields appear inside the stringified `message` value after the pipeline parses it:

| Field | Values | Notes |
|---|---|---|
| `category` | Any `TelemetryCategory` value | e.g. `"command.queued"`, `"job.started"` |
| `severity` | `"info"` \| `"warn"` \| `"error"` | From `TelemetrySeverity` |
| `schemaVersion` | `"1"` | Required field on all events |
| `trace.commandId` | UUID v7 | Minted by Prisma `@default(uuid(7))` |
| `trace.computeTargetId` | UUID | Identifies the compute node |
| `trace.gatewaySessionId` | UUID | Desktop gateway WebSocket session — never log or expose in client responses |
| `trace.operationId` | string | Relay operation identifier |
| `errorClass` | `"connection"` \| `"protocol"` \| `"approval"` \| `"sandbox"` \| `"execution"` \| `"deployment"` | From `ErrorClass` const in `schema.ts`; present on error events only |

### Origin resolution detail

`ORIGIN` is resolved once at module load in `origin.ts` by matching `DD_SERVICE` against `KNOWN_ORIGINS`. If `DD_SERVICE` is unset or does not match a known origin, `origin` falls back to `"unknown"` and a server-side warning is emitted. Set `DD_SERVICE=api` for the API app and `DD_SERVICE=relay` for the relay process.

## Dependencies and Scope

### Production relay verification

Full production-side relay verification (connection lifecycle events from deployed relay instances) is gated on **FEA-441**. Update this section when FEA-441 lands.

### Vercel serverless audit

`log.flush()` must be wrapped with `waitUntil()` in Vercel serverless routes. To audit for unguarded flush calls:

```sh
grep -r "log\.flush" apps/api/app --include="*.ts" | grep -v waitUntil
```

The correct import for serverless routes:

```ts
import { waitUntil } from "@vercel/functions";
```

Usage pattern:

```ts
waitUntil(log.flush());
```

A `.catch()` on a bare `log.flush()` promise without `waitUntil()` is a bug — the Vercel runtime may freeze the function before the flush completes.

## See also

- [packages/observability/README.md](../../../packages/observability/README.md) — naming conventions, `origin` semantics, ddtag contract, and cardinality rules
- [apps/api/docs/command-correlation.md](./command-correlation.md) — `commandId` minting, propagation, and correlation context contract
- [`/packages/observability/telemetry/telemetry-category.ts`](/packages/observability/telemetry/telemetry-category.ts) — canonical `TelemetryCategory` and `TelemetrySeverity` definitions
- [`/packages/observability/telemetry/schema.ts`](/packages/observability/telemetry/schema.ts) — canonical `TelemetryTraceContext` and the event envelope schemas
- [`/packages/observability/telemetry/emitter.ts`](/packages/observability/telemetry/emitter.ts) — `emitCommandLifecycleEvent()`, `emitConnectionStateEvent()`, and `logAtSeverity()`
- [`/packages/observability/log.ts`](/packages/observability/log.ts) — `buildEntry()`, `DatadogLogEntry`, flush behavior
- [`/packages/observability/telemetry/origin.ts`](/packages/observability/telemetry/origin.ts) — `Origin` const and `ORIGIN` module-load resolution
- [`/apps/api/lib/desktop-telemetry-handler.ts`](/apps/api/lib/desktop-telemetry-handler.ts) — `handleTelemetryEvent()` which sets `origin = Origin.Desktop`
- [`/apps/relay/src/index.ts`](/apps/relay/src/index.ts) — relay connection lifecycle event emission and `/dispatch` HTTP handler
