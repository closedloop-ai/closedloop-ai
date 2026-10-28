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
- [db_pool_* connection-pool telemetry](#db_pool_-connection-pool-telemetry)
- [Call-path invariant for desktop telemetry](#call-path-invariant-for-desktop-telemetry)
- [insights.dashboard.* section latency](#insightsdashboard-section-latency)
- [`origin` vs `service` fields](#origin-vs-service-fields)
- [One-shot startup warnings](#one-shot-startup-warnings)
- [No kill switch for enrichment](#no-kill-switch-for-enrichment)
- [Test setup](#test-setup)
- [See also](#see-also)

---

## Structured logger (`log`)

`log` is a drop-in replacement for `console`. It always writes to stdout and,
when `DD_API_KEY` + `DD_SITE` are present, batches and ships entries to the
Datadog HTTP log intake (agentless — no Datadog agent required).

Set `DD_LOGS_DISABLED=1` to force the intake sink closed even when `DD_API_KEY`
is present, for a process that holds the key for something other than logs.
It was added because, until ISS-12354, CI set the key on every instrumented test
lane for dd-trace's agentless Test Optimization reporter (ISS-4399), and without
the flag that would also ship the code-under-test's log calls to Datadog as if
they were production. Console output is unaffected.

Set `DD_LOGS_FORWARDER_URL` to a loopback address (for example the realtime
task's collector sidecar, `http://localhost:6060`) to send the same batches to a
forwarder that adds the key itself, so the process holds no `DD_API_KEY`
(ISS-11827). It wins over a key in the environment. A value that is not a
loopback HTTP(S) URL without credentials closes the sink, and
`DD_LOGS_DISABLED` closes it too. `isLogExportOpen()` reports
whether either path is open, and `isLogExportDisabled()` whether the flag is
set, so the realtime boot check can tell logs switched off on purpose from a
sink closed by mistake (ISS-12799).

`DD_LOGS_MIN_LEVEL` (`debug`, `info`, `warn` or `error`) drops calls below that
level, and `DD_LOGS_SAMPLE_RATE` (0 to 1) keeps that fraction of the calls that
remain (ISS-12265). Each call is decided once, before it reaches either sink, so
the console line and the intake entry are kept or dropped together. Below 1,
each kept entry carries the rate as `logSampleRate` on both sinks. Unset, every
call is emitted. Both keys are in `keys.ts`, so an invalid value fails the env
validation of the apps that extend it; where `keys()` cannot run, an invalid
value is reported with `console.error` and treated as unset.

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

### Bounded buffering and the `telemetry.dropped` counter (ISS-7219)

The intake buffer has a hard ceiling — `MAX_BUFFER_ENTRIES` (10,000), overridable
per deploy with `DD_LOG_BUFFER_MAX_ENTRIES` (a whole positive integer up to
`MAX_CONFIGURABLE_BUFFER_ENTRIES` (100,000); anything else — `1oops`, `1.5`,
`0`, a negative, an over-cap value — falls back to the default rather than being
truncated into a ceiling nobody asked for). A stalled intake can no longer grow
it without bound, and a retryable failure (timeout, 429, 5xx, transport) no
longer drops the batch: it stays buffered across flush cycles, so capacity is
the only place entries are ever shed.

Storage is a **ring**, so the memory bound does not become a CPU bound: storing
an arriving entry costs the same whether the ceiling is 10 or 100,000, where
splicing the head of an array would have cost O(capacity) per arrival once the
buffer filled.

Everything shed is counted. Read it in-process with `log.droppedStats()`:

```ts
const { cumulativeDropped, byReason, bufferLength, cumulativeAbandonedCycles } =
  log.droppedStats();
```

### `cumulativeDropped` is not the whole loss picture

It counts entries that left the pipeline **definitively** — capacity shed, an
intake refusal replay cannot fix, metadata nothing could serialize.

It deliberately does **not** count entries still sitting in the buffer after a
drain cycle spent its retry budget, because in a long-running process the next
5s interval usually delivers them; counting them would overstate loss and break
the counter's conservation. The gap that leaves is real and worth knowing:

> In serverless, `waitUntil(log.flush())` resolves, Vercel freezes the function,
> and a buffered backlog evaporates from process memory — with `cumulativeDropped`
> reading `0` the whole way through.

`cumulativeAbandonedCycles` is the signal for that window, reported on the
`telemetry.undelivered` category:

| Field | Meaning |
|---|---|
| `@telemetryUndelivered.cumulativeAbandonedCycles` | Drain cycles that ended with entries still buffered. Counts **cycles, not entries** — the same backlog is abandoned again on every failing cycle, so summing its size would inflate the signal for entries that were never lost. Alert on its **rate**. |
| `@telemetryUndelivered.undeliveredEntries` | Entries buffered at that instant. A **gauge**, not a running total. |
| `@telemetryUndelivered.cause` | The flush failure behind the give-up. |

So: a non-zero `cumulativeDropped` means telemetry was definitely lost; a
climbing `cumulativeAbandonedCycles` means telemetry is at risk of being lost
silently, and on a freezing runtime probably was.

The same figures reach Datadog on the `telemetry.dropped` category, written as a
structured `console.error` line so it rides the **platform log drain**, not the
HTTP intake that is failing. Query
`service:cl-api env:prod @category:telemetry.dropped`.

**Pick the field that answers your question — they are not interchangeable:**

| Question | Field | Notes |
|---|---|---|
| How much have we lost overall? | `@telemetryDropped.cumulativeDropped` | A total across ALL reasons, present on every report. Read it **ungrouped** — grouping it by `reason` repeats the same global total inside each group, and summing the groups double-counts. |
| How much per reason? | `@telemetryDropped.cumulativeByReason.queue_full` / `.intake_rejected` / `.unserializable` | The per-reason split. |
| What happened in this window? | `@telemetryDropped.count` | Scoped to that row's own `reason` **and** `httpStatus`. |

**Every emitted value describes the group it is labelled with.** Drops are
coalesced per `(reason, httpStatus, cause)` and emitted as one row per group, so
a row's `reason`, `httpStatus`, `cause`, and `count` always belong together. A
single row summing across reasons and stamped with whichever one arrived last is
the defect this shape exists to prevent.

| Reason | Meaning |
|---|---|
| `queue_full` | Capacity shed. `@telemetryDropped.cause` names the flush failure that built the backlog (`timeout`, `server_error`, `client_error`, `transport_error`). Carries no HTTP status. |
| `intake_rejected` | Datadog refused the batch with a status replay cannot fix; `@telemetryDropped.httpStatus` carries it, and a window that saw several statuses produces one row per status rather than letting one stand in for the rest. |
| `unserializable` | The entry's metadata was circular (or otherwise `JSON.stringify`-hostile), so no intake body could be built from it. The console sink still carries it; replay cannot help. |

Reports are throttled to one per `DROP_REPORT_INTERVAL_MS` (5s) because a full
buffer sheds once per arriving entry. Coalescing loses no count — every report
carries the cumulative totals. **Only process shutdown bypasses the throttle**;
the automatic drain and `log.flush()` stay throttled, because a bypass there
would emit after every flush cycle and recreate the log storm the interval caps.

---

## ddtags env contract

Every Datadog log entry carries a `ddtags` string with exactly three tags:

| Tag | Source env var(s) | Fallback |
|---|---|---|
| `env` | `DD_ENV` → `NODE_ENV` | `"development"` |
| `version` | `RELEASE_VERSION` → `npm_package_version` → `VERCEL_GIT_COMMIT_SHA` (via `resolveServerVersion`) | `"unknown"` |
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
| `count:` | Additive (sum) | Counters — "this many things happened" | `dropped_expired_work_items`, `command_state_transition`, `connection_churn_rate` |
| `value:` | Gauge (last/avg) | Snapshots — "this is the current state" | `queued_command_count`, `in_flight_command_count`, `executor_saturation`, `ack_latency`, `heartbeat_freshness` |

The `count:` / `value:` distinction matters for Datadog
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
| `"mcp"` | `Origin.Mcp` |
| `"realtime"` | `Origin.Realtime` |
| `"doc-sync"` | `Origin.DocSync` |
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

## db_pool_* connection-pool telemetry

`emitDbPoolMetric()` (`telemetry/metrics.ts`) emits pg connection-pool health for
`service:cl-api` (FEA-3300). The samples originate in `@repo/database`'s
`pool-telemetry.ts` and reach this package through an **injected sink** that
`apps/api/instrumentation.ts` registers in `register()`.

**Why injected and not imported:** `@repo/database` must not depend on
`@repo/observability`. `apps/mcp` consumes `@repo/database` through a narrow
Docker context that copies an explicit list of workspace packages, so a static
import there would build green locally and fail at runtime inside the mcp image.
A consumer that registers no sink emits nothing and warns once
(`db_pool_telemetry.sink_missing`).

| `metric` | Field | Emitted when |
|---|---|---|
| `db_pool_acquire_wait` | `value` (ms) | an acquisition waited ≥10ms — **always** at ≥1s **and always when `saturated`**, otherwise throttled to 1/s |
| `db_pool_acquire_timeout` | `count: 1` | `timeout exceeded when trying to connect` — raised by pg for a queued caller, **or by the acquisition gate for a permit wait** |
| `db_pool_checkout_duration` | `value` (ms) | first terminal event (`release` **or** `remove`) for a client |
| `db_pool_wait_queue_depth` | `value` | sampled at `connect` entry, every 10s |
| `db_pool_in_use` / `db_pool_idle` / `db_pool_total` | `value` | sampled at `connect` entry, every 10s |

All use `value:` except `db_pool_acquire_timeout`, which is a true counter and
uses `count:` — see [Metric field semantics](#metric-field-semantics-count-vs-value).

`origin` is **required** on `DbPoolMetric` and is stamped by the sink adapter in
`apps/api/instrumentation.ts`, matching `QueueMetric`/`ProtocolMetric`. Do not
rely on `buildEntry()` for it: `buildEntry()` enriches only the agentless HTTP
intake payload, while `writeConsole()` emits `{...meta, message, level, status}` to
stdout — so on the Vercel Log Drain path `@origin` comes **solely from the
emitted payload**.

**Contention is measured, not sampled.** The failure mode these exist to catch is
triggered by simultaneity: one request fanning out N concurrent queries against a
pool of `max` starves every other caller. A periodic gauge can miss a
multi-second saturation entirely, so `db_pool_acquire_wait` times *every*
acquisition and emits only above a threshold — a warm-pool hit is sub-millisecond
and costs nothing.

**`poolMax`, `waitingCount`, `inUse`, `idle` and `total` ride on every sample as
log attributes — never as metric tags** (see the allowlist above). `poolMax` is
read from `pool.options.max` rather than assumed: the IAM branch sets 20 and the
DATABASE_URL branch inherits pg's default of 10, so utilization is
`in_use / poolMax`, never `in_use / 20`.

### `saturated` and `permitQueued` — what did this caller wait on? (ISS-10293)

`db_pool_acquire_wait` alone does not say WHICH kind of wait it measured, and
they have different fixes. Every acquire-wait sample carries two booleans, both
decided when the caller arrived, and they split it:

| Query | What the wait was | Where to look next |
|---|---|---|
| `@permitQueued:true` | The caller's own unit of work had already spent its acquisition budget (`DB_ACQUISITION_BUDGET_MAX`, enforced by `gateDbAcquisitions`), so it queued for a permit before it could reach the pool. | That unit of work's fan-out — include width, concurrent reads under one scope. Not the pool, and not the event loop. |
| `@permitQueued:false @saturated:true` | Pool contention — no idle connection and no headroom to open one, so the caller queued. | Fan-out width across requests, `poolMax`, a long-held checkout (`db_pool_checkout_duration`). |
| `@permitQueued:false @saturated:false @idle:>0` | A connection was free when the caller arrived. Either the handover was slow — an event loop too busy to deliver it — or a sibling that arrived in the same tick took it first (below). | In-process CPU on the request path, then the request's fan-out. |
| `@permitQueued:false @saturated:false @idle:0` | No connection free, but the pool was **below `poolMax`**, so pg opened one: connection establishment. | TCP/TLS/IAM handshake latency, DB-side connect cost. |

**`saturated:false` means the pool had something to give when the caller
arrived — not that the caller got it.** `idle` does not yet reflect siblings
that arrived in the same tick, which is how a Prisma read fans out. At the
ceiling (`@total` equal to `@poolMax`) a burst wider than `idle` queues anyway
and still reads `false`; below it, pg opens a connection instead. On a
`permitQueued` sample, `saturated` describes the pool the caller arrived at,
not the one it reached once the permit was granted, which is not observed.

Both are emitted rather than derived at query time. `saturated` is
`idle === 0 && total >= poolMax` — a comparison between two attributes, which a
Datadog log query cannot express — and no attribute carries the budget at all.
`@idle:0` is the proxy an operator reaches for and is **not** the same
predicate: a pool below its ceiling can open a new connection, so a wait there
is not pool queueing.

> ⚠️ **The arms are sampled differently, so neither counts nor percentiles
> compare across them.** A saturated wait ALWAYS emits. An unsaturated one —
> permit waits included — always emits at ≥1s, but below 1s only as the first
> in each 1s window per process copy (see the emission table above). That is
> not a uniform sample: the sub-1s bulk is undersampled and the ≥1s tail is
> kept whole.
>
> - **A count over a threshold of 1s or more is complete on every arm** and
>   compares across them: `count(@saturated:false @value:>3000)` is exact.
> - A total count is complete on the `@saturated:true` arm only, so a share
>   computed across arms understates the unsaturated side.
> - **A p95 over the `@saturated:false` arm overstates it**, because the
>   survivors over-represent its tail. It is not comparable to a p95 over the
>   `true` arm, nor to itself across a change in request rate.

Measured 2026-09-16, `service:cl-api env:prod`, 24h, before either label
existed: 18,925 of 21,061 **emitted** waits (89.9%) arrived to a free
connection and an empty queue (`@idle:>0 @waitingCount:0`). That is a share of
emitted samples, and it does not convert into a share of acquisitions: the
unsaturated arm as a whole is at least as large as emitted, since the saturated
arm is complete, but one throttle serves every unsaturated state and does not
record how it split them, so this subset may be over- or under-represented.
The count over 3s needs no such qualification: **all four waits arrived with
at most 12 of 20 connections open**, so none queued behind a full pool at
arrival. Whether they waited on their own unit of work's budget, a sibling's new
connection, or the event loop is what `permitQueued` and `@idle` now separate;
the samples that measured them could not.

### Querying these — the name you emit is not the name you query

Three renames sit between the emit site and a dashboard, and getting any of them
wrong returns `0`, which reads exactly like a healthy pool. This is what
ISS-10293 was filed for: three signals reported as "never reach Datadog's index"
were all arriving, and all three zeros were query defects.

1. **In LOGS, query the attribute, never free text.** `emitTelemetryMetric`
   ships the payload as `log.info(JSON.stringify(payload))`, so the keys become
   attributes only via the pipeline's JSON parser on `message` — see
   `telemetry/filter-tokens.ts`. Measured 2026-09-16 over 24h:
   `service:cl-api @metric:db_pool_acquire_wait` → **144,511**;
   `service:cl-api "db_pool_acquire_wait"` → **0**.
2. **In METRICS, the generated name is not the emitted one.** The
   `datadog_logs_metric` rules rename `db_pool_*` to `api.db.pool.*`. Querying
   `db_pool_acquire_wait` as a metric matches nothing, silently.
3. **In METRICS, the tag keys are renamed too.** A `group_by` maps the camelCase
   log attribute to a snake_case metric tag, so `@permitQueued` on the log is
   `permit_queued` on the metric (`@saturated` happens to be spelled the same).
   `{permitQueued:true}` on a metric matches nothing, silently — the same defect
   as 2, one level down. Only `db_pool_acquire_wait` has tags at all; see the
   callout below.

| Emitted `@metric` | Datadog metric (prod) | Datadog metric (stage) |
|---|---|---|
| `db_pool_acquire_wait` | `api.db.pool.acquire_wait` | `api.db.pool.stage.acquire_wait` |
| `db_pool_acquire_timeout` | `api.db.pool.acquire_timeout` | `api.db.pool.stage.acquire_timeout` |
| `db_pool_checkout_duration` | `api.db.pool.checkout_duration` | `api.db.pool.stage.checkout_duration` |
| `db_pool_wait_queue_depth` | `api.db.pool.wait_queue_depth` | `api.db.pool.stage.wait_queue_depth` |
| `db_pool_in_use` / `db_pool_idle` / `db_pool_total` | `api.db.pool.in_use` / `.idle` / `.total` | `api.db.pool.stage.*` |

**Before reporting a metric absent, run the same query shape against one known
to work** (`service:cl-api @_telemetryMetric:true` returned 1,003,457 over the
same 24h). A zero with no positive control beside it is not evidence of absence.

> ⚠️ **Emitting these does not create Datadog metrics.** Each one needs a
> `datadog_logs_metric` rule in `example-infrastructure/_modules/datadog/pipelines/`,
> filtered on the **attribute** (`@metric:db_pool_*`) and pinned to a single
> ingestion path (`source:nodejs`). `service:cl-api @origin:api` alone matches
> **both** the agentless and Vercel Log Drain copies and would double-count.
> `saturated` and `permitQueued` are `group_by`s on the two `acquire_wait`
> rules (`api.db.pool.tf` and its `.stage.tf` twin, ISS-10426), which is what
> makes them metric tags rather than log attributes only. They change spelling
> on the way: camelCase on the log (`@saturated:true`, `@permitQueued:true`),
> snake_case on the metric
> (`sum:api.db.pool.acquire_wait{saturated:true,permit_queued:false}`), per that
> repo's Tag Naming Convention. The log form works whether or not the rule has
> applied; the metric form needs the apply.
>
> **The metric reaches three of the four rows above, not four.** Row 1 is
> `{permit_queued:true}`; row 2 is `{saturated:true,permit_queued:false}` —
> **both halves, exactly as the row is written.** `{saturated:true}` alone is
> NOT row 2. `saturated` describes the pool the caller ARRIVED at, per the
> paragraph above, so a permit-queued caller that arrived at a full pool carries
> both tags and the looser predicate pulls row-1 budget waits into pool
> contention. Rows 3 and 4 both fall in the residual
> `{saturated:false,permit_queued:false}`, because what separates them is
> `@idle`, and `@idle` is a diagnosis attribute that is deliberately not a
> metric tag. So a slow handover and a cold connect share one series — and that
> series is most of the traffic (1,458 of 1,472 prod events measured 2026-09-17
> 00:00–04:30Z). Telling those two apart stays a log query.

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

## insights.dashboard.* section latency

`emitInsightsSectionLatency()`
(`apps/api/lib/observability/insights-metrics.ts`) emits
`insights.dashboard.section_latency` for **successful** `/insights/*` section
reads (ISS-7512). It is wired once, in the shared `createInsightsHandler`, so
every section route is covered by construction rather than by remembering to
instrument each one.

**It is a sample, not a census — read it with its rollup.** `/insights/*` has
no rate limiter in front of it (`withAnyAuth` authenticates but applies no
abuse control), so an authenticated caller could otherwise replay a section
route into an unbounded emit stream — the amplification vector
`apps/api/AGENTS.md` names under "Emission and Abuse Control". Emission is
therefore throttled at the choke point to **at most one sample per
`(org, section, period, scope)` per 60s window**
(`insights-section-latency-throttle.ts`), and every read that window suppressed
is counted into a paired `insights.dashboard.section_latency_suppressed`
rollup. The org is only ever a key in that process-local throttle; it never
reaches a payload.

Consequences worth stating before someone reads a panel wrong:

- `p95(section_latency)` describes the **sampled** reads. Against a large
  suppressed count it is a p95 over roughly one read per minute per tag tuple,
  not over production traffic.
- `sum(section_latency_suppressed)` next to the sample count is what says how
  much traffic the sample stands for. A window with **no** suppressed rollup
  was fully observed.
- The rollup is materialised by an event, never a clock — the next read on the
  same key, an LRU eviction, or the `drainExpired` the handler runs on every
  section read. It is an eventual **lower bound**, so alert on a floor being
  crossed, not on the number being exact.
- The throttle is process-local, so a fleet emits up to one sample per tag
  tuple per instance per window.

| Field | Kind | Values |
|---|---|---|
| `value` | gauge (ms) | the section read's wall time |
| `section` | tag | `delivery`, `utilization`, `agents`, plus the standalone session-analytics sections that share the handler |
| `period` | tag | `7`, `30`, `90`, `all` |
| `scope` | tag | `me`, `org`, `team` |
| `teamScoped` | tag | boolean — a team read is identified *as* a team read, never by team id |

`insights.dashboard.section_latency_suppressed` carries the same `section`,
`period` and `scope` tags and a `count` (occurrences — it *is* summed, unlike
the gauge). It has no `teamScoped`, because `scope` already determines it, and
it is emitted only when the count is positive.

**Do not read `agent_sessions.dashboard.query_latency` as covering this.** That
metric belongs to the Sessions usage-summary path
(`app/agent-sessions/service/usage-summary.ts`) and never runs for
`/insights/*`. Attributing dashboard slowness to it is the mistake ISS-7512
exists to remove.

**Why no org/user/team id.** These reads are driven by an authenticated caller,
so a tenant-scoped tag lets one org multiply the metric's cardinality. Every
field above is a closed union or a boolean. The tenant correlation lives on the
paired FAILURE log (`insights.<section>_failed`), which is where an operator
pivoting from a latency spike to a specific org already looks.

**Success-only, deliberately.** A failed section has no meaningful duration to
report — timing how long an error took to raise would drag the p50 of the
latency panel toward a number no reader ever waited for.

### Dashboard-latency triage queries

Which section is slow, and for whom:

```
@_telemetryMetric:true @metric:insights.dashboard.section_latency @origin:api
@_telemetryMetric:true @metric:insights.dashboard.section_latency @origin:api @section:(delivery OR utilization OR agents)
@_telemetryMetric:true @metric:insights.dashboard.section_latency @origin:api @period:all
@_telemetryMetric:true @metric:insights.dashboard.section_latency @origin:api @scope:org
```

How much traffic that sample stands for — always read alongside the panel
above, never on its own:

```
@_telemetryMetric:true @metric:insights.dashboard.section_latency_suppressed @origin:api
```

Then corroborate against the route and pool views, which answer different
questions — the route view includes time this metric excludes (auth, flag
resolution, serialization), and a `db_pool_*` spike says the section is waiting
on a connection rather than on its own SQL:

```
service:api @http.url_details.path:/insights/* @http.status_code:200
@_telemetryMetric:true @metric:db_pool_acquire_wait @origin:api
@_telemetryMetric:true @metric:db_pool_checkout_duration @origin:api
```

A section that is slow here but flat in `db_pool_acquire_wait` is slow in its
own SQL; profile it with the API lane in
[`docs/runbooks/performance-profiling.md`](../../docs/runbooks/performance-profiling.md).

> ⚠️ **Emitting these does not create a Datadog metric.** Each needs its own
> `datadog_logs_metric` rule in `example-infrastructure/_modules/datadog/pipelines/`
> — one filtered on `@metric:insights.dashboard.section_latency`, one on
> `@metric:insights.dashboard.section_latency_suppressed` — each pinned to a
> single ingestion path (`source:nodejs`), because `service:cl-api @origin:api`
> alone matches both the agentless and Vercel Log Drain copies and would
> double-count. Land them together: the latency panel without its suppressed
> rollup is a sample with no way to tell how much it stands for.

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
| `telemetry.version_fallback` | `version` resolved to `"unknown"` (only off Vercel now — Vercel surfaces resolve to `VERCEL_GIT_COMMIT_SHA`) |
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

## No kill switch for enrichment

Telemetry enrichment (`ddtags`, `origin`) is unconditional. There is no
`DD_DDTAGS_DEPLOY_CORRELATION_DISABLED` flag or similar gate. The only rollback
path is a `git revert` of the enablement commit. This is intentional — the
added complexity of a feature flag outweighs the benefit given that the logic is
stateless and low-risk.

This covers enrichment only. `DD_LOGS_DISABLED` gates whether the intake sink
opens at all, and `DD_LOGS_JSON` gates the console format; neither changes what
a shipped entry carries.

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
