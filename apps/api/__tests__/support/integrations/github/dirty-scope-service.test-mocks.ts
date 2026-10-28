/**
 * The hand-rolled Prisma client the `githubDirtyScopeService` unit test mocks
 * `@repo/database` with, plus its shapes and stateless matchers. Extracted from
 * the test file to keep it under the per-file line budget.
 *
 * Everything here is a pure function OF the mock state — `createMockDb` takes
 * it as {@link MockDbState}, the way `acquireAdvisoryLock` already took
 * {@link MockLockState}. The mutable state itself stays in the test file, where
 * `vi.hoisted` has to own it.
 *
 * Module-scoped support, so it mirrors the module it supports
 * (`app/integrations/github/dirty-scope-service.ts`) under `__tests__/support/`
 * and is imported through the `@/` alias — `apps/api/AGENTS.md`,
 * "Test-Support Placement".
 */
import {
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  GitHubDirtyScopeKind,
} from "@repo/api/src/types/github-dirty-scope";
import { vi } from "vitest";

export type DirtyScopeTarget = {
  id: string;
  /**
   * The org the desktop belongs to NOW, which the dispatch-time recheck
   * compares against the pending row's own `organizationId`. Carried here so a
   * test can move a desktop between preparation and dispatch.
   */
  organizationId: string;
  gatewayId: string | null;
  isOnline: boolean;
  isSharedWithOrg: boolean;
  supportedOperations: unknown;
};

export type DirtyScopeRow = {
  id: string;
  organizationId: string;
  githubInstallationRepositoryId: string;
  computeTargetId: string;
  windowStartedAt: Date;
  dirtyScopes: unknown;
  genericRefresh: boolean;
  scheduledDispatchAt: Date;
  dispatchClaimedAt: Date | null;
  dispatchedAt: Date | null;
  expiresAt: Date;
  deliveryResult: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type UniqueKey = {
  organizationId: string;
  githubInstallationRepositoryId: string;
  computeTargetId: string;
  windowStartedAt: Date;
};

export type CreateManyRow = Omit<
  DirtyScopeRow,
  | "id"
  | "dispatchClaimedAt"
  | "dispatchedAt"
  | "deliveryResult"
  | "createdAt"
  | "updatedAt"
>;
export type CreateManyArgs = {
  data: CreateManyRow[];
  skipDuplicates?: boolean;
};
export type WindowWhere = {
  organizationId: string;
  githubInstallationRepositoryId: string;
  windowStartedAt: Date;
  computeTargetId: { in: string[] };
};
export type MockSql = { strings: TemplateStringsArray; values: unknown[] };
export type WindowFindManyArgs = { where: WindowWhere };
export type FindManyArgs = {
  /**
   * The due read's projection (ISS-8973). Honoured, and `include` alongside it,
   * so the mock hands the drain exactly the columns production asked for:
   * everything the delivery needs comes back from the CLAIM now, and a mock
   * that supplied the `computeTarget` join here regardless would keep a
   * stale-snapshot recheck green.
   */
  select?: { id: true };
  include?: {
    computeTarget: {
      select: {
        organizationId: true;
        supportedOperations: true;
      };
    };
  };
  /**
   * Honoured, with NO default (ISS-8973). Two earlier shapes both left every
   * re-paging test blind to `GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE`: a hardcoded
   * `slice(0, 100)`, and then a `?? 100` default — a default equal to the real
   * value is indistinguishable from honouring it, so deleting `take` from the
   * production read stayed green while Prisma would have emitted no LIMIT and
   * loaded the whole due set. Absent means unbounded here, as it does in Prisma.
   */
  take?: number;
  /**
   * Honoured, and only applied when present (ISS-8973). Sorting unconditionally
   * was the same defect one level down: the mock ordered rows production had
   * not asked it to order, so deleting `orderBy` from the due read stayed green.
   */
  orderBy?: { createdAt: "asc" };
  where: {
    computeTargetId?: string;
    organizationId?: string;
    githubInstallationRepositoryId?: string;
    OR?: DirtyScopeClaimWhere[];
    scheduledDispatchAt: { lte: Date };
    expiresAt: { gt: Date };
  };
};
export type ComputeTargetFindManyArgs = {
  where: {
    id?: { in: string[] };
    isOnline?: boolean;
    isSharedWithOrg?: boolean;
    organizationId?: string;
  };
};
export type DeleteManyArgs = {
  where: {
    expiresAt?: { lt: Date };
  };
};
export type UpdateManyWhere =
  | WindowWhere
  | {
      /** A page-wide claim or settle addresses its rows as a set (ISS-8973). */
      id?: string | { in: string[] };
      /**
       * The settle's claim-ownership predicate: a batched write must touch only
       * rows still holding THIS drain's claim (ISS-8973). Emulated here, or a
       * test could not tell a stomp from a correct write.
       */
      dispatchClaimedAt?: Date;
      dispatchedAt?: Date | null;
      OR?: DirtyScopeClaimWhere[];
      scheduledDispatchAt?: { lte: Date };
      expiresAt?: { gt: Date };
    };
export type DirtyScopeClaimWhere = {
  dispatchClaimedAt: null | { lt: Date };
};
export type UpdateManyArgs = {
  where: UpdateManyWhere;
  data: Partial<DirtyScopeRow>;
};
export type UpdateArgs = {
  where: { id: string };
  data: Partial<DirtyScopeRow>;
};
/** What the claim returns: the row, plus the join the recheck reads. */
export type ClaimedDirtyScopeRow = DirtyScopeRow & {
  computeTarget: {
    // The stored column, deliberately supplied although the claim no longer
    // selects it: a nudge body that stamped it again must turn a suite red.
    gatewayId: string | null;
    organizationId: string;
    supportedOperations: unknown;
  };
};
export type UpdateManyAndReturnArgs = UpdateManyArgs & {
  include: {
    computeTarget: {
      select: {
        organizationId: true;
        supportedOperations: true;
      };
    };
  };
};
export type MockDb = {
  $executeRaw: ReturnType<typeof vi.fn>;
  computeTarget: {
    findMany: ReturnType<typeof vi.fn>;
  };
  gitHubDirtyScopeNudge: {
    deleteMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    updateManyAndReturn: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

/** The org every suite publishes for, so an override is the interesting case. */
export const DIRTY_SCOPE_ORG_ID = "org-1";

export function makeTarget(
  id: string,
  overrides: Partial<DirtyScopeTarget> = {}
): DirtyScopeTarget {
  return {
    id,
    organizationId: DIRTY_SCOPE_ORG_ID,
    gatewayId: `${id}-gateway`,
    isOnline: true,
    isSharedWithOrg: true,
    supportedOperations: [GITHUB_RESYNC_NUDGE_OPERATION_ID],
    ...overrides,
  };
}

export function rowMatchesUnique(row: DirtyScopeRow, key: UniqueKey): boolean {
  return (
    row.organizationId === key.organizationId &&
    row.githubInstallationRepositoryId === key.githubInstallationRepositoryId &&
    row.computeTargetId === key.computeTargetId &&
    row.windowStartedAt.getTime() === key.windowStartedAt.getTime()
  );
}

export function isWindowFindMany(
  args: FindManyArgs | WindowFindManyArgs
): args is WindowFindManyArgs {
  return "windowStartedAt" in args.where;
}

export function rowMatchesWindow(
  row: DirtyScopeRow,
  where: WindowWhere
): boolean {
  return (
    row.organizationId === where.organizationId &&
    row.githubInstallationRepositoryId ===
      where.githubInstallationRepositoryId &&
    row.windowStartedAt.getTime() === where.windowStartedAt.getTime() &&
    where.computeTargetId.in.includes(row.computeTargetId)
  );
}

export function rowMatchesWhere(
  row: DirtyScopeRow,
  where: UpdateManyWhere
): boolean {
  if ("windowStartedAt" in where) {
    return rowMatchesWindow(row, where);
  }
  if (where.id && !matchesIdPredicate(row.id, where.id)) {
    return false;
  }
  if (
    where.dispatchClaimedAt &&
    row.dispatchClaimedAt?.getTime() !== where.dispatchClaimedAt.getTime()
  ) {
    return false;
  }
  if (
    Object.hasOwn(where, "dispatchedAt") &&
    row.dispatchedAt !== where.dispatchedAt
  ) {
    return false;
  }
  if (where.OR && !isUnclaimedOrStale(row, where.OR)) {
    return false;
  }
  if (
    where.scheduledDispatchAt &&
    row.scheduledDispatchAt > where.scheduledDispatchAt.lte
  ) {
    return false;
  }
  if (where.expiresAt && row.expiresAt <= where.expiresAt.gt) {
    return false;
  }
  return true;
}

export function isUnclaimedOrStale(
  row: DirtyScopeRow,
  clauses: DirtyScopeClaimWhere[] | undefined
): boolean {
  if (!clauses) {
    return true;
  }
  return clauses.some((clause) => {
    if (
      Object.hasOwn(clause, "dispatchClaimedAt") &&
      clause.dispatchClaimedAt === null
    ) {
      return row.dispatchClaimedAt === null;
    }
    return Boolean(
      clause.dispatchClaimedAt?.lt &&
        row.dispatchClaimedAt &&
        row.dispatchClaimedAt < clause.dispatchClaimedAt.lt
    );
  });
}

export function makeDirtyScopeRow(
  overrides: Partial<DirtyScopeRow> = {}
): DirtyScopeRow {
  const now = new Date("2026-07-06T09:00:00.000Z");
  return {
    id: "row-manual",
    organizationId: "org-1",
    githubInstallationRepositoryId: "repo-1",
    computeTargetId: "target-1",
    windowStartedAt: now,
    dirtyScopes: [
      { kind: GitHubDirtyScopeKind.Repository, repositoryId: "repo-1" },
    ],
    genericRefresh: false,
    scheduledDispatchAt: now,
    dispatchClaimedAt: null,
    dispatchedAt: null,
    expiresAt: new Date(now.getTime() + 60_000),
    deliveryResult: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * The keys the production `pg_advisory_xact_lock` statement is asked for. Read
 * out of the interpolated value rather than assumed, so the mock serializes on
 * exactly what Postgres would.
 */
export function advisoryLockKeys(query: MockSql): string[] {
  const keys = query.values.at(0);
  if (!Array.isArray(keys)) {
    throw new Error("advisory lock called without a key array");
  }
  return keys.map((key) => {
    if (typeof key !== "string") {
      throw new Error("advisory lock called without a string key");
    }
    return key;
  });
}

/**
 * What Postgres raises when an inserted nudge references a desktop that has
 * been deleted: the statement, and so the whole transaction, aborts. Prisma
 * surfaces the foreign-key violation as P2003.
 */
export function computeTargetForeignKeyError(computeTargetId: string): Error {
  return Object.assign(
    new Error(
      `Foreign key constraint violated on the constraint: github_dirty_scope_nudges_compute_target_id_fkey (${computeTargetId})`
    ),
    { code: "P2003" }
  );
}

/**
 * The mutable mock state the advisory-lock emulation reads. Structural, so the
 * test's `vi.hoisted` state — which owns more than this — still satisfies it.
 */
export type MockLockState = {
  lockTails: Map<string, Promise<void>>;
  counts: { heldLocks: number; peakHeldLocks: number };
};

/**
 * Emulate `pg_advisory_xact_lock`: queue behind every writer already holding
 * this exact key, and hand back the release the transaction runs on exit.
 */
export async function acquireAdvisoryLock(
  key: string,
  state: MockLockState
): Promise<() => void> {
  const previous = state.lockTails.get(key) ?? Promise.resolve();
  let releaseNext: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  state.lockTails.set(
    key,
    previous.then(() => held)
  );
  await previous;
  state.counts.heldLocks += 1;
  state.counts.peakHeldLocks = Math.max(
    state.counts.peakHeldLocks,
    state.counts.heldLocks
  );
  return () => {
    state.counts.heldLocks -= 1;
    releaseNext();
  };
}

/**
 * The mutable mock state `createMockDb` reads and writes. Structural, like
 * {@link MockLockState}, so the test's `vi.hoisted` object — which owns more
 * than this — satisfies it without the state itself moving out of the test
 * file, where `vi.hoisted` still has to own it.
 */
export type MockDbState = MockLockState & {
  rows: DirtyScopeRow[];
  targets: DirtyScopeTarget[];
  lockKeys: string[];
  counts: MockLockState["counts"] & {
    targetReads: number;
    expirySweeps: number;
    writeTransactions: number;
    /**
     * Every statement issued against the nudge table, across every client
     * (one is built per `withDb` call), so a drain's per-page statement cost is
     * observable rather than inferred (ISS-8973).
     */
    nudgeStatements: number;
  };
  /**
   * Errors to throw from the next `updateMany` calls, shifted one per call
   * (ISS-8973). Lets a test drive a settle that fails without the whole page
   * failing with it.
   */
  updateManyErrors?: Error[];
  /**
   * Run after the due read returns, before the drain claims those rows
   * (ISS-8973). The only seam a test has for moving a desktop INSIDE the claim
   * window, which is what decides whether the eligibility recheck reads
   * pre-claim or post-claim target state.
   */
  afterDueRead?: () => void;
};

/**
 * A hand-rolled Prisma client over {@link MockDbState}, built fresh per
 * `withDb` call so a fan-out's total round trips stay countable.
 */
export function createMockDb(
  mockState: MockDbState,
  heldLocks: Array<() => void>
): MockDb {
  const db: MockDb = {
    $executeRaw: vi.fn(async (query: MockSql) => {
      for (const key of advisoryLockKeys(query)) {
        mockState.lockKeys.push(key);
        heldLocks.push(await acquireAdvisoryLock(key, mockState));
      }
      return 1;
    }),
    computeTarget: {
      findMany: vi.fn(({ where }: ComputeTargetFindManyArgs) => {
        mockState.counts.targetReads += 1;
        return Promise.resolve(
          mockState.targets.filter(
            (target) =>
              (!Object.hasOwn(where, "isOnline") ||
                target.isOnline === where.isOnline) &&
              (!Object.hasOwn(where, "isSharedWithOrg") ||
                target.isSharedWithOrg === where.isSharedWithOrg) &&
              (!where.organizationId ||
                target.organizationId === where.organizationId) &&
              (!where.id || where.id.in.includes(target.id))
          )
        );
      }),
    },
    gitHubDirtyScopeNudge: {
      deleteMany: vi.fn(({ where }: DeleteManyArgs) => {
        mockState.counts.nudgeStatements += 1;
        mockState.counts.expirySweeps += 1;
        const before = mockState.rows.length;
        const retained = mockState.rows.filter(
          (row) => !(where.expiresAt && row.expiresAt < where.expiresAt.lt)
        );
        mockState.rows.splice(0, mockState.rows.length, ...retained);
        return { count: before - retained.length };
      }),
      createMany: vi.fn(({ data, skipDuplicates }: CreateManyArgs) => {
        mockState.counts.nudgeStatements += 1;
        let count = 0;
        for (const create of data) {
          if (
            !mockState.targets.some(
              (target) => target.id === create.computeTargetId
            )
          ) {
            throw computeTargetForeignKeyError(create.computeTargetId);
          }
          if (mockState.rows.some((row) => rowMatchesUnique(row, create))) {
            if (skipDuplicates) {
              continue;
            }
            // What Postgres does without ON CONFLICT: the whole statement — and
            // so the chunk's nudges — is lost.
            throw new Error(
              "Unique constraint failed on github_dirty_scope_nudges_org_repo_target_window_key"
            );
          }
          mockState.rows.push({
            id: `row-${mockState.rows.length + 1}`,
            organizationId: create.organizationId,
            githubInstallationRepositoryId:
              create.githubInstallationRepositoryId,
            computeTargetId: create.computeTargetId,
            windowStartedAt: create.windowStartedAt,
            dirtyScopes: create.dirtyScopes,
            genericRefresh: create.genericRefresh,
            scheduledDispatchAt: create.scheduledDispatchAt,
            dispatchClaimedAt: null,
            dispatchedAt: null,
            expiresAt: create.expiresAt,
            deliveryResult: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          count += 1;
        }
        return { count };
      }),
      findMany: vi.fn((args: FindManyArgs | WindowFindManyArgs) => {
        mockState.counts.nudgeStatements += 1;
        if (isWindowFindMany(args)) {
          return mockState.rows.filter((row) =>
            rowMatchesWindow(row, args.where)
          );
        }
        const { where } = args;
        const due = mockState.rows
          .filter(
            (row) =>
              row.dispatchedAt === null &&
              isUnclaimedOrStale(row, where.OR) &&
              row.scheduledDispatchAt <= where.scheduledDispatchAt.lte &&
              row.expiresAt > where.expiresAt.gt &&
              (!where.computeTargetId ||
                row.computeTargetId === where.computeTargetId) &&
              (!where.organizationId ||
                row.organizationId === where.organizationId) &&
              (!where.githubInstallationRepositoryId ||
                row.githubInstallationRepositoryId ===
                  where.githubInstallationRepositoryId)
          )
          .sort(args.orderBy ? byCreatedAtAscending : keepInsertionOrder)
          .slice(0, args.take ?? Number.POSITIVE_INFINITY)
          .map((row) =>
            args.include ? withComputeTarget(mockState, row) : { id: row.id }
          );
        mockState.afterDueRead?.();
        return due;
      }),
      updateMany: vi.fn(({ where, data }: UpdateManyArgs) => {
        mockState.counts.nudgeStatements += 1;
        const failure = mockState.updateManyErrors?.shift();
        if (failure) {
          throw failure;
        }
        return { count: applyUpdateMany(mockState, where, data).length };
      }),
      // Postgres re-evaluates the predicate per row, so what comes back is the
      // rows THIS statement updated — which is what the set-based claim reads
      // to decide the page it owns (ISS-8973).
      updateManyAndReturn: vi.fn(({ where, data }: UpdateManyAndReturnArgs) => {
        mockState.counts.nudgeStatements += 1;
        return applyUpdateMany(mockState, where, data).map((row) =>
          withComputeTarget(mockState, row)
        );
      }),
      update: vi.fn(({ where, data }: UpdateArgs) => {
        mockState.counts.nudgeStatements += 1;
        const row = mockState.rows.find(
          (candidate) => candidate.id === where.id
        );
        if (!row) {
          throw new Error("row not found");
        }
        Object.assign(row, data);
        return row;
      }),
    },
  };
  return db;
}

/** What an unordered `findMany` gets: `Array#sort` is stable, so nothing moves. */
function keepInsertionOrder(): number {
  return 0;
}

/**
 * The due read's `orderBy` (ISS-8973). Emulated because it decides which rows
 * fall on a page BOUNDARY: without it the mock pages in insertion order while
 * production pages by `created_at`, so a case built around a full page proves
 * nothing about the page production would actually read. `Array#sort` is
 * stable, so rows that tie keep insertion order.
 */
function byCreatedAtAscending(
  left: DirtyScopeRow,
  right: DirtyScopeRow
): number {
  return left.createdAt.getTime() - right.createdAt.getTime();
}

/** A row id predicate, either the single-row form or a set (ISS-8973). */
function matchesIdPredicate(
  id: string,
  predicate: string | { in: string[] }
): boolean {
  return typeof predicate === "string"
    ? id === predicate
    : predicate.in.includes(id);
}

/**
 * A claimed row with the join the dispatcher rechecks eligibility from —
 * projected from the CURRENT target, so a desktop moved between the due read
 * and the claim is what the recheck sees (ISS-8973).
 */
function withComputeTarget(
  mockState: MockDbState,
  row: DirtyScopeRow
): ClaimedDirtyScopeRow {
  const target = mockState.targets.find(
    (candidate) => candidate.id === row.computeTargetId
  );
  return {
    ...row,
    computeTarget: {
      gatewayId: target?.gatewayId ?? null,
      organizationId: target?.organizationId ?? row.organizationId,
      supportedOperations: target?.supportedOperations ?? [],
    },
  };
}

/** The rows an `updateMany`-shaped statement matched, after applying `data`. */
function applyUpdateMany(
  mockState: MockDbState,
  where: UpdateManyWhere,
  data: Partial<DirtyScopeRow>
): DirtyScopeRow[] {
  const matched = mockState.rows.filter((row) => rowMatchesWhere(row, where));
  for (const row of matched) {
    Object.assign(row, data);
  }
  return matched;
}
