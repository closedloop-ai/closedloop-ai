# @repo/observability

Structured logger with optional agentless Datadog export, plus telemetry enrichment
utilities shared across `apps/api` and `apps/relay`.

## Contents

- [Structured logger (`log`)](#structured-logger-log)
- [ddtags env contract](#ddtags-env-contract)
- [Naming conventions](#naming-conventions)
- [Origin semantics](#origin-semantics)
- [Origin precedence in `buildEntry()`](#origin-precedence-in-buildentry)
- [Metric-tag allowlist](#metric-tag-allowlist)
- [Call-path invariant for desktop telemetry](#call-path-invariant-for-desktop-telemetry)
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
