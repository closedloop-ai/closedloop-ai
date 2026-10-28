import { afterEach, describe, expect, it, vi } from "vitest";
import { CloneFailedError } from "../scripts/clone-schema";
import { defaultApplyToSchema } from "../scripts/migrate-all-previews";
import { PreviewResetMode } from "../scripts/migrate-deploy-recovery";
import {
  MigrateExecutor,
  MigrateGateOutcome,
} from "../scripts/migrate-telemetry";
import { SerializeLockContendedError } from "../scripts/migration-lock";
import {
  applyMigrationsToSchema,
  type MigrationPipelineDeps,
  runMigrationPipeline,
} from "../scripts/migration-pipeline";
import { previewBuildLockKey } from "../scripts/preview-clone-first";
import {
  type VibeEnvironmentMarker,
  VibeEnvironmentMode,
  VibeEnvironmentState,
} from "../scripts/vibe-environment";

/*
 * ISS-11785: the ORDER an empty preview schema is built in. Every collaborator is
 * injected and appends to one step log, so each case asserts the whole sequence:
 * a step that moved, vanished or ran twice changes the log.
 */

const URL = "postgres://x";
const PREVIEW_SCHEMA = "preview_feat_iss_11785_abc12345";
const BRANCH = "feat/iss-11785";
const MERGE_QUEUE_REF = "gh-readonly-queue/main/pr-4444-abc1234";
const CLONE_FAILED_RE =
  /The data clone from public into preview_feat_iss_11785_abc12345 failed/;
const MIGRATION_FAILED_RE = /ISS-11212: 1 comments rows match no body_format/;
const DROP_FAILED_RE = /Could not drop .*: permission denied/;
const REPLAY_INCOMPLETE_RE =
  /the replay of public's migrations did not complete/;
const GATE_NOT_HELD_RE = /the serialize gate was not held/;

function makeDeps(opts: {
  isNew: boolean;
  replayed?: boolean;
  cloneOk?: boolean;
  atHead?: boolean;
  reset?: boolean;
  vibeMarker?: VibeEnvironmentMarker | null;
}) {
  const steps: string[] = [];
  const deps = {
    ensureSchemaExists: vi.fn(() => Promise.resolve(opts.isNew)),
    upsertSchemaRegistry: vi.fn(() => Promise.resolve()),
    probePreviewSchemaAtHead: vi.fn(() => {
      steps.push("probe");
      return Promise.resolve(opts.atHead ?? false);
    }),
    withMigrationSerializeLock: vi.fn(
      (
        gate: {
          lockKey?: number;
          onOutcome?: (outcome: MigrateGateOutcome, waitMs: number) => void;
        },
        fn: () => Promise<boolean>
      ) => {
        gate.onOutcome?.(MigrateGateOutcome.Acquired, 1);
        return fn();
      }
    ),
    prestampSkippableMigrationsViaSql: vi.fn(() => Promise.resolve()),
    replayPendingMigrationsViaSql: vi.fn(() => {
      steps.push("replay");
      return Promise.resolve(opts.replayed ?? true);
    }),
    plainBuildPreviewConcurrentIndexes: vi.fn(() => Promise.resolve()),
    sweepInvalidIndexes: vi.fn(() => Promise.resolve([])),
    runMigrate: vi.fn(
      (
        _url: string,
        _schema: string | null,
        _branch: string | undefined,
        _hooks?: unknown,
        _cli?: unknown,
        previewReset?: PreviewResetMode
      ) => {
        steps.push(`migrate:${previewReset ?? "default"}`);
        return Promise.resolve(opts.reset ?? false);
      }
    ),
    cloneDataFromPublic: vi.fn((_url: string, schema: string) => {
      steps.push("clone");
      return opts.cloneOk === false
        ? Promise.reject(
            new CloneFailedError(schema, new Error("clone failed"))
          )
        : Promise.resolve();
    }),
    dropSchema: vi.fn(() => {
      steps.push("drop");
      return Promise.resolve();
    }),
    runPreviewSeed: vi.fn(),
    readVibeEnvironmentMarker: vi.fn(
      (): Promise<VibeEnvironmentMarker | null> =>
        Promise.resolve(opts.vibeMarker ?? null)
    ),
    writeVibeEnvironmentMarker: vi.fn(
      (_url: string, _schema: string, marker: VibeEnvironmentMarker) => {
        steps.push(`mark:${marker.mode}:${marker.state}`);
        return Promise.resolve();
      }
    ),
    withRetry: vi.fn((fn: () => Promise<void>) => fn()),
    assertMigrateRoleOwnsSchema: vi.fn(() => Promise.resolve()),
    readIncompletePreviewBuild: vi.fn(() => Promise.resolve(false)),
    clearIncompletePreviewBuild: vi.fn(() => Promise.resolve()),
  } satisfies MigrationPipelineDeps;
  return { deps, steps };
}

function apply(
  deps: MigrationPipelineDeps,
  isNew: boolean,
  branch: string = BRANCH
) {
  return applyMigrationsToSchema(URL, PREVIEW_SCHEMA, branch, { isNew }, deps);
}

describe("an empty preview schema is built around a clone of public (ISS-11785)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replays public's migrations, clones, then migrates the rest with no reset", async () => {
    const { deps, steps } = makeDeps({ isNew: true });
    await apply(deps, true);

    expect(steps).toEqual([
      "replay",
      "clone",
      "probe",
      `migrate:${PreviewResetMode.Never}`,
    ]);
    expect(deps.replayPendingMigrationsViaSql).toHaveBeenCalledWith(
      URL,
      PREVIEW_SCHEMA,
      expect.objectContaining({ appliedInSchema: "public" })
    );
  });

  it("runs no migrate after the clone when public's level is already head", async () => {
    const { deps, steps } = makeDeps({ isNew: true, atHead: true });
    await apply(deps, true);

    expect(steps).toEqual(["replay", "clone", "probe"]);
  });

  it("fails the run when a migration fails on the cloned rows, leaving the schema", async () => {
    const { deps, steps } = makeDeps({ isNew: true });
    deps.runMigrate.mockImplementationOnce(() => {
      steps.push("migrate:failed");
      return Promise.reject(
        new Error("ISS-11212: 1 comments rows match no body_format rule")
      );
    });

    await expect(
      runMigrationPipeline(URL, PREVIEW_SCHEMA, BRANCH, deps)
    ).rejects.toThrow(MIGRATION_FAILED_RE);
    expect(steps).toEqual(["replay", "clone", "probe", "migrate:failed"]);
    expect(deps.runPreviewSeed).not.toHaveBeenCalled();
  });

  it("drops the schema and fails the run when the clone fails", async () => {
    const { deps, steps } = makeDeps({ isNew: true, cloneOk: false });

    await expect(
      runMigrationPipeline(URL, PREVIEW_SCHEMA, BRANCH, deps)
    ).rejects.toThrow(CLONE_FAILED_RE);
    expect(steps).toEqual(["replay", "clone", "drop"]);
    expect(deps.runPreviewSeed).not.toHaveBeenCalled();
  });

  it("drops the schema when the build fails before the clone, rethrowing that failure", async () => {
    const { deps, steps } = makeDeps({ isNew: true });
    const contended = new SerializeLockContendedError(
      "serialize gate contended"
    );
    deps.withMigrationSerializeLock.mockRejectedValueOnce(contended);

    await expect(apply(deps, true)).rejects.toBe(contended);
    expect(steps).toEqual(["drop"]);
  });

  it("still reports the clone failure when the drop fails too", async () => {
    const { deps } = makeDeps({ isNew: true, cloneOk: false });
    deps.dropSchema.mockRejectedValueOnce(new Error("permission denied"));
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(apply(deps, true)).rejects.toThrow(CLONE_FAILED_RE);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(DROP_FAILED_RE));
  });

  it("drops the schema and fails the run when the replay cannot stop at public's level", async () => {
    const { deps, steps } = makeDeps({ isNew: true, replayed: false });

    await expect(apply(deps, true)).rejects.toThrow(REPLAY_INCOMPLETE_RE);
    expect(steps).toEqual(["replay", "drop"]);
  });

  it("drops the schema and fails the run when the gate failed open", async () => {
    const { deps, steps } = makeDeps({ isNew: true });
    deps.withMigrationSerializeLock.mockImplementationOnce((gate, fn) => {
      gate.onOutcome?.(MigrateGateOutcome.FailOpen, 1);
      return fn();
    });

    await expect(apply(deps, true)).rejects.toThrow(GATE_NOT_HELD_RE);
    expect(steps).toEqual(["drop"]);
  });

  it("empties an existing preview on reset and rebuilds it around the clone", async () => {
    const { deps, steps } = makeDeps({ isNew: false, reset: true });
    deps.runMigrate.mockImplementation(
      (_url, _schema, _branch, _hooks, _cli, previewReset) => {
        steps.push(`migrate:${previewReset}`);
        return Promise.resolve(previewReset === PreviewResetMode.ResetOnly);
      }
    );
    const result = await apply(deps, false);

    expect(result.didReset).toBe(true);
    expect(steps).toEqual([
      "probe",
      `migrate:${PreviewResetMode.ResetOnly}`,
      "replay",
      "clone",
      "probe",
      `migrate:${PreviewResetMode.Never}`,
    ]);
  });

  it("replays a reset schema inside the reset's gate hold, so a contended later take leaves it cloned", async () => {
    const { deps, steps } = makeDeps({ isNew: false });
    deps.runMigrate.mockImplementation(
      (_url, _schema, _branch, _hooks, _cli, previewReset) => {
        steps.push(`migrate:${previewReset}`);
        return Promise.resolve(previewReset === PreviewResetMode.ResetOnly);
      }
    );
    const contended = new SerializeLockContendedError("gate contended");
    deps.withMigrationSerializeLock
      .mockImplementationOnce((gate, fn) => {
        gate.onOutcome?.(MigrateGateOutcome.Acquired, 1);
        return fn();
      })
      .mockRejectedValue(contended);

    await expect(
      applyMigrationsToSchema(
        URL,
        PREVIEW_SCHEMA,
        BRANCH,
        { isNew: false, serializeMode: "skip" },
        deps
      )
    ).rejects.toBe(contended);
    expect(steps).toEqual([
      "probe",
      `migrate:${PreviewResetMode.ResetOnly}`,
      "replay",
      "clone",
      "probe",
    ]);
  });

  it("drops a reset schema whose replay fails inside the reset's gate hold", async () => {
    const { deps, steps } = makeDeps({ isNew: false, replayed: false });
    deps.runMigrate.mockImplementation(
      (_url, _schema, _branch, _hooks, _cli, previewReset) => {
        steps.push(`migrate:${previewReset}`);
        return Promise.resolve(previewReset === PreviewResetMode.ResetOnly);
      }
    );

    await expect(apply(deps, false)).rejects.toThrow(REPLAY_INCOMPLETE_RE);
    expect(steps).toEqual([
      "probe",
      `migrate:${PreviewResetMode.ResetOnly}`,
      "replay",
      "drop",
    ]);
  });

  it("reports the post-clone migrate on the run's telemetry event", async () => {
    const { deps } = makeDeps({ isNew: true });
    const events: { migrate_executor?: string | null }[] = [];
    await applyMigrationsToSchema(
      URL,
      PREVIEW_SCHEMA,
      BRANCH,
      { isNew: true, telemetry: { emit: (event) => events.push(event) } },
      deps
    );

    expect(events.map((event) => event.migrate_executor)).toEqual([
      MigrateExecutor.PrismaCli,
    ]);
  });

  it("keeps a merge-queue preview on re-migrating resets and no clone", async () => {
    const { deps, steps } = makeDeps({ isNew: false, reset: true });
    await apply(deps, false, MERGE_QUEUE_REF);

    expect(steps).toEqual(["probe", `migrate:${PreviewResetMode.Remigrate}`]);
  });
});

describe("one pipeline at a time per clone-first preview (ISS-11785, review: tamsinb)", () => {
  /** A gate that serializes per lock key, as Postgres advisory locks do. */
  function keyedLockGate() {
    const tails = new Map<number | undefined, Promise<unknown>>();
    return vi.fn(
      (
        gate: {
          lockKey?: number;
          onOutcome?: (outcome: MigrateGateOutcome, waitMs: number) => void;
        },
        fn: () => Promise<boolean>
      ) => {
        const held = (tails.get(gate.lockKey) ?? Promise.resolve()).then(() => {
          gate.onOutcome?.(MigrateGateOutcome.Acquired, 1);
          return fn();
        });
        tails.set(
          gate.lockKey,
          held.catch(() => undefined)
        );
        return held;
      }
    );
  }

  it("holds a second deploy of a new branch until the first has built its schema", async () => {
    const steps: string[] = [];
    const schema = { level: "empty" };
    const gate = keyedLockGate();
    function deploy(run: string, isNew: boolean) {
      const { deps } = makeDeps({ isNew });
      return runMigrationPipeline(URL, PREVIEW_SCHEMA, BRANCH, {
        ...deps,
        withMigrationSerializeLock: gate,
        probePreviewSchemaAtHead: vi.fn(() =>
          Promise.resolve(schema.level === "head")
        ),
        replayPendingMigrationsViaSql: vi.fn(() => {
          steps.push(`${run}:replay`);
          schema.level = "public";
          return Promise.resolve(true);
        }),
        cloneDataFromPublic: vi.fn(async () => {
          await new Promise((resolve) => setImmediate(resolve));
          steps.push(`${run}:clone`);
        }),
        runMigrate: vi.fn(() => {
          steps.push(`${run}:migrate:${schema.level}`);
          schema.level = "head";
          return Promise.resolve(false);
        }),
      });
    }

    await Promise.all([deploy("A", true), deploy("B", false)]);

    expect(steps).toEqual(["A:replay", "A:clone", "A:migrate:public"]);
  });

  it("the migrator walk leaves a preview whose build lock is held to the run holding it", async () => {
    const { deps, steps } = makeDeps({ isNew: false });
    const contended = new SerializeLockContendedError("build lock held");
    deps.withMigrationSerializeLock.mockRejectedValueOnce(contended);

    await expect(
      defaultApplyToSchema(
        URL,
        PREVIEW_SCHEMA,
        60_000,
        () => Promise.resolve(URL),
        BRANCH,
        deps
      )
    ).rejects.toBe(contended);
    expect(steps).toEqual([]);
    expect(deps.withMigrationSerializeLock).toHaveBeenCalledWith(
      expect.objectContaining({
        lockKey: previewBuildLockKey(PREVIEW_SCHEMA),
        onContended: "skip",
      }),
      expect.any(Function)
    );
  });

  it("keys the build lock per schema, above the int4 range of other advisory keys", () => {
    const key = previewBuildLockKey(PREVIEW_SCHEMA);

    expect(key).toBe(previewBuildLockKey(PREVIEW_SCHEMA));
    expect(key).not.toBe(previewBuildLockKey(`${PREVIEW_SCHEMA}x`));
    expect(key).toBeGreaterThan(2 ** 32);
    expect(Number.isSafeInteger(key)).toBe(true);
  });
});

describe("a vibe environment is never cloned from public (ISS-12056)", () => {
  const blankReady = {
    mode: VibeEnvironmentMode.Blank,
    state: VibeEnvironmentState.Ready,
  };

  it("migrates a new marked schema empty to head and never seeds it", async () => {
    const { deps, steps } = makeDeps({ isNew: true, vibeMarker: blankReady });

    const result = await runMigrationPipeline(
      URL,
      PREVIEW_SCHEMA,
      BRANCH,
      deps
    );

    expect(steps).toEqual(["replay"]);
    expect(deps.replayPendingMigrationsViaSql).toHaveBeenCalledWith(
      URL,
      PREVIEW_SCHEMA,
      expect.not.objectContaining({ appliedInSchema: "public" })
    );
    expect(deps.cloneDataFromPublic).not.toHaveBeenCalled();
    expect(deps.runPreviewSeed).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      vibeEnvironment: blankReady,
      rebuilt: false,
    });
  });

  it("re-migrates a reset marked schema empty instead of rebuilding it on a clone", async () => {
    const { deps, steps } = makeDeps({
      isNew: false,
      reset: true,
      vibeMarker: blankReady,
    });

    await runMigrationPipeline(URL, PREVIEW_SCHEMA, BRANCH, deps);

    expect(steps).toEqual(["probe", `migrate:${PreviewResetMode.Remigrate}`]);
    expect(deps.cloneDataFromPublic).not.toHaveBeenCalled();
    expect(deps.runPreviewSeed).not.toHaveBeenCalled();
  });

  it("a dispatch drops a schema a normal deploy cloned and builds it empty and marked", async () => {
    const { deps, steps } = makeDeps({ isNew: true });

    const result = await runMigrationPipeline(
      URL,
      PREVIEW_SCHEMA,
      BRANCH,
      deps,
      { vibeEnvironment: VibeEnvironmentMode.Seeded }
    );

    expect(steps).toEqual(["drop", "mark:seeded:pending", "replay"]);
    expect(deps.cloneDataFromPublic).not.toHaveBeenCalled();
    expect(deps.runPreviewSeed).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      rebuilt: true,
      vibeEnvironment: {
        mode: VibeEnvironmentMode.Seeded,
        state: VibeEnvironmentState.Pending,
      },
    });
  });

  it("an unmarked preview still clones and seeds as before", async () => {
    const { deps, steps } = makeDeps({ isNew: true });

    await runMigrationPipeline(URL, PREVIEW_SCHEMA, BRANCH, deps);

    expect(steps).toContain("clone");
    expect(deps.runPreviewSeed).toHaveBeenCalledTimes(1);
  });
});
