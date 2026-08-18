/**
 * FEA-3628 — the compute/write split that moves the heavy pack scan off the
 * db-host so it can no longer starve renderer DB reads.
 *
 * These tests assert the invariant behaviorally: `computePackScan` is pure
 * compute (it takes NO database handle and only fills a sink), and the
 * coordinator drives a normal scan through a bounded db-host read
 * (`packScanner.recentRoots`) + write (`packScanner.apply`) — never the heavy
 * in-db-host `packScanner.run` path — so the db-host JS thread stays free to
 * serve reads while the worker computes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DefinitionRootsResolution,
  DefinitionScanRoots,
} from "../src/main/packs/definition-discovery.js";
import { createPackScanCoordinator } from "../src/main/packs/pack-scan-coordinator.js";
import {
  applyPackScan,
  CollectingSink,
  computePackScan,
  type PackScanComputeResult,
  type PackScanSink,
} from "../src/main/packs/pack-scanner.js";
import type {
  DefinitionsComputeOutcome,
  PackScanRunner,
} from "../src/main/packs/utility-process-pack-scan-runner.js";
import { openTestPrisma } from "./prisma-test-utils.js";

function emptyResult(
  overrides: Partial<PackScanComputeResult> = {}
): PackScanComputeResult {
  return {
    plan: { packs: [], skills: [], associations: [] },
    counts: {
      gstack: { installs: 0, skills: 0 },
      bmad: { installs: 0, skills: 0, projects: 0 },
      marketplaces: { installs: 0, skills: 0, marketplaces: 0 },
      catalogDetectors: {},
      gstackProjects: 0,
    },
    scopes: {
      gstack: true,
      bmad: true,
      marketplaces: true,
      gstackProjects: true,
      catalogDetectors: true,
    },
    ...overrides,
  };
}

test("computePackScan is pure compute: emits a plan from a sink, touches no DB", async () => {
  // Inject fake scan phases so the test never probes the real filesystem. Each
  // phase writes to the sink — exactly what the real phases do — proving the
  // heavy path's only output is a serializable plan.
  const result = await computePackScan(
    { recentProjectRoots: ["/proj/a"] },
    {
      scanGStack: async (sink: PackScanSink) => {
        await sink.pack({
          pack_id: "gstack",
          harness: "claude",
          install_path: "/home/.claude/skills/gstack",
          install_kind: "directory",
          version: "1.0.0",
        });
        await sink.skill({
          skill_id: "s1",
          pack_id: "gstack",
          harness: "claude",
          install_path: "/home/.claude/skills/gstack/SKILL.md",
          name: "autoplan",
        });
        return { installs: 1, skills: 1 };
      },
      scanBmad: async (sink: PackScanSink) => {
        // Exercise the injected recent roots (the scanner's single DB read).
        assert.deepEqual(sink.recentProjectRoots(), ["/proj/a"]);
        await sink.association({ project_path: "/proj/a", pack_id: "gstack" });
        return { installs: 0, skills: 0, projects: 1 };
      },
      scanClaudeMarketplaces: async () => ({
        installs: 0,
        skills: 0,
        marketplaces: 0,
      }),
      scanProjectGStackAssociations: async () => 0,
      runCatalogDetectorAdapters: async () => ({}),
    }
  );

  assert.equal(result.plan.packs.length, 1);
  assert.equal(result.plan.skills.length, 1);
  assert.equal(result.plan.associations.length, 1);
  assert.equal(result.counts.gstack.installs, 1);
  assert.equal(result.scopes.gstack, true);
  // The result must be structured-clone safe to cross the utilityProcess IPC.
  assert.doesNotThrow(() => structuredClone(result));
});

test("a failed scan phase records its scope false without aborting the others", async () => {
  const result = await computePackScan(
    { recentProjectRoots: [] },
    {
      scanGStack: () => Promise.reject(new Error("boom")),
      scanBmad: () => Promise.resolve({ installs: 0, skills: 0, projects: 0 }),
      scanClaudeMarketplaces: async () => ({
        installs: 0,
        skills: 0,
        marketplaces: 0,
      }),
      scanProjectGStackAssociations: async () => 0,
      runCatalogDetectorAdapters: async () => ({}),
    }
  );
  assert.equal(result.scopes.gstack, false);
  assert.equal(result.scopes.bmad, true);
});

test("CollectingSink dedupes packs/skills/associations by their upsert key", async () => {
  const sink = new CollectingSink([]);
  await sink.pack({
    pack_id: "p",
    harness: "claude",
    install_path: "/x",
    install_kind: "directory",
    version: "1",
  });
  await sink.pack({
    pack_id: "p",
    harness: "claude",
    install_path: "/x",
    install_kind: "directory",
    version: "2", // same key -> last write wins
  });
  await sink.skill({
    skill_id: "s",
    harness: "claude",
    install_path: "/x/SKILL.md",
    name: "a",
  });
  await sink.skill({
    skill_id: "s",
    harness: "claude",
    install_path: "/x/SKILL.md",
    name: "a",
  });
  const plan = sink.toPlan();
  assert.equal(plan.packs.length, 1);
  assert.equal(plan.packs[0]?.version, "2");
  assert.equal(plan.skills.length, 1);
});

test("applyPackScan replays a plan through the sole writer and prunes when clean", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Seed a stale pack that this scan won't observe; a clean scan should
    // tombstone it.
    await prisma.write((client) =>
      client.agentPack.create({
        data: {
          packId: "old-pack",
          harness: "claude",
          installPath: "/old",
          installKind: "directory",
          detectedAt: "2000-01-01T00:00:00.000Z",
          lastSeenAt: "2000-01-01T00:00:00.000Z",
          uninstalledAt: null,
        },
      })
    );

    const summary = await applyPackScan(
      prisma,
      emptyResult({
        plan: {
          packs: [
            {
              pack_id: "new-pack",
              harness: "claude",
              install_path: "/new",
              install_kind: "directory",
              version: "1",
            },
          ],
          skills: [],
          associations: [],
        },
      }),
      new Date().toISOString()
    );

    assert.equal(summary.pruned, true);
    assert.equal(summary.pruneSkipped, false);

    const rows = await prisma.client.$queryRawUnsafe<
      { pack_id: string; uninstalled_at: string | null }[]
    >("SELECT pack_id, uninstalled_at FROM agent_packs ORDER BY pack_id ASC");
    const byId = new Map(rows.map((r) => [r.pack_id, r.uninstalled_at]));
    assert.equal(byId.get("new-pack"), null); // freshly upserted, live
    assert.notEqual(byId.get("old-pack"), null); // tombstoned by prune
  } finally {
    await close();
  }
});

test("applyPackScan skips prune when a scan scope failed (never tombstones on a partial scan)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await prisma.write((client) =>
      client.agentPack.create({
        data: {
          packId: "keep-me",
          harness: "claude",
          installPath: "/keep",
          installKind: "directory",
          detectedAt: "2000-01-01T00:00:00.000Z",
          lastSeenAt: "2000-01-01T00:00:00.000Z",
          uninstalledAt: null,
        },
      })
    );
    const summary = await applyPackScan(
      prisma,
      emptyResult({ scopes: { gstack: false } }),
      new Date().toISOString()
    );
    assert.equal(summary.pruned, false);
    assert.equal(summary.pruneSkipped, true);
    const rows = await prisma.client.$queryRawUnsafe<
      { uninstalled_at: string | null }[]
    >(`SELECT uninstalled_at FROM agent_packs WHERE pack_id = 'keep-me'`);
    assert.equal(rows[0]?.uninstalled_at, null); // not tombstoned
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Coordinator (main-process orchestration)
// ---------------------------------------------------------------------------

/** The roots `packScanner.definitionRoots` resolves in these tests. */
const DEFINITION_ROOTS: DefinitionRootsResolution = {
  scanRoots: {
    skillRoots: [{ dir: "/home/u/.claude/skills" }],
    claudeRoots: [{ dir: "/home/u/.claude" }],
    openCodeRoots: [{ dir: "/home/u/.config/opencode" }],
  },
  context: { homeDir: "/home/u", userScopeRoots: ["/home/u/.config/opencode"] },
};

function fakeRunner(
  onCompute: (roots: string[]) => Promise<PackScanComputeResult>,
  onDefinitions?: (
    scanRoots: DefinitionScanRoots
  ) => Promise<DefinitionsComputeOutcome>
): PackScanRunner {
  return {
    computeScan: (roots) => onCompute(roots),
    // Defaults to a complete (empty) payload so the existing scan-path tests
    // exercise the whole cycle, definition pass included.
    computeDefinitions: (scanRoots) =>
      onDefinitions
        ? onDefinitions(scanRoots)
        : Promise.resolve({ omitted: false, definitions: [] }),
    stop: () => {},
  };
}

/** A `rawStoreOp` that answers the reads and records every op name. */
function recordingStoreOp(calls: string[]): (name: string) => Promise<unknown> {
  return (name: string) => {
    calls.push(name);
    if (name === "packScanner.recentRoots") {
      return Promise.resolve(["/proj/a"]);
    }
    if (name === "packScanner.definitionRoots") {
      return Promise.resolve(DEFINITION_ROOTS);
    }
    return Promise.resolve(undefined);
  };
}

test("coordinator drives a scan off the db-host: recentRoots read + apply, never the heavy in-db-host run", async () => {
  const calls: string[] = [];
  const coordinator = createPackScanCoordinator({
    rawStoreOp: recordingStoreOp(calls),
    createRunner: () =>
      fakeRunner((roots) => {
        assert.deepEqual(roots, ["/proj/a"]);
        return Promise.resolve(emptyResult());
      }),
  });

  await coordinator.run();

  // Both heavy filesystem walks ran in the worker (fakeRunner). The db-host only
  // saw bounded reads then bounded writes — so its thread stayed free for
  // renderer reads. Crucially, neither in-db-host walk (`packScanner.run`,
  // `packScanner.collectDefinitions`) fired. Inventory applies BEFORE the
  // definition pass, which attaches content to the rows it just wrote.
  assert.deepEqual(calls, [
    "packScanner.recentRoots",
    "packScanner.apply",
    "packScanner.definitionRoots",
    "packScanner.applyDefinitions",
  ]);
});

test("coordinator forwards the db-host's roots verbatim and applies with the context that op returned", async () => {
  const calls: string[] = [];
  let sentRoots: DefinitionScanRoots | null = null;
  let applyArgs: unknown[] = [];
  const coordinator = createPackScanCoordinator({
    rawStoreOp: (name, args = []) => {
      calls.push(name);
      if (name === "packScanner.applyDefinitions") {
        applyArgs = args;
      }
      return recordingStoreOp([])(name);
    },
    createRunner: () =>
      fakeRunner(
        () => Promise.resolve(emptyResult()),
        (scanRoots) => {
          sentRoots = scanRoots;
          return Promise.resolve({ omitted: false, definitions: [] });
        }
      ),
  });

  await coordinator.run();

  // The db-host owns root and scope-context resolution; the worker reads no
  // environment. Both halves must therefore travel unchanged — a re-derivation
  // anywhere in between would silently change the scanned set and, through
  // `homeDir`, the persisted `agent_components.scope`.
  assert.deepEqual(sentRoots, DEFINITION_ROOTS.scanRoots);
  assert.deepEqual(applyArgs[1], DEFINITION_ROOTS.context);
});

test("coordinator falls back to the on-host walk exactly once when the worker omits an over-budget payload", async () => {
  const calls: string[] = [];
  const coordinator = createPackScanCoordinator({
    rawStoreOp: recordingStoreOp(calls),
    createRunner: () =>
      fakeRunner(
        () => Promise.resolve(emptyResult()),
        () =>
          Promise.resolve({ omitted: true, reason: "definition count too big" })
      ),
  });

  await coordinator.run();

  // Complete-or-fall-back: an omitted payload must produce the FULL on-host
  // walk, never a partial apply.
  assert.equal(
    calls.filter((c) => c === "packScanner.collectDefinitions").length,
    1
  );
  assert.ok(!calls.includes("packScanner.applyDefinitions"));
});

test("coordinator falls back to the on-host walk when the definitions worker fails", async () => {
  const calls: string[] = [];
  const coordinator = createPackScanCoordinator({
    rawStoreOp: recordingStoreOp(calls),
    createRunner: () =>
      fakeRunner(
        () => Promise.resolve(emptyResult()),
        () => Promise.reject(new Error("definitions worker crashed"))
      ),
  });

  await coordinator.run();

  assert.ok(calls.includes("packScanner.collectDefinitions"));
  assert.ok(!calls.includes("packScanner.applyDefinitions"));
  // The inventory half already succeeded — it must not be redone.
  assert.ok(!calls.includes("packScanner.run"));
});

test("coordinator falls back to the on-host walk when definitionRoots itself fails", async () => {
  const calls: string[] = [];
  const coordinator = createPackScanCoordinator({
    rawStoreOp: (name) => {
      calls.push(name);
      if (name === "packScanner.definitionRoots") {
        return Promise.reject(new Error("db-host closing"));
      }
      return name === "packScanner.recentRoots"
        ? Promise.resolve(["/proj/a"])
        : Promise.resolve(undefined);
    },
    createRunner: () => fakeRunner(() => Promise.resolve(emptyResult())),
  });

  await coordinator.run();

  // Losing the roots read must not silently skip definitions for this cycle.
  assert.ok(calls.includes("packScanner.collectDefinitions"));
});

test("an applyDefinitions failure does NOT trigger a re-walk", async () => {
  const calls: string[] = [];
  const coordinator = createPackScanCoordinator({
    rawStoreOp: (name) => {
      calls.push(name);
      if (name === "packScanner.applyDefinitions") {
        return Promise.reject(new Error("write failed"));
      }
      return recordingStoreOp([])(name);
    },
    createRunner: () => fakeRunner(() => Promise.resolve(emptyResult())),
  });

  await coordinator.run();

  // The walk already succeeded; re-walking to retry a bounded DB write would
  // repeat the expensive half. The next trigger retries instead.
  assert.ok(!calls.includes("packScanner.collectDefinitions"));
  assert.ok(!calls.includes("packScanner.run"));
});

test("stop() mid-computeDefinitions fires neither applyDefinitions nor collectDefinitions", async () => {
  const calls: string[] = [];
  let rejectDefinitions: ((error: Error) => void) | null = null;
  const coordinator = createPackScanCoordinator({
    rawStoreOp: recordingStoreOp(calls),
    createRunner: () =>
      fakeRunner(
        () => Promise.resolve(emptyResult()),
        () =>
          new Promise<DefinitionsComputeOutcome>((_resolve, reject) => {
            rejectDefinitions = reject;
          })
      ),
  });

  const scan = coordinator.run();
  await new Promise((resolve) => setTimeout(resolve, 10)); // let the walk start
  coordinator.stop();
  // `PackScanRunner.stop()` rejects pending work as the app tears down. Without
  // the guard this would queue a full home-tree walk into a closing db-host —
  // strictly worse than the behavior this ticket replaces.
  (rejectDefinitions as unknown as (error: Error) => void)(
    new Error("pack scan worker stopped")
  );
  await scan;

  assert.ok(!calls.includes("packScanner.collectDefinitions"));
  assert.ok(!calls.includes("packScanner.applyDefinitions"));
});

test("coordinator falls back to the in-db-host scan when the worker fails", async () => {
  const calls: string[] = [];
  const coordinator = createPackScanCoordinator({
    rawStoreOp: (name) => {
      calls.push(name);
      if (name === "packScanner.recentRoots") {
        return Promise.resolve([]);
      }
      return Promise.resolve(undefined);
    },
    createRunner: () =>
      fakeRunner(() => Promise.reject(new Error("worker crashed"))),
  });

  await coordinator.run();

  assert.ok(calls.includes("packScanner.recentRoots"));
  assert.ok(
    calls.includes("packScanner.run"),
    "must fall back to the in-db-host scan"
  );
  assert.ok(!calls.includes("packScanner.apply"));
});

test("coordinator with no runner (golden mode) always uses the in-db-host fallback", async () => {
  const calls: string[] = [];
  const coordinator = createPackScanCoordinator({
    rawStoreOp: (name) => {
      calls.push(name);
      return Promise.resolve(undefined);
    },
    createRunner: () => null,
  });
  await coordinator.run();
  assert.deepEqual(calls, ["packScanner.run"]);
});

test("coordinator does not start the heavy fallback scan when stopped mid-flight", async () => {
  const calls: string[] = [];
  let rejectCompute: ((error: Error) => void) | null = null;
  const coordinator = createPackScanCoordinator({
    rawStoreOp: (name) => {
      calls.push(name);
      return name === "packScanner.recentRoots"
        ? Promise.resolve([])
        : Promise.resolve(undefined);
    },
    createRunner: () =>
      fakeRunner(
        () =>
          new Promise<PackScanComputeResult>((_resolve, reject) => {
            rejectCompute = reject;
          })
      ),
  });

  const scan = coordinator.run();
  await new Promise((resolve) => setTimeout(resolve, 10)); // let compute start
  coordinator.stop();
  // The worker dies as the app tears down; the coordinator must NOT respond by
  // launching the heavy in-db-host scan during shutdown.
  (rejectCompute as unknown as (error: Error) => void)(
    new Error("worker died during shutdown")
  );
  await scan;

  assert.ok(
    !calls.includes("packScanner.run"),
    "must not start the heavy fallback scan during shutdown"
  );
});

test("coordinator coalesces back-to-back triggers into at most one trailing rerun", async () => {
  let computeCount = 0;
  let releaseFirst: (() => void) | null = null;
  const coordinator = createPackScanCoordinator({
    rawStoreOp: (name) =>
      name === "packScanner.recentRoots"
        ? Promise.resolve([])
        : Promise.resolve(undefined),
    createRunner: () =>
      fakeRunner(() => {
        computeCount += 1;
        if (computeCount === 1) {
          // Hold the first scan open so the next three triggers pile up while
          // it is in flight — they must collapse to a single rerun.
          return new Promise<PackScanComputeResult>((resolve) => {
            releaseFirst = () => resolve(emptyResult());
          });
        }
        return Promise.resolve(emptyResult());
      }),
  });

  const first = coordinator.run();
  const second = coordinator.run();
  const third = coordinator.run();
  const fourth = coordinator.run();
  // The first scan reaches computeScan only after its recentRoots read resolves
  // (a microtask); let that settle before releasing it.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(releaseFirst, "first scan should be in flight");
  (releaseFirst as unknown as () => void)();
  await Promise.all([first, second, third, fourth]);

  // 1 in-flight + 1 coalesced rerun = 2, no matter how many triggers landed.
  assert.equal(computeCount, 2);
});
