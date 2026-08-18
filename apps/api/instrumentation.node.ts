import { log } from "@repo/observability/log";
import { emitDbPoolMetric } from "@repo/observability/telemetry/metrics";
import { ORIGIN } from "@repo/observability/telemetry/origin";
import type { TracingConfig } from "@repo/observability/tracing/config";
import { TracingDisabledReason } from "@repo/observability/tracing/config";

/**
 * Registers the API instrumentation that depends on Node-only modules.
 *
 * Tracing must start before the database import: PgInstrumentation patches
 * `pg` at module-evaluation time, while `packages/database/index.ts` imports
 * `pg` directly at module scope — and `@prisma/adapter-pg` beside it, which
 * depends on `pg` as well.
 *
 * That ordering is load-bearing as a *measured* fact, not just in theory. The
 * ISS-4659 probe (since removed) sampled 4,356 cold starts: 4,267 had `pg`
 * absent before tracing and were patched, while **89 had `pg` already resident
 * and were NOT patched** — those cold starts produced zero DB child spans for
 * the life of the process.
 *
 * Every failing sample also had `@prisma/client` resident, but that is a
 * co-symptom rather than the cause: `@prisma/client` does not depend on `pg`
 * at all (the lockfile gives it one runtime dependency,
 * `@prisma/client-runtime-utils`), and `packages/database/index.ts` imports
 * the generated client and `pg` from the same module scope, so either being
 * resident just means `@repo/database` was already loaded. `@repo/database` is
 * the edge to look at — anything that reaches it before this function runs
 * silently forfeits DB tracing. Keep `registerPoolTelemetry`'s import dynamic
 * and keep it after `registerTracing()`.
 */
export async function registerNodeInstrumentation(): Promise<void> {
  await registerTracing();
  await registerPoolTelemetry();
  await registerSchemaBootstrap();
}

/**
 * ISS-4659: start the OpenTelemetry tracer.
 *
 * The import AND the initialisation share one fail-open boundary. `initTracing`
 * catches its own bootstrap failures, but module resolution and evaluation
 * happen before it is called. Tracing must never fail the API cold start.
 *
 * The outcome is reported once per cold start. `not_deployed` is the expected
 * local/CI state and stays quiet — warning on every local cold start would
 * train operators to ignore the warnings that matter.
 */
async function registerTracing(): Promise<void> {
  let result: TracingConfig;
  try {
    const { initTracing } = await import(
      "@repo/observability/tracing/provider"
    );
    result = initTracing();
  } catch {
    log.warn("telemetry.tracing_disabled", {
      reason: TracingDisabledReason.InitFailed,
    });
    return;
  }

  if (result.enabled) {
    log.info("telemetry.tracing_initialized", {
      service: result.service,
      sampleRate: result.sampleRate,
    });
    return;
  }
  if (result.reason !== TracingDisabledReason.NotDeployed) {
    log.warn("telemetry.tracing_disabled", { reason: result.reason });
  }
}

/**
 * FEA-3300: injects the Datadog emitter into the database pool telemetry.
 *
 * `@repo/database` intentionally has no `@repo/observability` dependency, and
 * `origin` must be present in the emitted payload for the Vercel Log Drain.
 * The database import remains dynamic so it occurs only after tracing patches
 * `pg` in `registerTracing()`.
 */
async function registerPoolTelemetry(): Promise<void> {
  const { setPoolTelemetrySink } = await import("@repo/database");
  setPoolTelemetrySink((sample) =>
    emitDbPoolMetric({ ...sample, origin: ORIGIN })
  );
}

/**
 * ISS-5984: installs the lazy preview-schema bootstrap so it runs immediately
 * before the first Prisma client of a cold instance — the last moment before a
 * query could hit a schema that does not exist yet.
 *
 * Registered UNCONDITIONALLY; the gate itself owns both closed-by-default
 * conditions (`VERCEL_ENV === "preview"` plus an explicit token), so there is
 * exactly one place that decides whether a bootstrap happens. Off, the hook is
 * a resolved promise.
 *
 * `@repo/database` stays dynamic for the same reason `registerPoolTelemetry`
 * does — this must not pull the database module in ahead of `registerTracing`,
 * which patches `pg` at module-evaluation time. The gate's own heavy import
 * (the migration pipeline) is dynamic inside the gate, so nothing here traces
 * `prisma migrate` into every function.
 */
async function registerSchemaBootstrap(): Promise<void> {
  const { setSchemaBootstrapHook } = await import("@repo/database");
  const { ensurePreviewSchemaBootstrap } = await import(
    "@/lib/preview-schema-bootstrap"
  );
  setSchemaBootstrapHook(() => ensurePreviewSchemaBootstrap());
}
