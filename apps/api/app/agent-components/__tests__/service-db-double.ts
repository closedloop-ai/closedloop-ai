/**
 * The service-level fake Prisma client: every delegate `listForOrg` and
 * `getDetailForOrg` touch, with empty defaults, plus the two derive-defaults the
 * suites rely on (the FK usage rollup and, ISS-4799, the ORPHAN usage lane).
 *
 * Extracted from `service.test.ts` so the ISS-4797/ISS-4799 facet-invariant suite
 * can drive the same production paths against the same double instead of
 * re-deriving one — and so the grandfathered `service.test.ts` shrinks rather
 * than grows as it accretes them.
 *
 * Not a test file: the vitest include pattern only collects `*.test.ts`.
 */

import { vi } from "vitest";
import {
  ensureInventorySpineDefault,
  isOrphanUsageRead,
  type OrphanUsageShape,
  resolveOrphanUsageGroupBy,
} from "./usage-lane-doubles";

// FEA-3467: `listForOrg`/`getDetailForOrg` issue a sibling
// `agentComponentSessionUsage.groupBy` instead of eagerly loading each row's
// nested `sessionUsages`. Tests still declare usage as per-row `sessionUsages`
// fixtures (they read clearly); this folds those into the grouped rows the DB
// would return — summing `invocationCount`, maxing `lastInvokedAt` per
// (component, session, branch) — so the fixtures stay the SSOT while exercising
// the grouped-rows path. Org scope mirrors `where.session.artifact.orgId`.
type NestedUsageFixture = {
  agentSessionId: string;
  invocationCount: number;
  gitBranch?: string;
  // ISS-4630: override the usage row's OWN (kind, key) so a fixture can model
  // usage FK-linked to one inventory row but divergent. Absent ⇒ matches the FK.
  usageComponentKind?: string;
  usageComponentKey?: string | null;
  // ISS-4635: errors ride the same grouped lane as invocations (optional).
  errorCount?: number;
  // FEA-3758: per-session harness so the rollup attributes the component's
  // harness from the sessions it ran in.
  harness?: string | null;
  lastInvokedAt?: Date | null;
  session?: { artifact?: { organizationId?: string } | null } | null;
};
type UsageGroupRow = {
  agentComponentId: string;
  // ISS-4630: the real groupBy carries the usage row's own (componentKind,
  // componentKey) so `foldFkUsageIntoMerged` attributes by it. The mock derives
  // them from the FK'd inventory row unless a fixture supplies a divergent one.
  componentKind: string | null;
  componentKey: string | null;
  agentSessionId: string;
  gitBranch: string;
  // FEA-3758: harness joins the grouping key in the real groupBy; the mock
  // mirrors that so each (component, session, branch, harness) tuple is one row.
  harness: string | null;
  // ISS-4635: mirrors identity.ts `UsageGroupRow._sum` — errors summed alongside
  // invocations so `errorRate` derives from the same fold as invocations.
  _sum: { invocationCount: number; errorCount: number };
  _max: { lastInvokedAt: Date | null };
};
function deriveUsageGroupBy(
  rows: Array<{
    id: string;
    componentKind?: string;
    componentKey?: string | null;
    sessionUsages?: NestedUsageFixture[];
  }>,
  organizationId: string | undefined
): UsageGroupRow[] {
  const groups = new Map<string, UsageGroupRow>();
  for (const row of rows) {
    for (const usage of row.sessionUsages ?? []) {
      if (
        organizationId !== undefined &&
        usage.session?.artifact?.organizationId !== organizationId
      ) {
        continue;
      }
      const gitBranch = usage.gitBranch ?? "";
      const harness = usage.harness ?? null;
      // ISS-4630: the usage row's own identity — overridable per fixture via
      // `usageComponentKind`/`usageComponentKey`; else the FK'd inventory row's.
      const componentKind =
        usage.usageComponentKind ?? row.componentKind ?? null;
      const componentKey = usage.usageComponentKey ?? row.componentKey ?? null;
      const mapKey = `${row.id}\u0000${componentKind ?? ""}\u0000${componentKey ?? ""}\u0000${usage.agentSessionId}\u0000${gitBranch}\u0000${harness ?? ""}`;
      const lastInvokedAt = usage.lastInvokedAt ?? null;
      const existing = groups.get(mapKey);
      if (existing) {
        existing._sum.invocationCount += usage.invocationCount;
        existing._sum.errorCount += usage.errorCount ?? 0;
        if (
          lastInvokedAt &&
          (!existing._max.lastInvokedAt ||
            lastInvokedAt > existing._max.lastInvokedAt)
        ) {
          existing._max.lastInvokedAt = lastInvokedAt;
        }
      } else {
        groups.set(mapKey, {
          agentComponentId: row.id,
          componentKind,
          componentKey,
          agentSessionId: usage.agentSessionId,
          gitBranch,
          harness,
          _sum: {
            invocationCount: usage.invocationCount,
            errorCount: usage.errorCount ?? 0,
          },
          _max: { lastInvokedAt },
        });
      }
    }
  }
  return [...groups.values()];
}

/**
 * The fake Prisma client {@link buildServiceDb} returns.
 *
 * Delegates are declared as loose mock bags rather than by their vitest `Mock`
 * types, for two reasons. The inferred type is not NAMEABLE outside this package
 * (it reaches into `@vitest/spy`, so `tsc` rejects it as non-portable), and it
 * would not be HONEST anyway: the built object mixes the defaults below,
 * per-case overrides, and two delegates installed at RUNTIME — the ISS-4797
 * inventory spine and the FEA-3467 usage rollup — so an inferred type reports
 * the defaults' shape and silently omits whichever mocks a case actually got.
 * That gap is what forced a per-call-site cast to read a recorded `groupBy`.
 *
 * The two delegates named explicitly are the ones suites reach into; both are
 * guaranteed to carry a `groupBy` by the time this returns. Read their recorded
 * calls through the `usage-lane-doubles` helpers (`inventorySpineCall`,
 * `orphanGroupByCalls`), which take exactly this shape.
 */
export type ServiceDbDouble = Record<string, unknown> & {
  agentComponent: Record<string, unknown>;
  agentComponentSessionUsage: Record<string, unknown>;
};

/**
 * ISS-4799: the LIST's orphan (null-FK) usage lane moved off
 * `agentComponentSessionUsage.findMany` onto an identity-capped `groupBy` pair
 * (spine + aggregate). Cases seed those rows HERE rather than through the
 * `findMany` mock, which now serves only the reads that still are row reads —
 * the DETAIL orphan read, the plugin child-usage read, and the per-session
 * version attribution read. A case that drives BOTH surfaces (the list ⇄ detail
 * parity tests) seeds the same rows in both places, which is the point: the two
 * lanes must agree over one population.
 */
export function buildServiceDb(
  db: Record<string, unknown>,
  orphanUsage: readonly OrphanUsageShape[] = []
): ServiceDbDouble {
  const dbWithDefaults = {
    agentComponent: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    agentComponentInvocation: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    // Content-hash version history (FEA-2923) — defaults to none so cases that
    // don't set it report an empty `versions` array.
    agentComponentVersion: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // Orphaned (null-FK) usage fold — defaults to none so existing cases that
    // don't set it keep their FK-linked-only totals. `groupBy` (the FEA-3467
    // usage rollup) is intentionally NOT defaulted here: the block below installs
    // the derive-default that folds each case's per-row `sessionUsages` fixtures
    // into the grouped rows the DB would return, unless the case supplies its own.
    agentComponentSessionUsage: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // F1 (FEA-3290, Slice 6): exact-fingerprint `DefinitionVersion` reads —
    // `findMany` backs the usage-session definitionHash resolution; defaults to
    // none so cases that don't link a version report definitionHash=null.
    definitionVersion: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // FEA-4098 (Slice 3): the authors (collaborators) lineage read; defaults to
    // none so cases that don't seed lineage report an empty authors set.
    definitionVersionEditor: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // F1 (FEA-3290, Slice 6): provenance occurrences read; defaults to none.
    sourceOccurrence: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    artifactLink: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // KLOC/$ local-git LOC + cost lookup — defaults to none so cases that
    // don't set it report locPerDollar=null (no fabricated metric).
    sessionDetail: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // FEA-4247: the read-time owner FALLBACK resolves observing compute-target
    // user ids to display names via `user.findMany`. Defaults to none so cases
    // that don't seed users resolve no fallback name — a row with empty lineage
    // and no resolvable observer keeps an honest-empty authors set. Cases that
    // exercise the fallback override this with the observing user rows.
    user: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    ...db,
  };
  // ISS-4797: the org inventory read now resolves an identity spine
  // (`agentComponent.groupBy`) before its row read, so every double needs one —
  // including the cases that override `agentComponent` with only `findMany`.
  ensureInventorySpineDefault(
    dbWithDefaults.agentComponent as Record<string, unknown>
  );
  // FEA-3467: the usage rollup `groupBy` must always resolve, even when a case
  // overrides `agentComponentSessionUsage` with only `findMany` (the orphan/
  // version reads). Unless a case supplies its own `groupBy`, install the
  // derive-default that folds the inventory rows' `sessionUsages` fixtures into
  // the grouped rows the DB would return. The service always fetches the
  // inventory rows (`agentComponent.findMany`) before this rollup, so their
  // resolved value is available here to derive from.
  const usageDelegate = dbWithDefaults.agentComponentSessionUsage as Record<
    string,
    unknown
  >;
  if (typeof usageDelegate.groupBy !== "function") {
    const inventoryDelegate = dbWithDefaults.agentComponent as {
      findMany: { mock: { results: Array<{ value: unknown }> } };
    };
    usageDelegate.groupBy = vi.fn(
      async (args?: {
        by?: string[];
        where?: {
          agentComponentId?: { in?: string[]; notIn?: string[] };
          session?: { artifact?: { organizationId?: string } };
        };
        take?: number;
      }) => {
        // ISS-4799: route the ORPHAN lane's two reads to the seeded orphan rows.
        // Answering them with the FK-derived groups instead would double-count
        // every FK-linked component as a synthetic orphan bucket.
        if (isOrphanUsageRead(args?.where)) {
          return resolveOrphanUsageGroupBy(orphanUsage, args);
        }
        const organizationId = args?.where?.session?.artifact?.organizationId;
        const inventoryCall = inventoryDelegate.findMany.mock.results[0];
        const inventoryRows = inventoryCall
          ? ((await inventoryCall.value) as Array<{
              id: string;
              sessionUsages?: NestedUsageFixture[];
            }>)
          : [];
        // ISS-5363: honor the `agentComponentId` predicate the real query has
        // always carried. The DETAIL now reads FK usage through TWO lanes — the
        // inventory-bounded one (`in`) and the own-identity one (`notIn`, for
        // rows FK-linked to another family) — which are disjoint in SQL. A
        // double that ignored the predicate answered BOTH with the same rows and
        // doubled every detail total, reporting a double-count the database
        // cannot produce.
        return deriveUsageGroupBy(
          filterRowsByFkPredicate(inventoryRows, args?.where?.agentComponentId),
          organizationId
        );
      }
    );
  }
  return dbWithDefaults;
}

// ---------------------------------------------------------------------------
// Shared inventory-row fixtures.
//
// Moved out of `service.test.ts` (ISS-4660) so a second suite can drive the same
// production paths against the same fixture shape instead of re-deriving one —
// and so the grandfathered `service.test.ts` shrinks rather than grows.
// ---------------------------------------------------------------------------

export function buildComputeTarget(
  id: string,
  userId: string,
  user: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null = {
    id: userId,
    firstName: "Ada",
    lastName: "Lovelace",
    email: `${userId}@example.com`,
  }
) {
  return { id, userId, user };
}

export function buildInventoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ac-uuid-1",
    organizationId: "org-1",
    computeTargetId: "target-1",
    componentKind: "skill",
    externalComponentId: "skill::my-skill",
    harness: "claude",
    name: "My Skill",
    componentKey: "my-skill",
    sourceUrl: null,
    installPath: null,
    packId: null,
    scope: null,
    projectPath: null,
    // F1 (FEA-3290, Slice 6): honest resolution; DB column default is
    // `unresolved`, so name-only/legacy rows are never surfaced as resolved.
    resolvedState: "unresolved",
    firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSeenAt: new Date("2026-01-10T00:00:00.000Z"),
    computeTarget: buildComputeTarget("target-1", "user-1"),
    sessionUsages: [],
    ...overrides,
  };
}

/**
 * ISS-5363: apply a Prisma `agentComponentId` `in`/`notIn` predicate to the
 * inventory rows the grouped-usage default derives from, so the double drops the
 * same groups SQL would. Absent predicate ⇒ every row, matching a query with no
 * FK bound.
 */
function filterRowsByFkPredicate<T extends { id: string }>(
  rows: readonly T[],
  idFilter: { in?: string[]; notIn?: string[] } | undefined
): T[] {
  if (!idFilter) {
    return [...rows];
  }
  return rows.filter((row) => {
    if (idFilter.in && !idFilter.in.includes(row.id)) {
      return false;
    }
    if (idFilter.notIn?.includes(row.id)) {
      return false;
    }
    return true;
  });
}
