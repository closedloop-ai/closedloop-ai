/**
 * ISS-8139. What a TIMED-OUT `POST /preview-schemas/ensure` leaves behind.
 *
 * The 504 itself is already pinned in `preview-schemas-ensure-route.test.ts`.
 * This is the FOLD that route cannot reach: it replaces `runMigrationPipeline`
 * wholesale, so nothing there executes the ordering that produces the residue.
 *
 * `runMigrationPipeline`'s stated invariant is
 * `ensureSchemaExists -> upsertSchemaRegistry -> runMigrate -> cloneDataFromPublic`,
 * deliberately so a mid-migration FAILURE still leaves a registered, reapable
 * orphan. A deadline expiry is not a failure: `runPipelineWithinBudget` races a
 * timeout against the pipeline and never cancels it, so the pipeline promise
 * simply never settles and no `catch`/`finally` inside it runs.
 *
 * These cases PIN CURRENT BEHAVIOUR, deliberately. That behaviour is a real
 * gap, but closing it means adding a completion signal the registry has no
 * column for, which is a product/ops decision and NOT this change's to make.
 * Pinning it means the decision, whenever it is taken, has to be taken on
 * purpose.
 *
 * Scope, stated precisely so the next reader does not over-read these:
 * - PINNED: the pipeline registers the schema before its migrate is entered
 *   (for a new branch preview, the replay of `public`'s migrations, ISS-11785),
 *   and `categorizeSchema` answers `active` for a freshly-seen row.
 * - NOT PINNED HERE: that `upsertSchemaRegistry`'s SQL stamps `last_seen_at`
 *   fresh, which needs a database; and the ensure route's timeout wrapper. The
 *   hang below MODELS what that wrapper races against rather than invoking it.
 *   The wrapper is pinned on its own side, in
 *   `apps/api/__tests__/unit/preview-schemas-ensure-route.test.ts`: its 504,
 *   and — the premise these cases rest on — that the deadline abandons the
 *   pipeline rather than cancelling it or compensating what it already wrote.
 */

import { describe, expect, it, vi } from "vitest";
import { categorizeSchema } from "../scripts/cleanup-preview-schemas-lib";
import { MigrateGateOutcome } from "../scripts/migrate-telemetry";
import type { MigrationPipelineDeps } from "../scripts/migration-pipeline";
import { runMigrationPipeline } from "../scripts/migration-pipeline";

const PREVIEW_SCHEMA = "preview_my_branch_abc12345";
const BRANCH = "feat/my-branch";
const DATABASE_URL = "postgres://x";
const TTL_DAYS = 7;
const NOW = new Date("2026-01-15T00:00:00.000Z");

describe("what a deadline-expired ensure leaves in the registry", () => {
  it("registers the schema before the migrate can hang", async () => {
    const { deps, isPipelinePending } = startHangingMigrate();

    await tick();

    // The registry write is the one that already completed, so the schema is
    // reapable rather than a silent unregistered orphan.
    expect(deps.upsertSchemaRegistry).toHaveBeenCalledWith(
      DATABASE_URL,
      PREVIEW_SCHEMA,
      BRANCH
    );
    expect(deps.replayPendingMigrationsViaSql).toHaveBeenCalledOnce();
    expect(deps.upsertSchemaRegistry.mock.invocationCallOrder[0]).toBeLessThan(
      deps.replayPendingMigrationsViaSql.mock.invocationCallOrder[0]
    );

    // The pipeline is still running: a timeout does not cancel it, which is
    // exactly why nothing downstream of the migrate ever compensates.
    expect(await isPipelinePending()).toBe(true);
    expect(deps.cloneDataFromPublic).not.toHaveBeenCalled();
    expect(deps.runPreviewSeed).not.toHaveBeenCalled();
  });

  /**
   * The consequence. `categorizeSchema` reads exactly one signal off the row —
   * `last_seen_at` freshness — and `upsertSchemaRegistry` stamps it `now()` on
   * every call, including the one that ran just before the migrate hung.
   */
  it("classifies the half-migrated schema as active, like any healthy preview", () => {
    const justRegistered = categorizeSchema({
      schemaName: PREVIEW_SCHEMA,
      registryRow: { lastSeenAt: NOW },
      registryTableMissing: false,
      ttlDays: TTL_DAYS,
      now: NOW,
    });

    expect(justRegistered).toBe("active");
  });

  /**
   * WHY it cannot be told apart: freshness is the only signal the classifier
   * consumes. `registryRow` reaches it as `{ lastSeenAt }` alone, so no other
   * column — and no column the registry could grow — reaches this decision
   * without a signature change. Holding `lastSeenAt` fixed and moving
   * everything else available at the call site leaves the answer unmoved.
   */
  it("decides on last-seen freshness alone, with no other input in reach", () => {
    const classify = (schemaName: string, ttlDays: number) =>
      categorizeSchema({
        schemaName,
        registryRow: { lastSeenAt: NOW },
        registryTableMissing: false,
        ttlDays,
        now: NOW,
      });

    // Same freshness, different schema and a TTL an order of magnitude apart.
    expect(classify(PREVIEW_SCHEMA, TTL_DAYS)).toBe("active");
    expect(classify("preview_other_branch_def67890", TTL_DAYS * 10)).toBe(
      "active"
    );
  });

  // Control: the classifier is not stuck answering "active". A row the TTL has
  // passed still reads `stale`, so the cases above pin a real decision.
  it("still reaps the same schema once its TTL elapses", () => {
    const longIdle = new Date(
      NOW.getTime() - (TTL_DAYS + 1) * 24 * 3600 * 1000
    );

    expect(
      categorizeSchema({
        schemaName: PREVIEW_SCHEMA,
        registryRow: { lastSeenAt: longIdle },
        registryTableMissing: false,
        ttlDays: TTL_DAYS,
        now: NOW,
      })
    ).toBe("stale");
  });
});

/** Resolves after the microtask queue drains, so pending work can advance. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Runs the real pipeline with a migrate that never settles — the shape a
 * migrate outliving `budgetMs` presents to the ensure route — and returns a
 * `settled()` probe so the test can prove the pipeline is still in flight. A
 * new branch preview's migrate is the replay of `public`'s migrations
 * (ISS-11785), so that is the step that hangs.
 */
function startHangingMigrate() {
  const deps = {
    ensureSchemaExists: vi.fn(() => Promise.resolve(true)),
    upsertSchemaRegistry: vi.fn(() => Promise.resolve()),
    probePreviewSchemaAtHead: vi.fn(() => Promise.resolve(false)),
    withMigrationSerializeLock: vi.fn(
      (
        opts: {
          onOutcome?: (outcome: MigrateGateOutcome, waitMs: number) => void;
        },
        fn: () => Promise<boolean>
      ) => {
        opts.onOutcome?.(MigrateGateOutcome.Acquired, 1);
        return fn();
      }
    ),
    prestampSkippableMigrationsViaSql: vi.fn(() => Promise.resolve()),
    replayPendingMigrationsViaSql: vi.fn(
      () =>
        new Promise<boolean>(() => {
          // Never settles: the migrate is still running at the deadline.
        })
    ),
    plainBuildPreviewConcurrentIndexes: vi.fn(() => Promise.resolve()),
    sweepInvalidIndexes: vi.fn(() => Promise.resolve([])),
    runMigrate: vi.fn(() => Promise.resolve(false)),
    cloneDataFromPublic: vi.fn(() => Promise.resolve()),
    dropSchema: vi.fn(() => Promise.resolve()),
    runPreviewSeed: vi.fn(),
    readVibeEnvironmentMarker: vi.fn(() => Promise.resolve(null)),
    writeVibeEnvironmentMarker: vi.fn(() => Promise.resolve()),
    withRetry: vi.fn((fn: () => Promise<void>) => fn()),
    assertMigrateRoleOwnsSchema: vi.fn(() => Promise.resolve()),
    readIncompletePreviewBuild: vi.fn(() => Promise.resolve(false)),
    clearIncompletePreviewBuild: vi.fn(() => Promise.resolve()),
  } satisfies MigrationPipelineDeps;

  // Settlement is folded to one token so the pending probe below can race it,
  // and attaching the handler here keeps a future rejection from surfacing as
  // an unhandled one.
  const outcome = runMigrationPipeline(
    DATABASE_URL,
    PREVIEW_SCHEMA,
    BRANCH,
    deps
  ).then(
    () => SETTLED,
    () => SETTLED
  );

  return { deps, isPipelinePending: () => isPending(outcome) };
}

const SETTLED = "settled" as const;
const PENDING = "pending" as const;

/**
 * Whether `outcome` is still in flight, decided by racing it against an
 * already-resolved sentinel: a settled promise wins the race, a pending one
 * cannot.
 */
async function isPending(outcome: Promise<typeof SETTLED>): Promise<boolean> {
  const winner = await Promise.race([outcome, Promise.resolve(PENDING)]);
  return winner === PENDING;
}
