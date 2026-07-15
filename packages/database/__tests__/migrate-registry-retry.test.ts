import { describe, expect, it, vi } from "vitest";
import {
  applyJitter,
  backoffMs,
  formatRetryAttemptLine,
  formatRetryExhaustedLine,
  isPrismaAdvisoryLockError,
  isPrismaUnreachableError,
  isTransientConnectionError,
  isTransientMigrateDeployError,
  MIGRATE_DEPLOY_RETRY,
  subprocessErrorOutput,
  TRANSIENT_ERROR_CODES,
  withRetry,
} from "../scripts/migrate-retry";
import { makeDeployError } from "./test-helpers/deploy-error";

// Positional convenience over the shared makeDeployError builder: most
// connectivity/classification tests here only vary the stderr text, and they
// want the production-accurate message migrate.ts's runMigrateDeploy throws.
function deployError(stderr: string, stdout = ""): Error {
  return makeDeployError({
    stderr,
    stdout,
    message: "prisma migrate deploy failed with exit code 1",
  });
}

const P1001_STDERR =
  "Error: P1001: Can't reach database server at `db.example.com:5432`\n\nPlease make sure your database server is running at `db.example.com:5432`.";

// Verbatim shape of the FEA-3062 production failure: P1002 emitted WITH the
// advisory-lock acquire-timeout context (from the api-stage deploy build logs).
const ADVISORY_LOCK_STDERR =
  "Error: P1002\n\nThe database server was reached but timed out.\n\nPlease try again.\n\nContext: Timed out trying to acquire a postgres advisory lock (SELECT pg_advisory_lock(72707369)). Timeout: 10000ms. See https://pris.ly/d/migrate-advisory-locking for details.";

// A genuine reached-but-timed-out P1002 with NO advisory-lock context — must
// stay non-transient so a real outage is not masked by minutes of retries.
const BARE_P1002_STDERR =
  "Error: P1002\n\nThe database server was reached but timed out.\n\nPlease make sure your database server is running at the configured address.";

// ---------------------------------------------------------------------------
// isTransientConnectionError
// ---------------------------------------------------------------------------

describe("isTransientConnectionError", () => {
  it("(a) plain Error with no .code and transient message → transient", () => {
    const err = new Error("Connection terminated unexpectedly");
    expect(isTransientConnectionError(err)).toBe(true);
  });

  it("(b) Error with code 57P01 (admin_shutdown) → transient", () => {
    const err = Object.assign(new Error("admin shutdown"), { code: "57P01" });
    expect(isTransientConnectionError(err)).toBe(true);
  });

  it("(c) Error with code 08006 (connection_failure SQLSTATE class 08) → transient", () => {
    const err = Object.assign(new Error("connection failure"), {
      code: "08006",
    });
    expect(isTransientConnectionError(err)).toBe(true);
  });

  it("(d) Error with code ECONNRESET (OS-level, no SQLSTATE pattern) → transient", () => {
    const err = Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
    expect(isTransientConnectionError(err)).toBe(true);
  });

  it("(e) Error with code 23505 (unique_violation) → non-transient", () => {
    const err = Object.assign(new Error("duplicate key"), { code: "23505" });
    expect(isTransientConnectionError(err)).toBe(false);
  });

  it("(f) Error with code 42703 (undefined_column) → non-transient", () => {
    const err = Object.assign(new Error("column does not exist"), {
      code: "42703",
    });
    expect(isTransientConnectionError(err)).toBe(false);
  });

  it("(g) Error with code 28P01 (invalid_password) → non-transient", () => {
    const err = Object.assign(new Error("password authentication failed"), {
      code: "28P01",
    });
    expect(isTransientConnectionError(err)).toBe(false);
  });

  it("(h) wrapped Error where cause.code = ECONNREFUSED → transient (one-level cause walk)", () => {
    const inner = Object.assign(new Error("inner"), { code: "ECONNREFUSED" });
    const outer = Object.assign(new Error("wrapped"), { cause: inner });
    expect(isTransientConnectionError(outer)).toBe(true);
  });

  it("(i) Error with code 57P02 (crash_shutdown) → transient", () => {
    const err = Object.assign(new Error("crash shutdown"), { code: "57P02" });
    expect(isTransientConnectionError(err)).toBe(true);
  });

  it("(j) Error with code 57P03 (cannot_connect_now) → transient", () => {
    const err = Object.assign(new Error("cannot connect now"), {
      code: "57P03",
    });
    expect(isTransientConnectionError(err)).toBe(true);
  });

  it("(k) Error with code 57000 (class 57 but NOT 57P0x) → non-transient", () => {
    const err = Object.assign(new Error("operator intervention"), {
      code: "57000",
    });
    expect(isTransientConnectionError(err)).toBe(false);
  });

  it("(l) Error with code 42P01 (undefined_table) → non-transient", () => {
    const err = Object.assign(new Error("relation does not exist"), {
      code: "42P01",
    });
    expect(isTransientConnectionError(err)).toBe(false);
  });

  it("(m) non-Error thrown value (string) → non-transient (no reliable signal)", () => {
    expect(isTransientConnectionError("boom")).toBe(false);
  });

  it("(n) non-Error thrown value (number) → non-transient", () => {
    expect(isTransientConnectionError(42)).toBe(false);
  });

  it("(o) non-Error thrown value (null) → non-transient", () => {
    expect(isTransientConnectionError(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TRANSIENT_ERROR_CODES
// ---------------------------------------------------------------------------

describe("TRANSIENT_ERROR_CODES", () => {
  it("is a Set", () => {
    expect(TRANSIENT_ERROR_CODES).toBeInstanceOf(Set);
  });

  it("includes ECONNRESET", () => {
    expect(TRANSIENT_ERROR_CODES.has("ECONNRESET")).toBe(true);
  });

  it("includes ECONNREFUSED", () => {
    expect(TRANSIENT_ERROR_CODES.has("ECONNREFUSED")).toBe(true);
  });

  it("includes ETIMEDOUT", () => {
    expect(TRANSIENT_ERROR_CODES.has("ETIMEDOUT")).toBe(true);
  });

  it("includes EHOSTUNREACH", () => {
    expect(TRANSIENT_ERROR_CODES.has("EHOSTUNREACH")).toBe(true);
  });

  it("does not contain ENOTFOUND or EAGAIN", () => {
    expect(TRANSIENT_ERROR_CODES.has("ENOTFOUND")).toBe(false);
    expect(TRANSIENT_ERROR_CODES.has("EAGAIN")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe("withRetry", () => {
  const noopSleep = () => Promise.resolve();

  it("(a) resolves on first attempt — fn resolves immediately, sleep never called", async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withRetry(fn, isTransientConnectionError, {
      attempts: 3,
      sleep: sleepFn,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("(b) retries and succeeds after one transient error", async () => {
    const transientErr = Object.assign(new Error("conn drop"), {
      code: "08006",
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValueOnce("success");

    const result = await withRetry(fn, isTransientConnectionError, {
      attempts: 3,
      sleep: noopSleep,
    });

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("(c) exhausts retry budget — thrown error is the SAME instance (identity)", async () => {
    const orig = Object.assign(new Error("conn drop"), { code: "08006" });
    const fn = vi.fn().mockRejectedValue(orig);

    let thrown: unknown;
    try {
      await withRetry(fn, isTransientConnectionError, {
        attempts: 3,
        sleep: noopSleep,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(orig);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("(d) non-transient error rethrown immediately, sleep not called", async () => {
    const nonTransientErr = Object.assign(new Error("dup key"), {
      code: "23505",
    });
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(nonTransientErr);

    let thrown: unknown;
    try {
      await withRetry(fn, isTransientConnectionError, {
        attempts: 3,
        sleep: sleepFn,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(nonTransientErr);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("(e) fn resolves immediately (no-op path) — wrapper resolves once with zero retries", async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockResolvedValue(undefined);

    const result = await withRetry(fn, isTransientConnectionError, {
      attempts: 3,
      sleep: sleepFn,
    });

    expect(result).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("(f) auth failure (SQLSTATE 28P01) → not retried, thrown immediately", async () => {
    const authErr = Object.assign(new Error("password authentication failed"), {
      code: "28P01",
    });
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(authErr);

    let thrown: unknown;
    try {
      await withRetry(fn, isTransientConnectionError, {
        attempts: 3,
        sleep: sleepFn,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(authErr);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("(g) wrapper re-throws original Error instance preserving .code and .message", async () => {
    const orig = Object.assign(new Error("msg"), { code: "08006" });
    const fn = vi.fn().mockRejectedValue(orig);

    let thrown: unknown;
    try {
      await withRetry(fn, isTransientConnectionError, {
        attempts: 1,
        sleep: noopSleep,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(orig);
    expect((thrown as Error & { code: string }).code).toBe("08006");
    expect((thrown as Error).message).toBe("msg");
  });

  it("(h) non-transient on attempt 2 after transient on attempt 1 — rethrows immediately, no attempt 3", async () => {
    const transientErr = Object.assign(new Error("conn drop"), {
      code: "ECONNRESET",
    });
    const nonTransientErr = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientErr)
      .mockRejectedValueOnce(nonTransientErr);

    let thrown: unknown;
    try {
      await withRetry(fn, isTransientConnectionError, {
        attempts: 3,
        sleep: sleepFn,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(nonTransientErr);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });

  it("(i) passes computed backoff delay to sleep (not 0) on each retry", async () => {
    const transientErr = Object.assign(new Error("conn drop"), {
      code: "08006",
    });
    const sleepFn = vi
      .fn<(ms: number) => Promise<void>>()
      .mockResolvedValue(undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientErr)
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValueOnce("ok");

    await withRetry(fn, isTransientConnectionError, {
      attempts: 3,
      sleep: sleepFn,
      baseDelayMs: 100,
    });

    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(sleepFn.mock.calls[0][0]).toBe(100); // backoffMs(1, 100) = 100
    expect(sleepFn.mock.calls[1][0]).toBe(200); // backoffMs(2, 100) = 200
  });
});

// ---------------------------------------------------------------------------
// backoffMs (exponential backoff, capped)
// ---------------------------------------------------------------------------

describe("backoffMs", () => {
  it("returns base on attempt 1", () => {
    expect(backoffMs(1, 100)).toBe(100);
  });

  it("doubles each attempt: 100 → 200 → 400 → 800 → 1600", () => {
    expect(backoffMs(1, 100)).toBe(100);
    expect(backoffMs(2, 100)).toBe(200);
    expect(backoffMs(3, 100)).toBe(400);
    expect(backoffMs(4, 100)).toBe(800);
    expect(backoffMs(5, 100)).toBe(1600);
  });

  it("caps at 2000ms regardless of base or attempt", () => {
    expect(backoffMs(6, 100)).toBe(2000); // 100 * 32 = 3200 → capped to 2000
    expect(backoffMs(10, 100)).toBe(2000);
    expect(backoffMs(3, 1000)).toBe(2000); // 1000 * 4 = 4000 → capped
  });

  it("uses 100ms default when base is omitted", () => {
    expect(backoffMs(1)).toBe(100);
    expect(backoffMs(2)).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// formatRetryAttemptLine / formatRetryExhaustedLine (pure formatters)
// ---------------------------------------------------------------------------

describe("formatRetryAttemptLine", () => {
  it("includes [CODE] when err.code is a string", () => {
    const err = Object.assign(new Error("conn failure"), { code: "08006" });
    const line = formatRetryAttemptLine({ attempt: 1, totalAttempts: 3, err });
    expect(line).toContain("[08006]");
  });

  it("omits [undefined] when err has no .code", () => {
    const err = new Error("connection reset by peer");
    const line = formatRetryAttemptLine({ attempt: 1, totalAttempts: 3, err });
    expect(line).not.toContain("[undefined]");
    expect(line).not.toContain("[]");
  });

  it("omits the code fragment when .code is a non-string (number, undefined)", () => {
    const errNum = Object.assign(new Error("x"), { code: 42 });
    const errUndef = Object.assign(new Error("y"), { code: undefined });
    expect(
      formatRetryAttemptLine({ attempt: 1, totalAttempts: 3, err: errNum })
    ).not.toContain("[42]");
    expect(
      formatRetryAttemptLine({ attempt: 1, totalAttempts: 3, err: errUndef })
    ).not.toContain("[undefined]");
  });

  it("truncates the message at exactly 120 characters", () => {
    const longMessage = "x".repeat(200);
    const err = new Error(longMessage);
    const line = formatRetryAttemptLine({ attempt: 1, totalAttempts: 3, err });
    expect(line).toContain("x".repeat(120));
    expect(line).not.toContain("x".repeat(121));
  });

  it("includes the attempt/totalAttempts counter", () => {
    const err = new Error("e");
    expect(
      formatRetryAttemptLine({ attempt: 2, totalAttempts: 3, err })
    ).toContain("2/3");
  });

  it("renders a non-Error thrown value via String() coercion", () => {
    const line = formatRetryAttemptLine({
      attempt: 1,
      totalAttempts: 3,
      err: "boom",
    });
    expect(line).toContain("boom");
    expect(line).not.toContain("[");
  });
});

describe("formatRetryExhaustedLine", () => {
  it("includes [CODE] when err.code is a string", () => {
    const err = Object.assign(new Error("conn drop"), { code: "08006" });
    const line = formatRetryExhaustedLine({ totalAttempts: 3, err });
    expect(line).toContain("[08006]");
    expect(line).toContain("exhausted 3 attempts");
  });

  it("truncates the message at 120 characters", () => {
    const err = new Error("y".repeat(200));
    const line = formatRetryExhaustedLine({ totalAttempts: 3, err });
    expect(line).toContain("y".repeat(120));
    expect(line).not.toContain("y".repeat(121));
  });
});

// ---------------------------------------------------------------------------
// operation label (default preserved, overridable)
// ---------------------------------------------------------------------------

describe("retry log operation label", () => {
  it("formatRetryAttemptLine defaults to 'Registry upsert'", () => {
    const line = formatRetryAttemptLine({
      attempt: 1,
      totalAttempts: 3,
      err: new Error("e"),
    });
    expect(line).toContain("Registry upsert attempt 1/3");
  });

  it("formatRetryAttemptLine uses a provided operation label", () => {
    const line = formatRetryAttemptLine({
      attempt: 1,
      totalAttempts: 3,
      err: new Error("e"),
      operation: "Migrate deploy",
    });
    expect(line).toContain("Migrate deploy attempt 1/3");
    expect(line).not.toContain("Registry upsert");
  });

  it("formatRetryExhaustedLine defaults to 'Registry upsert'", () => {
    const line = formatRetryExhaustedLine({
      totalAttempts: 3,
      err: new Error("e"),
    });
    expect(line).toContain("Registry upsert exhausted 3 attempts");
  });

  it("formatRetryExhaustedLine uses a provided operation label", () => {
    const line = formatRetryExhaustedLine({
      totalAttempts: 3,
      err: new Error("e"),
      operation: "Migrate deploy",
    });
    expect(line).toContain("Migrate deploy exhausted 3 attempts");
    expect(line).not.toContain("Registry upsert");
  });
});

// ---------------------------------------------------------------------------
// subprocessErrorOutput
// ---------------------------------------------------------------------------

describe("subprocessErrorOutput", () => {
  it("joins stderr, stdout, and message for a spawnSync-style Error", () => {
    const err = deployError("the stderr", "the stdout");
    const output = subprocessErrorOutput(err);
    expect(output).toContain("the stderr");
    expect(output).toContain("the stdout");
    expect(output).toContain("prisma migrate deploy failed");
  });

  it("falls back to message when stderr/stdout are absent", () => {
    expect(subprocessErrorOutput(new Error("just a message"))).toContain(
      "just a message"
    );
  });

  it("ignores non-string stderr/stdout fields", () => {
    const err = Object.assign(new Error("msg"), { stderr: 42, stdout: null });
    expect(subprocessErrorOutput(err)).toContain("msg");
    expect(subprocessErrorOutput(err)).not.toContain("42");
  });

  it("returns the string itself for a non-Error string throw", () => {
    expect(subprocessErrorOutput("raw boom")).toBe("raw boom");
  });

  it("returns empty string for a non-Error, non-string throw", () => {
    expect(subprocessErrorOutput(42)).toBe("");
    expect(subprocessErrorOutput(null)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// isPrismaUnreachableError (Prisma CLI P1001 connectivity)
// ---------------------------------------------------------------------------

describe("isPrismaUnreachableError", () => {
  it("P1001 on stderr → true", () => {
    expect(isPrismaUnreachableError(deployError(P1001_STDERR))).toBe(true);
  });

  it("P1001 on stdout → true (output scanned regardless of stream)", () => {
    expect(isPrismaUnreachableError(deployError("", P1001_STDERR))).toBe(true);
  });

  it("P1000 (auth failed) → false (auth is not connectivity)", () => {
    const err = deployError(
      "Error: P1000: Authentication failed against database server"
    );
    expect(isPrismaUnreachableError(err)).toBe(false);
  });

  it("P1002 (reached-but-timed-out) → false (deliberately narrow to P1001)", () => {
    const err = deployError(
      "Error: P1002: The database server was reached but timed out"
    );
    expect(isPrismaUnreachableError(err)).toBe(false);
  });

  it("P3009 (failed migration) → false (migration-state, not connectivity)", () => {
    const err = deployError(
      "Error: P3009: migrate found failed migrations in the target database"
    );
    expect(isPrismaUnreachableError(err)).toBe(false);
  });

  it("pg connection drop (08006) → false (not a Prisma CLI P1001)", () => {
    const err = Object.assign(new Error("connection failure"), {
      code: "08006",
    });
    expect(isPrismaUnreachableError(err)).toBe(false);
  });

  it("does not match an incidental substring like P10010", () => {
    expect(isPrismaUnreachableError(deployError("token P10010 xyz"))).toBe(
      false
    );
  });

  it("non-Error throw → false", () => {
    expect(isPrismaUnreachableError("boom")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTransientMigrateDeployError (combined predicate for the deploy step)
// ---------------------------------------------------------------------------

describe("isTransientMigrateDeployError", () => {
  it("Prisma P1001 → transient", () => {
    expect(isTransientMigrateDeployError(deployError(P1001_STDERR))).toBe(true);
  });

  it("pg connection drop (08006) → transient (reuses isTransientConnectionError)", () => {
    const err = Object.assign(new Error("connection failure"), {
      code: "08006",
    });
    expect(isTransientMigrateDeployError(err)).toBe(true);
  });

  it("OS-level ECONNRESET → transient", () => {
    const err = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    expect(isTransientMigrateDeployError(err)).toBe(true);
  });

  it.each([
    ["P3005", "Error: P3005: database schema is not empty"],
    ["P3009", "Error: P3009: migrate found failed migrations"],
    ["P3018", "Error: P3018: a migration failed to apply"],
    ["P0001", "Error: P0001: user-defined invariant failed"],
  ])("migration-state %s → NOT transient (routes to recovery)", (_code, stderr) => {
    expect(isTransientMigrateDeployError(deployError(stderr))).toBe(false);
  });

  it("P1000 auth failure → NOT transient", () => {
    const err = deployError("Error: P1000: Authentication failed");
    expect(isTransientMigrateDeployError(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withRetry wiring for the migrate-deploy step (production seam)
// ---------------------------------------------------------------------------

describe("withRetry + isTransientMigrateDeployError (build-time deploy)", () => {
  const noopSleep = () => Promise.resolve();

  it("retries a transient P1001 blip then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(deployError(P1001_STDERR))
      .mockResolvedValueOnce(undefined);

    await withRetry(fn, isTransientMigrateDeployError, {
      attempts: 3,
      sleep: noopSleep,
      operation: "Migrate deploy",
    });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("exhausts on a persistent P1001 and rethrows the original error instance", async () => {
    const orig = deployError(P1001_STDERR);
    const fn = vi.fn().mockRejectedValue(orig);

    let thrown: unknown;
    try {
      await withRetry(fn, isTransientMigrateDeployError, {
        attempts: 3,
        sleep: noopSleep,
        operation: "Migrate deploy",
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(orig);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a migration-state P3009 failure (one attempt, rethrown)", async () => {
    const orig = deployError("Error: P3009: migrate found failed migrations");
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(orig);

    let thrown: unknown;
    try {
      await withRetry(fn, isTransientMigrateDeployError, {
        attempts: 3,
        sleep: sleepFn,
        operation: "Migrate deploy",
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(orig);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// isPrismaAdvisoryLockError (FEA-3062 — migration advisory-lock contention)
// ---------------------------------------------------------------------------

describe("isPrismaAdvisoryLockError", () => {
  it("advisory-lock P1002 (production shape) → true", () => {
    expect(isPrismaAdvisoryLockError(deployError(ADVISORY_LOCK_STDERR))).toBe(
      true
    );
  });

  it("advisory-lock context on stdout → true (output scanned regardless of stream)", () => {
    expect(
      isPrismaAdvisoryLockError(deployError("", ADVISORY_LOCK_STDERR))
    ).toBe(true);
  });

  it("bare P1002 with no advisory-lock context → false (a real outage is not masked)", () => {
    expect(isPrismaAdvisoryLockError(deployError(BARE_P1002_STDERR))).toBe(
      false
    );
  });

  it("P1001 unreachable → false (that is connectivity, not lock contention)", () => {
    expect(isPrismaAdvisoryLockError(deployError(P1001_STDERR))).toBe(false);
  });

  it("non-Error throw → false", () => {
    expect(isPrismaAdvisoryLockError("boom")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTransientMigrateDeployError — advisory-lock additions (FEA-3062)
// ---------------------------------------------------------------------------

describe("isTransientMigrateDeployError (advisory lock)", () => {
  it("advisory-lock P1002 → transient (retried)", () => {
    expect(
      isTransientMigrateDeployError(deployError(ADVISORY_LOCK_STDERR))
    ).toBe(true);
  });

  it("bare P1002 (no advisory-lock context) → NOT transient", () => {
    expect(isTransientMigrateDeployError(deployError(BARE_P1002_STDERR))).toBe(
      false
    );
  });
});

// ---------------------------------------------------------------------------
// applyJitter (equal-jitter, deterministic under injected random)
// ---------------------------------------------------------------------------

describe("applyJitter", () => {
  it("random()=0 → exactly half the delay (lower bound)", () => {
    expect(applyJitter(1000, () => 0)).toBe(500);
  });

  it("random()→1 → approaches the full delay (upper bound)", () => {
    // half + 1*half = full; floor keeps it an integer.
    expect(applyJitter(1000, () => 0.999_999)).toBe(999);
  });

  it("random()=0.5 → three-quarters of the delay", () => {
    expect(applyJitter(1000, () => 0.5)).toBe(750);
  });

  it("always returns an integer within [delay/2, delay]", () => {
    for (const r of [0, 0.1, 0.37, 0.5, 0.83, 0.999]) {
      const out = applyJitter(2000, () => r);
      expect(Number.isInteger(out)).toBe(true);
      expect(out).toBeGreaterThanOrEqual(1000);
      expect(out).toBeLessThanOrEqual(2000);
    }
  });
});

// ---------------------------------------------------------------------------
// backoffMs — per-call cap override (FEA-3062 uses a larger cap)
// ---------------------------------------------------------------------------

describe("backoffMs (maxMs override)", () => {
  it("honors a larger cap so the deploy path can wait longer than 2s", () => {
    // 500 * 2^5 = 16000, capped to the 15000 override (not the 2000 default).
    expect(backoffMs(6, 500, 15_000)).toBe(15_000);
    expect(backoffMs(4, 500, 15_000)).toBe(4000); // 500*8, under the cap
  });

  it("still defaults to the 2000ms cap when maxMs is omitted", () => {
    expect(backoffMs(6, 100)).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// withRetry — jitter wiring (FEA-3062)
// ---------------------------------------------------------------------------

describe("withRetry (jitter)", () => {
  it("applies equal-jitter to the backoff via the injected random", async () => {
    const transientErr = Object.assign(new Error("conn drop"), {
      code: "08006",
    });
    const sleepFn = vi
      .fn<(ms: number) => Promise<void>>()
      .mockResolvedValue(undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValueOnce("ok");

    await withRetry(fn, isTransientConnectionError, {
      attempts: 3,
      sleep: sleepFn,
      baseDelayMs: 1000,
      maxDelayMs: 15_000,
      jitter: true,
      random: () => 0.5,
    });

    // backoffMs(1, 1000, 15000) = 1000 → applyJitter(1000, 0.5) = 750.
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(sleepFn.mock.calls[0][0]).toBe(750);
  });

  it("without jitter, sleeps the exact computed backoff (unchanged default)", async () => {
    const transientErr = Object.assign(new Error("conn drop"), {
      code: "08006",
    });
    const sleepFn = vi
      .fn<(ms: number) => Promise<void>>()
      .mockResolvedValue(undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValueOnce("ok");

    await withRetry(fn, isTransientConnectionError, {
      attempts: 3,
      sleep: sleepFn,
      baseDelayMs: 1000,
    });

    expect(sleepFn.mock.calls[0][0]).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// MIGRATE_DEPLOY_RETRY — production tuning + end-to-end deploy seam (FEA-3062)
// ---------------------------------------------------------------------------

describe("MIGRATE_DEPLOY_RETRY", () => {
  const noopSleep = () => Promise.resolve();

  it("is configured to wait out a contended lock (wide, jittered)", () => {
    expect(MIGRATE_DEPLOY_RETRY.attempts).toBeGreaterThanOrEqual(6);
    expect(MIGRATE_DEPLOY_RETRY.jitter).toBe(true);
  });

  it("the actual worst-case backoff driven through withRetry stays under the IAM-token window", async () => {
    // Behaviour test (not constant arithmetic): exhaust every attempt against a
    // persistent advisory-lock failure and sum the real delays withRetry passes
    // to sleep(). random()→~1 makes equal-jitter pick the full (worst-case)
    // delay each time, so this exercises the true backoffMs+cap+jitter path.
    const observedDelays: number[] = [];
    const recordingSleep = (ms: number) => {
      observedDelays.push(ms);
      return Promise.resolve();
    };
    const orig = deployError(ADVISORY_LOCK_STDERR);
    const fn = vi.fn().mockRejectedValue(orig);

    await expect(
      withRetry(fn, isTransientMigrateDeployError, {
        ...MIGRATE_DEPLOY_RETRY,
        sleep: recordingSleep,
        random: () => 0.999_999,
      })
    ).rejects.toBe(orig);

    // withRetry sleeps between attempts only → attempts - 1 delays.
    expect(observedDelays).toHaveLength(MIGRATE_DEPLOY_RETRY.attempts - 1);
    const actualSleepMs = observedDelays.reduce((sum, ms) => sum + ms, 0);
    // Each attempt itself can block up to Prisma's fixed 10s advisory-lock
    // acquire timeout; total must stay well under the 15-minute (900s) RDS
    // IAM-token validity window (retries reuse the same IAM-signed URL).
    const lockWaitMs = MIGRATE_DEPLOY_RETRY.attempts * 10_000;
    expect(actualSleepMs + lockWaitMs).toBeLessThan(15 * 60 * 1000);
  });

  it("retries an advisory-lock P1002 then succeeds (deploy seam)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(deployError(ADVISORY_LOCK_STDERR))
      .mockResolvedValueOnce(undefined);

    await withRetry(fn, isTransientMigrateDeployError, {
      ...MIGRATE_DEPLOY_RETRY,
      sleep: noopSleep,
      random: () => 0.5,
    });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("exhausts on a persistent advisory-lock P1002 and rethrows the original error", async () => {
    const orig = deployError(ADVISORY_LOCK_STDERR);
    const fn = vi.fn().mockRejectedValue(orig);

    let thrown: unknown;
    try {
      await withRetry(fn, isTransientMigrateDeployError, {
        ...MIGRATE_DEPLOY_RETRY,
        sleep: noopSleep,
        random: () => 0.5,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(orig);
    expect(fn).toHaveBeenCalledTimes(MIGRATE_DEPLOY_RETRY.attempts);
  });

  it("does NOT retry a bare P1002 (no advisory-lock context) — one attempt, rethrown", async () => {
    const orig = deployError(BARE_P1002_STDERR);
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(orig);

    let thrown: unknown;
    try {
      await withRetry(fn, isTransientMigrateDeployError, {
        ...MIGRATE_DEPLOY_RETRY,
        sleep: sleepFn,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(orig);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });
});
