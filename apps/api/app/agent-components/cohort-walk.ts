// The cohort half of the Performance-tab computation (ISS-9853): every session
// id the caller hands over is read, in chunks, and folded as it streams past.
//
// This is a chunked id-list walk, not a cursor keyset: the input is an explicit
// id list, so each chunk is one bind-bounded `IN` slice of it in `artifactId`
// order, and the walk covers its input completely. What it replaced was a
// `.slice(0, 2000)` over an insertion-ordered id set plus a `take` mirroring it
// — a retained prefix published as the population (PRD-666, cap family TC-3 of
// the ISS-9621 sweep). The chunk size and order are the ISS-9627 keyset owner's
// so the two population walks on this surface agree on one bound.
//
// Residency is bounded per chunk, not per cohort (this repo has a documented
// history of db-host OOMs from unbounded scans — FEA-3132): the PR-link graph
// each row carries is folded into a small accumulator the moment its chunk
// arrives, and only the row's scalars are retained for the sums that need every
// row at once.

import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  allowsUniqueBranchPrFallback,
  commandDerivedSessionPrRefsFromMetadata,
  sessionPrIdentityKey,
} from "@repo/api/src/types/session-artifact-link";
import { LOC_SOURCE_BRANCH_FALLBACK } from "@repo/api/src/utils/session-loc";
import type { Prisma, withDb } from "@repo/database";
import {
  SESSION_CANDIDATE_CHUNK_SIZE,
  SESSION_CANDIDATE_KEYSET_ORDER_BY,
} from "@/app/agent-sessions/service/session-candidate-stream";
import { branchCandidatePullRequests } from "@/app/branches/branch-canonical-pull-request";
import { chunksOf } from "@/lib/chunks-of";
import {
  SessionPrLinkAudience,
  sessionPrLinkWhere,
} from "@/lib/session-pr-links";
import {
  loadSessionLocBranchIdentities,
  type SessionLocBranchIdentity,
} from "./session-loc-branch-identity";

type DbClient = Parameters<Parameters<typeof withDb>[0]>[0];

export const COHORT_SESSION_SELECT = {
  artifactId: true,
  linesAdded: true,
  linesRemoved: true,
  // FEA-3633: provenance + branch identity for the per-branch fallback dedup.
  locSource: true,
  repositoryFullName: true,
  estimatedCost: true,
  inputTokens: true,
  outputTokens: true,
  sessionStartedAt: true,
  artifact: {
    select: {
      sourceLinks: {
        // ISS-5823 Metric: feeds `sessionsWithMergedPr` / `distinctMergedPrs`.
        where: sessionPrLinkWhere(SessionPrLinkAudience.Metric),
        select: {
          metadata: true,
          targetId: true,
          target: {
            select: {
              branch: {
                select: {
                  repository: { select: { fullName: true } },
                  currentPullRequestDetail: {
                    select: {
                      number: true,
                      prState: true,
                      mergedAt: true,
                      lastVerifiedAt: true,
                      repositoryFullName: true,
                      repository: { select: { fullName: true } },
                    },
                  },
                },
              },
              pullRequestDetails: {
                select: {
                  number: true,
                  prState: true,
                  mergedAt: true,
                  lastVerifiedAt: true,
                  repositoryFullName: true,
                  repository: { select: { fullName: true } },
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.SessionDetailSelect;

/**
 * Cohort session row: LOC/cost/token scalars + timing + PR-link presence.
 * Derived from {@link COHORT_SESSION_SELECT} via `GetPayload` (the convention
 * shared with `apps/api/lib/agent-session-delivery-metrics.ts`) so the row type
 * can never drift from the actual `select`, which lets the `findMany` results be
 * consumed without an `as` cast.
 */
export type CohortSessionRow = Prisma.SessionDetailGetPayload<{
  select: typeof COHORT_SESSION_SELECT;
}>;

/**
 * The part of a cohort row retained past its chunk: everything but the PR-link
 * graph, which is folded into {@link PrOutcome} as the chunk arrives.
 */
export type CohortSessionScalars = Omit<CohortSessionRow, "artifact">;

/** Per-session PR outcome across a cohort of rows. */
export type PrOutcome = {
  sessionsWithMergedPr: number;
  total: number;
  distinctMergedPrs: Set<string>;
};

function emptyPrOutcome(): PrOutcome {
  return { sessionsWithMergedPr: 0, total: 0, distinctMergedPrs: new Set() };
}

/** Fold `rows` into `outcome`; returns the same accumulator for chaining. */
function foldPrOutcome(
  outcome: PrOutcome,
  rows: readonly CohortSessionRow[]
): PrOutcome {
  for (const row of rows) {
    let sessionHasMerged = false;
    for (const link of row.artifact.sourceLinks) {
      for (const identity of cohortPrIdentities(link)) {
        const detail = cohortPrDetail(link, identity);
        if (!detail) {
          continue;
        }
        sessionHasMerged = true;
        outcome.distinctMergedPrs.add(
          identity.prNumber == null
            ? `branch:${link.targetId}`
            : sessionPrIdentityKey(
                identity.repositoryFullName,
                identity.prNumber
              )
        );
      }
    }
    if (sessionHasMerged) {
      outcome.sessionsWithMergedPr += 1;
    }
  }
  outcome.total += rows.length;
  return outcome;
}

type CohortPrLink = CohortSessionRow["artifact"]["sourceLinks"][number];
type CohortPrIdentity = {
  repositoryFullName: string;
  prNumber: number | null;
};

function cohortPrIdentities(link: CohortPrLink): CohortPrIdentity[] {
  // ISS-5823: a prose-derived identity on an otherwise command-derived link
  // must not reach `distinctMergedPrs` or flip `sessionsWithMergedPr`.
  const refs = commandDerivedSessionPrRefsFromMetadata(link.metadata);
  if (refs.length > 0) {
    return refs;
  }
  if (!allowsUniqueBranchPrFallback(link.metadata)) {
    return [];
  }
  const candidates = cohortPrCandidates(link);
  const identities = new Map<string, CohortPrIdentity>();
  for (const detail of candidates) {
    const repositoryFullName =
      detail?.repository?.fullName ??
      detail?.repositoryFullName ??
      link.target.branch?.repository?.fullName;
    if (!(detail && repositoryFullName)) {
      continue;
    }
    const identityKey =
      detail.number == null
        ? `branch:${link.targetId}`
        : sessionPrIdentityKey(repositoryFullName, detail.number);
    identities.set(identityKey, {
      repositoryFullName,
      prNumber: detail.number,
    });
  }
  return identities.size === 1 ? [...identities.values()] : [];
}

function cohortPrDetail(link: CohortPrLink, identity: CohortPrIdentity) {
  return (
    cohortPrCandidates(link).find((detail) => {
      const repositoryFullName =
        detail?.repository?.fullName ?? detail?.repositoryFullName;
      return (
        detail?.prState === GitHubPRState.Merged &&
        detail.mergedAt != null &&
        detail.lastVerifiedAt != null &&
        detail.number === identity.prNumber &&
        repositoryFullName != null &&
        normalizeRepoFullName(repositoryFullName) ===
          normalizeRepoFullName(identity.repositoryFullName)
      );
    }) ?? null
  );
}

function cohortPrCandidates(link: CohortPrLink) {
  return branchCandidatePullRequests(
    link.target.branch,
    link.target.pullRequestDetails
  );
}

/** What one full walk of a cohort's ids folded to. */
export type CohortWalk = {
  /** Every cohort row's scalars, in `artifactId` order across the chunks. */
  scalars: CohortSessionScalars[];
  /** The merged-PR outcome over every walked row. */
  prOutcome: PrOutcome;
  /** Ids of the walked rows whose LOC came from the branch/PR-total fallback. */
  fallbackSessionIds: string[];
};

/**
 * Read every cohort session the caller named, in `artifactId`-ordered chunks
 * of {@link SESSION_CANDIDATE_CHUNK_SIZE}, folding as it goes.
 *
 * Chunks run SEQUENTIALLY (a fan-out would demand one pooled connection per
 * chunk — "Bounded fan-out", `apps/api/AGENTS.md`), with no `take`: the `IN`
 * list is the `SessionDetail` primary key, so a chunk can never return more
 * rows than ids and a LIMIT restating that could never bind — the same reason
 * `loc-per-dollar.ts`'s chunked LOC fold carries none. Not fail-open: a chunk
 * that rejects rejects the walk, exactly as the single capped read it replaced
 * did. The ids are sorted so each chunk is one contiguous slice of the key
 * space and the fold is order-independent either way.
 */
export async function walkCohort(
  db: DbClient,
  organizationId: string,
  cohortSessionIds: readonly string[]
): Promise<CohortWalk> {
  const scalars: CohortSessionScalars[] = [];
  const prOutcome = emptyPrOutcome();
  const fallbackSessionIds: string[] = [];
  const orderedIds = [...cohortSessionIds].sort();
  for (const idChunk of chunksOf(orderedIds, SESSION_CANDIDATE_CHUNK_SIZE)) {
    const rows = await db.sessionDetail.findMany({
      where: { artifactId: { in: idChunk }, artifact: { organizationId } },
      select: COHORT_SESSION_SELECT,
      orderBy: SESSION_CANDIDATE_KEYSET_ORDER_BY,
    });
    foldPrOutcome(prOutcome, rows);
    for (const { artifact: _links, ...rowScalars } of rows) {
      scalars.push(rowScalars);
      if (rowScalars.locSource === LOC_SOURCE_BRANCH_FALLBACK) {
        fallbackSessionIds.push(rowScalars.artifactId);
      }
    }
  }
  return { scalars, prOutcome, fallbackSessionIds };
}

/**
 * The PR outcome over a complete set of rows already in hand — the baseline
 * read's whole-batch shape, where there is nothing to accumulate across.
 */
export function prOutcomeOf(rows: readonly CohortSessionRow[]): PrOutcome {
  return foldPrOutcome(emptyPrOutcome(), rows);
}

/**
 * {@link loadSessionLocBranchIdentities} over an id list of any length: the
 * loader binds one `IN` list, and a cohort's fallback ids are no longer bounded
 * by a scan cap, so they are cut to the same chunk size the walk uses.
 */
export async function loadCohortFallbackBranchIdentities(
  db: DbClient,
  organizationId: string,
  fallbackSessionIds: readonly string[]
): Promise<Map<string, SessionLocBranchIdentity>> {
  const merged = new Map<string, SessionLocBranchIdentity>();
  for (const idChunk of chunksOf(
    fallbackSessionIds,
    SESSION_CANDIDATE_CHUNK_SIZE
  )) {
    const identities = await loadSessionLocBranchIdentities(
      db,
      organizationId,
      idChunk
    );
    for (const [sessionId, identity] of identities) {
      merged.set(sessionId, identity);
    }
  }
  return merged;
}
