import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PrismaMigrateDeployErrorCode,
  recoverMigrateDeployFailure,
} from "../scripts/migrate-deploy-recovery";
import { backoffMs } from "../scripts/migrate-retry";
import { MigrateResetKind } from "../scripts/migrate-telemetry";
import { makeDeployError } from "./test-helpers/deploy-error";

/*
 * The reset-kind precedence on the preview-reset path, split from
 * migrate-deploy-recovery.test.ts (963 lines, at the file-size ceiling).
 *
 * A preview reset can be triggered by P3005, P3009, or P3018, and the code
 * resolves them in that priority order in TWO places: the telemetry callback
 * and the logged label. They are separate `if` chains over the same flags, so
 * they can drift — the existing suite only ever exercised the P3005 fall-through,
 * leaving both P3009 and P3018 arms unexecuted in both chains.
 *
 * The reset itself is not in question here (the sibling suite covers it); what
 * these pin is that the reported kind matches the reason.
 */

const DATABASE_URL = "postgresql://app:password@localhost:5432/db";
const PREVIEW_SCHEMA = "preview_iss_5293";
const BRANCH = "iss-5293";
// SQLSTATE class 08 (connection_failure) — the transient pg shape
// `isTransientConnectionError` retries on, same fixture as the sibling suite.
const TRANSIENT_SQLSTATE_CONNECTION_FAILURE = "08006";

function createDeps() {
  const resetKinds: MigrateResetKind[] = [];
  return {
    resetKinds,
    deps: {
      onResetKind: vi.fn((kind: MigrateResetKind) => {
        resetKinds.push(kind);
      }),
      prestampSkippableMigrations: vi.fn(() => Promise.resolve()),
      resetSchema: vi.fn(() => Promise.resolve()),
      resolveFailedMigration: vi.fn(() => Promise.resolve()),
      runMigrateDeploy: vi.fn(() => Promise.resolve()),
      upsertSchemaRegistry: vi.fn(() => Promise.resolve()),
    },
  };
}

function recover(
  stderr: string,
  deps: ReturnType<typeof createDeps>["deps"],
  schema = PREVIEW_SCHEMA
) {
  return recoverMigrateDeployFailure(
    {
      branch: BRANCH,
      databaseUrl: DATABASE_URL,
      error: makeDeployError({ stderr }),
      schema,
    },
    deps as unknown as Parameters<typeof recoverMigrateDeployFailure>[1]
  );
}

describe("preview reset — reported kind matches the reason", () => {
  it("reports p3009 for a failed migration", async () => {
    const { deps, resetKinds } = createDeps();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await recover(
      `Error: ${PrismaMigrateDeployErrorCode.FailedMigration}`,
      deps
    );

    expect(resetKinds).toEqual([MigrateResetKind.P3009]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        `hit ${PrismaMigrateDeployErrorCode.FailedMigration},`
      )
    );
    expect(deps.resetSchema).toHaveBeenCalled();
    log.mockRestore();
  });

  it("reports p3018 for a migration that failed to apply", async () => {
    const { deps, resetKinds } = createDeps();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await recover(
      `Error: ${PrismaMigrateDeployErrorCode.MigrationFailedToApply}`,
      deps
    );

    expect(resetKinds).toEqual([MigrateResetKind.P3018]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        `hit ${PrismaMigrateDeployErrorCode.MigrationFailedToApply},`
      )
    );
    log.mockRestore();
  });

  it("reports p3005 for a non-empty schema", async () => {
    const { deps, resetKinds } = createDeps();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await recover(
      `Error: ${PrismaMigrateDeployErrorCode.NonEmptySchema}`,
      deps
    );

    expect(resetKinds).toEqual([MigrateResetKind.P3005]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        `hit ${PrismaMigrateDeployErrorCode.NonEmptySchema},`
      )
    );
    log.mockRestore();
  });

  it("prefers p3009 when P3009 and P3018 both appear", async () => {
    // Prisma's output can carry both. The telemetry chain and the log label
    // must agree on which one wins, or the metric disagrees with the log line
    // describing the same reset.
    const { deps, resetKinds } = createDeps();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await recover(
      `Error: ${PrismaMigrateDeployErrorCode.MigrationFailedToApply}\nError: ${PrismaMigrateDeployErrorCode.FailedMigration}`,
      deps
    );

    expect(resetKinds).toEqual([MigrateResetKind.P3009]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        `hit ${PrismaMigrateDeployErrorCode.FailedMigration},`
      )
    );
    log.mockRestore();
  });

  it("prefers p3009 over p3005", async () => {
    const { deps, resetKinds } = createDeps();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await recover(
      `Error: ${PrismaMigrateDeployErrorCode.NonEmptySchema}\nError: ${PrismaMigrateDeployErrorCode.FailedMigration}`,
      deps
    );

    expect(resetKinds).toEqual([MigrateResetKind.P3009]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        `hit ${PrismaMigrateDeployErrorCode.FailedMigration},`
      )
    );
    log.mockRestore();
  });

  it("prefers p3018 over p3005", async () => {
    // The middle rung of the P3009 > P3018 > P3005 order. Without it, both
    // reporting chains could demote P3018 below P3005 — every other case here
    // has P3009 present or exactly one code set, so none of them would notice.
    const { deps, resetKinds } = createDeps();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await recover(
      `Error: ${PrismaMigrateDeployErrorCode.NonEmptySchema}\nError: ${PrismaMigrateDeployErrorCode.MigrationFailedToApply}`,
      deps
    );

    expect(resetKinds).toEqual([MigrateResetKind.P3018]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        `hit ${PrismaMigrateDeployErrorCode.MigrationFailedToApply},`
      )
    );
    log.mockRestore();
  });
});

describe("preview reset — telemetry is best effort", () => {
  it("still resets when the telemetry callback throws", async () => {
    // The callback is wrapped precisely so a telemetry bug can never abort a
    // recovery that is otherwise about to succeed.
    const { deps } = createDeps();
    deps.onResetKind = vi.fn(() => {
      throw new Error("metrics sink down");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      recover(`Error: ${PrismaMigrateDeployErrorCode.FailedMigration}`, deps)
    ).resolves.not.toThrow();

    expect(deps.resetSchema).toHaveBeenCalled();
    log.mockRestore();
  });

  it("resets without a telemetry callback at all", async () => {
    const { deps } = createDeps();
    const withoutCallback = { ...deps, onResetKind: undefined };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await recover(
      `Error: ${PrismaMigrateDeployErrorCode.FailedMigration}`,
      withoutCallback as unknown as typeof deps
    );

    expect(deps.resetSchema).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("registry re-upsert after reset", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits out the default backoff before retrying when no test sleep is injected", async () => {
    // `registryRetrySleep` is a test seam. With it absent, the retry must still
    // wait on withRetry's own timer-backed backoff — a no-op sleep would let
    // the recovery hammer a database that is still down. The sibling suite
    // covers the injected-seam path; this is the production shape, where the
    // seam is never provided.
    const { deps } = createDeps();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const transientError = Object.assign(new Error("connection failed"), {
      code: TRANSIENT_SQLSTATE_CONNECTION_FAILURE,
    });
    deps.upsertSchemaRegistry = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(transientError))
      .mockImplementation(() => Promise.resolve());
    vi.useFakeTimers();

    const pending = recover(
      `Error: ${PrismaMigrateDeployErrorCode.FailedMigration}`,
      deps
    );

    const backoff = backoffMs(1);
    await vi.advanceTimersByTimeAsync(backoff - 1);
    expect(deps.upsertSchemaRegistry).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(true);

    expect(deps.upsertSchemaRegistry).toHaveBeenCalledTimes(2);
    expect(deps.upsertSchemaRegistry).toHaveBeenLastCalledWith(
      DATABASE_URL,
      PREVIEW_SCHEMA,
      BRANCH
    );
    log.mockRestore();
  });
});
