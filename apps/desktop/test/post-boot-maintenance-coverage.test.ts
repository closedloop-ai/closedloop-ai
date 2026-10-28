/**
 * @file post-boot-maintenance-coverage.test.ts
 * @description ISS-10514: the cancellation, failure, and renderer-invalidation
 * arms of the post-boot maintenance chain, driven through
 * `createPostBootMaintenance` over a recording double of the db-host database,
 * the store-op dispatch, and the renderer window. Also covers both arms of
 * `rebuildParseSource`.
 *
 * The rebuild itself runs for real (`runDataRevisionRebuild`). The double either
 * returns no stale rows, throws (plain or as a db-host exit), or returns one
 * stale row wired so exactly one of rebuilt / deleted / rollups-recomputed is
 * non-zero, which is what isolates each arm of the invalidation condition.
 */
import type { BrowserWindow, WebContents, WebFrameMain } from "electron";
import { describe, expect, it } from "vitest";
import type { HistoricalParseRunner } from "../src/main/collectors/engine/historical-parse-runner.js";
import {
  type BatchHarnessCollector,
  CollectorParseScope,
  type FileHarnessCollector,
  Harness,
  type HarnessCollector,
} from "../src/main/collectors/types.js";
import {
  createPostBootMaintenance,
  rebuildParseSource,
} from "../src/main/dashboard/post-boot-maintenance.js";
import { SESSION_LIST_TRACE_BACKFILL_STORE_OP } from "../src/main/database/session-list-trace-maintenance-contract.js";
import { SKILL_SHADOW_INVENTORY_REPAIR_OP } from "../src/main/database/skill-shadow-inventory-repair-boundary.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import { DbHostExitError } from "../src/shared/db-host-exit-error.js";
import { describeDroppedDbHostWrite } from "../src/shared/db-host-fire-and-forget.js";
import {
  DbHostShutdownError,
  DbHostShutdownReason,
} from "../src/shared/db-host-shutdown-error.js";
import { MaintenancePhase } from "../src/shared/maintenance-progress-contract.js";
import { fakeCollector, makeSession } from "./normalized-session-test-utils.js";

const ARTIFACT_LINKS_OP = "artifactLinks.backfill";
const ACTIVITY_SEGMENTS_OP = "activitySegments.backfill";
const DB_CHANGED = "desktop:db:changed";
const GENERATION = 3;
const REBUILD_FAILED_RE = /^data-revision rebuild failed:/;
const STALE_ACTIVITY_AT = "2026-01-01T00:00:00.000Z";
const STORE_NOW = "2026-06-07T12:00:00.000Z";
const INVALIDATION_LABEL = "session historical-details invalidation";

type ChainOptions = {
  repairDeletedComponents?: number;
  rebuildError?: unknown;
  cancelDuringRebuild?: boolean;
  invalidateReturnsPromise?: boolean;
  invalidateResult?: () => Promise<void>;
  listStale?: (
    attempt: number
  ) => ReturnType<DbHostAgentDatabase["listStaleRevisionSessions"]>;
  rebuildDb?: RebuildDatabaseDouble;
  collectors?: HarnessCollector[];
  cancelOnLog?: RegExp;
  resolveComputeTarget?: (cancel: () => void) => string | null;
  artifactBackfill?: (cancel: () => void) => Promise<unknown>;
  activityBackfill?: (cancel: () => void) => Promise<unknown>;
  prLinkCounts?: [number, number];
  cancelAfterPrStep?: 0 | 1;
};

/** The slice of the db-host database the maintenance chain touches. */
type MaintenanceDatabaseDouble = Pick<
  DbHostAgentDatabase,
  | "listStaleRevisionSessions"
  | "removeUnauthoredBranchPrLinks"
  | "propagateAllBranchPrLinks"
> & {
  sessions: Pick<
    DbHostAgentDatabase["sessions"],
    "invalidateHistoricalDetails"
  >;
};

/** The rebuild-only members a case can supply to drive a non-empty summary. */
type RebuildDatabaseDouble = Partial<
  Pick<
    DbHostAgentDatabase,
    | "now"
    | "deleteSessionRow"
    | "recomputeAnalyticsRollups"
    | "rebuildComponentInvocationsFromStoredRows"
  >
>;

/** The slice of a BrowserWindow `sendToRendererWindow` reads. */
type RendererWindowDouble = Pick<BrowserWindow, "isDestroyed"> & {
  webContents: Pick<WebContents, "isDestroyed" | "send"> & {
    mainFrame: Pick<WebFrameMain, "isDestroyed">;
  };
};

type ChainHarness = {
  calls: string[];
  logs: string[];
  phases: string[];
  sends: string[];
  invalidations: () => number;
  computeTargetReads: () => number;
  run: () => Promise<void>;
};

function buildChain(options: ChainOptions = {}): ChainHarness {
  const calls: string[] = [];
  const logs: string[] = [];
  const phases: string[] = [];
  const sends: string[] = [];
  let invalidations = 0;
  let computeTargetReads = 0;
  let staleAttempts = 0;
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
  };
  const [removed, linked] = options.prLinkCounts ?? [0, 0];
  const prStep = (index: 0 | 1, name: string, count: number) => () => {
    calls.push(name);
    if (options.cancelAfterPrStep === index) {
      cancel();
    }
    return Promise.resolve(count);
  };

  const agentDatabase: MaintenanceDatabaseDouble = {
    ...options.rebuildDb,
    listStaleRevisionSessions: () => {
      calls.push("listStaleRevisionSessions");
      staleAttempts++;
      if (options.listStale) {
        return options.listStale(staleAttempts);
      }
      if (options.cancelDuringRebuild) {
        cancel();
      }
      if (options.rebuildError !== undefined) {
        return Promise.reject(options.rebuildError);
      }
      return Promise.resolve([]);
    },
    sessions: {
      invalidateHistoricalDetails: () => {
        invalidations++;
        if (options.invalidateResult) {
          return options.invalidateResult();
        }
        return options.invalidateReturnsPromise ? Promise.resolve() : undefined;
      },
    },
    removeUnauthoredBranchPrLinks: prStep(
      0,
      "removeUnauthoredBranchPrLinks",
      removed
    ),
    propagateAllBranchPrLinks: prStep(1, "propagateAllBranchPrLinks", linked),
  };

  const window: RendererWindowDouble = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      mainFrame: { isDestroyed: () => false },
      send: (channel: string) => {
        sends.push(channel);
      },
    },
  };

  const invokeStoreOp = (name: string): Promise<unknown> => {
    calls.push(name);
    if (name === SKILL_SHADOW_INVENTORY_REPAIR_OP) {
      return Promise.resolve({
        deletedComponents: options.repairDeletedComponents ?? 0,
        markedSessions: 0,
      });
    }
    if (name === ARTIFACT_LINKS_OP && options.artifactBackfill) {
      return options.artifactBackfill(cancel);
    }
    if (name === ACTIVITY_SEGMENTS_OP && options.activityBackfill) {
      return options.activityBackfill(cancel);
    }
    return Promise.resolve({ captured: 0 });
  };

  const maintenance = createPostBootMaintenance({
    agentDatabase: agentDatabase as DbHostAgentDatabase,
    cooperativeDelay: () => Promise.resolve(),
    getCollectors: () => options.collectors ?? [],
    getHistoricalParseRunner: () => null,
    getWindow: () => window as BrowserWindow,
    invokeStoreOp,
    isDbHostUnderMemoryPressure: () => false,
    isMaintenanceActive: (generation) =>
      generation === GENERATION && !cancelled,
    log: (message) => {
      logs.push(message);
      if (options.cancelOnLog?.test(message)) {
        cancel();
      }
    },
    resolveComputeTargetId: () => {
      computeTargetReads++;
      return options.resolveComputeTarget
        ? options.resolveComputeTarget(cancel)
        : null;
    },
    setMaintenancePhase: (_generation, phase) => {
      phases.push(phase);
    },
  });

  return {
    calls,
    logs,
    phases,
    sends,
    invalidations: () => invalidations,
    computeTargetReads: () => computeTargetReads,
    run: () => maintenance.runPostBootMaintenance(GENERATION),
  };
}

describe("post-boot maintenance chain", () => {
  it("a clean pass runs every phase in order and nudges the renderer for nothing", async () => {
    const chain = buildChain();
    await chain.run();

    expect(chain.calls).toEqual([
      SKILL_SHADOW_INVENTORY_REPAIR_OP,
      "listStaleRevisionSessions",
      ARTIFACT_LINKS_OP,
      "removeUnauthoredBranchPrLinks",
      "propagateAllBranchPrLinks",
      SESSION_LIST_TRACE_BACKFILL_STORE_OP,
      ACTIVITY_SEGMENTS_OP,
    ]);
    expect(chain.phases).toEqual([
      MaintenancePhase.Rebuild,
      MaintenancePhase.Rebuild,
      MaintenancePhase.ArtifactLinks,
    ]);
    expect(chain.sends).toEqual([]);
    expect(chain.invalidations()).toBe(0);
    expect(chain.logs).toEqual([]);
  });

  it("a repair that deleted components nudges the renderer once", async () => {
    const chain = buildChain({ repairDeletedComponents: 2 });
    await chain.run();
    expect(chain.sends).toEqual([DB_CHANGED]);
  });

  it("a failed rebuild is logged, invalidates caches, and the chain continues", async () => {
    const chain = buildChain({ rebuildError: new Error("stale read boom") });
    await chain.run();

    expect(chain.logs).toContain(
      "data-revision rebuild failed: stale read boom"
    );
    expect(chain.invalidations()).toBe(1);
    expect(chain.sends).toEqual([DB_CHANGED]);
    expect(chain.calls).toContain(ARTIFACT_LINKS_OP);
  });

  it("a non-Error rebuild failure is stringified and a promise invalidation is still sent", async () => {
    const chain = buildChain({
      rebuildError: "plain failure",
      invalidateReturnsPromise: true,
    });
    await chain.run();

    expect(chain.logs).toContain("data-revision rebuild failed: plain failure");
    expect(chain.invalidations()).toBe(1);
    expect(chain.sends).toEqual([DB_CHANGED]);
  });

  it("a generation cancelled during the rebuild stops before artifact links", async () => {
    const chain = buildChain({ cancelDuringRebuild: true });
    await chain.run();

    expect(chain.calls).toEqual([
      SKILL_SHADOW_INVENTORY_REPAIR_OP,
      "listStaleRevisionSessions",
    ]);
    expect(chain.phases).not.toContain(MaintenancePhase.ArtifactLinks);
    expect(chain.invalidations()).toBe(0);
    expect(chain.computeTargetReads()).toBe(0);
  });

  it("a generation cancelled during the sync hand-off stops before artifact links", async () => {
    const chain = buildChain({
      resolveComputeTarget: (cancel) => {
        cancel();
        return null;
      },
    });
    await chain.run();

    expect(chain.calls).not.toContain(ARTIFACT_LINKS_OP);
    expect(chain.logs).toEqual([]);
  });

  it("a thrown hand-off is logged and the chain continues", async () => {
    const chain = buildChain({
      resolveComputeTarget: () => {
        throw new Error("target lookup failed");
      },
    });
    await chain.run();

    expect(chain.logs).toEqual([
      "data-revision rebuild result hand-off failed: target lookup failed",
    ]);
    expect(chain.calls).toContain(ARTIFACT_LINKS_OP);
  });

  it("a thrown non-Error hand-off is stringified in the log", async () => {
    const chain = buildChain({
      resolveComputeTarget: () => {
        // biome-ignore lint/style/useThrowOnlyError: the String(e) fallback for a non-Error throw is the arm under test.
        throw "raw hand-off failure";
      },
    });
    await chain.run();

    expect(chain.logs).toEqual([
      "data-revision rebuild result hand-off failed: raw hand-off failure",
    ]);
  });

  it("a hand-off that throws after cancellation stops silently", async () => {
    const chain = buildChain({
      resolveComputeTarget: (cancel) => {
        cancel();
        throw new Error("superseded");
      },
    });
    await chain.run();

    expect(chain.logs).toEqual([]);
    expect(chain.calls).not.toContain(ARTIFACT_LINKS_OP);
  });
});

describe("post-boot maintenance artifact-link and activity-segment passes", () => {
  it("a failed artifact-link backfill is logged, skips the PR post-pass, and still re-tiles", async () => {
    const chain = buildChain({
      artifactBackfill: () => Promise.reject(new Error("backfill boom")),
    });
    await chain.run();

    expect(chain.logs).toEqual([
      "artifact-link backfill failed: backfill boom",
    ]);
    expect(chain.calls).not.toContain("removeUnauthoredBranchPrLinks");
    expect(chain.calls).toContain(ACTIVITY_SEGMENTS_OP);
  });

  it("a non-Error artifact-link failure is stringified", async () => {
    const chain = buildChain({
      artifactBackfill: () => Promise.reject("raw backfill failure"),
    });
    await chain.run();
    expect(chain.logs).toEqual([
      "artifact-link backfill failed: raw backfill failure",
    ]);
  });

  it("an artifact-link failure after cancellation stops the chain silently", async () => {
    const chain = buildChain({
      artifactBackfill: (cancel) => {
        cancel();
        return Promise.reject(new Error("superseded"));
      },
    });
    await chain.run();

    expect(chain.logs).toEqual([]);
    expect(chain.calls).not.toContain(ACTIVITY_SEGMENTS_OP);
  });

  it("a generation cancelled during the artifact-link backfill skips the rest", async () => {
    const chain = buildChain({
      artifactBackfill: (cancel) => {
        cancel();
        return Promise.resolve({ captured: 0 });
      },
    });
    await chain.run();

    expect(chain.calls).not.toContain("removeUnauthoredBranchPrLinks");
    expect(chain.calls).not.toContain(ACTIVITY_SEGMENTS_OP);
  });

  for (const counts of [
    [1, 0],
    [0, 1],
  ] as const) {
    it(`PR post-pass counts ${counts.join("/")} nudge the renderer`, async () => {
      const chain = buildChain({ prLinkCounts: [...counts] });
      await chain.run();
      expect(chain.sends).toEqual([DB_CHANGED]);
    });
  }

  for (const [step, next] of [
    [0, "propagateAllBranchPrLinks"],
    [1, ACTIVITY_SEGMENTS_OP],
  ] as const) {
    it(`cancellation after PR post-pass step ${step} stops before ${next}`, async () => {
      const chain = buildChain({
        cancelAfterPrStep: step,
        prLinkCounts: [1, 1],
      });
      await chain.run();

      expect(chain.calls).not.toContain(next);
      expect(chain.sends).toEqual([]);
    });
  }

  it("a failed activity-segment backfill is logged", async () => {
    const chain = buildChain({
      activityBackfill: () => Promise.reject(new Error("tiling boom")),
    });
    await chain.run();
    expect(chain.logs).toEqual([
      "activity-segment backfill failed: tiling boom",
    ]);
  });

  it("a non-Error activity-segment failure is stringified", async () => {
    const chain = buildChain({
      activityBackfill: () => Promise.reject("raw tiling failure"),
    });
    await chain.run();
    expect(chain.logs).toEqual([
      "activity-segment backfill failed: raw tiling failure",
    ]);
  });

  it("an activity-segment failure after cancellation is not logged", async () => {
    const chain = buildChain({
      activityBackfill: (cancel) => {
        cancel();
        return Promise.reject(new Error("superseded"));
      },
    });
    await chain.run();
    expect(chain.logs).toEqual([]);
  });
});

describe("rebuildParseSource", () => {
  it("parses in-process when no historical parse runner exists", async () => {
    const session = makeSession({ sessionId: "in-process" });
    const parsed: string[] = [];
    const collector: Pick<FileHarnessCollector, "key" | "parse"> = {
      key: Harness.Claude,
      parse: (source: string) => {
        parsed.push(source);
        return Promise.resolve([session]);
      },
    };

    const parse = rebuildParseSource(() => null);
    expect(
      await parse(collector as FileHarnessCollector, "/src/a.jsonl")
    ).toEqual([session]);
    expect(parsed).toEqual(["/src/a.jsonl"]);
  });

  it("routes through the runner and applies the side report under the rebuild scope", async () => {
    const session = makeSession({ sessionId: "via-runner" });
    const runnerCalls: [string, string][] = [];
    const sideReports: unknown[] = [];
    const runner: Pick<HistoricalParseRunner, "parseSource"> = {
      parseSource: (collectorKey, source) => {
        runnerCalls.push([collectorKey, source]);
        return Promise.resolve({ sessions: [session], droppedSessions: 2 });
      },
    };
    const collector: Pick<
      BatchHarnessCollector,
      "key" | "batch" | "parse" | "applyParseSideReport"
    > = {
      key: Harness.OpenCode,
      batch: true,
      parse: () => Promise.reject(new Error("must not parse in-process")),
      applyParseSideReport: (report) => {
        sideReports.push(report);
        return Promise.resolve();
      },
    };

    const parse = rebuildParseSource(() => runner as HistoricalParseRunner);
    expect(
      await parse(collector as BatchHarnessCollector, "/store/opencode.db")
    ).toEqual([session]);
    expect(runnerCalls).toEqual([[Harness.OpenCode, "/store/opencode.db"]]);
    expect(sideReports).toEqual([
      {
        droppedSessions: 2,
        sourcePath: "/store/opencode.db",
        scope: CollectorParseScope.Rebuild,
      },
    ]);
  });
});

describe("post-boot maintenance rebuild hand-off", () => {
  it("a rebuild re-driven after a db-host exit still invalidates caches without logging a failure", async () => {
    const chain = buildChain({
      listStale: (attempt) =>
        attempt === 1
          ? Promise.reject(
              new DbHostExitError(1, true, "db-host exited (code: 1)")
            )
          : Promise.resolve([]),
    });
    await chain.run();

    expect(
      chain.calls.filter((call) => call === "listStaleRevisionSessions")
    ).toHaveLength(2);
    expect(chain.logs.some((line) => REBUILD_FAILED_RE.test(line))).toBe(false);
    expect(chain.invalidations()).toBe(1);
    expect(chain.sends).toEqual([DB_CHANGED]);
  });

  it("a cancellation raised while the failure is logged stops before artifact links", async () => {
    const chain = buildChain({
      rebuildError: new Error("boom"),
      cancelOnLog: REBUILD_FAILED_RE,
    });
    await chain.run();

    expect(chain.logs).toContain("data-revision rebuild failed: boom");
    expect(chain.calls).not.toContain(ARTIFACT_LINKS_OP);
  });

  it("a cancellation during the hand-off skips the abandoned-attempt invalidation", async () => {
    const chain = buildChain({
      rebuildError: new Error("boom"),
      resolveComputeTarget: (cancel) => {
        cancel();
        return null;
      },
    });
    await chain.run();

    expect(chain.invalidations()).toBe(0);
    expect(chain.sends).toEqual([]);
  });

  it("an invalidation dropped by a db-host shutdown is logged under its label", async () => {
    const shutdown = new DbHostShutdownError(
      DbHostShutdownReason.Closed,
      "db-host closed"
    );
    const chain = buildChain({
      rebuildError: new Error("boom"),
      invalidateResult: () => Promise.reject(shutdown),
    });
    await chain.run();

    expect(chain.logs).toContain(
      describeDroppedDbHostWrite(INVALIDATION_LABEL, shutdown)
    );
  });

  const missingSourceRow = {
    id: "missing-source",
    harness: Harness.Claude,
    status: "inactive",
    lastActivityAt: STALE_ACTIVITY_AT,
  };

  it("a committed missing-source rollup recompute alone invalidates caches", async () => {
    const chain = buildChain({
      listStale: () => Promise.resolve([missingSourceRow]),
      collectors: [fakeCollector(Harness.Claude, { sources: [] })],
      rebuildDb: {
        now: () => STORE_NOW,
        recomputeAnalyticsRollups: (ids) =>
          Promise.resolve({
            attempted: ids.length,
            committed: ids.length,
            failed: 0,
          }),
        rebuildComponentInvocationsFromStoredRows: () =>
          Promise.resolve({ rebuilt: false, activeRace: false }),
      },
    });
    await chain.run();

    expect(chain.invalidations()).toBe(1);
    expect(chain.sends).toEqual([DB_CHANGED]);
  });

  it("a stored-row rebuild alone invalidates caches", async () => {
    const chain = buildChain({
      listStale: () => Promise.resolve([missingSourceRow]),
      collectors: [fakeCollector(Harness.Claude, { sources: [] })],
      rebuildDb: {
        now: () => STORE_NOW,
        recomputeAnalyticsRollups: (ids) =>
          Promise.resolve({ attempted: ids.length, committed: 0, failed: 0 }),
        rebuildComponentInvocationsFromStoredRows: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
      },
    });
    await chain.run();

    expect(chain.invalidations()).toBe(1);
    expect(chain.sends).toEqual([DB_CHANGED]);
  });

  it("a deleted burst-artifact session alone invalidates caches", async () => {
    const deleted: string[] = [];
    const chain = buildChain({
      listStale: () =>
        Promise.resolve([
          {
            id: "burst-session",
            harness: Harness.Codex,
            status: "inactive",
            lastActivityAt: STALE_ACTIVITY_AT,
          },
        ]),
      collectors: [
        fakeCollector(Harness.Codex, {
          sources: ["/fake/burst-rollout.jsonl"],
          parse: () => Promise.resolve([]),
          sessionIdForSource: () => "burst-session",
          isBurstArtifactSource: () => true,
        }),
      ],
      rebuildDb: {
        now: () => STORE_NOW,
        deleteSessionRow: (sessionId) => {
          deleted.push(sessionId);
          return Promise.resolve(true);
        },
      },
    });
    await chain.run();

    expect(deleted).toEqual(["burst-session"]);
    expect(chain.invalidations()).toBe(1);
    expect(chain.sends).toEqual([DB_CHANGED]);
  });
});
