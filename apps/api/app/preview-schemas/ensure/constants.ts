/**
 * Which schema a `/preview-schemas/ensure` request targets (ISS-5984).
 *
 * The literal values are a wire contract: the stage-deploy workflow POSTs
 * `{"target":"public"}` from bash, which cannot import this module, so
 * `scripts/deploy/staging-integration-workflow-source.test.ts` asserts the
 * workflow's literal against this const rather than against a second copy.
 */
export const EnsureTarget = {
  Preview: "preview",
  Public: "public",
} as const;

export type EnsureTarget = (typeof EnsureTarget)[keyof typeof EnsureTarget];

/**
 * Why `ensureSchemaAtHead` refused or failed, for a caller that answers
 * differently per cause. The HTTP route gives each one its own status; the
 * lazy bootstrap gate just throws either way.
 *
 * Not a wire value — it is never serialized into a response body. The client
 * gets a deliberately generic message (ISS-6403, review: whitlockk); this is how
 * the SERVER tells the two apart. `statusForFailure` in `route.ts` owns the
 * mapping to HTTP and is exhaustive over this union, so adding a member here
 * fails typecheck until it is given a status.
 */
export const EnsureFailureReason = {
  HostNotAllowed: "host_not_allowed",
  Failed: "failed",
  /**
   * ISS-6403 Finding 1: the caller's deadline expired with the migrate STILL
   * RUNNING. Distinct from `Failed` because the two want opposite responses —
   * a `Failed` run is over, whereas this one holds the serialize lock and may
   * be mid-DDL, so retrying it behind a preview's fail-open gate starts a
   * second concurrent migrate. ISS-11781: `public`'s gate fails closed, so a
   * retry there waits for that lock or is refused as `Contended`.
   */
  TimedOut: "timed_out",
  /**
   * ISS-11781: another migrate held a migration lock — the FEA-3065 serialize
   * gate (refused fail-closed) or Prisma's own advisory lock (P1002) — so this
   * run applied nothing. Distinct from `Failed`, which is a migration verdict,
   * because this one is safe to retry.
   */
  Contended: "contended",
} as const;

export type EnsureFailureReason =
  (typeof EnsureFailureReason)[keyof typeof EnsureFailureReason];

/**
 * The ensure route's serverless ceiling, in MILLISECONDS (ISS-6403 Finding 1).
 *
 * A restatement of `route.ts`'s `maxDuration = 300`, which itself restates
 * `LONG_RUNNING_API_TIMEOUT_MS`. Next reads `maxDuration` as statically
 * analyzable segment config and will not follow an import; this module could
 * import the canonical constant, but only from `@repo/app` — a package
 * `apps/api` does not depend on and would not want to pull into a function.
 * `long-running-route-max-duration.test.ts` chains all three so drift fails CI.
 */
export const ENSURE_ROUTE_CEILING_MS = 300_000;

/**
 * Wall-clock held back from {@link ENSURE_ROUTE_CEILING_MS} so the route can
 * still answer when its deadline fires.
 *
 * Sized against what actually runs AFTER the deadline fires, which is more than
 * building a response: `ensureSchemaAtHead`'s `finally` awaits
 * `flushMigrateTelemetry()`, and that is itself bounded at a 3s Datadog-intake
 * deadline (`DD_LOG_INTAKE_TIMEOUT_MS`, `packages/database/scripts/migrate-telemetry.ts`).
 * 10s leaves that room several times over. A reserve under it would let the
 * flush push the 504 past the platform kill — reintroducing the opaque
 * `FUNCTION_INVOCATION_TIMEOUT` on the exact path meant to replace it (review).
 *
 * Bounded ABOVE as well, and the pinning test enforces both ends. Every
 * millisecond here is taken from a migrate that has a real use for it, and a
 * reserve that crept upward would convert runs finishing between the deadline
 * and the ceiling — which return 200 today — into reported failures, a
 * behavior trade this ticket did not ask for.
 *
 * The route subtracts its own elapsed preamble (OIDC validation, body parse)
 * from the budget rather than charging it to this reserve, so a cold-instance
 * JWKS fetch cannot silently eat it.
 */
export const ENSURE_DEADLINE_RESERVE_MS = 10_000;

/**
 * ISS-11781: the share of a `public` ensure's budget kept for the migrate once
 * the FEA-3065 serialize gate is held. The gate waits only for the rest, then
 * refuses fail-closed (`Contended`) instead of letting the route's deadline cut
 * a request that is still queued — a queued waiter outlives its 504 and later
 * runs unguarded. Sized from 30 days of stage `public` runs: the slowest
 * successful migrate took 106s and an exhausted P1002 retry loop ~133s, while
 * no successful run waited more than 16s for the gate.
 */
export const ENSURE_PUBLIC_MIGRATE_ALLOWANCE_MS = 150_000;
