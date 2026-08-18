import type { BranchPageDetail } from "@repo/api/src/types/branch";
import type { BranchUsageActorBucket } from "@repo/api/src/types/branch-usage";
import type { PrismaClient } from "@repo/database";
import { displayUserName } from "@/lib/user-display-name";
import type { SessionUsage, UsageTotals } from "./session-usage-window";

/**
 * Branch owner attribution (FEA-3457 / FEA-3576): which human a branch and each
 * of its sessions is credited to, and the per-owner usage rollup that facets
 * from it. Split out of `branch-read-service.ts`, which consumes these helpers
 * from its list, detail, and usage paths.
 */

/** The Prisma surface this concern reads — only the org-scoped User lookup. */
type BranchOwnerReadClient = Pick<PrismaClient, "user">;

/**
 * The most-frequent owner `user_id` across a branch's linked sessions, or null.
 * Ties break on first-seen insertion order (Map iteration), matching the desktop
 * producer's `dominantOwnerUserId` (apps/desktop/src/main/branch/shared-branches-api.ts)
 * so the two surfaces pick the same owner for the same links.
 */
export function dominantOwnerUserId(
  counts: Map<string, number>
): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [userId, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = userId;
    }
  }
  return best;
}

/**
 * Resolve a set of owner `user_id`s to their org display names in ONE query
 * (FEA-3457). Called once per page with every distinct dominant owner id, so
 * the list path never issues a per-branch (N+1) User read. STRICTLY org-scoped:
 * `organizationId` is ANDed into the WHERE, so an owner id that belongs to
 * another org (never expected — sessions are org-scoped — but defended anyway)
 * resolves to null (unattributed) rather than leaking a cross-org identity.
 * Display name mirrors the sessions service's `displayUserName` (full name, then
 * a name part, then email) so the same user reads identically on both surfaces.
 */
export async function resolveOwnerNames(
  db: BranchOwnerReadClient,
  organizationId: string,
  userIds: Iterable<string>
): Promise<Map<string, string>> {
  const distinct = [...new Set(userIds)];
  const names = new Map<string, string>();
  if (distinct.length === 0) {
    return names;
  }
  const users = await db.user.findMany({
    where: { id: { in: distinct }, organizationId },
    select: { id: true, email: true, firstName: true, lastName: true },
  });
  for (const user of users) {
    names.set(user.id, displayUserName(user));
  }
  return names;
}

/**
 * FEA-3576 — stamp each `detail.sessions[]` row with its HUMAN owner's display
 * name so the branch PR-activity timeline segments each hour by user spend. The
 * per-session owner ids live on `usage.sessionOwnerById` (session artifact id →
 * `SessionDetail.userId`); resolve the DISTINCT ids to names in ONE org-scoped
 * User query (no N+1, and no cross-org identity leak — `resolveOwnerNames` ANDs
 * `organizationId`), then set each matching session's `ownerUserName`. A session
 * with no owner id, or one that does not resolve (unknown / cross-org), keeps its
 * null placeholder and folds into the timeline's shared "unattributed" bucket.
 * Mutates `detail.sessions` in place.
 */
export function attachSessionOwnerNames(
  usage: SessionUsage,
  detail: BranchPageDetail,
  nameById: Map<string, string>
): void {
  for (const session of detail.sessions) {
    const ownerId = usage.sessionOwnerById.get(session.sessionId) ?? null;
    session.ownerUserId = ownerId;
    session.ownerUserName = ownerId ? (nameById.get(ownerId) ?? null) : null;
  }
}

/**
 * The DISTINCT owner user ids referenced by a set of branches' usage — the union
 * of each branch's dominant owner id AND every session's per-owner id
 * (`sessionOwnerById`). Resolving this union in ONE `resolveOwnerNames` call feeds
 * both the branch-header `owner` and each session's `ownerUserName` from a single
 * org-scoped User query, instead of two sequential lookups over overlapping id
 * sets. Null owner ids (ownerless sessions) are excluded.
 */
export function collectBranchOwnerIds(
  usageByBranch: Map<string, SessionUsage>
): Set<string> {
  const ownerIds = new Set<string>();
  for (const usage of usageByBranch.values()) {
    const dominant = dominantOwnerUserId(usage.ownerCounts);
    if (dominant) {
      ownerIds.add(dominant);
    }
    for (const ownerId of usage.sessionOwnerById.values()) {
      if (ownerId) {
        ownerIds.add(ownerId);
      }
    }
  }
  return ownerIds;
}

/**
 * Derive each branch's dominant-owner DISPLAY NAME from an already-resolved
 * id→name map (see `collectBranchOwnerIds`). Returns a branch-id → owner-name map;
 * a branch whose dominant owner is unknown/cross-org (absent from `nameById`) is
 * simply absent (owner stays null → "unattributed").
 */
export function deriveBranchOwnerNames(
  usageByBranch: Map<string, SessionUsage>,
  nameById: Map<string, string>
): Map<string, string> {
  const ownerByBranch = new Map<string, string>();
  for (const [branchId, usage] of usageByBranch) {
    const dominant = dominantOwnerUserId(usage.ownerCounts);
    if (!dominant) {
      continue;
    }
    const name = nameById.get(dominant);
    if (name) {
      ownerByBranch.set(branchId, name);
    }
  }
  return ownerByBranch;
}

/**
 * Resolve each branch's dominant owner to a display name, batching the User
 * lookup across the whole page (no N+1). Returns a branch-id → owner-name map;
 * a branch whose dominant owner is unknown/cross-org is simply absent (owner
 * stays null → "unattributed"). Used by the LIST/USAGE paths, which need only the
 * dominant owner (not per-session names); the DETAIL path unions the two id sets
 * (`collectBranchOwnerIds` + `deriveBranchOwnerNames`) into one query instead.
 */
export async function resolveBranchOwnerNames(
  db: BranchOwnerReadClient,
  organizationId: string,
  usageByBranch: Map<string, SessionUsage>
): Promise<Map<string, string>> {
  const distinctOwnerIds = new Set<string>();
  for (const usage of usageByBranch.values()) {
    const dominant = dominantOwnerUserId(usage.ownerCounts);
    if (dominant) {
      distinctOwnerIds.add(dominant);
    }
  }
  const nameById = await resolveOwnerNames(
    db,
    organizationId,
    distinctOwnerIds
  );
  return deriveBranchOwnerNames(usageByBranch, nameById);
}

/**
 * The per-owner usage rollup (`byActor`, FEA-3457): each DISTINCT session across
 * the corpus contributes its tokens/cost ONCE, grouped by its owner's resolved
 * display name. Owner ids are resolved in ONE org-scoped User query (no N+1);
 * sessions with no owner (or an unresolved / cross-org owner) fold into a single
 * `owner: null` unattributed bucket. Buckets are ordered by cost desc, with the
 * unattributed bucket last, for a stable, useful facet order.
 */
export async function buildBranchByActor(
  db: BranchOwnerReadClient,
  organizationId: string,
  usageByBranch: Map<string, SessionUsage>
): Promise<BranchUsageActorBucket[]> {
  // Fold each distinct session's usage under its owner id (null = unattributed),
  // counting a session once even if several branches (or links) reference it.
  const totalsByOwner = new Map<string | null, UsageTotals>();
  const seen = new Set<string>();
  for (const usage of usageByBranch.values()) {
    for (const session of usage.sessions) {
      if (seen.has(session.sessionId)) {
        continue;
      }
      seen.add(session.sessionId);
      const ownerId = usage.sessionOwnerById.get(session.sessionId) ?? null;
      const bucket = totalsByOwner.get(ownerId) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
      };
      bucket.inputTokens += session.inputTokens;
      bucket.outputTokens += session.outputTokens;
      bucket.cacheReadTokens += session.cacheReadTokens;
      bucket.cacheWriteTokens += session.cacheWriteTokens;
      bucket.estimatedCostUsd += session.estimatedCostUsd ?? 0;
      totalsByOwner.set(ownerId, bucket);
    }
  }
  const ownerIds = [...totalsByOwner.keys()].filter(
    (id): id is string => id !== null
  );
  const nameById = await resolveOwnerNames(db, organizationId, ownerIds);
  // Emit ONE bucket per RESOLVED owner id (never merged by display name, so two
  // distinct users who happen to share a name stay separate and are not
  // double-counted). Only the unattributed rows fold together: a null owner id,
  // OR a non-null id that did not resolve (unknown / cross-org) — those all
  // accumulate into the single `owner: null` bucket so the byActor totals still
  // reconcile with the corpus total.
  const buckets: BranchUsageActorBucket[] = [];
  const unattributed: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
  };
  let hasUnattributed = false;
  for (const [ownerId, totals] of totalsByOwner) {
    const owner = ownerId ? (nameById.get(ownerId) ?? null) : null;
    if (owner === null) {
      hasUnattributed = true;
      unattributed.inputTokens += totals.inputTokens;
      unattributed.outputTokens += totals.outputTokens;
      unattributed.cacheReadTokens += totals.cacheReadTokens;
      unattributed.cacheWriteTokens += totals.cacheWriteTokens;
      unattributed.estimatedCostUsd += totals.estimatedCostUsd;
      continue;
    }
    // Keyed by the resolved owner id (one totals entry per id), so this is one
    // bucket per distinct user — no name-based merge that could collide two ids.
    buckets.push({ owner, ...totals });
  }
  if (hasUnattributed) {
    buckets.push({ owner: null, ...unattributed });
  }
  return buckets.sort((a, b) => {
    // Unattributed bucket sorts last; otherwise by cost desc.
    if (a.owner === null) {
      return 1;
    }
    if (b.owner === null) {
      return -1;
    }
    return b.estimatedCostUsd - a.estimatedCostUsd;
  });
}
