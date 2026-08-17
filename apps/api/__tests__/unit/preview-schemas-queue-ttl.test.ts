/**
 * ISS-5343: merge-queue preview schemas must be reaped before they accumulate.
 *
 * Three behaviors are pinned here, each of which fails against the pre-ISS-5343
 * service:
 *
 * 1. `gh-readonly-queue/*` schemas expire on their own short TTL (hours), not
 *    the 7-day branch-preview TTL, and are dropped by the uncapped `stale` path
 *    rather than depending on a remote branch-liveness check.
 * 2. Those schemas sit out the branch-aware pass entirely, so their normal
 *    steady state — a branch GitHub deleted minutes after the merge group —
 *    can no longer trip the mass-drop cap and disable the pass for ordinary
 *    feature branches.
 * 3. The sweep bounds its DROP work by wall clock and reports what it deferred,
 *    so a large backlog drain cannot outlive the serverless function and read
 *    as a cron failure.
 *
 * All DB interactions are mocked via vi.mock("@repo/database") — no real
 * database connections. Time is driven with fake timers, never the real clock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

const { mockWithDb, mockWithDbTx, mockListAllBranchNames } = vi.hoisted(() => ({
  mockWithDb: vi.fn(),
  mockWithDbTx: vi.fn(),
  mockListAllBranchNames: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(mockWithDb, { tx: mockWithDbTx }),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@repo/github", () => ({
  listAllBranchNames: mockListAllBranchNames,
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import {
  MERGE_QUEUE_REF_PREFIX,
  MERGE_QUEUE_SCHEMA_PREFIX,
} from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { log } from "@repo/observability/log";
import { maxDuration as cronMaxDuration } from "@/app/cron/cleanup-preview-schemas/route";
import { previewSchemaCleanupService } from "@/app/preview-schemas/service";
import {
  getSweepBudgetMs,
  SWEEP_BUDGET_CEILING_MS,
} from "@/app/preview-schemas/service/drop-budget";
import { createPreviewSchemaMocks } from "./preview-schemas-mocks";

const {
  mockQueryRawOnce,
  mockRevalidateRegistry,
  mockObservationReadFailure,
  mockObservationsBatch,
  mockUpsertObservationsBatch,
  mockDropBlockedByRevalidation,
  mockDropContention,
  mockCleanupStaleObservationsSuccess,
  mockDropSuccess,
  mockGitHubBranches,
  mockListSchemas,
  mockRegistryRow,
} = createPreviewSchemaMocks(mockWithDb, mockListAllBranchNames, mockWithDbTx);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-06T06:17:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_QUEUE_TTL_HOURS = 12;
const SET_LOCK_TIMEOUT_SQL = /^SET LOCAL lock_timeout/;
const SET_STATEMENT_TIMEOUT_SQL = /^SET LOCAL statement_timeout/;
const DROP_SCHEMA_SQL = /^DROP SCHEMA IF EXISTS/;

/** A merge-group ref, in the exact shape GitHub generates. */
function queueBranch(prNumber: number): string {
  return `${MERGE_QUEUE_REF_PREFIX}main/pr-${prNumber}-abc1234`;
}

/** The preview schema name a queue ref normalizes to. */
function queueSchema(prNumber: number): string {
  return `${MERGE_QUEUE_SCHEMA_PREFIX}main_pr_${prNumber}_abc1234_0a1b2c3d`;
}

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * HOUR_MS).toISOString();
}

/**
 * Restores `process.env[key]` to its exact prior state — removing the property
 * when it was originally unset, since assigning `undefined` would leave the
 * string "undefined" behind.
 */
function setEnv(key: string, value: string | undefined): () => void {
  const had = Object.hasOwn(process.env, key);
  const previous = process.env[key];
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
  return () => {
    if (had && previous !== undefined) {
      process.env[key] = previous;
      return;
    }
    Reflect.deleteProperty(process.env, key);
  };
}

/**
 * Every env var that can override a policy default these tests assert against.
 *
 * `__tests__/setup.ts` loads `.env.local` into `process.env` before the suite
 * runs, and `PREVIEW_QUEUE_SCHEMA_TTL_HOURS` is this feature's documented ops
 * rollback lever — so an operator who set it locally would otherwise silently
 * flip the default-path assertions to the wrong branch. Clearing them makes the
 * "falls back to the default" tests actually exercise the fallback.
 */
const POLICY_ENV_KEYS = [
  "PREVIEW_QUEUE_SCHEMA_TTL_HOURS",
  "PREVIEW_SWEEP_BUDGET_MS",
  "PREVIEW_ORPHAN_GRACE_HOURS",
  "PREVIEW_SCHEMA_TTL_DAYS",
] as const;

let policyEnvRestorers: Array<() => void> = [];

function clearPolicyEnv(): void {
  policyEnvRestorers = POLICY_ENV_KEYS.map((key) => setEnv(key, undefined));
}

function restorePolicyEnv(): void {
  for (const restore of policyEnvRestorers.reverse()) {
    restore();
  }
  policyEnvRestorers = [];
}

// ---------------------------------------------------------------------------
// Queue-family TTL
// ---------------------------------------------------------------------------

describe("runDailySweep — merge-queue TTL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Drain any `mockImplementationOnce` queue the previous test did not
    // consume — `clearAllMocks` clears call history but NOT queued
    // implementations, so a leftover would be handed to the next test's first
    // query and cascade failures across the file.
    mockWithDb.mockReset();
    mockWithDbTx.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    clearPolicyEnv();
    mockListAllBranchNames.mockResolvedValue(["main"]);
  });

  afterEach(() => {
    restorePolicyEnv();
    vi.useRealTimers();
  });

  it("drops a queue schema past the queue TTL even though its branch is still live", async () => {
    // 13h old: inside the 7-day branch TTL that governed it before ISS-5343,
    // past the 12h queue TTL. The branch is deliberately still on the remote so
    // the drop cannot be attributed to the branch-aware path.
    const schemaName = queueSchema(4444);
    const branch = queueBranch(4444);

    mockListSchemas([schemaName]);
    mockGitHubBranches(["main", branch]);
    mockRegistryRow({ last_seen_at: hoursAgo(13), branch });
    mockDropSuccess();
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.counters["ttl-expired"].dropped).toBe(1);
    expect(result.counters["ttl-expired"].kept).toBe(0);
    expect(result.counters["orphan-branch"].dropped).toBe(0);
    expect(result.exitCode).toBe(0);
  });

  it("keeps a queue schema still inside the queue TTL", async () => {
    const schemaName = queueSchema(4445);
    const branch = queueBranch(4445);

    mockListSchemas([schemaName]);
    mockGitHubBranches(["main", branch]);
    mockRegistryRow({ last_seen_at: hoursAgo(11), branch });
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.counters["ttl-expired"].dropped).toBe(0);
    expect(result.counters["ttl-expired"].kept).toBe(1);
  });

  it("leaves an ordinary branch preview of the same age alone", async () => {
    // Same 13h age, non-queue family: the short TTL must not have become the
    // global default.
    mockListSchemas(["preview_feat_add_widget_9f8e7d6c"]);
    mockGitHubBranches(["main", "feat/add-widget"]);
    mockRegistryRow({
      last_seen_at: hoursAgo(13),
      branch: "feat/add-widget",
    });
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.counters["ttl-expired"].dropped).toBe(0);
    expect(result.counters["ttl-expired"].kept).toBe(1);
  });

  it("drops a queue schema whose registry branch is NULL, classified by name", async () => {
    // `preview_schemas.branch` is nullable, so the derived schema name is the
    // only queue signal for these rows. Asserted through to the drop, not just
    // to classification.
    const schemaName = queueSchema(4446);

    mockListSchemas([schemaName]);
    mockGitHubBranches(["main"]);
    mockRegistryRow({ last_seen_at: hoursAgo(13), branch: null });
    mockDropSuccess();
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.counters["ttl-expired"].dropped).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  it("honors PREVIEW_QUEUE_SCHEMA_TTL_HOURS when set", async () => {
    const restore = setEnv("PREVIEW_QUEUE_SCHEMA_TTL_HOURS", "48");
    try {
      const schemaName = queueSchema(4447);
      const branch = queueBranch(4447);

      mockListSchemas([schemaName]);
      mockGitHubBranches(["main", branch]);
      // 13h old — past the 12h default, inside the 48h override.
      mockRegistryRow({ last_seen_at: hoursAgo(13), branch });
      mockCleanupStaleObservationsSuccess();

      const result = await previewSchemaCleanupService.runDailySweep(7);

      expect(result.counters["ttl-expired"].dropped).toBe(0);
      expect(result.counters["ttl-expired"].kept).toBe(1);
    } finally {
      restore();
    }
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["non-numeric", "soon"],
    ["zero", "0"],
    ["negative", "-4"],
  ])("falls back to the %s-safe default queue TTL when the env var is %s", async (_label, raw) => {
    const restore = setEnv("PREVIEW_QUEUE_SCHEMA_TTL_HOURS", raw);
    try {
      const schemaName = queueSchema(4448);
      const branch = queueBranch(4448);

      mockListSchemas([schemaName]);
      mockGitHubBranches(["main", branch]);
      mockRegistryRow({
        last_seen_at: hoursAgo(DEFAULT_QUEUE_TTL_HOURS + 1),
        branch,
      });
      mockDropSuccess();
      mockCleanupStaleObservationsSuccess();

      const result = await previewSchemaCleanupService.runDailySweep(7);

      expect(result.counters["ttl-expired"].dropped).toBe(1);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Branch-aware pass: queue schemas excluded
// ---------------------------------------------------------------------------

describe("runDailySweep — queue schemas and the mass-drop cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Drain any `mockImplementationOnce` queue the previous test did not
    // consume — `clearAllMocks` clears call history but NOT queued
    // implementations, so a leftover would be handed to the next test's first
    // query and cascade failures across the file.
    mockWithDb.mockReset();
    mockWithDbTx.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    clearPolicyEnv();
    mockListAllBranchNames.mockResolvedValue(["main"]);
  });

  afterEach(() => {
    restorePolicyEnv();
    vi.useRealTimers();
  });

  it("still reaps dead human branches when dead queue schemas outnumber them", async () => {
    // 12 human-branch schemas, 5 of them branch-dead (5/12 is under the 0.5 cap),
    // plus 30 branch-dead queue schemas young enough to still be `active`.
    //
    // Against the pre-ISS-5343 service the queue rows counted toward the cap:
    // 35 dead of 42 candidates > 0.5, the whole pass was skipped, and every one
    // of the 5 human drops was silently withheld. This is the merge queue's
    // ordinary steady state, which is why the pass had been inert for months.
    const humanSchemas = Array.from(
      { length: 12 },
      (_unused, index) => `preview_human_${index.toString().padStart(2, "0")}`
    );
    const queueSchemas = Array.from({ length: 30 }, (_unused, index) =>
      queueSchema(5000 + index)
    );
    const liveHumanBranches = Array.from(
      { length: 7 },
      (_unused, index) => `feat/live-${index}`
    );

    mockListSchemas([...humanSchemas, ...queueSchemas]);
    mockGitHubBranches(["main", ...liveHumanBranches]);

    // First 7 human schemas point at live branches; the last 5 are dead.
    for (let index = 0; index < humanSchemas.length; index += 1) {
      mockRegistryRow({
        last_seen_at: hoursAgo(24),
        branch: index < 7 ? `feat/live-${index}` : `feat/deleted-${index}`,
      });
    }
    // Queue schemas: fresh enough to stay `active`, branches long since gone.
    for (let index = 0; index < queueSchemas.length; index += 1) {
      mockRegistryRow({
        last_seen_at: hoursAgo(2),
        branch: queueBranch(5000 + index),
      });
    }
    for (let index = 0; index < 5; index += 1) {
      mockDropSuccess();
    }
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.counters["orphan-branch"].dropped).toBe(5);
    expect(result.counters["orphan-branch"].kept).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(log.warn).not.toHaveBeenCalledWith(
      "[preview-schema-cleanup] Skipping branch-aware pass: orphan-branch candidates exceed mass-drop cap",
      expect.anything()
    );
  });

  it("never proposes a queue schema as an orphan-branch drop, cap or no cap", async () => {
    // One live human branch and 4 dead-branch queue schemas: nowhere near the
    // cap, so nothing is being withheld. The queue schemas must still be left
    // to their TTL rather than dropped on a remote-liveness check.
    const queueSchemas = Array.from({ length: 4 }, (_unused, index) =>
      queueSchema(6000 + index)
    );

    mockListSchemas(["preview_human_live_11112222", ...queueSchemas]);
    mockGitHubBranches(["main", "feat/live"]);
    mockRegistryRow({ last_seen_at: hoursAgo(24), branch: "feat/live" });
    for (let index = 0; index < queueSchemas.length; index += 1) {
      mockRegistryRow({
        last_seen_at: hoursAgo(2),
        branch: queueBranch(6000 + index),
      });
    }
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.counters["orphan-branch"].dropped).toBe(0);
    // 1 human + 4 queue previews, all preserved.
    expect(result.counters["ttl-expired"].kept).toBe(5);
  });

  it("excludes queue schemas from the cap denominator it reports", async () => {
    // A genuinely human-dominated dead population (8 of 12) still trips the cap.
    // The logged arithmetic must describe the human population only, and the
    // withheld candidates must surface as orphan-branch.kept.
    const humanSchemas = Array.from(
      { length: 12 },
      (_unused, index) => `preview_human_${index.toString().padStart(2, "0")}`
    );
    const queueSchemas = Array.from({ length: 3 }, (_unused, index) =>
      queueSchema(7000 + index)
    );

    mockListSchemas([...humanSchemas, ...queueSchemas]);
    mockGitHubBranches([
      "main",
      "feat/live-0",
      "feat/live-1",
      "feat/live-2",
      "feat/live-3",
    ]);
    for (let index = 0; index < humanSchemas.length; index += 1) {
      mockRegistryRow({
        last_seen_at: hoursAgo(24),
        branch: index < 4 ? `feat/live-${index}` : `feat/deleted-${index}`,
      });
    }
    for (let index = 0; index < queueSchemas.length; index += 1) {
      mockRegistryRow({
        last_seen_at: hoursAgo(2),
        branch: queueBranch(7000 + index),
      });
    }
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.counters["orphan-branch"].dropped).toBe(0);
    expect(result.counters["orphan-branch"].kept).toBe(8);
    // 4 live human + 3 queue previews preserved; the 8 withheld are NOT here.
    expect(result.counters["ttl-expired"].kept).toBe(7);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("orphan-branch[dropped=0 kept=8");
    expect(log.warn).toHaveBeenCalledWith(
      "[preview-schema-cleanup] Skipping branch-aware pass: orphan-branch candidates exceed mass-drop cap",
      expect.objectContaining({
        branchAwareCandidateCount: 12,
        orphanBranchCandidateCount: 8,
        queuePreviewsExcluded: 3,
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Sweep time budget
// ---------------------------------------------------------------------------

describe("runDailySweep — DROP time budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Drain any `mockImplementationOnce` queue the previous test did not
    // consume — `clearAllMocks` clears call history but NOT queued
    // implementations, so a leftover would be handed to the next test's first
    // query and cascade failures across the file.
    mockWithDb.mockReset();
    mockWithDbTx.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    clearPolicyEnv();
    mockListAllBranchNames.mockResolvedValue(["main"]);
  });

  afterEach(() => {
    restorePolicyEnv();
    vi.useRealTimers();
  });

  /**
   * Makes each successful DROP advance the fake clock, so the budget is
   * exercised deterministically instead of against real elapsed time.
   */
  function mockDropAdvancingClock(byMs: number): void {
    // The re-verification read that clears the schema for dropping: an ancient
    // `last_seen_at` means nothing re-registered it since classification.
    mockQueryRawOnce({
      last_seen_at: new Date(0).toISOString(),
      branch: null,
    });
    // The DROP itself, which runs in a transaction and burns the clock.
    // The transaction issues three statements (two `SET LOCAL` guards plus the
    // DROP); only the DROP represents real elapsed work, so only it advances
    // the clock — otherwise one drop would spend 3x its budget.
    mockWithDbTx.mockImplementationOnce((fn: (tx: unknown) => unknown) =>
      fn({
        $executeRawUnsafe: vi.fn((sql: string) => {
          if (sql.startsWith("DROP SCHEMA")) {
            vi.advanceTimersByTime(byMs);
          }
          return Promise.resolve(0);
        }),
      })
    );
  }

  it("stops dropping once the budget is spent and reports the remainder", async () => {
    const restore = setEnv("PREVIEW_SWEEP_BUDGET_MS", "1000");
    try {
      const schemaNames = Array.from(
        { length: 10 },
        (_unused, index) => `preview_stale_${index.toString().padStart(2, "0")}`
      );

      mockListSchemas(schemaNames);
      mockGitHubBranches(["main"]);
      for (const _schemaName of schemaNames) {
        mockRegistryRow({ last_seen_at: hoursAgo(10 * 24), branch: null });
      }
      // Each drop burns 400ms: two fit inside the 1000ms budget, the third
      // starts at 800ms, and by 1200ms the budget is spent.
      for (let index = 0; index < 3; index += 1) {
        mockDropAdvancingClock(400);
      }
      mockCleanupStaleObservationsSuccess();

      const result = await previewSchemaCleanupService.runDailySweep(7);

      expect(result.counters["ttl-expired"].dropped).toBe(3);
      expect(result.counters.deferredDrops).toBe(7);
      // A deferred drop is not a failure — the next sweep resumes it.
      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain("deferred=7");
    } finally {
      restore();
    }
  });

  it("shares one budget across every drop path, not one per path", async () => {
    // Budget is spent during the stale path; the orphan path that follows must
    // issue zero DROPs and have its grace-elapsed candidates counted as
    // deferred rather than silently dropped from the tally.
    const restore = setEnv("PREVIEW_SWEEP_BUDGET_MS", "500");
    try {
      const staleSchemas = ["preview_stale_a1b2c3d4", "preview_stale_e5f6a7b8"];
      const orphanSchemas = ["preview_orph_11112222", "preview_orph_33334444"];

      mockListSchemas([...staleSchemas, ...orphanSchemas]);
      mockGitHubBranches(["main"]);
      for (const _schemaName of staleSchemas) {
        mockRegistryRow({ last_seen_at: hoursAgo(10 * 24), branch: null });
      }
      for (const _schemaName of orphanSchemas) {
        mockRegistryRow(null);
      }
      // One drop exhausts the budget outright.
      mockDropAdvancingClock(600);
      // Orphan bookkeeping still runs — first_observed_at is what starts the
      // grace clock, so skipping it would strand orphans forever. It is
      // set-based: one read and one upsert for the whole batch, so it stays
      // bounded even though it is deliberately un-budgeted.
      mockObservationsBatch(
        orphanSchemas.map((schema_name) => ({
          schema_name,
          first_observed_at: new Date(
            NOW.getTime() - 72 * HOUR_MS
          ).toISOString(),
        }))
      );
      mockUpsertObservationsBatch();
      mockCleanupStaleObservationsSuccess();

      const result = await previewSchemaCleanupService.runDailySweep(7);

      expect(result.counters["ttl-expired"].dropped).toBe(1);
      expect(result.counters.orphan.dropped).toBe(0);
      // 1 stale remainder + 2 grace-elapsed orphans never attempted.
      expect(result.counters.deferredDrops).toBe(3);
      expect(result.exitCode).toBe(0);
    } finally {
      restore();
    }
  });

  it("resumes the remainder on the next sweep", async () => {
    const restore = setEnv("PREVIEW_SWEEP_BUDGET_MS", "1000");
    try {
      const schemaNames = ["preview_stale_aaaa1111", "preview_stale_bbbb2222"];

      // First sweep: the single drop exhausts the budget.
      mockListSchemas(schemaNames);
      mockGitHubBranches(["main"]);
      for (const _schemaName of schemaNames) {
        mockRegistryRow({ last_seen_at: hoursAgo(10 * 24), branch: null });
      }
      mockDropAdvancingClock(1200);
      mockCleanupStaleObservationsSuccess();

      const first = await previewSchemaCleanupService.runDailySweep(7);
      expect(first.counters["ttl-expired"].dropped).toBe(1);
      expect(first.counters.deferredDrops).toBe(1);

      // Second sweep, fresh budget: the survivor is re-enumerated from
      // pg_namespace and dropped. No state is carried between sweeps.
      mockListSchemas([schemaNames[1]]);
      mockGitHubBranches(["main"]);
      mockRegistryRow({ last_seen_at: hoursAgo(10 * 24), branch: null });
      mockDropSuccess();
      mockCleanupStaleObservationsSuccess();

      const second = await previewSchemaCleanupService.runDailySweep(7);
      expect(second.counters["ttl-expired"].dropped).toBe(1);
      expect(second.counters.deferredDrops).toBe(0);
    } finally {
      restore();
    }
  });

  it("defaults to a budget that leaves headroom under the cron's maxDuration", async () => {
    // The budget exists so the sweep finishes before the platform kills the
    // function; a drop already in flight cannot be preempted, so the default
    // must leave room for one to finish. Asserted by driving the real default:
    // a drop that lands just inside it proceeds, the next one does not.
    const restore = setEnv("PREVIEW_SWEEP_BUDGET_MS", undefined);
    try {
      const schemaNames = ["preview_stale_cccc3333", "preview_stale_dddd4444"];

      mockListSchemas(schemaNames);
      mockGitHubBranches(["main"]);
      for (const _schemaName of schemaNames) {
        mockRegistryRow({ last_seen_at: hoursAgo(10 * 24), branch: null });
      }
      // Burn the whole default budget on the first drop.
      mockDropAdvancingClock(cronMaxDuration * 1000);
      mockCleanupStaleObservationsSuccess();

      const result = await previewSchemaCleanupService.runDailySweep(7);

      expect(result.counters["ttl-expired"].dropped).toBe(1);
      expect(result.counters.deferredDrops).toBe(1);
      // The first drop ran, which proves the default budget is > 0 and the
      // second was refused, which proves it is < the maxDuration it burned.
      expect(cronMaxDuration).toBe(300);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Dry-run parity — runDryRun shares categorization and partitioning
// ---------------------------------------------------------------------------

describe("runDryRun — parity with the sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Drain any `mockImplementationOnce` queue the previous test did not
    // consume — `clearAllMocks` clears call history but NOT queued
    // implementations, so a leftover would be handed to the next test's first
    // query and cascade failures across the file.
    mockWithDb.mockReset();
    mockWithDbTx.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    clearPolicyEnv();
    mockListAllBranchNames.mockResolvedValue(["main"]);
  });

  afterEach(() => {
    restorePolicyEnv();
    vi.useRealTimers();
  });

  it("reports a past-TTL queue schema as a would-drop, issuing no DROP", async () => {
    const schemaName = queueSchema(8000);
    const branch = queueBranch(8000);

    mockListSchemas([schemaName]);
    mockGitHubBranches(["main", branch]);
    mockRegistryRow({ last_seen_at: hoursAgo(13), branch });

    const result = await previewSchemaCleanupService.runDryRun(7);

    expect(result.wouldDropStale).toEqual([schemaName]);
    expect(result.wouldDropOrphanBranch).toEqual([]);
    // listPreviewSchemas + one registry read. No DROP, no observation writes.
    expect(mockWithDb).toHaveBeenCalledTimes(2);
  });

  it("reports candidates the mass-drop cap withheld instead of showing nothing", async () => {
    const humanSchemas = Array.from(
      { length: 12 },
      (_unused, index) => `preview_human_${index.toString().padStart(2, "0")}`
    );

    mockListSchemas(humanSchemas);
    mockGitHubBranches([
      "main",
      "feat/live-0",
      "feat/live-1",
      "feat/live-2",
      "feat/live-3",
    ]);
    for (let index = 0; index < humanSchemas.length; index += 1) {
      mockRegistryRow({
        last_seen_at: hoursAgo(24),
        branch: index < 4 ? `feat/live-${index}` : `feat/deleted-${index}`,
      });
    }

    const result = await previewSchemaCleanupService.runDryRun(7);

    expect(result.wouldDropOrphanBranch).toEqual([]);
    expect(result.withheldByMassDropCap).toHaveLength(8);
    expect(result.keptActive).toHaveLength(4);
    expect(result.summary).toContain("withheld-by-mass-drop-cap=8");
  });

  it("applies no time budget — a dry-run issues no DROPs to bound", async () => {
    const restore = setEnv("PREVIEW_SWEEP_BUDGET_MS", "1");
    try {
      const schemaNames = Array.from(
        { length: 6 },
        (_unused, index) => `preview_stale_${index.toString().padStart(2, "0")}`
      );

      mockListSchemas(schemaNames);
      mockGitHubBranches(["main"]);
      for (const _schemaName of schemaNames) {
        mockRegistryRow({ last_seen_at: hoursAgo(10 * 24), branch: null });
      }

      const result = await previewSchemaCleanupService.runDryRun(7);

      // The whole would-drop set is reported even with a 1ms budget: truncating
      // the preview would understate the work a real sweep faces.
      expect(result.wouldDropStale).toHaveLength(6);
      expect(result.counters.deferredDrops).toBe(0);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Drop safety — PR #4499 review
// ---------------------------------------------------------------------------

describe("runDailySweep — drop safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithDb.mockReset();
    mockWithDbTx.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    clearPolicyEnv();
    mockListAllBranchNames.mockResolvedValue(["main"]);
  });

  afterEach(() => {
    restorePolicyEnv();
    vi.useRealTimers();
  });

  it("does not drop a schema that was re-registered between classification and the DROP", async () => {
    // An ejected merge group requeued under the byte-identical branch name maps
    // to the SAME schema: upsertSchemaRegistry refreshes last_seen_at and the
    // migration pipeline starts writing. Dropping on the stale decision would
    // delete the schema out from under a live build.
    const schemaName = queueSchema(9100);
    const branch = queueBranch(9100);

    mockListSchemas([schemaName]);
    mockGitHubBranches(["main", branch]);
    mockRegistryRow({ last_seen_at: hoursAgo(13), branch }); // classified stale
    // Re-verification finds a fresher timestamp — the requeue landed.
    mockDropBlockedByRevalidation(hoursAgo(0));
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.counters["ttl-expired"].dropped).toBe(0);
    expect(result.counters["ttl-expired"].kept).toBe(1);
    expect(mockWithDbTx).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it("does not drop an orphan that gained a registry row since classification", async () => {
    const schemaName = "preview_orph_late_reg_1234";

    mockListSchemas([schemaName]);
    mockGitHubBranches(["main"]);
    mockRegistryRow(null); // orphan at classification
    mockObservationsBatch([
      {
        schema_name: schemaName,
        first_observed_at: new Date(NOW.getTime() - 72 * HOUR_MS).toISOString(),
      },
    ]);
    mockUpsertObservationsBatch();
    // Re-verification finds a row — a deploy registered it in the meantime.
    mockRevalidateRegistry({ last_seen_at: hoursAgo(0), branch: "feat/new" });
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.counters.orphan.dropped).toBe(0);
    expect(result.counters.orphan.kept).toBe(1);
    expect(mockWithDbTx).not.toHaveBeenCalled();
  });

  it("fails closed: an unverifiable registry read skips the drop rather than risking it", async () => {
    const schemaName = queueSchema(9101);
    const branch = queueBranch(9101);

    mockListSchemas([schemaName]);
    mockGitHubBranches(["main", branch]);
    mockRegistryRow({ last_seen_at: hoursAgo(13), branch });
    // The re-verification read itself fails.
    mockObservationReadFailure("connection reset during re-verification");
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.counters["ttl-expired"].dropped).toBe(0);
    expect(result.counters["ttl-expired"].kept).toBe(1);
    expect(mockWithDbTx).not.toHaveBeenCalled();
  });

  it.each([
    ["55P03", "prisma-raw"],
    ["57014", "prisma-raw"],
    ["55P03", "direct"],
    ["57014", "direct"],
  ] as const)("treats a busy schema (SQLSTATE %s, %s error shape) as kept, not errored, so it cannot page", async (sqlState, shape) => {
    // lock_timeout / statement_timeout mean the schema is in use — exactly
    // the schema we must not drop. Routing it to `errored` would return 500
    // and fire the Slack alert on the sweep behaving as designed.
    const schemaName = queueSchema(9102);
    const branch = queueBranch(9102);

    mockListSchemas([schemaName]);
    mockGitHubBranches(["main", branch]);
    mockRegistryRow({ last_seen_at: hoursAgo(13), branch });
    mockDropContention(sqlState, shape);
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.counters["ttl-expired"].dropped).toBe(0);
    expect(result.counters["ttl-expired"].errored).toBe(0);
    expect(result.counters["ttl-expired"].kept).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  it("guards the DROP with lock_timeout and statement_timeout in one transaction", async () => {
    const schemaName = queueSchema(9103);
    const branch = queueBranch(9103);
    const statements: string[] = [];

    mockListSchemas([schemaName]);
    mockGitHubBranches(["main", branch]);
    mockRegistryRow({ last_seen_at: hoursAgo(13), branch });
    mockRevalidateRegistry({ last_seen_at: new Date(0).toISOString() });
    mockWithDbTx.mockImplementationOnce((fn: (tx: unknown) => unknown) =>
      fn({
        $executeRawUnsafe: vi.fn((sql: string) => {
          statements.push(sql);
          return Promise.resolve(0);
        }),
      })
    );
    mockCleanupStaleObservationsSuccess();

    await previewSchemaCleanupService.runDailySweep(7);

    // Both guards must precede the DROP, and all three must share the one
    // transaction — `SET LOCAL` outside a transaction would not bind to the
    // connection the DROP runs on.
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(SET_LOCK_TIMEOUT_SQL);
    expect(statements[1]).toMatch(SET_STATEMENT_TIMEOUT_SQL);
    expect(statements[2]).toMatch(DROP_SCHEMA_SQL);
  });
});

// ---------------------------------------------------------------------------
// Budget ceiling — PR #4499 review
// ---------------------------------------------------------------------------

describe("sweep budget ceiling", () => {
  it("clamps an oversized override so the headroom cannot be erased", () => {
    const restore = setEnv("PREVIEW_SWEEP_BUDGET_MS", "300000");
    try {
      expect(getSweepBudgetMs()).toBe(SWEEP_BUDGET_CEILING_MS);
    } finally {
      restore();
    }
  });

  it("still honors an override below the ceiling", () => {
    const restore = setEnv("PREVIEW_SWEEP_BUDGET_MS", "1000");
    try {
      expect(getSweepBudgetMs()).toBe(1000);
    } finally {
      restore();
    }
  });

  it("keeps the ceiling strictly under the cron route's maxDuration", () => {
    // The gap is headroom for one in-flight DROP that cannot be preempted.
    expect(SWEEP_BUDGET_CEILING_MS).toBeLessThan(cronMaxDuration * 1000);
  });
});
