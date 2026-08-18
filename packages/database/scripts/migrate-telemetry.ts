/**
 * Build-time migrate-deploy telemetry (ISS-4392, PLN-1523).
 *
 * Makes the P1002 migrate-lock storm queryable: one structured event per
 * schema-migrate carrying start/duration (⇒ concurrency), the serialize-gate
 * outcome, retry attempts, reset kind, and the P1002/ok outcome. Downstream, the
 * count of overlapping `[started_at, started_at+duration_ms]` windows (grouped by
 * `pghost_hash`) is concurrent-migrate volume (Axis A); `migrate_ms`/`reset_kind`
 * is per-migrate hold cost (Axis B). See FEA-4291 / FEA-3738 for what those axes
 * decide.
 *
 * ## Self-contained by design (no `@repo/observability`)
 * `packages/database` is consumed by `apps/mcp` through a narrow Docker context;
 * a `@repo/observability` import here would type-check and build green locally,
 * then fail at runtime inside the mcp image — the same rule `pool-telemetry.ts`
 * and `AGENTS.md` state. So this reimplements the minimal agentless-intake path
 * from `@repo/observability`'s `log.ts` rather than importing it, and reads DD_*
 * straight from `process.env`.
 *
 * The one `@repo/*` import is the Datadog site allowlist (ISS-5417). That is a
 * different case, and deliberately not covered by the rule above: `@repo/api` is
 * a DECLARED dependency of `@repo/database` (11 sibling modules under
 * `scripts/` already import `@repo/api/src/types/*`), so pnpm links it inside
 * the mcp image exactly as it does locally, and the module itself is a
 * zero-dependency constants leaf. What must not be imported here is
 * `@repo/observability`, which is not a dependency of this package at all.
 *
 * ## Why a standalone emitter and not the pool-telemetry sink
 * The migrate step runs as a build-time `tsx scripts/migrate.ts` process
 * (`prebuild`), NOT the Next.js server — so `apps/api`'s `register()` hook (which
 * calls `setPoolTelemetrySink`) never runs here. There is no injected sink to
 * reuse; this module owns its own dual sink.
 *
 * ## Dual sink (mirrors log.ts), gated + bounded
 *  1. Structured stdout, one JSON line per event — ALWAYS when running under
 *     Vercel (`env.VERCEL` set), picked up by the Vercel→Datadog log drain and
 *     greppable in the build log regardless. Zero deps, cannot fail the build.
 *  2. Agentless HTTPS POST to the Datadog logs intake — ONLY when `DD_API_KEY`
 *     is present. Events are buffered and sent as ONE batched body on
 *     `flushMigrateTelemetry()` (the preview-migrator walk migrates N schemas per
 *     process; per-event POST would be N × timeout). Bounded by `AbortSignal`
 *     AND a total flush deadline; NO retries on the deploy critical path.
 *
 * ## Never breaks or hangs the migrate
 * Every sink is wrapped in try/catch (warn once), and the flush is deadline-
 * bounded, so telemetry can neither throw into nor stall the migrate/deploy.
 *
 * ## No secret in the payload
 * Events are built from `PG*`/`VERCEL_*` env + the schema name only — NEVER from
 * the IAM-signed `databaseUrl` (which carries the token/password). `pghost_hash`
 * is a truncated SHA-256 of `PGHOST`, so the host is grouped without being
 * disclosed.
 *
 * No I/O or env reads at module load. Sibling-lib pattern, see `migrate-retry.ts`
 * / `pool-telemetry.ts`.
 */

import { createHash } from "node:crypto";
import {
  DEFAULT_DD_SITE,
  isAllowedDatadogSite,
} from "@repo/api/src/types/datadog-sites";

// --- contract enums -------------------------------------------------------

/** Terminal outcome of a schema-migrate run. */
export const MigrateOutcome = {
  Ok: "ok",
  /** Timed out acquiring Prisma's advisory lock 72707369 — the storm signature. */
  P1002: "p1002",
  OtherError: "other_error",
} as const;
export type MigrateOutcome =
  (typeof MigrateOutcome)[keyof typeof MigrateOutcome];

/** Result of the FEA-3065 serialization gate for this run. */
export const MigrateGateOutcome = {
  Acquired: "acquired",
  /** Gate acquire failed → ran unguarded (the fail-open trap that lets P1002 through). */
  FailOpen: "fail_open",
  /** Gate acquire failed under `onContended: "skip"` → the walk skipped the schema. */
  FailClosed: "fail_closed",
} as const;
export type MigrateGateOutcome =
  (typeof MigrateGateOutcome)[keyof typeof MigrateGateOutcome];

/** Whether a P3005/P3009/P3018 recovery forced a full-history replay, and which. */
export const MigrateResetKind = {
  None: "none",
  P3005: "p3005",
  P3009: "p3009",
  P3018: "p3018",
} as const;
export type MigrateResetKind =
  (typeof MigrateResetKind)[keyof typeof MigrateResetKind];

// --- event shape ----------------------------------------------------------

/** One emitted `migrate_deploy` event. All fields are non-sensitive. */
export type MigrateDeployEvent = {
  event: "migrate_deploy";
  /**
   * Stable per-run id (`deployment_id:schema:started_at`). The SAME event reaches
   * Datadog by TWO ingestion paths — the Vercel log drain (stdout) and the direct
   * agentless POST — so a raw row count double-counts when both are live. Downstream
   * metrics must `count_distinct(migrate_run_id)` (mirrors the pool-telemetry
   * one-source contract). Both copies carry the same id, so the two rows collapse.
   */
  migrate_run_id: string;
  /** ISO-8601 start of the run — with `duration_ms` reconstructs concurrency windows. */
  started_at: string;
  duration_ms: number;
  schema: string | null;
  is_preview: boolean;
  pgdatabase: string | null;
  /** Truncated SHA-256 of PGHOST — DB identity without disclosing the host. */
  pghost_hash: string | null;
  /** `production` is BOTH stage and prod on Vercel; `pghost_hash` is the real discriminator. */
  vercel_env: string | null;
  git_ref: string | null;
  commit_sha: string | null;
  deployment_id: string | null;
  at_head_skip: boolean;
  gate_outcome: MigrateGateOutcome | null;
  gate_wait_ms: number | null;
  /**
   * ISO start of the ACTUAL `prisma migrate deploy` interval (null when it never
   * ran — at-head skip). Axis-A concurrency must be derived from
   * `[migrate_started_at, migrate_started_at + migrate_ms]`, NOT the whole-run
   * `started_at`/`duration_ms`: those bracket the pre-lock wait + post-migrate
   * clone too, so gate-serialized runs (only one migrating at a time) would show
   * false overlap. Whole-run duration is kept for total deploy-time analysis.
   */
  migrate_started_at: string | null;
  migrate_ms: number | null;
  reset_kind: MigrateResetKind;
  outcome: MigrateOutcome;
  attempts: number | null;
  /**
   * ISS-4601: how many INVALID indexes the post-deploy sweep found on this
   * schema — the alertable scalar (`@invalid_index_count:>0`). `null` means the
   * sweep could not run, which is UNKNOWN, not clean; a monitor must not read a
   * missing value as zero.
   */
  invalid_index_count: number | null;
  /** The invalid index names, so the alert itself says which ones. `null` = unswept. */
  invalid_indexes: string[] | null;
};

/** The non-sensitive environment fields an event is built from. */
export type MigrateTelemetryEnv = {
  pgdatabase: string | null;
  pghost_hash: string | null;
  vercel_env: string | null;
  git_ref: string | null;
  commit_sha: string | null;
  deployment_id: string | null;
};

const PGHOST_HASH_LENGTH = 12;

/**
 * Truncated SHA-256 of the host — a stable fingerprint for GROUPING deploys by
 * database instance, NOT anonymization (unsalted → dictionaryable for a known
 * host). The internal RDS host is not secret; this only keeps it out of the
 * payload while still letting us group stage vs prod.
 */
function hashHost(host: string): string {
  return createHash("sha256")
    .update(host)
    .digest("hex")
    .slice(0, PGHOST_HASH_LENGTH);
}

/**
 * Extract the non-sensitive telemetry env from a process-env-like object.
 * NEVER reads `DATABASE_URL` or any credential — only PGHOST (hashed), PGDATABASE
 * and the Vercel build vars.
 */
export function readMigrateTelemetryEnv(
  env: NodeJS.ProcessEnv
): MigrateTelemetryEnv {
  const host = env.PGHOST;
  return {
    pgdatabase: env.PGDATABASE ?? null,
    pghost_hash: host ? hashHost(host) : null,
    vercel_env: env.VERCEL_ENV ?? null,
    git_ref: env.VERCEL_GIT_COMMIT_REF ?? null,
    commit_sha: env.VERCEL_GIT_COMMIT_SHA ?? null,
    deployment_id: env.VERCEL_DEPLOYMENT_ID ?? env.VERCEL_URL ?? null,
  };
}

/** Inputs to the pure event builder. */
export type BuildMigrateEventInput = {
  env: MigrateTelemetryEnv;
  schema: string | null;
  isPreview: boolean;
  startedAt: string;
  durationMs: number;
  atHeadSkip: boolean;
  gateOutcome: MigrateGateOutcome | null;
  gateWaitMs: number | null;
  migrateStartedAt: string | null;
  migrateMs: number | null;
  resetKind: MigrateResetKind;
  outcome: MigrateOutcome;
  attempts: number | null;
  /** ISS-4601: `null` when the sweep did not run (unknown), never a fabricated 0. */
  invalidIndexes: string[] | null;
};

/**
 * Stable per-run id: one migrate of a given schema, in a given deploy, starts
 * once — so `deployment_id:schema:started_at` is unique per run and identical
 * across the stdout + POST copies, enabling downstream dedup.
 */
function makeMigrateRunId(input: BuildMigrateEventInput): string {
  return `${input.env.deployment_id ?? "unknown"}:${input.schema ?? "public"}:${input.startedAt}`;
}

/** Pure — assembles a `MigrateDeployEvent`. No I/O, no env reads. */
export function buildMigrateEvent(
  input: BuildMigrateEventInput
): MigrateDeployEvent {
  return {
    event: "migrate_deploy",
    migrate_run_id: makeMigrateRunId(input),
    started_at: input.startedAt,
    duration_ms: input.durationMs,
    schema: input.schema,
    is_preview: input.isPreview,
    pgdatabase: input.env.pgdatabase,
    pghost_hash: input.env.pghost_hash,
    vercel_env: input.env.vercel_env,
    git_ref: input.env.git_ref,
    commit_sha: input.env.commit_sha,
    deployment_id: input.env.deployment_id,
    at_head_skip: input.atHeadSkip,
    gate_outcome: input.gateOutcome,
    gate_wait_ms: input.gateWaitMs,
    migrate_started_at: input.migrateStartedAt,
    migrate_ms: input.migrateMs,
    reset_kind: input.resetKind,
    outcome: input.outcome,
    attempts: input.attempts,
    invalid_index_count: input.invalidIndexes?.length ?? null,
    invalid_indexes: input.invalidIndexes,
  };
}

// --- sinks ----------------------------------------------------------------

const DD_LOG_INTAKE_TIMEOUT_MS = 3000;
const DD_SOURCE = "migrate";
const DEFAULT_DD_SERVICE = "api";

type WarnKey = "sink_failed" | "flush_failed";
const warned: Record<WarnKey, boolean> = {
  sink_failed: false,
  flush_failed: false,
};

function warnOnce(key: WarnKey, message: string): void {
  if (warned[key]) {
    return;
  }
  warned[key] = true;
  console.warn(
    JSON.stringify({
      level: "warn",
      event: `migrate_telemetry.${key}`,
      message,
    })
  );
}

/** In-process buffer of events awaiting the batched flush. Append-only per event. */
const buffer: MigrateDeployEvent[] = [];

/**
 * The one call shape this module uses (URL + a fully-formed init). Narrower than
 * `typeof fetch` so an injected test mock's `mock.calls` are strongly typed; the
 * real global `fetch` is assignable to it.
 */
export type MigrateFetch = (
  url: string,
  init: RequestInit
) => Promise<Response>;

/** The subset of `process.stdout` the flush drains; injected so tests avoid real stdout. */
export type MigrateStdout = {
  writableLength: number;
  write: (chunk: string, callback: () => void) => void;
};

/** Injectable collaborators for the sinks (defaults bind real impls; tests override). */
export type MigrateTelemetrySinkDeps = {
  env?: NodeJS.ProcessEnv;
  logImpl?: (line: string) => void;
  fetchImpl?: MigrateFetch;
  /** Schedules the total-flush deadline; injected so tests need no real timers. */
  scheduleDeadline?: (ms: number, onFire: () => void) => void;
  /** stdout to drain before a forced exit; defaults to `process.stdout`. */
  stdoutImpl?: MigrateStdout;
};

/**
 * Record one event: write the stdout line immediately (Vercel builds only) and
 * buffer it for the batched flush. Never throws.
 */
export function recordMigrateEvent(
  event: MigrateDeployEvent,
  deps: MigrateTelemetrySinkDeps = {}
): void {
  const env = deps.env ?? process.env;
  // Only emit inside a Vercel build — the storm is a Vercel-deploy phenomenon,
  // and this keeps local `pnpm migrate` and unit tests silent (mirrors log.ts's
  // STRUCTURED_CONSOLE gate on `env.VERCEL`).
  if (!env.VERCEL) {
    return;
  }
  try {
    buffer.push(event);
    const log = deps.logImpl ?? console.log;
    log(
      JSON.stringify({
        level: "info",
        ddsource: DD_SOURCE,
        service: env.DD_SERVICE ?? DEFAULT_DD_SERVICE,
        message: "migrate_deploy",
        ...event,
      })
    );
  } catch {
    warnOnce(
      "sink_failed",
      "migrate telemetry: stdout sink threw; event dropped."
    );
  }
}

function toIntakeEntry(
  event: MigrateDeployEvent,
  service: string
): Record<string, unknown> {
  return {
    ddsource: DD_SOURCE,
    service,
    message: "migrate_deploy",
    ...event,
  };
}

/**
 * Flush telemetry before the caller may `process.exit()`:
 *  1. When `DD_API_KEY` is present, POST the buffered events to the Datadog logs
 *     intake as ONE batched request (bounded by `AbortSignal` AND a total
 *     deadline; NO retries). A rejection or non-2xx warns once so a dead direct
 *     sink is visible (it is NOT silently treated as success).
 *  2. ALWAYS drain stdout — the structured lines already written by
 *     `recordMigrateEvent` reach Datadog via the Vercel log drain, and a forced
 *     `process.exit()` can truncate the last line on Vercel's async stdout pipe.
 * Clears the buffer regardless. Never throws.
 */
export async function flushMigrateTelemetry(
  deps: MigrateTelemetrySinkDeps = {}
): Promise<void> {
  const env = deps.env ?? process.env;
  const events = buffer.splice(0, buffer.length);
  try {
    // ONE deadline bounds the POST AND the stdout drain together (not 3s each),
    // and swallows any failure — including a synchronous drain throw — so
    // telemetry can never reject into or over-hold the caller's `main()`.
    await raceDeadline(flushWork(events, env, deps), deps);
  } catch {
    warnOnce(
      "flush_failed",
      "migrate telemetry: flush failed; events dropped."
    );
  }
}

/**
 * POST the batch (when keyed) and drain stdout CONCURRENTLY so neither blocks the
 * other, bounded by the caller's single deadline. The stdout copy is the primary
 * (drain-backed) path; the POST is secondary and best-effort.
 */
function flushWork(
  events: MigrateDeployEvent[],
  env: NodeJS.ProcessEnv,
  deps: MigrateTelemetrySinkDeps
): Promise<void> {
  const work: Promise<void>[] = [drainStdout(deps)];
  const apiKey = env.DD_API_KEY;
  if (apiKey && events.length > 0) {
    work.push(postEvents(events, apiKey, env, deps));
  }
  return Promise.all(work).then(() => undefined);
}

/** POST the batch to the Datadog intake, warning once on a dead sink. */
function postEvents(
  events: MigrateDeployEvent[],
  apiKey: string,
  env: NodeJS.ProcessEnv,
  deps: MigrateTelemetrySinkDeps
): Promise<void> {
  const site = env.DD_SITE || DEFAULT_DD_SITE;
  if (!isAllowedDatadogSite(site)) {
    // Never attach DD-API-KEY to an unrecognized authority (SSRF / key egress).
    warnOnce(
      "flush_failed",
      `migrate telemetry: DD_SITE "${site}" is not an allowed Datadog site; skipping POST.`
    );
    return Promise.resolve();
  }
  const service = env.DD_SERVICE ?? DEFAULT_DD_SERVICE;
  const fetchImpl = deps.fetchImpl ?? fetch;
  return fetchImpl(`https://http-intake.logs.${site}/api/v2/logs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "DD-API-KEY": apiKey,
    },
    body: JSON.stringify(events.map((e) => toIntakeEntry(e, service))),
    signal: AbortSignal.timeout(DD_LOG_INTAKE_TIMEOUT_MS),
    // Do NOT follow redirects: Undici keeps DD-API-KEY on a cross-origin redirect
    // and a 307/308 replays the body, which would leak the key past the allowlist.
    redirect: "error",
  }).then(
    (response) => {
      // A non-2xx means the sink is (mis)configured and events are being dropped
      // upstream — surface it once rather than reporting silent success.
      if (!response.ok) {
        warnOnce(
          "flush_failed",
          `migrate telemetry: intake returned ${response.status}.`
        );
      }
    },
    () => {
      // NEVER interpolate the raw error: Undici's "invalid header value" error can
      // echo the DD-API-KEY value, which would then land in Vercel build logs.
      warnOnce(
        "flush_failed",
        "migrate telemetry: intake POST failed (transport error)."
      );
    }
  );
}

/**
 * Flush any buffered `process.stdout` before a forced exit. Writing an empty
 * chunk with a callback resolves once the prior buffered data has been handed to
 * the OS, so the last structured line is not truncated. Never rejects (the caller
 * bounds it with the shared deadline); a no-op when nothing is buffered.
 */
function drainStdout(deps: MigrateTelemetrySinkDeps): Promise<void> {
  const out = deps.stdoutImpl ?? process.stdout;
  if (!out.writableLength) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    try {
      out.write("", () => resolve());
    } catch {
      // Telemetry must never throw into the caller — give up the drain quietly.
      resolve();
    }
  });
}

/**
 * Resolve when `work` settles OR the deadline fires, whichever first — so a
 * `fetchImpl` that never settles cannot hang the process. The deadline timer is
 * injectable so tests are deterministic without real time.
 */
function raceDeadline(
  work: Promise<void>,
  deps: MigrateTelemetrySinkDeps
): Promise<void> {
  const schedule =
    deps.scheduleDeadline ??
    ((ms, onFire) => {
      const timer = setTimeout(onFire, ms);
      // Do not keep the event loop alive solely for the deadline.
      timer.unref?.();
    });
  const deadline = new Promise<void>((resolve) => {
    schedule(DD_LOG_INTAKE_TIMEOUT_MS, resolve);
  });
  return Promise.race([work, deadline]);
}

// --- per-run recorder -----------------------------------------------------

/** Injectable clock so tests get deterministic durations. */
export type MigrateRunRecorderContext = {
  schema: string | null;
  isPreview: boolean;
  env: MigrateTelemetryEnv;
  now?: () => number;
  emit?: (event: MigrateDeployEvent) => void;
};

/**
 * Accumulates one schema-migrate's signals and emits exactly one event on
 * `finish`. A FRESH recorder per schema — the preview-migrator walk migrates N
 * schemas in one process, so a shared recorder would cross-contaminate them.
 * Every setter is best-effort; `finish` builds + emits and never throws.
 */
export type MigrateRunRecorder = {
  start(): void;
  setAtHeadSkip(value: boolean): void;
  setGate(outcome: MigrateGateOutcome, waitMs: number): void;
  markMigrateStart(): void;
  markMigrateDone(): void;
  setAttempts(attempts: number): void;
  setResetKind(kind: MigrateResetKind): void;
  /** ISS-4601: the post-deploy sweep's result; unset leaves it `null` (unswept). */
  setInvalidIndexes(names: string[]): void;
  finish(outcome: MigrateOutcome): void;
};

export function createMigrateRunRecorder(
  ctx: MigrateRunRecorderContext
): MigrateRunRecorder {
  const now = ctx.now ?? Date.now;
  const emit = ctx.emit ?? ((event) => recordMigrateEvent(event));

  let startedAtMs: number | null = null;
  let startedAtIso = "";
  let atHeadSkip = false;
  let gateOutcome: MigrateGateOutcome | null = null;
  let gateWaitMs: number | null = null;
  let migrateStartMs: number | null = null;
  let migrateStartedIso: string | null = null;
  let migrateMs: number | null = null;
  let attempts: number | null = null;
  let resetKind: MigrateResetKind = MigrateResetKind.None;
  let invalidIndexes: string[] | null = null;
  let finished = false;

  return {
    start() {
      startedAtMs = now();
      startedAtIso = new Date(startedAtMs).toISOString();
    },
    setAtHeadSkip(value) {
      atHeadSkip = value;
    },
    setGate(outcome, waitMs) {
      gateOutcome = outcome;
      gateWaitMs = waitMs;
    },
    markMigrateStart() {
      migrateStartMs = now();
      migrateStartedIso = new Date(migrateStartMs).toISOString();
    },
    markMigrateDone() {
      if (migrateStartMs !== null) {
        migrateMs = now() - migrateStartMs;
      }
    },
    setAttempts(value) {
      attempts = value;
    },
    setResetKind(kind) {
      resetKind = kind;
    },
    setInvalidIndexes(names) {
      invalidIndexes = names;
    },
    finish(outcome) {
      // Guard against a double-finish (defensive; the emit choke point calls once).
      if (finished) {
        return;
      }
      finished = true;
      try {
        const endedAtMs = now();
        emit(
          buildMigrateEvent({
            env: ctx.env,
            schema: ctx.schema,
            isPreview: ctx.isPreview,
            startedAt: startedAtIso || new Date(endedAtMs).toISOString(),
            durationMs: startedAtMs === null ? 0 : endedAtMs - startedAtMs,
            atHeadSkip,
            gateOutcome,
            gateWaitMs,
            migrateStartedAt: migrateStartedIso,
            migrateMs,
            resetKind,
            outcome,
            attempts,
            invalidIndexes,
          })
        );
      } catch {
        warnOnce(
          "sink_failed",
          "migrate telemetry: finish threw; event dropped."
        );
      }
    },
  };
}

/** Test-only: clear the buffer and warn-once latches so cases cannot leak. */
export function __resetMigrateTelemetryForTests(): void {
  buffer.length = 0;
  warned.sink_failed = false;
  warned.flush_failed = false;
}
