import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const recoverMigrateDeployFailureMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("./migrate-deploy-recovery", () => ({
  recoverMigrateDeployFailure: recoverMigrateDeployFailureMock,
}));

const { PRISMA_CLI_ENTRY_ENV, runMigrateWithRetry } = await import(
  "./migration-pipeline"
);

/*
 * The two `prisma` CLI wrappers inside migration-pipeline.ts -- the migrate
 * itself and the rolled-back recovery. Both are module-private, so they are
 * driven through the exported `runMigrateWithRetry`, with `spawnSync` stubbed.
 *
 * `recoverMigrateDeployFailure` is stubbed to capture the collaborator bag it
 * is handed. That serves two purposes: it lets `resolveFailedMigration` be
 * called directly without first satisfying the whole recovery decision tree,
 * and it asserts the production wiring -- that the real helper is the one
 * passed into recovery, so deleting that wiring fails a test.
 */

// Kept at a bare placeholder domain with a placeholder password. The
// credential audit in scripts/seed/__tests__/unit/credential-audit.test.ts
// scans scripts/*.ts and reads a user:secret pair as a raw address; its
// exclusion list matches the placeholder domain exactly, not subdomains of it,
// so a host prefix here would fail that gate.
const DATABASE_URL = "postgresql://user:placeholder@example.com:5432/cl";
const SCHEMA = "public";
const MIGRATION = "20260101000000_add_widget";

type SpawnResult = {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
};

/**
 * A child process that produces `result`, close enough to Node's for the
 * drain contract to be real: `close` is emitted only AFTER both stdio streams
 * have ended and been consumed, which is the ordering the production code
 * depends on to not lose output. A fake that closed first would let a
 * dropped-output regression pass.
 */
function spawnReturns(result: SpawnResult) {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();

    let drained = 0;
    const settle = () => {
      drained += 1;
      if (drained < 2) {
        return;
      }
      if (result.error) {
        child.emit("error", result.error);
      }
      // `in`, not `??` -- an explicit `status: null` is the case under test (a
      // process killed by a signal reports no exit code) and must not collapse
      // to 0.
      child.emit("close", "status" in result ? result.status : 0);
    };
    child.stdout.on("end", settle);
    child.stderr.on("end", settle);

    // After the production code has attached its own listeners.
    setImmediate(() => {
      child.stdout.end(result.stdout ?? "");
      child.stderr.end(result.stderr ?? "");
    });

    return child;
  });
}

function firstRecoveryCall() {
  const call = recoverMigrateDeployFailureMock.mock.calls[0];
  if (!call) {
    throw new Error(
      "recovery was never invoked — the migrate under test did not fail"
    );
  }
  return call;
}

/** The collaborator bag `runMigrateWithRetry` hands to recovery. */
function capturedRecoveryDeps() {
  return firstRecoveryCall()[1] as {
    resolveFailedMigration: (url: string, name: string) => Promise<void>;
  };
}

/** The error `runMigrateDeploy` threw, as seen by recovery. */
function capturedMigrateError(): Error & {
  stdout?: string;
  stderr?: string;
} {
  return firstRecoveryCall()[0].error;
}

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  spawnMock.mockReset();
  recoverMigrateDeployFailureMock.mockReset();
  recoverMigrateDeployFailureMock.mockResolvedValue(false);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runMigrateDeploy — invocation", () => {
  it("runs prisma migrate deploy against the URL it was given", async () => {
    spawnReturns({ status: 0 });

    await runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined);

    expect(spawnMock).toHaveBeenCalledWith(
      "prisma",
      ["migrate", "deploy"],
      expect.objectContaining({
        env: expect.objectContaining({ DATABASE_URL }),
      })
    );
  });

  it("reports no recovery was needed on success", async () => {
    spawnReturns({ status: 0 });

    await expect(
      runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined)
    ).resolves.toBe(false);
    expect(recoverMigrateDeployFailureMock).not.toHaveBeenCalled();
  });
});

describe("runMigrateDeploy — output forwarding", () => {
  it("forwards prisma's stdout and stderr to the build log", async () => {
    spawnReturns({
      status: 0,
      stdout: "1 migration applied\n",
      stderr: "warning: slow\n",
    });

    await runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined);

    expect(stdoutSpy).toHaveBeenCalledWith("1 migration applied\n");
    expect(stderrSpy).toHaveBeenCalledWith("warning: slow\n");
  });

  it("writes nothing when prisma produced no output", async () => {
    // Empty strings are falsy here, so neither stream is touched -- a blank
    // line in the build log would be noise.
    spawnReturns({ status: 0, stdout: "", stderr: "" });

    await runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined);

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe("runMigrateDeploy — failure", () => {
  it("fails on a non-zero exit code and names it", async () => {
    spawnReturns({ status: 1, stderr: "migration failed\n" });

    await runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined);

    expect(capturedMigrateError().message).toContain("exit code 1");
    // A non-transient failure must not burn the retry budget.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("says the exit code is unknown rather than printing null", async () => {
    spawnReturns({ status: null });

    await runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined);

    expect(capturedMigrateError().message).toContain("exit code unknown");
  });

  it("propagates the spawn error itself when the process never started", async () => {
    // e.g. prisma is not on PATH. The original error carries the errno and
    // syscall, so it must not be replaced with a generic exit-code message.
    const spawnError = new Error("spawn prisma ENOENT");
    spawnReturns({ status: null, error: spawnError });

    await runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined);

    expect(capturedMigrateError()).toBe(spawnError);
  });

  it("attaches prisma's output to the error for the recovery classifier", async () => {
    // Recovery reads stdout/stderr off the error to tell P3009 from P3018 from
    // a committed-DDL artifact; losing them would blind it.
    spawnReturns({
      status: 1,
      stdout: "Applying migration...\n",
      stderr: "Error: P3009\n",
    });

    await runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined);

    const error = capturedMigrateError();
    expect(error.stdout).toBe("Applying migration...\n");
    expect(error.stderr).toBe("Error: P3009\n");
  });

  it("attaches empty strings rather than undefined when prisma wrote nothing", async () => {
    spawnReturns({ status: 1 });

    await runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined);

    const error = capturedMigrateError();
    expect(error.stdout).toBe("");
    expect(error.stderr).toBe("");
  });
});

describe("resolveFailedMigration", () => {
  let resolveFailedMigration: (url: string, name: string) => Promise<void>;

  beforeEach(async () => {
    // Fail a migrate so recovery is invoked, which is the only way to get hold
    // of the private helper -- and proves it is the one actually wired in.
    spawnReturns({ status: 1 });
    await runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined);
    resolveFailedMigration = capturedRecoveryDeps().resolveFailedMigration;
    spawnMock.mockClear();
  });

  it("is the helper wired into recovery", () => {
    expect(resolveFailedMigration).toBeTypeOf("function");
  });

  it("marks the migration rolled-back through the prisma CLI", async () => {
    spawnReturns({ status: 0, stdout: "rolled back\n" });
    await resolveFailedMigration(DATABASE_URL, MIGRATION);

    expect(spawnMock).toHaveBeenCalledWith(
      "prisma",
      ["migrate", "resolve", "--rolled-back", MIGRATION],
      expect.objectContaining({
        env: expect.objectContaining({ DATABASE_URL }),
      })
    );
    expect(stdoutSpy).toHaveBeenCalledWith("rolled back\n");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(MIGRATION));
  });

  /*
   * These used to be asserted as SYNCHRONOUS throws, with a note calling that
   * "a sharp edge in the signature, not a live defect": the helper declared
   * `Promise<void>` but threw before returning one, so `.rejects` never saw it
   * and a caller using `.catch()` rather than `await` was unprotected.
   *
   * ISS-6403 Finding 4 removed the edge rather than documenting it again. The
   * helper is now genuinely `async`, so the failure arrives as a rejection and
   * the signature finally tells the truth. The expectation changed because the
   * BEHAVIOR changed; what is being asserted -- that a failed
   * `prisma migrate resolve` is never reported as success -- is untouched.
   */

  it("REFUSES to report success when prisma migrate resolve fails", async () => {
    // Swallowing this would let the pipeline retry the deploy against a
    // migration that is still recorded as failed, looping instead of stopping.
    spawnReturns({ status: 1, stderr: "P3012 not in a failed state" });
    await expect(
      resolveFailedMigration(DATABASE_URL, MIGRATION)
    ).rejects.toThrow("P3012 not in a failed state");
  });

  it("falls back to the spawn error message when prisma wrote no stderr", async () => {
    spawnReturns({
      status: null,
      stderr: "",
      error: new Error("spawn prisma ENOENT"),
    });
    await expect(
      resolveFailedMigration(DATABASE_URL, MIGRATION)
    ).rejects.toThrow("spawn prisma ENOENT");
  });

  it("names the migration in the failure so an operator knows which one", async () => {
    spawnReturns({ status: 1, stderr: "boom" });
    await expect(
      resolveFailedMigration(DATABASE_URL, MIGRATION)
    ).rejects.toThrow(MIGRATION);
  });
});

/*
 * ISS-6403. A deployed serverless bundle has no `prisma` on PATH it can
 * actually execute, so a caller that has located the CLI inside its own bundle
 * names the entrypoint through PRISMA_CLI_ENTRY and the spawn runs it under the
 * current `node`.
 *
 * BOTH CLI spawns are asserted, not just the migrate. They were separate
 * `spawnSync("prisma", …)` literals before this change, and a fix that routed
 * only the migrate through the entrypoint would leave the rolled-back recovery
 * unable to run in the exact environment where recovery is needed — the failure
 * that strands `_prisma_migrations` mid-migration.
 */
describe("prisma CLI invocation — PRISMA_CLI_ENTRY", () => {
  const CLI_ENTRY = "/var/task/node_modules/.pnpm/prisma@7.8.0/build/index.js";
  let previousEntry: string | undefined;

  beforeEach(() => {
    previousEntry = process.env[PRISMA_CLI_ENTRY_ENV];
  });

  afterEach(() => {
    if (previousEntry === undefined) {
      Reflect.deleteProperty(process.env, PRISMA_CLI_ENTRY_ENV);
      return;
    }
    process.env[PRISMA_CLI_ENTRY_ENV] = previousEntry;
  });

  it("runs migrate deploy as an entrypoint under the current node", async () => {
    process.env[PRISMA_CLI_ENTRY_ENV] = CLI_ENTRY;
    spawnReturns({ status: 0 });

    await runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined);

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [CLI_ENTRY, "migrate", "deploy"],
      expect.objectContaining({
        env: expect.objectContaining({ DATABASE_URL }),
      })
    );
  });

  it("runs the rolled-back recovery through the same entrypoint", async () => {
    process.env[PRISMA_CLI_ENTRY_ENV] = CLI_ENTRY;
    spawnReturns({ status: 1 });
    await runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined);
    const { resolveFailedMigration } = capturedRecoveryDeps();
    spawnMock.mockClear();
    spawnReturns({ status: 0 });

    await resolveFailedMigration(DATABASE_URL, MIGRATION);

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [CLI_ENTRY, "migrate", "resolve", "--rolled-back", MIGRATION],
      expect.objectContaining({
        env: expect.objectContaining({ DATABASE_URL }),
      })
    );
  });

  it("keeps resolving through PATH when the entrypoint is empty", async () => {
    // The build's path. An empty value is what a misconfigured env yields, and
    // it has to read as "unset" rather than spawning `node ""`.
    process.env[PRISMA_CLI_ENTRY_ENV] = "";
    spawnReturns({ status: 0 });

    await runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined);

    expect(spawnMock).toHaveBeenCalledWith(
      "prisma",
      ["migrate", "deploy"],
      expect.objectContaining({
        env: expect.objectContaining({ DATABASE_URL }),
      })
    );
  });
});

/*
 * ISS-6403 Finding 5. The caller used to `process.chdir()` into the Prisma
 * config directory, which moved the cwd of the entire api process — every
 * concurrent and subsequent request on that warm Fluid Compute instance, for
 * its whole life. Only the spawned CHILD needs to be there, so the directory
 * travels as the child's `cwd`.
 *
 * It arrives as a PER-INVOCATION option, not a `PRISMA_CLI_CWD` env var
 * (review: shafty023). An env var is the same process-global reach one
 * indirection later: this pipeline is shared by every build and migrator
 * caller, so a stale inherited value would silently run Prisma from the wrong
 * config directory. The last case below is what makes that a behavior rather
 * than a comment.
 *
 * BOTH spawns are asserted for the same reason the entrypoint is: a recovery
 * that cannot find the config in the environment where recovery is needed
 * strands `_prisma_migrations` mid-migration. They are separate call sites, so
 * binding the option into only one is a live failure mode.
 */
describe("prisma CLI invocation — per-invocation cwd", () => {
  const CONFIG_DIR = "/var/task/packages/database/prisma-runtime";

  it("spawns migrate deploy in the config directory it was handed", async () => {
    spawnReturns({ status: 0 });

    await runMigrateWithRetry(
      DATABASE_URL,
      SCHEMA,
      undefined,
      undefined,
      {},
      {
        cwd: CONFIG_DIR,
      }
    );

    expect(spawnMock).toHaveBeenCalledWith(
      "prisma",
      ["migrate", "deploy"],
      expect.objectContaining({ cwd: CONFIG_DIR })
    );
  });

  it("spawns the rolled-back recovery in that same directory", async () => {
    spawnReturns({ status: 1 });
    await runMigrateWithRetry(
      DATABASE_URL,
      SCHEMA,
      undefined,
      undefined,
      {},
      {
        cwd: CONFIG_DIR,
      }
    );
    const { resolveFailedMigration } = capturedRecoveryDeps();
    spawnMock.mockClear();
    spawnReturns({ status: 0 });

    await resolveFailedMigration(DATABASE_URL, MIGRATION);

    expect(spawnMock).toHaveBeenCalledWith(
      "prisma",
      ["migrate", "resolve", "--rolled-back", MIGRATION],
      expect.objectContaining({ cwd: CONFIG_DIR })
    );
  });

  it("inherits this process's cwd when the caller names none", async () => {
    // The build's path: its cwd is already `packages/database`, so naming one
    // would be wrong. `undefined` is what `spawn` reads as "inherit".
    spawnReturns({ status: 0 });

    await runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined);

    expect(spawnMock).toHaveBeenCalledWith(
      "prisma",
      ["migrate", "deploy"],
      expect.objectContaining({ cwd: undefined })
    );
  });

  it("treats a blank directory as unset", async () => {
    spawnReturns({ status: 0 });

    await runMigrateWithRetry(
      DATABASE_URL,
      SCHEMA,
      undefined,
      undefined,
      {},
      {
        cwd: "   ",
      }
    );

    expect(spawnMock).toHaveBeenCalledWith(
      "prisma",
      ["migrate", "deploy"],
      expect.objectContaining({ cwd: undefined })
    );
  });

  it("REFUSES to read the cwd off the process environment", async () => {
    // The defeat path for the whole change: reintroducing a `PRISMA_CLI_CWD`
    // read would make every case above still pass while restoring exactly the
    // cross-caller leakage the option exists to remove. A caller that named no
    // cwd must get none, whatever the environment says.
    vi.stubEnv("PRISMA_CLI_CWD", "/var/task/some/other/config");
    spawnReturns({ status: 0 });

    await runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined);

    expect(spawnMock).toHaveBeenCalledWith(
      "prisma",
      ["migrate", "deploy"],
      expect.objectContaining({ cwd: undefined })
    );
    vi.unstubAllEnvs();
  });
});

/*
 * ISS-6781. `NODE_PATH` (ISS-6728) resolves the bundled CLI's CommonJS
 * `require`s; its config loader then `import`s ES modules, which node resolves
 * without `NODE_PATH`. The ensure caller hands the pipeline a resolver module to
 * preload with node's `--import`, and it travels the same per-invocation seam
 * as `cwd` — into the spawn's ARGUMENTS, before the entrypoint, never into
 * `NODE_OPTIONS`, which every child of this process would inherit.
 *
 * BOTH spawns again: a recovery that cannot load its config in the environment
 * where recovery is needed strands `_prisma_migrations` mid-migration.
 */
describe("prisma CLI invocation — per-invocation ESM resolver preload", () => {
  const CLI_ENTRY = "/var/task/node_modules/.pnpm/prisma@7.8.0/build/index.js";
  const PRELOAD =
    "/var/task/packages/database/prisma-runtime/esm-store-resolver.mjs";
  const PRELOAD_URL =
    "file:///var/task/packages/database/prisma-runtime/esm-store-resolver.mjs";
  let previousEntry: string | undefined;

  beforeEach(() => {
    previousEntry = process.env[PRISMA_CLI_ENTRY_ENV];
    process.env[PRISMA_CLI_ENTRY_ENV] = CLI_ENTRY;
  });

  afterEach(() => {
    if (previousEntry === undefined) {
      Reflect.deleteProperty(process.env, PRISMA_CLI_ENTRY_ENV);
      return;
    }
    process.env[PRISMA_CLI_ENTRY_ENV] = previousEntry;
  });

  it("preloads the resolver into migrate deploy, as a file URL before the entrypoint", async () => {
    // The preload is an ARGUMENT of this spawn, never an env-wide `NODE_OPTIONS`
    // that every other child of this process would inherit. The required test
    // jobs run under a `NODE_OPTIONS` of their own (heap ceilings, dd-trace),
    // so an inherited value is SEEDED and asserted to reach the child unchanged
    // — asserting absence would go red there, and asserting "equal to the
    // parent's" proves nothing when both are unset (review: wongk).
    const inherited = "--max-old-space-size=4096";
    vi.stubEnv("NODE_OPTIONS", inherited);
    spawnReturns({ status: 0 });

    try {
      await runMigrateWithRetry(
        DATABASE_URL,
        SCHEMA,
        undefined,
        undefined,
        {},
        {
          preload: PRELOAD,
        }
      );
    } finally {
      vi.unstubAllEnvs();
    }

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ["--import", PRELOAD_URL, CLI_ENTRY, "migrate", "deploy"],
      expect.objectContaining({
        env: expect.objectContaining({ NODE_OPTIONS: inherited }),
      })
    );
  });

  it("preloads it into the rolled-back recovery too", async () => {
    spawnReturns({ status: 1 });
    await runMigrateWithRetry(
      DATABASE_URL,
      SCHEMA,
      undefined,
      undefined,
      {},
      {
        preload: PRELOAD,
      }
    );
    const { resolveFailedMigration } = capturedRecoveryDeps();
    spawnMock.mockClear();
    spawnReturns({ status: 0 });

    await resolveFailedMigration(DATABASE_URL, MIGRATION);

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [
        "--import",
        PRELOAD_URL,
        CLI_ENTRY,
        "migrate",
        "resolve",
        "--rolled-back",
        MIGRATION,
      ],
      expect.anything()
    );
  });

  it("spawns the bare entrypoint when no preload is named, or a blank one", async () => {
    spawnReturns({ status: 0 });

    await runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined);
    await runMigrateWithRetry(
      DATABASE_URL,
      SCHEMA,
      undefined,
      undefined,
      {},
      {
        preload: "  ",
      }
    );

    expect(spawnMock).toHaveBeenCalledTimes(2);
    for (const call of spawnMock.mock.calls) {
      expect(call[0]).toBe(process.execPath);
      expect(call[1]).toEqual([CLI_ENTRY, "migrate", "deploy"]);
    }
  });

  it("does not pass node flags to a PATH `prisma`, which cannot take them", async () => {
    // The build's path. pnpm's shim execs its own `node`; a `--import` in front
    // of `migrate` would reach the CLI as a command it does not have.
    Reflect.deleteProperty(process.env, PRISMA_CLI_ENTRY_ENV);
    spawnReturns({ status: 0 });

    await runMigrateWithRetry(
      DATABASE_URL,
      SCHEMA,
      undefined,
      undefined,
      {},
      {
        preload: PRELOAD,
      }
    );

    expect(spawnMock).toHaveBeenCalledWith(
      "prisma",
      ["migrate", "deploy"],
      expect.anything()
    );
  });
});

/*
 * ISS-6403, review: shafty023. `spawnSync` bounded its captured output with
 * `maxBuffer` and killed the child past it. The async drain that replaced it
 * accumulated into JS strings with no bound, so a verbose or runaway migration
 * could grow the SHARED api process heap until unrelated requests went down —
 * and overlapping ensure requests multiply it.
 */
describe("prisma CLI invocation — output ceiling", () => {
  /** Streams `total` characters in chunks, then ends without a status. */
  function spawnFloods(total: number) {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      // A real kill ends the stream, which is what lets `close` fire; a fake
      // that ignored it would let a missing `child.kill()` still pass.
      child.kill = vi.fn(() => {
        child.stdout.end();
        child.stderr.end();
      });

      let drained = 0;
      const settle = () => {
        drained += 1;
        if (drained === 2) {
          child.emit("close", 0);
        }
      };
      child.stdout.on("end", settle);
      child.stderr.on("end", settle);

      setImmediate(() => {
        const chunk = "x".repeat(100_000);
        for (let written = 0; written < total; written += chunk.length) {
          if (child.stdout.writableEnded) {
            break;
          }
          child.stdout.write(chunk);
        }
        if (!child.stdout.writableEnded) {
          child.stdout.end();
        }
        if (!child.stderr.writableEnded) {
          child.stderr.end();
        }
      });

      return child;
    });
  }

  it("terminates the child and fails when output blows past the ceiling", async () => {
    spawnFloods(3_000_000);

    await runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined);

    const error = capturedMigrateError();
    expect(error.message).toContain("terminated");
    expect(spawnMock.mock.results[0]?.value.kill).toHaveBeenCalled();
  });

  it("keeps a BOUNDED diagnostic rather than discarding the output", async () => {
    // The point of capturing this text is that recovery classifies P3009/P3018
    // off it and the sanitizer exists to let an operator read it. Truncating to
    // nothing would trade one failure mode for a blinder one.
    spawnFloods(3_000_000);

    await runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined);

    const error = capturedMigrateError();
    expect(error.stdout?.length).toBeGreaterThan(0);
    // 1M ceiling plus the truncation marker, and nowhere near the 3M streamed.
    expect(error.stdout?.length).toBeLessThan(1_100_000);
    expect(error.stdout).toContain("output truncated");
  });

  it("leaves output under the ceiling completely untouched", async () => {
    // The other half: the ceiling must not truncate an ordinary migration.
    spawnReturns({ status: 0, stdout: "1 migration applied\n" });

    await expect(
      runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined)
    ).resolves.toBe(false);
    expect(stdoutSpy).toHaveBeenCalledWith("1 migration applied\n");
  });
});

/*
 * ISS-6403 Finding 4. `spawnSync` blocked the Node event loop for the child's
 * entire lifetime. Harmless in the build script this was written for; in
 * `apps/api` it froze every other request Fluid Compute had multiplexed onto
 * the instance for the length of a `migrate deploy`.
 */
describe("prisma CLI invocation — non-blocking spawn", () => {
  it("drives the CLI through async spawn, never spawnSync", async () => {
    // `node:child_process` is mocked with ONLY `spawn`. A regression to
    // `spawnSync` therefore cannot pass as a timing difference -- it throws
    // "spawnSync is not a function" and this file goes red, which is the
    // assertion a wall-clock measurement could never make deterministically.
    spawnReturns({ status: 0 });

    await runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined);

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("reassembles output split across several stream chunks", async () => {
    // `spawnSync` handed back one finished buffer; async spawn delivers N
    // `data` events, so joining them is new work this change introduced and
    // the one place a real migration's multi-line output could be truncated.
    // Recovery classifies P3009/P3018 off this text, so a lost chunk is a
    // misclassified failure.
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      let drained = 0;
      const settle = () => {
        drained += 1;
        if (drained === 2) {
          child.emit("close", 1);
        }
      };
      child.stdout.on("end", settle);
      child.stderr.on("end", settle);
      setImmediate(() => {
        child.stdout.write("Applying migration ");
        child.stdout.end("20260101_add\n");
        child.stderr.write("Error: ");
        child.stderr.end("P3009\n");
      });
      return child;
    });

    await runMigrateWithRetry(DATABASE_URL, SCHEMA, undefined);

    const error = capturedMigrateError();
    expect(error.stdout).toBe("Applying migration 20260101_add\n");
    expect(error.stderr).toBe("Error: P3009\n");
  });
});
