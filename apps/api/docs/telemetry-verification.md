# Source of truth for TelemetryCategory values: packages/observability/telemetry/schema.ts — update this document when categories are added or removed.

This document is the authoritative verification guide for structured telemetry events in the ClosedLoop relay pipeline.

## Contents

- [Prerequisites — Datadog Pipeline](#prerequisites--datadog-pipeline)
- [Local Setup](#local-setup)
- [Trigger Scenarios](#trigger-scenarios)
- [Expected Datadog Queries](#expected-datadog-queries)
- [Expected Field Values](#expected-field-values)
- [Dependencies and Scope](#dependencies-and-scope)

## Prerequisites — Datadog Pipeline

`log.ts` batches `DatadogLogEntry[]` and flushes them to `https://http-intake.logs.{DD_SITE}/api/v2/logs`. For events emitted through `emitter.ts`, `logAtSeverity()` dispatches to `log.error`, `log.warn`, or `log.info` based on the event's `severity` — the resulting Datadog `level` attribute reflects that choice. In all three cases the event is emitted as a stringified JSON payload, so the telemetry fields (`category`, `severity`, `schemaVersion`, `trace`, etc.) land inside the `message` string rather than as top-level Datadog attributes. `origin` is the exception — it is always set as a top-level `DatadogLogEntry` attribute by `buildEntry()` in `log.ts`, so `@origin:` is facet-queryable without the pipeline rule regardless of emission path.

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
*telemetry.validation_failed*
```

Raw-text searches are slower and cannot filter by structured facets, but they confirm events are reaching Datadog before the pipeline is configured.

## Local Setup

Set the following variables in `apps/api/.env.local`:

| Variable | Description | Example |
|---|---|---|
| `DD_API_KEY` | Logs Write API key — Datadog Organization Settings → API Keys | `abc123...` |
| `DD_SITE` | Your Datadog intake site | `datadoghq.com` |
| `DD_ENV` | Environment label applied to `ddtags` | `local` |

`DD_SERVICE` must also be set to `api` so `origin` resolves correctly (see [Expected Field Values](#expected-field-values)). The relay service sets `DD_SERVICE=relay`.

## Trigger Scenarios

All four scenarios require `DD_API_KEY`, `DD_SITE`, and `DD_ENV` to be set. Scenario (a) additionally uses `$CLOSEDLOOP_API_KEY` — an org-issued API key. Scenarios (b), (c), and (d) use `$INTERNAL_API_SECRET` — the relay↔API shared secret from `apps/api/.env.local`. Replace each with the value from your local env.

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

Simulate a relay-forwarded `desktop.telemetry` event for `TelemetryCategory.JobStarted = "job.started"`. This hits `handleTelemetryEvent()` in `apps/api/lib/desktop-telemetry-handler.ts`, which sets `origin = Origin.Desktop`:

```sh
curl -X POST http://localhost:3002/internal/relay/socket-event \
  -H "Content-Type: application/json" \
  -H "x-internal-secret: $INTERNAL_API_SECRET" \
  -d '{
    "event": "desktop.telemetry",
    "targetId": "<your-compute-target-id>",
    "payload": {
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
    }
  }'
```

Expected: structured log entry in Datadog with `category: "job.started"` and `origin: "desktop"`.

### (c) Validation failure trigger

Same endpoint as (b), but with an intentionally invalid payload (missing required `schemaVersion` field). This triggers `telemetry.validation_failed`:

```sh
curl -X POST http://localhost:3002/internal/relay/socket-event \
  -H "Content-Type: application/json" \
  -H "x-internal-secret: $INTERNAL_API_SECRET" \
  -d '{
    "event": "desktop.telemetry",
    "targetId": "<your-compute-target-id>",
    "payload": {
      "category": "job.started",
      "severity": "info",
      "timestamp": "2024-01-01T00:00:00.000Z",
      "trace": {
        "commandId": "test-cmd-001",
        "operationId": "test-op-001",
        "computeTargetId": "<your-compute-target-id>"
      }
    }
  }'
```

Expected: log entry with `category: "telemetry.validation_failed"` and `issues` array describing the missing `schemaVersion`.

### (d) Connection lifecycle events

Connection lifecycle events require an actual Socket.IO connection from a desktop worker to the relay. They split by origin:

- **Relay-origin** (`connection.socket_accepted`, `connection.reconnecting`, `connection.degraded`, `connection.disconnected`, `connection.stale_heartbeat`) — emitted directly by `apps/relay/src/index.ts` via `log.*(JSON.stringify({ category: ... }))`, bypassing the structured `emitter.ts` pipeline. Origin resolves to `relay` via `DD_SERVICE`. Severity is mixed: `connection.socket_accepted`, `connection.reconnecting`, and `connection.disconnected` use `log.info` and land with `level:"info"`; `connection.stale_heartbeat` and `connection.degraded` use `log.warn` and land with `level:"warn"`. Scoping a Datadog query with `level:info` would silently drop the two degradation signals.
- **API-origin** (`connection.registered`, `connection.resumed`) — emitted from `apps/api/app/internal/relay/socket-event/service.ts` via `emitConnectionStateEvent()` through `emitter.ts`. Origin resolves to `api`.

To trigger them: start the relay (`pnpm turbo dev --filter=relay`) and connect a desktop worker. The relay emits its categories on socket accept, disconnect, heartbeat-stale detection, and reconnect; the API emits its categories when acknowledging the worker's hello.

## Expected Datadog Queries

The pipeline rule requirement varies by emission path:

- **API-origin and relay-origin events** — emitted via `emitter.ts` (`log.*(JSON.stringify(payload))`) or the relay's direct `log.*(JSON.stringify({ ... }))` calls. `category`, `severity`, `trace`, etc. live inside the stringified `message` field and require the pipeline rule to be facet-queryable. Without it, use the raw-text fallbacks from the Prerequisites section.
- **Desktop-origin events** — emitted via `handleTelemetryEvent()` using `log.info("message", { meta })`. `log.ts` spreads the meta object into top-level `DatadogLogEntry` attributes, so `@category:` and `@origin:` resolve without the pipeline rule.

`@origin:` is always top-level and queryable without the rule regardless of path (see [Prerequisites](#prerequisites--datadog-pipeline)).

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

### Relay connection events (origin: `relay`)

The relay emits the connection lifecycle events below via `log.info(JSON.stringify({ category: ... }))` **directly** — not through `emitter.ts`. This means they appear as raw stringified JSON in the `message` field and require the pipeline rule to be facet-queryable. The hello-ACK categories (`connection.registered`, `connection.resumed`) are NOT emitted from the relay — they are emitted from `apps/api` when the API acknowledges a worker's hello, and are listed in the [API-origin events table](#api-origin-events-origin-api) above.

| Query | Fallback raw query | Category |
|---|---|---|
| `@category:"connection.socket_accepted" @origin:"relay"` | `@message:*connection.socket_accepted*` | `TelemetryCategory.ConnectionSocketAccepted` |
| `@category:"connection.reconnecting" @origin:"relay"` | `@message:*connection.reconnecting*` | `TelemetryCategory.ConnectionReconnecting` |
| `@category:"connection.degraded" @origin:"relay"` | `@message:*connection.degraded*` | `TelemetryCategory.ConnectionDegraded` — emitted via `log.warn` (`level:"warn"`) |
| `@category:"connection.disconnected" @origin:"relay"` | `@message:*connection.disconnected*` | `TelemetryCategory.ConnectionDisconnected` |
| `@category:"connection.stale_heartbeat" @origin:"relay"` | `@message:*connection.stale_heartbeat*` | `TelemetryCategory.ConnectionStaleHeartbeat` — emitted via `log.warn` (`level:"warn"`) |

**Note:** All `emitter.ts`-path events call `log.info(JSON.stringify(payload))` through `logAtSeverity()`. The structured fields land in `message` as stringified JSON. Faceted queries require the pipeline. The relay-origin connection events above bypass the emitter entirely but follow the same stringified-JSON-in-`message` pattern.

**Deprecated category — do not query in production dashboards:**
`command.streaming_started` (`TelemetryCategory.CommandStreamingStarted`) has no active emission site. Removal tracked in FEA-535.

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
- [`/packages/observability/telemetry/schema.ts`](/packages/observability/telemetry/schema.ts) — canonical `TelemetryCategory` and `TelemetryTraceContext` definitions
- [`/packages/observability/telemetry/emitter.ts`](/packages/observability/telemetry/emitter.ts) — `emitCommandLifecycleEvent()`, `emitConnectionStateEvent()`, and `logAtSeverity()`
- [`/packages/observability/log.ts`](/packages/observability/log.ts) — `buildEntry()`, `DatadogLogEntry`, flush behavior
- [`/packages/observability/telemetry/origin.ts`](/packages/observability/telemetry/origin.ts) — `Origin` const and `ORIGIN` module-load resolution
- [`/apps/api/lib/desktop-telemetry-handler.ts`](/apps/api/lib/desktop-telemetry-handler.ts) — `handleTelemetryEvent()` which sets `origin = Origin.Desktop`
- [`/apps/relay/src/index.ts`](/apps/relay/src/index.ts) — relay connection lifecycle event emission and `/dispatch` HTTP handler
