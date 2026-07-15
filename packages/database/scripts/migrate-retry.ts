/**
 * Pure retry helpers for migrate.ts: shared backoff/withRetry machinery for
 * registry writes (isTransientConnectionError) and the build-time
 * `prisma migrate deploy` connectivity classification (subprocessErrorOutput,
 * isPrismaUnreachableError, isTransientMigrateDeployError).
 *
 * No I/O, no process.env reads, no pg calls at module level — all inputs are
 * arguments. This design allows the retry logic to be unit-tested without
 * executing migrate.ts's top-level main().
 *
 * Follows the cleanup-preview-schemas-lib.ts sibling-lib pattern.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Matches any 5-character alphanumeric SQLSTATE code (server-side SQL errors).
// OS-level error codes (ECONNRESET, etc.) do NOT match this pattern.
const SQLSTATE_FORMAT_REGEX = /^[0-9A-Z]{5}$/;

// OS-level error codes that are always transient.
export const TRANSIENT_ERROR_CODES = new Set<string>([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
]);

// Backoff strategy for transient retries: exponential with a hard cap.
// 100ms → 200ms → 400ms → 800ms → 1.6s → capped at 2s. With the current
// 3-attempt budget this caps total worst-case wait at ~700ms — small enough
// to stay well under the 15-minute IAM token validity window, large enough
// to let a brief connection blip clear before retrying.
const DEFAULT_BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 2000;

const ERROR_MESSAGE_MAX_LENGTH = 120;

// ---------------------------------------------------------------------------
// isTransientConnectionError
// ---------------------------------------------------------------------------

function classifySingleError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    // Non-Error throws (e.g. `throw "boom"`, `throw 42`) carry no reliable
    // signal — no `.code`, no `.message`, no `.cause`. Classify as
    // non-transient so the first failure surfaces to the caller immediately
    // rather than masking a programming bug behind retries.
    return false;
  }

  const rawCode = (err as Error & { code?: unknown }).code;
  const code = typeof rawCode === "string" ? rawCode : undefined;

  if (code !== undefined) {
    if (TRANSIENT_ERROR_CODES.has(code)) {
      return true;
    }

    // If the code looks like a SQLSTATE (5 alphanum chars), check for transient classes.
    if (SQLSTATE_FORMAT_REGEX.test(code)) {
      // Class 08 = connection exceptions (08000, 08001, 08006, etc.)
      if (code.startsWith("08")) {
        return true;
      }
      // 57P01 = admin_shutdown, 57P02 = crash_shutdown, 57P03 = cannot_connect_now
      if (code === "57P01" || code === "57P02" || code === "57P03") {
        return true;
      }
      return false;
    }
  }

  // No code or non-SQLSTATE code: check message for node-postgres connection drop patterns.
  const msg = err.message.toLowerCase();
  return (
    msg.includes("connection terminated") ||
    msg.includes("server closed the connection") ||
    msg.includes("connection reset") ||
    msg.includes("read econnreset") ||
    msg.includes("socket hang up")
  );
}

export function isTransientConnectionError(err: unknown): boolean {
  if (classifySingleError(err)) {
    return true;
  }

  // Walk one level into err.cause before giving up. Guard against null/undefined
  // and other non-object values where property access would throw.
  if (err === null || typeof err !== "object") {
    return false;
  }
  const cause = (err as { cause?: unknown }).cause;
  return cause !== undefined && classifySingleError(cause);
}

// ---------------------------------------------------------------------------
// backoffMs
// ---------------------------------------------------------------------------

/**
 * Exponential backoff: `baseMs * 2 ** (attempt - 1)`, capped at `maxMs`
 * (defaults to `MAX_DELAY_MS`). Pure function — safe to unit test directly.
 * The advisory-lock deploy path (FEA-3062) passes a larger `maxMs` so a burst
 * of contending pipelines can wait out a lock held by a peer migrate deploy.
 */
export function backoffMs(
  attempt: number,
  baseMs: number = DEFAULT_BASE_DELAY_MS,
  maxMs: number = MAX_DELAY_MS
): number {
  return Math.min(baseMs * 2 ** (attempt - 1), maxMs);
}

// ---------------------------------------------------------------------------
// Error log formatters (pure helpers — kept testable)
// ---------------------------------------------------------------------------

function errorCodeFragment(err: unknown): string {
  if (
    err instanceof Error &&
    typeof (err as Error & { code?: unknown }).code === "string"
  ) {
    return ` [${(err as Error & { code: string }).code}]`;
  }
  return "";
}

function errorMessageTruncated(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.slice(0, ERROR_MESSAGE_MAX_LENGTH);
}

// Default operation label for the retry log lines. Overridable via the
// `operation` field so the same withRetry machinery can serve callers other
// than the registry upsert (e.g. the build-time migrate deploy) without
// emitting misleading "Registry upsert ..." lines.
const DEFAULT_RETRY_OPERATION = "Registry upsert";

/**
 * Format the per-attempt retry log line. Pure function — caller decides
 * whether to log it.
 */
export function formatRetryAttemptLine(input: {
  attempt: number;
  totalAttempts: number;
  err: unknown;
  operation?: string;
}): string {
  const operation = input.operation ?? DEFAULT_RETRY_OPERATION;
  return `↪ ${operation} attempt ${input.attempt}/${input.totalAttempts} failed (transient), retrying:${errorCodeFragment(input.err)} ${errorMessageTruncated(input.err)}`;
}

/**
 * Format the retry-budget-exhausted log line. Pure function.
 */
export function formatRetryExhaustedLine(input: {
  totalAttempts: number;
  err: unknown;
  operation?: string;
}): string {
  const operation = input.operation ?? DEFAULT_RETRY_OPERATION;
  return `❌ ${operation} exhausted ${input.totalAttempts} attempts, last error:${errorCodeFragment(input.err)} ${errorMessageTruncated(input.err)}`;
}

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Equal-jitter: keep half the computed backoff fixed and randomize the other
 * half — `delay/2 + random()*delay/2`, floored to an integer. Guarantees at
 * least half the intended wait (so we still outlast a contended lock) while
 * de-synchronizing pipelines that failed the advisory-lock acquire at the same
 * instant, preventing them from re-colliding in lockstep. `random` is injected
 * so the behaviour stays deterministic under test.
 */
export function applyJitter(delayMs: number, random: () => number): number {
  const half = delayMs / 2;
  return Math.floor(half + random() * half);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  isTransient: (e: unknown) => boolean,
  opts: {
    attempts: number;
    sleep?: (ms: number) => Promise<void>;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitter?: boolean;
    random?: () => number;
    operation?: string;
  }
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? MAX_DELAY_MS;
  const random = opts.random ?? Math.random;
  const operation = opts.operation ?? DEFAULT_RETRY_OPERATION;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) {
        console.log(
          `↪ ${operation} succeeded on attempt ${attempt}/${opts.attempts}`
        );
      }
      return result;
    } catch (err) {
      lastErr = err;

      if (!isTransient(err)) {
        throw err;
      }

      if (attempt === opts.attempts) {
        console.error(
          formatRetryExhaustedLine({
            totalAttempts: opts.attempts,
            err,
            operation,
          })
        );
        throw lastErr;
      }

      console.log(
        formatRetryAttemptLine({
          attempt,
          totalAttempts: opts.attempts,
          err,
          operation,
        })
      );
      const delay = backoffMs(attempt, baseDelayMs, maxDelayMs);
      await sleep(opts.jitter ? applyJitter(delay, random) : delay);
    }
  }

  // Unreachable — the loop always returns or throws. TypeScript needs this.
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Prisma CLI connectivity classification (build-time migrate deploy)
// ---------------------------------------------------------------------------

// Prisma CLI connectivity error. P1001 = "Can't reach database server" — the
// CLI could not open a connection at all, the transient blip we want to retry.
// Deliberately narrow: P1000 (auth failed) and every P30xx migration-state code
// are NOT connectivity and must fall through to fail-fast or the existing
// recoverMigrateDeployFailure path. P1002 is handled separately: a *bare* P1002
// (reached-but-timed-out) is still non-transient here, but the advisory-lock
// variant of P1002 is retried via isPrismaAdvisoryLockError below (FEA-3062).
const PRISMA_UNREACHABLE_CODE_PATTERN = /\bP1001\b/;

// Prisma Migrate serializes every `migrate deploy` on ONE hardcoded, per-database
// advisory lock (SELECT pg_advisory_lock(72707369)); the acquire has a fixed,
// non-configurable 10s timeout. When several pipelines migrate the same physical
// database at once (e.g. an api-stage deploy plus a burst of preview-schema
// deploys), the loser reports P1002 with a "Timed out trying to acquire a postgres
// advisory lock" context. This is pure transient contention — the peer releases
// the lock when its deploy ends — so we retry it rather than failing the build
// (FEA-3062). Matched on the stable context phrase, independent of the lock key.
const PRISMA_ADVISORY_LOCK_PATTERN = /acquire a postgres advisory lock/i;

function readSubprocessField(err: Error, field: "stdout" | "stderr"): string {
  const value = (err as Error & Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

/**
 * Canonical extraction of a child-process error's captured output. `spawnSync`
 * failures from migrate.ts attach `.stdout`/`.stderr`; generic errors carry
 * only `.message`. All three are joined so a single scan covers every source.
 * Non-Error throws fall back to their string form. Single source of truth for
 * scanning Prisma CLI output (also consumed by migrate-deploy-recovery.ts).
 */
export function subprocessErrorOutput(err: unknown): string {
  if (err instanceof Error) {
    const stderr = readSubprocessField(err, "stderr");
    const stdout = readSubprocessField(err, "stdout");
    return [stderr, stdout, err.message].join("\n");
  }
  return typeof err === "string" ? err : "";
}

/**
 * True when a `prisma migrate deploy` subprocess failed because it could not
 * reach the database server (P1001). This is the build-time analogue of
 * isTransientConnectionError: the latter classifies node-postgres *client*
 * errors (registry writes) by `.code`/message, whereas the Prisma *CLI*
 * surfaces connectivity as a P1001 string on stderr with no `.code`.
 */
export function isPrismaUnreachableError(err: unknown): boolean {
  return PRISMA_UNREACHABLE_CODE_PATTERN.test(subprocessErrorOutput(err));
}

/**
 * True when a `prisma migrate deploy` subprocess failed because it could not
 * acquire Prisma's migration advisory lock within the 10s timeout — i.e. a
 * peer migrate deploy against the same physical database is holding it. Matched
 * on the Prisma context phrase (not the P1002 code) so a *bare* P1002 with no
 * advisory-lock context (a genuine reached-but-timed-out connection) is NOT
 * retried here and is not masked by minutes of retries. (FEA-3062)
 */
export function isPrismaAdvisoryLockError(err: unknown): boolean {
  return PRISMA_ADVISORY_LOCK_PATTERN.test(subprocessErrorOutput(err));
}

/**
 * Transient-error predicate for the build-time `prisma migrate deploy` step:
 * a dropped pg connection (isTransientConnectionError) OR the Prisma CLI's
 * P1001 "can't reach database server" (isPrismaUnreachableError) OR advisory-
 * lock contention (isPrismaAdvisoryLockError). Migration-state failures
 * (P3005/P3009/P3018/P0001) are NOT matched — they fall through to
 * recoverMigrateDeployFailure unchanged.
 */
export function isTransientMigrateDeployError(err: unknown): boolean {
  return (
    isTransientConnectionError(err) ||
    isPrismaUnreachableError(err) ||
    isPrismaAdvisoryLockError(err)
  );
}

// Build-time `prisma migrate deploy` retry budget (FEA-3062). As of FEA-3065
// this is the **fail-open backstop**: the primary defense is the app-side
// serialization gate (`withMigrationSerializeLock`, migration-lock.ts), which
// makes Prisma's advisory lock uncontended in the common case; this retry only
// fires when the gate itself fails open (e.g. its acquire exceeds the budget).
// Wider than the registry-upsert default so a contended advisory lock can be
// waited out: the dominant cost is re-attempting the acquire (each attempt
// itself blocks up to Prisma's 10s lock timeout), so attempts matter more than
// sleep length. Worst case ≈ 8 acquire attempts (~80s of lock waits) + jittered
// sleeps capped at 15s ≈ under ~3 min — comfortably inside the ~15-min RDS
// IAM-token validity window (retries reuse the same IAM-signed URL). Jitter
// de-synchronizes simultaneous losers so they don't re-collide in lockstep.
export const MIGRATE_DEPLOY_RETRY = {
  attempts: 8,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  jitter: true,
  operation: "Migrate deploy",
} as const;
