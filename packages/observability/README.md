# @repo/observability

Structured logger with optional agentless Datadog export, plus telemetry enrichment
utilities shared across `apps/api` and `apps/relay`.

## Contents

- [Structured logger (`log`)](#structured-logger-log)
- [ddtags env contract](#ddtags-env-contract)
- [Naming conventions](#naming-conventions)
- [Metric field semantics (`count:` vs `value:`)](#metric-field-semantics-count-vs-value)
- [Origin semantics](#origin-semantics)
- [Origin precedence in `buildEntry()`](#origin-precedence-in-buildentry)
- [Metric-tag allowlist](#metric-tag-allowlist)
- [Call-path invariant for desktop telemetry](#call-path-invariant-for-desktop-telemetry)
- [loop.perf.* telemetry categories](#loopperf-telemetry-categories)
- [`origin` vs `service` fields](#origin-vs-service-fields)
- [One-shot startup warnings](#one-shot-startup-warnings)
- [No kill switch](#no-kill-switch)
- [Test setup](#test-setup)
- [See also](#see-also)

---

## Structured logger (`log`)

`log` is a drop-in replacement for `console`. It always writes to stdout and,
when `DD_API_KEY` + `DD_SITE` are present, batches and ships entries to the
Datadog HTTP log intake (agentless — no Datadog agent required).

```ts
import { log } from "@repo/observability/log";

log.info("command.completed", { commandId: "cmd_123" });
log.warn("telemetry.enrichment_failed", { errorClass: "TypeError" });
log.error("db.query_failed", { errorClass: "PrismaClientKnownRequestError" });
```

### Flush in Vercel serverless

The logger buffers entries and flushes on a timer. In serverless environments
the process may be frozen before the timer fires. Always wrap `log.flush()` with
`waitUntil()`:

```ts
import { waitUntil } from "@vercel/functions";
waitUntil(log.flush());
```

---

## ddtags env contract

Every Datadog log entry carries a `ddtags` string with exactly three tags:

| Tag | Source env var(s) | Fallback |
|---|---|---|
| `env` | `DD_ENV` → `NODE_ENV` | `"development"` |
| `version` | `RELEASE_VERSION` → `npm_package_version` (via `resolveServerVersion`) | `"unknown"` |
| `git_sha` | `VERCEL_GIT_COMMIT_SHA` → `GIT_SHA` | `"unknown"` |

These values are resolved **once at module load** and cached in the module-scope
`DD` object. Changing env vars at runtime has no effect — a fresh process is
required to pick up new values.

---

## Naming conventions

### Category (log message / event name)

`dot.snake_case` — two or more dot-separated segments where each segment is
`snake_case`.

```
telemetry.origin_fallback
command.completed
telemetry.enrichment_failed
```

### Metric name (inside `QueueMetric.metric` / `ProtocolMetric.metric`)

`snake_case` — no dots.

```
queued_command_count
ack_latency
origin_fallback
```

### Structured field (keys inside meta objects)

`camelCase`.

```ts
{ commandId, gatewaySessionId, errorClass, fromStatus, toStatus }
```

### Metric field semantics (`count:` vs `value:`)

`QueueMetric` and `ProtocolMetric` both expose optional `count` and `value`
fields. Use them consistently:

| Field | Aggregation intent | Use for | Examples |
|---|---|---|---|
| `count:` | Additive (sum) | Counters — "this many things happened" | `dropped_expired_work_items`, `replay_frequency`, `command_state_transition`, `connection_churn_rate` |
| `value:` | Gauge (last/avg) | Snapshots — "this is the current state" | `queued_command_count`, `in_flight_command_count`, `executor_saturation`, `ack_latency`, `heartbeat_freshness` |

`computeMetricSnapshot()` sums both fields today (it is a test-only utility,
not a production aggregator). The distinction matters for Datadog
log-to-metrics rules configured downstream: `count:` metrics should use
`sum` aggregation, `value:` metrics should use `last` or `avg`. Choosing the
wrong field causes overcounting on reconnect (a gauge emitted twice with the
same value looks like 2x under sum) or undercounting on rollup (a counter
averaged across windows loses total throughput).

---

## Origin semantics

`origin` labels every log emission with the service that originally produced the
event. It is resolved **once at module load** from `DD_SERVICE` in
`telemetry/origin.ts` and stored as the module-scope constant `ORIGIN`.

**No call site reads `DD_SERVICE` directly.**

The whitelist of valid origins is:

| `DD_SERVICE` value | `Origin` constant |
|---|---|
| `"desktop"` | `Origin.Desktop` |
| `"api"` | `Origin.Api` |
| `"relay"` | `Origin.Relay` |
| anything else / unset | `Origin.Unknown` + one-shot `console.warn` |

When `DD_SERVICE` does not match a known value, `resolveOrigin()` emits a
structured warning (see [One-shot startup warnings](#one-shot-startup-warnings))
and returns `Origin.Unknown`. This is forward-compatible with the OpenTelemetry
`service.name` semantic convention (PRD-158).

---

## Origin precedence in `buildEntry()`

`buildEntry()` (in `log.ts`) resolves the final `origin` for every structured
log entry using the following precedence:

1. **`meta.origin`** — if present and a valid whitelisted `Origin` value, it wins.
2. **Module-scope `ORIGIN`** — used as fallback when `meta.origin` is absent or
   invalid.

Only `apps/api/lib/desktop-telemetry-handler.ts` (`handleTelemetryEvent`) sets
`meta.origin` explicitly (to `Origin.Desktop`). All other call sites rely on the
module-scope `ORIGIN`.

---

## Metric-tag allowlist

To prevent cardinality explosion in Datadog, only the following fields may be
attached to metric emissions (via `emitQueueMetric` / `emitProtocolMetric`):

| Allowed tag | Type |
|---|---|
| `computeTargetId` | string |
| `gatewaySessionId` | string |
| `errorClass` | string |
| `fromStatus` | string |
| `toStatus` | string |
| `origin` | `Origin` |
| `state` | string |

Do **not** add high-cardinality values (user IDs, request IDs, free-form
strings) to metric emissions.

---

## Call-path invariant for desktop telemetry

Desktop-forwarded telemetry events **must** flow through Path A:

```
desktop plugin
  → WebSocket (direct-connect or relay)
    → apps/api/lib/desktop-telemetry-handler.ts  handleTelemetryEvent()  ← Path A
      → log.info(..., { origin: Origin.Desktop })
```

**Do not** call `emitDesktopTelemetryEvent()` (Path B) from `apps/api` or
`apps/relay`. That stringified emitter does not apply origin enrichment and
would leave `origin` set to the server's module-scope `ORIGIN` value (`"api"`
or `"relay"`), not `"desktop"`.

Path A is used by both:

- `apps/api/app/internal/relay/socket-event/route.ts` (relay-forwarded path)
- `apps/api/lib/desktop-gateway-socket-server.ts` (direct-connect path)

---

## loop.perf.* telemetry categories

The desktop emits `loop.perf.*` events as `perf.jsonl` records are appended
during a running Loop (near-real-time: p95 latency from `perf.jsonl` append to
Datadog visibility is under 5 seconds per PRD-254 FR-3a). This means dashboards
and alerts can reflect Loop activity while Loops are still in flight, including
long-running multi-hour Loops where batch arrival would have caused the entire
Loop duration of lag.

### Category names

| Category | Description |
|---|---|
| `loop.perf.run` | One record per Loop run — run ID, command, start time, repo, and branch. |
| `loop.perf.phase` | One record per phase transition — phase name, status, iteration, start SHA. |
| `loop.perf.iteration` | One record per iteration — duration, exit code, status. |
| `loop.perf.pipeline_step` | One record per pipeline step — step number (may be fractional, e.g. `8.5`), step name, duration, exit code, skipped flag. |
| `loop.perf.agent` | One record per agent invocation — agent ID, type, name, duration, token counts, model. |
| `loop.perf.tool` | One record per tool call — tool name, agent ID, duration. `endedAt`/`durationS`/`ok` may be `null` for orphaned-tool sentinel records reconciled at end-of-loop. |
| `loop.perf.skill` | One record per skill execution — skill name, tool name, agent ID, duration, ok flag. |
| `loop.perf.spawn` | One record per agent spawn — parent agent ID, parent session ID, planned subagent type, phase. |
| `loop.perf.parse_failure` | One record per JSONL parse failure in `perf.jsonl` — line number, raw bytes, and error message. Indicates a producer-version incompatibility. |

### ddtag contract — no new tags

`loop.perf.*` events do **NOT** add ddtags. The existing three-tag env contract
is preserved: every log entry carries exactly `env`, `version`, and `git_sha` —
sourced once at module load from env vars and applied uniformly to all events
regardless of category. No `command`, `phase`, `agent_id`, or other loop-perf
fields are promoted to ddtags.

High-cardinality fields (`run_id`, `agent_id`, `tool_name`, `skill_name`, token
counts, durations) live in the structured payload as standard log fields. This
means zero Datadog tag cardinality impact from rolling out `loop.perf.*` events.

### Querying with `@field:value` syntax

Datadog log queries support the same filter and pivot semantics on structured
payload fields via `@field:value` syntax as on ddtags. Structured fields in
`loop.perf.*` events are nested under `diagnostics.loopPerf.*` in the log
payload.

**Worked examples:**

Find all agent events for Phase 3 of EXECUTE Loops:

```
service:api @category:loop.perf.agent @diagnostics.loopPerf.phase:"Phase 3" @diagnostics.loopPerf.command:EXECUTE
```

Find all tool calls for a specific run:

```
service:api @category:loop.perf.tool @diagnostics.loopPerf.runId:019e0817-5638-7068-9900-01940cff49ac
```

Find orphaned tool sentinels (null endedAt):

```
service:api @category:loop.perf.tool -@diagnostics.loopPerf.endedAt:*
```

Find all events for a single Loop run across all categories:

```
service:api @category:loop.perf.* @diagnostics.loopPerf.runId:<run-id>
```

### Recommended Datadog facets

Declare these structured fields as Datadog facets in the Datadog UI to enable
click-to-filter UX. This is a one-time UI configuration, not a code change.

| Field path | Description | Cardinality |
|---|---|---|
| `@diagnostics.loopPerf.command` | Loop command (PLAN, EXECUTE, DECOMPOSE, …) | ~10 unique values |
| `@diagnostics.loopPerf.event` | Event type (run, phase, iteration, …) | 9 unique values |
| `@diagnostics.loopPerf.phase` | Phase name (Phase 0.9 through Phase 7) | ~12 unique values |
| `@diagnostics.loopPerf.runId` | Loop run identifier | High (one per run) |
| `@diagnostics.loopPerf.agentId` | Agent identifier | High |
| `@diagnostics.loopPerf.toolName` | Tool name | Low–medium |
| `@diagnostics.loopPerf.skillName` | Skill name | Low–medium |
| `@diagnostics.loopPerf.model` | Model identifier used by an agent | Low |

### Producer-compatibility notes

1. **Optional fields are absent, not null.** When a structured field is absent in
   a `loop.perf.*` event, it is omitted from the payload entirely — it is NOT
   sent as `null`. The one exception is `loop.perf.tool`'s `endedAt`, `durationS`,
   and `ok` fields, which may be explicitly `null` as an in-flight sentinel for
   orphaned tool records reconciled at end-of-loop.

2. **`pipeline_step.step` is fractional.** The `step` field is a `number`, not an
   integer. The producer emits `8.5` for the synthetic `write_merged_patterns`
   step — Datadog facet declarations for this field should use `Measure` (float),
   not `Facet` (string).

3. **Unknown `loopPerf.event` variants are forwarded with a drift warning.**
   The relay's `loopPerf` schema is intentionally permissive (passthrough on
   unknown `event` values) per PRD-254 §FR-6 producer-additivity. When the
   desktop emits an event variant outside the known set (e.g. legacy
   `post_loop_review` / `post_loop_fix` from a skewed desktop build, or any
   future variant added before the relay catches up), the payload is
   forwarded to Datadog as-is and a `loop.perf.unknown_event_variant`
   warning is emitted carrying the unknown variant name plus the
   `commandId` / `gatewaySessionId` for correlation. Catch desktop-version
   skew with:

   ```
   service:api @category:loop.perf.unknown_event_variant
   ```

---

## `origin` vs `service` fields

Both `origin` and `service` are present in every Datadog log entry:

| Field | Source | Changes for desktop events? |
|---|---|---|
| `service` | `DD_SERVICE` env var (via `loadConfig()`) | No — always reflects the forwarding app (`"api"`) |
| `origin` | `ORIGIN` constant or explicit `meta.origin` | Yes — overwritten to `"desktop"` by `handleTelemetryEvent` |

For native `api` and `relay` emissions both fields are equal. For
desktop-enriched events they intentionally diverge: `service` stays as `"api"`
(the forwarding app), while `origin` is `"desktop"` (the true source). Do not
remove either field.

---

## One-shot startup warnings

Three diagnostic warnings are emitted **exactly once per process lifetime**
during module load. Cold-started Vercel lambdas and relay restarts will re-emit
them — this is expected and intentional (startup diagnostics, not per-event
noise).

| Warning message | Condition |
|---|---|
| `telemetry.dd_service_fallback` | `DD_SERVICE` is unset or empty string; co-fires with `telemetry.origin_fallback` since both trigger when `DD_SERVICE` is absent |
| `telemetry.origin_fallback` | `DD_SERVICE` is unset or not a known origin |
| `telemetry.version_fallback` | `version` resolved to `"unknown"` |
| `telemetry.git_sha_fallback` | `git_sha` resolved to `"unknown"` |

### Cold-start delivery caveat

Startup warnings always hit **stdout / the container console** synchronously.
The Datadog HTTP-intake copy (via `log.warn` → batch buffer → `flushToDatadog`)
is **best-effort** at module load: in Vercel serverless cold starts there is
no request context when the module evaluates, so the warnings cannot be
wrapped in `waitUntil(log.flush())`. If the instance handles a short-lived
request and is frozen before the 5s flush timer fires, the intake copy is
silently dropped.

This is not a reliability gap in practice: the **Vercel Log Drain** to
Datadog already forwards stdout and platform-level logs from every Vercel
app in this repo, so startup warnings reach Datadog via the drain even when
the intake copy is dropped. Relay has the same coverage via Fargate
container-stdout routing.

In practice these warnings only fire when `DD_SERVICE`, `RELEASE_VERSION`, or
`VERCEL_GIT_COMMIT_SHA` is misconfigured, so a correctly configured
production deploy does not exercise this path.

---

## No kill switch

Telemetry enrichment (`ddtags`, `origin`) is unconditional. There is no
`DD_DDTAGS_DEPLOY_CORRELATION_DISABLED` flag or similar gate. The only rollback
path is a `git revert` of the enablement commit. This is intentional — the
added complexity of a feature flag outweighs the benefit given that the logic is
stateless and low-risk.

---

## Test setup

`DD_SERVICE` **must** be set before any test file imports `@repo/observability`.
The package's `vitest.setup.ts` sets `process.env.DD_SERVICE = "api"` as the
safe default for all tests in this package.

Tests in other packages (e.g., `apps/api`) that need a different origin must:

1. Call `vi.resetModules()` to clear the module registry.
2. Call `vi.stubEnv("DD_SERVICE", "relay")` (or the desired value).
3. Re-import `@repo/observability/log` (or the relevant subpath) dynamically.

If you import `@repo/observability` at the top of a test file, the module-scope
`ORIGIN` is already frozen by the time your test body runs and `vi.stubEnv`
alone will not change it.

---

## See also

- [commandId Correlation Contract](../../apps/api/docs/command-correlation.md) — authoritative reference for `commandId` minting, propagation, and cardinality discipline across the relay pipeline.
