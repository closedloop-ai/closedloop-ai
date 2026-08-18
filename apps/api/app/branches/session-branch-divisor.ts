import { LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { ArtifactType, type PrismaClient } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  branchParticipationForLink,
  SESSION_USAGE_BRANCH_ID_CHUNK_SIZE,
  sessionBranchParticipationWhere,
  sessionBranchUsageLinkKindWhere,
} from "./branch-read-service/session-usage-window";

/**
 * The FEA-2032 even-split DIVISOR read: how many distinct branches each session
 * wrote to, org-wide and unfiltered.
 *
 * Extracted from `branch-read-service.ts` (ISS-4689) because it is its own
 * responsibility — the one query that answers "what does this session's cost get
 * divided by", consumed by the list path's `attributedCostUsd`, the branch-detail
 * header, and the wire `sessionBranchCount` the client's Value-per-$ card divides
 * by. Its siblings are the pure even-split math in `branch-cost-attribution.ts`;
 * this module owns the read those helpers consume, keeping the DB access out of
 * that pure module while still splitting it off the read service.
 */

/** The narrow Prisma surface the divisor read needs — one `artifactLink` scan. */
type SessionBranchDivisorClient = Pick<PrismaClient, "artifactLink">;

/**
 * How many DISTINCT branches each of `sessionIds` wrote to, org-wide and
 * UNFILTERED — the FEA-2032 even-split divisor. Keyed on the same session→branch
 * usage links as `getSessionUsageByBranch`, but WITHOUT the
 * single-branch `targetId` filter, so it counts every branch a session touched
 * regardless of the branch in view. Mirrors the desktop producer's GLOBAL
 * `branch_count` subquery (apps/desktop/src/main/database/branch-reads.ts
 * `readBranchTokenAggregateRowsForBranch`), so the per-branch even-split cost
 * matches on both surfaces. Sessions absent from the result default to a divisor
 * of 1 at the call site (never over-divide on missing data).
 *
 * Callers must bound `sessionIds` — this scans one chunk per
 * SESSION_USAGE_BRANCH_ID_CHUNK_SIZE ids, so an unbounded corpus-wide id list
 * makes it an unbounded sequential scan (wongk, ISS-4689). The list path passes
 * one page's session ids; the canonical analytics path applies its own fixed
 * request-wide admission cap before calling this helper.
 */
export async function getSessionBranchCounts(
  db: SessionBranchDivisorClient,
  organizationId: string,
  sessionIds: string[]
): Promise<Map<string, number>> {
  const branchesBySession = new Map<string, Set<string>>();
  for (
    let start = 0;
    start < sessionIds.length;
    start += SESSION_USAGE_BRANCH_ID_CHUNK_SIZE
  ) {
    const idChunk = sessionIds.slice(
      start,
      start + SESSION_USAGE_BRANCH_ID_CHUNK_SIZE
    );
    const links = await db.artifactLink.findMany({
      where: {
        organizationId,
        linkType: LinkType.RelatesTo,
        AND: [
          { OR: sessionBranchUsageLinkKindWhere() },
          { OR: sessionBranchParticipationWhere() },
        ],
        sourceId: { in: idChunk },
        // FEA-3826: use the same persisted-session membership relation as the
        // branch corpus and usage fold. A raw SESSION artifact/link without a
        // SessionDetail row is not a canonical session and cannot inflate the
        // global, filter-independent even-split divisor.
        source: {
          organizationId,
          type: ArtifactType.SESSION,
          session: { isNot: null },
        },
        // FEA-4331 + FEA-4311 — the divisor must count exactly the branches that
        // are CORPUS MEMBERS (visible on the Branches list), so the 1/N even-split
        // denominator matches the set of branches the cost is actually split
        // across. FEA-4331 originally gated targets on push evidence (an owned
        // current PR OR set-once `firstPushedAt`) to keep a merely-observed second
        // branch out of the denominator. FEA-4311 widened corpus membership to any
        // SESSION-LINKED branch (`branchCandidateMembershipClause` /
        // `branchLinkedSessionExistsSql`) — a session-observed branch now surfaces
        // on the list BEFORE any push/PR — so the push-evidence gate here would
        // UNDER-count the divisor: a priced session linking to N session-only
        // branches would divide by 1 (the fallback) and attribute the FULL session
        // cost to each visible branch instead of the intended 1/N split. Match the
        // widened membership: this link row is already constrained to a
        // session→branch usage link with active-write participation (the
        // `linkKind` + participation `AND`s above and the Reviewed skip below),
        // which IS the membership relation; the target only needs to be a
        // non-deleted BRANCH, exactly the `branchWhere` corpus scope. Push
        // evidence enriches a branch but no longer gates it, here or on the list.
        target: {
          organizationId,
          type: ArtifactType.BRANCH,
          branch: { deletedAt: null },
        },
      },
      select: {
        sourceId: true,
        targetId: true,
        branchParticipation: true,
        metadata: true,
      },
    });
    for (const link of links) {
      if (
        branchParticipationForLink(link) === BranchParticipationKind.Reviewed
      ) {
        continue;
      }
      let branches = branchesBySession.get(link.sourceId);
      if (!branches) {
        branches = new Set<string>();
        branchesBySession.set(link.sourceId, branches);
      }
      branches.add(link.targetId);
    }
  }
  const counts = new Map<string, number>();
  for (const [sessionId, branches] of branchesBySession) {
    counts.set(sessionId, branches.size);
  }
  return counts;
}

/**
 * ISS-4689 (review) — flag a divisor that came back BELOW the in-set count.
 *
 * The wire divisor and the client's in-set count are drawn from two different
 * link bases: the client counts branches off `row.sessionIds` (the windowed usage
 * fold) while the divisor comes from {@link getSessionBranchCounts}' own scan. The
 * kernel's `Math.max(inSetTouched, globalCount)` floor is the right RENDER
 * behavior — dividing by less than the branches actually in the set would
 * attribute more than 100% of a session's cost — but on its own it absorbs the
 * disagreement silently: that one session quietly falls back to the pre-ISS-4689
 * divisor while every other session in the same denominator uses the global one,
 * and the card shows a blended number nobody can trace.
 *
 * Per the repo's bad-data rule the mismatch is a corrupt-source signal, not
 * something to coerce away, and this is the server-side layer that holds both
 * numbers — so it warns here rather than in the browser-shared kernel, where
 * logging is banned. Detection only: the value is left untouched and the floor
 * still renders an honest ratio.
 */
export function warnOnDivisorBelowInSetCount(
  branchCounts: ReadonlyMap<string, number>,
  usageByBranch: ReadonlyMap<string, { sessionIds: readonly string[] }>,
  context: { organizationId: string }
): void {
  const inSetCounts = new Map<string, number>();
  for (const usage of usageByBranch.values()) {
    for (const sessionId of new Set(usage.sessionIds)) {
      inSetCounts.set(sessionId, (inSetCounts.get(sessionId) ?? 0) + 1);
    }
  }
  const drifted: string[] = [];
  for (const [sessionId, inSetCount] of inSetCounts) {
    const globalCount = branchCounts.get(sessionId);
    if (globalCount !== undefined && globalCount < inSetCount) {
      drifted.push(sessionId);
    }
  }
  if (drifted.length === 0) {
    return;
  }
  log.warn("[branch-divisor] global branch count below in-set count", {
    organizationId: context.organizationId,
    driftedSessionCount: drifted.length,
    sampleSessionIds: drifted.slice(0, DRIFT_LOG_SAMPLE_SIZE),
  });
}

/** Cap the ids carried on the drift warning so one bad corpus cannot flood logs. */
const DRIFT_LOG_SAMPLE_SIZE = 10;
