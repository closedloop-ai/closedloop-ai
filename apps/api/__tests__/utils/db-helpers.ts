import { randomUUID } from "node:crypto";
import { LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { User } from "@repo/api/src/types/user";
import { ArtifactType, type Prisma, withDb } from "@repo/database";
import {
  type AmbientTransactionOptionsDiscard,
  observeAmbientTransactionOptionDiscards,
} from "@repo/database/ambient-transaction-observer";
import type { TransactionClient } from "@repo/database/generated/internal/prismaNamespace";
import type {
  OrganizationCreateInput,
  ProjectUncheckedCreateInput,
  UserUncheckedCreateInput,
} from "@repo/database/generated/models";
import { type Mock, vi } from "vitest";

/**
 * Create test organization and return its ID.
 */
export async function createTestOrganization(
  overrides?: Partial<OrganizationCreateInput>
): Promise<string> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const org = await withDb((db) =>
    db.organization.create({
      data: {
        clerkId: `org_test_${suffix}`,
        name: `Test Organization ${suffix}`,
        slug: `test-org-${suffix}`,
        ...overrides,
      },
    })
  );
  return org.id;
}

/**
 * Create test user and return user object.
 * Returns User type from @repo/api for consistency with route handlers.
 */
export async function createTestUser(
  organizationId: string,
  overrides?: Partial<UserUncheckedCreateInput>
): Promise<User> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const user = await withDb((db) =>
    db.user.create({
      data: {
        organizationId,
        clerkId: `clerk_test_user_${suffix}`,
        email: `test+${suffix}@example.com`,
        firstName: "Test",
        lastName: "User",
        role: "ENGINEER",
        active: true,
        ...overrides,
      },
    })
  );

  return user as User;
}

/**
 * Create test project and return its ID.
 */
export async function createTestProject(
  organizationId: string,
  createdById: string,
  overrides?: Partial<ProjectUncheckedCreateInput>
): Promise<string> {
  const project = await withDb((db) =>
    db.project.create({
      data: {
        organizationId,
        createdById,
        name: "Test Project",
        description: "A test project",
        ...overrides,
      },
    })
  );
  return project.id;
}

/**
 * Custom error for transaction rollback.
 * Not a real error - used to exit transaction and trigger rollback.
 */
class TestTransactionRollback extends Error {
  result: unknown;

  constructor(result: unknown) {
    super();
    this.result = result;
  }
}

// ---------------------------------------------------------------------------
// Unit test mock helpers — for tests that vi.mock("@repo/database")
// ---------------------------------------------------------------------------

/**
 * Returns `withDb` cast as a Vitest Mock with a `.tx` Mock property.
 * Call once after `vi.mock("@repo/database")` and the subsequent import.
 *
 * @example
 * const mockWithDb = getMockWithDb();
 * // later: mockWithDb.mockClear();
 */
export function getMockWithDb() {
  return withDb as unknown as Mock & { tx: Mock };
}

/**
 * Cast a plain mock object to a TransactionClient so it can be passed to
 * handler functions that accept `TransactionClient` as their first argument.
 *
 * @example
 * const mockTx = { workstream: { findUnique: vi.fn().mockResolvedValue(...) } };
 * await handleWorkflowSuccess(asTx(mockTx), ctx, true);
 */
export function asTx<T extends Record<string, unknown>>(mock: T) {
  return mock as unknown as TransactionClient;
}

/**
 * Set up the mocked `withDb.tx` to invoke its callback with the given mock
 * object as the transaction client.
 *
 * @example
 * mockWithDbTx(mockTx);
 * await processWorkflowCompletion(event, correlationId, true);
 */
export function mockWithDbTx(mockDb: Record<string, unknown>) {
  // Provide a default `$queryRaw`/`$executeRaw` so services that issue raw
  // statements inside the transaction (e.g. `SELECT ... FOR UPDATE` row locks or
  // `pg_advisory_xact_lock` guards) don't blow up when the test only stubbed
  // model methods. Tests can still supply their own.
  if (!("$queryRaw" in mockDb)) {
    mockDb.$queryRaw = vi.fn().mockResolvedValue([]);
  }
  if (!("$executeRaw" in mockDb)) {
    mockDb.$executeRaw = vi.fn().mockResolvedValue(0);
  }
  getMockWithDb().tx = vi
    .fn()
    .mockImplementation((callback: (tx: unknown) => unknown) =>
      callback(mockDb)
    );
}

/**
 * Set up the mocked `withDb` (non-transactional) to invoke its callback with
 * the given mock object as the database client.
 *
 * @example
 * mockWithDbCall(mockDb);
 * await handleExecutionSuccess(ctx, executionResult);
 */
export function mockWithDbCall(mockDb: Record<string, unknown>) {
  getMockWithDb().mockImplementation((callback: (db: unknown) => unknown) =>
    callback(mockDb)
  );
}

/**
 * Route BOTH `withDb` and `withDb.tx` at one mock database.
 *
 * Services routinely mix pooled reads with a transaction in the same call, so
 * stubbing only one of the two silently exercises a half-mocked path. Prefer
 * this over calling `mockWithDbCall` and `mockWithDbTx` in sequence.
 */
export function mockWithDbAll(mockDb: Record<string, unknown>) {
  mockWithDbCall(mockDb);
  mockWithDbTx(mockDb);
}

/**
 * Link a VALID agent session to a branch artifact.
 *
 * FEA-4225 made "≥1 valid linked session" a server-side ELIGIBILITY requirement
 * for the Branches corpus: remote evidence (a push webhook or PR) may enrich a
 * session-derived branch but is no longer sufficient provenance to place it in
 * the list, its counts, or its detail read. "Valid" is load-bearing — an
 * `ArtifactLink` whose source SESSION artifact has no `SessionDetail` row is an
 * orphaned/half-synced link and still does not count (FEA-4263).
 *
 * So an integration test that asserts a branch is VISIBLE must give it a
 * session. Tests that specifically exercise the orphaned-link case build the
 * link inline instead — see `branch-requires-session.integration.test.ts`.
 *
 * Safe to call inside `autoRollbackTransaction`; every write goes through the
 * ambient transaction and rolls back with it.
 *
 * @returns the id of the session artifact now linked to the branch
 */
export async function linkValidSessionToBranch(params: {
  organizationId: string;
  userId: string;
  branchArtifactId: string;
  /** Short label woven into the seeded record names to aid debugging. */
  label: string;
  sessionTimestamp?: Date;
  /**
   * Which session→target relationship the link records. Defaults to
   * `SessionBranch` (the session wrote the branch). Pass `SessionPr` for a
   * session→PR link — the kind the delivery/attribution readers select on.
   */
  linkKind?: SessionArtifactLinkKind;
  /** Exact metadata for identity-contract integration tests. */
  metadata?: Prisma.InputJsonObject;
  /** Cost/revision columns the seeded `SessionDetail` carries. */
  cost?: TestSessionCostColumns;
  endsWithError?: boolean | null;
  /** See `createTestSessionDetail`; omitted keeps the schema's `now()`. */
  lastSyncedAt?: Date;
}): Promise<string> {
  const { organizationId, userId, branchArtifactId, label } = params;
  const sessionArtifactId = await createTestSessionDetail({
    organizationId,
    userId,
    label,
    sessionTimestamp: params.sessionTimestamp,
    cost: params.cost,
    endsWithError: params.endsWithError,
    lastSyncedAt: params.lastSyncedAt,
  });
  await withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId,
        sourceId: sessionArtifactId,
        targetId: branchArtifactId,
        linkType: LinkType.RelatesTo,
        branchParticipation: BranchParticipationKind.Wrote,
        metadata: params.metadata ?? {
          linkKind: params.linkKind ?? SessionArtifactLinkKind.SessionBranch,
        },
      },
    })
  );
  return sessionArtifactId;
}

/**
 * The cost and derived-revision columns a seeded session carries.
 *
 * ISS-8515: `estimated_cost` no longer HAS a schema default, so omitting it would
 * now seed a NULL rather than a 0 — silently changing the measured cost basis for
 * every fixture that never mentioned cost (`SUM` ignores NULL, so those suites
 * stay green while meaning something different). `createTestSessionDetail`
 * therefore names `0` explicitly when the caller omits it, which is what keeps
 * "a caller that does not care about cost seeds the same row it always did" TRUE.
 *
 * `estimatedCost` is `number | null`, not `number | undefined`: `null` is now a
 * meaningful stored value ("never priced"), so a suite that wants to seed an
 * unknown cost must be able to ask for one.
 */
export type TestSessionCostColumns = {
  /** USD written to `SessionDetail.estimatedCost`. `null` = never priced. */
  estimatedCost?: number | null;
  /**
   * The opaque per-session billing mode the usage cost split classifies for a
   * row with no legacy loop ledger — see `@repo/api/src/types/billing-mode`. A metered
   * mode lands the row's spend in `apiEstimatedCost`, the LOC/$ divisor.
   */
  billingMode?: string;
  /** Parser revision stamp; `null` is the never-stamped (stale) shape. */
  dataRevision?: number | null;
  /** A staged chunked replacement that has not committed yet. */
  pendingChunkRevision?: number | null;
  /**
   * The rest of that staged sequence's identity. Seedable because the schema's
   * invariant is that all FOUR marker columns are NULL together (the fourth is
   * `pendingChunkAckContract` below), so a suite about the marker's lifecycle has
   * to write — and assert — the whole set rather than the revision alone.
   */
  pendingChunkTotal?: number | null;
  pendingChunkReceived?: number | null;
  /**
   * ISS-8602: which acknowledgement contract the producer that opened the staged
   * sequence speaks. Seedable — and seedable as `null` — because the sweep's
   * whole gate is this column, so a suite about it must be able to express the
   * pre-migration row as well as both live bands.
   */
  pendingChunkAckContract?: string | null;
};

/**
 * Seed one session artifact plus the `SessionDetail` row that makes it a real
 * session, with no links to anything — the no-push/no-merge shape.
 *
 * Extracted from {@link linkValidSessionToBranch} so a test needing an UNLINKED
 * session does not have to restate the artifact + compute-target + detail
 * sequence and drift from it.
 *
 * Safe to call inside `autoRollbackTransaction`; every write goes through the
 * ambient transaction and rolls back with it.
 *
 * @returns the id of the seeded session artifact
 */
export async function createTestSessionDetail(params: {
  organizationId: string;
  userId: string;
  /** Short label woven into the seeded record names to aid debugging. */
  label: string;
  sessionTimestamp?: Date;
  cost?: TestSessionCostColumns;
  /**
   * ISS-8858: the four columns a row's DISPLAYED status is derived from, so a
   * suite can seed a population that spans the whole displayed vocabulary rather
   * than only the `active` default. Every one is optional and every default is
   * the pre-ISS-8858 value, so existing callers seed exactly what they did.
   */
  status?: string;
  sessionEndedAt?: Date | null;
  awaitingInputSince?: Date | null;
  endsWithError?: boolean | null;
  /**
   * The staleness/window anchor, when it must differ from `sessionTimestamp` —
   * the reconciliation compares it against `sessionEndedAt`, so a suite about
   * ended-vs-resumed rows has to set the two independently.
   */
  lastActivityAt?: Date;
  /**
   * Server RECEIVE time, distinct from every session-time column above. The
   * schema defaults it to `now()`, so a suite about an age window measured on
   * ingest freshness cannot express its fixture without setting it.
   */
  lastSyncedAt?: Date;
  /** Positive editor-history proof for Sessions created by receipt-aware writers. */
  metadataActivityCoverageStartedAt?: Date | null;
}): Promise<string> {
  const { organizationId, userId, label } = params;
  const timestamp = params.sessionTimestamp ?? new Date("2026-05-15T00:00:00Z");
  // Unique-constraint safety across repeated calls within one test.
  const unique = randomUUID().slice(0, 8);

  return await withDb(async (db) => {
    const session = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.SESSION,
        name: `session-${label}-${unique}`,
        status: params.status ?? SESSION_STATUS.ACTIVE,
        // ISS-12251: the ingest create arm stamps the uploader as both Created
        // by and Owner (`session-slice-detail-write.ts`).
        createdById: userId,
        assigneeId: userId,
      },
      select: { id: true },
    });
    const computeTarget = await db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName: `machine-${label}-${unique}`,
        platform: "darwin",
      },
      select: { id: true },
    });
    // The SessionDetail row is what makes the link count as a real session.
    await db.sessionDetail.create({
      data: {
        artifactId: session.id,
        computeTargetId: computeTarget.id,
        externalSessionId: `ext-${label}-${unique}`,
        harness: "claude",
        sessionStartedAt: timestamp,
        sessionUpdatedAt: timestamp,
        // ISS-6463: NOT NULL. Seeded at the start time, matching what the ingest
        // writer's GREATEST floor produces for a session with no events.
        lastActivityAt: params.lastActivityAt ?? timestamp,
        ...(params.metadataActivityCoverageStartedAt === undefined
          ? {}
          : {
              metadataActivityCoverageStartedAt:
                params.metadataActivityCoverageStartedAt,
            }),
        ...(params.lastSyncedAt ? { lastSyncedAt: params.lastSyncedAt } : {}),
        sessionEndedAt: params.sessionEndedAt ?? null,
        awaitingInputSince: params.awaitingInputSince ?? null,
        endsWithError: params.endsWithError ?? null,
        ...params.cost,
        // ISS-8515: AFTER the spread, deliberately. Placed before it, a caller
        // that omits cost spreads `{ estimatedCost: undefined }` over this key,
        // Prisma reads `undefined` as not-provided, and — with the schema default
        // now gone — the row is seeded NULL: exactly the state this line exists to
        // prevent, and silent. Same reserved-key ordering rule the ingest's create
        // arm follows.
        estimatedCost:
          params.cost?.estimatedCost === undefined
            ? 0
            : params.cost.estimatedCost,
      },
      select: { artifactId: true },
    });
    return session.id;
  });
}

type AutoRollbackTransactionOptions = {
  maxWait?: number;
  timeout?: number;
  /**
   * Opt out of the ISS-11104 collapsed-boundary guard, with the reason stated
   * here at the call site. Legitimate only when joining the ambient transaction
   * IS the behaviour under test — never to quiet the guard on a case that
   * actually wants the real per-chunk boundaries.
   */
  ambientBoundaryCollapseAcceptedBecause?: string;
};

/**
 * Track committed integration-test organizations and delete their full graph.
 * Use when the production entry point must open its own transaction boundary.
 */
export function createCommittedTestOrganizationTracker() {
  const organizationIds = new Set<string>();
  return {
    async create(
      overrides?: Partial<OrganizationCreateInput>
    ): Promise<string> {
      const organizationId = await createTestOrganization(overrides);
      organizationIds.add(organizationId);
      return organizationId;
    },
    track(organizationId: string): void {
      organizationIds.add(organizationId);
    },
    run<Result>(run: () => Promise<Result>): Promise<Result> {
      return run();
    },
    async cleanup(): Promise<void> {
      for (const organizationId of organizationIds) {
        await deleteCommittedTestOrganization(organizationId);
      }
      organizationIds.clear();
    },
  };
}

async function deleteCommittedTestOrganization(
  organizationId: string
): Promise<void> {
  await withDb.tx(async (db) => {
    await db.artifact.deleteMany({ where: { organizationId } });
    await db.team.deleteMany({ where: { organizationId } });
    await db.project.deleteMany({ where: { organizationId } });
    await db.gitHubInstallation.deleteMany({ where: { organizationId } });
    await db.publicRepository.deleteMany({ where: { organizationId } });
    await db.tag.deleteMany({ where: { organizationId } });
    // `SessionTranscript.computeTarget` is onDelete: Restrict, so a suite that
    // planned a transcript blocks the compute-target delete below unless its
    // rows go first.
    await db.sessionTranscript.deleteMany({ where: { organizationId } });
    await db.computeTarget.deleteMany({ where: { organizationId } });
    await db.user.deleteMany({ where: { organizationId } });
    // `SlugCounter.organizationId` is a bare uuid column with no `@relation`,
    // so deleting the organization cascades nothing here. Any suite that drives
    // a production entry point through `generateSlug` leaves a counter row per
    // prefix behind forever otherwise.
    await db.slugCounter.deleteMany({ where: { organizationId } });
    await db.organization.deleteMany({ where: { id: organizationId } });
  });
}

/**
 * Wrap test code in a transaction that automatically rolls back.
 * Use this for integration tests to ensure test isolation without manual cleanup.
 *
 * @example
 * it("creates a user", async () => {
 *   await autoRollbackTransaction(async () => {
 *     const orgId = await createTestOrganization();
 *     const user = await usersService.create({ organizationId: orgId, ... });
 *     expect(user.id).toBeDefined();
 *   });
 *   // Transaction rolled back - no data persists
 * });
 *
 * Pass an explicit timeout for intentionally heavy integration cases that can
 * exceed Prisma's 5-second default under coverage instrumentation.
 *
 * ISS-11104 — WHAT THIS HARNESS CANNOT COVER. The one ambient transaction it
 * opens absorbs every nested `withDb.tx`, whose `maxWait`/`timeout` are then
 * discarded (`packages/database/index.ts`). A service that deliberately opens
 * one short transaction per chunk therefore runs as ONE `BEGIN … ROLLBACK`, so
 * the case cannot fail if those boundaries are deleted — the single property
 * they exist for. A case whose production path DECLARES a nested budget now
 * FAILS here, naming the call site. Fix it by moving the case onto
 * `createCommittedTestOrganizationTracker`, whose docstring names exactly this
 * need, or — when joining IS the behaviour under test — state why with
 * `ambientBoundaryCollapseAcceptedBecause`.
 *
 * READ THE BOUND BEFORE TRUSTING A GREEN. The guard keys on a DECLARED BUDGET,
 * not on the boundary itself, because the ambient join is only observable where
 * it had something to discard. A bare `withDb.tx(fn)` with no `maxWait`/
 * `timeout` joins just as silently and reports NOTHING — so a suite driving
 * `purgePhantomSessionsBatch` (agent-sessions/phantom-retention-service.ts),
 * or either per-batch loop in agent-sessions/retention-service.ts collapses a
 * real per-batch boundary and stays green. Those are bare by design and out of this guard's reach; widening the
 * report to every ambient join would fail most of the integration tier at once
 * and is a separate cutover, not a gap in what is asserted below.
 *
 * WHERE COMMITTED COVERAGE EXISTS, so a reader can tell a stated gap from a
 * closed one. Two boundaries are pinned by their own committed fixtures: the
 * blocked-dependent per-chunk one
 * (app/documents/blocked-dependent-unblock-chunk-boundary.integration.test.ts,
 * ISS-11104) and the session-sync per-session one
 * (app/agent-sessions/service/upsert-sessions-batch-commit-boundary.integration.test.ts,
 * ISS-11312). `refreshBranchAnalyticsRollupBatch` and the stale-session reaper
 * still have none, and their opt-out reason strings say so in those words.
 * ISS-11312 left the AUDIT's numbers exactly where #7982 measured them — 15
 * budget-passing production call sites, four bare ones named above — because it
 * added no production call site and changed none; it closed a coverage gap, not
 * a reporting one.
 */
export async function autoRollbackTransaction<T>(
  fn: () => Promise<T>,
  options?: AutoRollbackTransactionOptions
): Promise<T> {
  const discards: AmbientTransactionOptionsDiscard[] = [];
  const stopObserving = observeAmbientTransactionOptionDiscards((discard) => {
    discards.push(discard);
  });
  let result: T;
  try {
    result = await runRollingBackTransaction(fn, options);
  } finally {
    stopObserving();
  }
  assertNoCollapsedTransactionBoundary(discards, options);
  return result;
}

/**
 * A pre-reasoned `autoRollbackTransaction` for a suite whose cases deliberately
 * let the ambient transaction absorb a nested one — the reason stated ONCE at
 * the top of the file instead of copy-pasted onto every case (ISS-11104).
 *
 * Legitimate only when the per-chunk/per-batch boundary is not what those cases
 * assert. It is NOT a way to quiet the guard on a suite that does assert it:
 * that suite belongs on `createCommittedTestOrganizationTracker`, and the
 * reason string is what a reviewer reads to tell the two apart.
 *
 * BIND IT TO A DISTINCT NAME — `joinAmbientTransaction`, by convention here —
 * and never to `autoRollbackTransaction`. Shadowing the guarded name would
 * silently pre-approve every case a later author adds to the file, including one
 * written specifically to cover the boundary, which re-opens the exact blindness
 * this guard closes. Bound to its own name, a new case that reaches for
 * `autoRollbackTransaction` gets the guard.
 */
export function autoRollbackTransactionJoining(
  reason: string
): <T>(
  fn: () => Promise<T>,
  options?: AutoRollbackTransactionOptions
) => Promise<T> {
  if (reason.trim().length === 0) {
    throw new Error(
      "autoRollbackTransactionJoining: state why the ambient transaction is correct for this suite — an empty reason is the silent collapse ISS-11104 closed."
    );
  }
  return (fn, options) =>
    autoRollbackTransaction(fn, {
      ...options,
      ambientBoundaryCollapseAcceptedBecause: reason,
    });
}

async function runRollingBackTransaction<T>(
  fn: () => Promise<T>,
  options?: AutoRollbackTransactionOptions
): Promise<T> {
  try {
    return await withDb.tx(async () => {
      const result = await fn();
      throw new TestTransactionRollback(result);
    }, options);
  } catch (e) {
    if (e instanceof TestTransactionRollback) {
      return e.result as T;
    }
    throw e;
  }
}

/**
 * Fail a case whose production path opened a transaction boundary this wrapper
 * swallowed. Runs only after the body succeeded, so a real assertion failure is
 * never masked by this one.
 *
 * The acceptance reason must carry actual text: a blank or whitespace-only
 * string is truthy and would wave the guard through on nothing at all, which is
 * the silent collapse this exists to stop.
 */
function assertNoCollapsedTransactionBoundary(
  discards: readonly AmbientTransactionOptionsDiscard[],
  options?: AutoRollbackTransactionOptions
): void {
  if (
    discards.length === 0 ||
    (options?.ambientBoundaryCollapseAcceptedBecause ?? "").trim().length > 0
  ) {
    return;
  }
  const sites = discards
    .map((discard) => formatDiscardSite(discard))
    .join("\n");
  throw new Error(
    `autoRollbackTransaction: ${discards.length} nested withDb.tx call(s) asked for their own transaction budget and this wrapper's ambient transaction discarded it, so those boundaries did not exist and this case cannot fail if they are removed (ISS-11104). Move the case onto createCommittedTestOrganizationTracker, or pass ambientBoundaryCollapseAcceptedBecause: "<why joining is the behaviour under test>".\n${sites}`
  );
}

function formatDiscardSite(discard: AmbientTransactionOptionsDiscard): string {
  const asked = [
    discard.discarded.timeout === undefined
      ? null
      : `timeout=${discard.discarded.timeout}`,
    discard.discarded.maxWait === undefined
      ? null
      : `maxWait=${discard.discarded.maxWait}`,
  ]
    .filter((part) => part !== null)
    .join(" ");
  // Skip the frames that are always the same — the `withDb.tx` helper itself
  // and this file — so the site named is the PRODUCTION caller that asked for
  // its own budget, which is the thing a reader has to go and look at.
  const frame =
    discard.stack
      ?.split("\n")
      .find(
        (line) =>
          line.includes("at ") &&
          !line.includes("db-helpers") &&
          !line.includes("packages/database/")
      ) ?? "<no stack>";
  return `  - asked ${asked} ${frame.trim()}`;
}

/**
 * The session-sync suites' pre-reasoned joiner (ISS-11104).
 *
 * Bound ONCE here rather than re-stated in each of the 21 suites that declare it
 * while driving `upsertSessionsBatch`: every one of them asserts what the batch
 * WRITES, and none asserts the per-session commit boundary its slice loop opens.
 * Those 21 are not the whole population that drives the batch — several suites
 * drive it on a committed tracker instead and need no opt-out. Eight of them
 * when this was written, and deliberately NOT enumerated: a hand-kept list of
 * them goes stale the day the ninth lands, and the set is the one its own
 * predicate defines — a suite that reaches the session-sync batch while running
 * on `createCommittedTestOrganizationTracker` rather than declaring this joiner.
 * None of them asserts
 * the boundary either, which is why the fixture named below is its own file. Stated in
 * one place so that committed coverage for that boundary corrects one sentence
 * instead of leaving twenty stale copies behind — which is what ISS-11312 did.
 *
 * WHETHER ANY SUITE CAN NOW DROP IT WAS MEASURED, NOT ASSUMED, and none can.
 * The boundary is covered (see the reason string), but the fixture that covers
 * it does not make the opt-out redundant here: routing this joiner at the
 * GUARDED `autoRollbackTransaction` reds 21 of 21 files — 159 of 179 cases,
 * measured 2026-09-27 on the integration tier — because every one of them
 * reaches the slice loop's budgeted `withDb.tx`. The 20 cases that survive are
 * scattered across files rather than concentrated in one, and this helper is
 * bound per FILE, so no file can drop it today. It outlives its reason only when
 * a suite stops driving the batch, and that is what to re-measure then.
 */
export const joinAmbientTransactionForSessionSyncWrites =
  autoRollbackTransactionJoining(
    "these cases pin what the session-sync batch WRITES — upsert semantics, links, analytics, priority, repair — not the per-session commit boundary `upsertSessionsBatch` opens; that boundary has its own committed fixture in app/agent-sessions/service/upsert-sessions-batch-commit-boundary.integration.test.ts (ISS-11312)"
  );
