import "server-only";

import {
  type AgentComponentKind,
  isLocPerDollarVerifiableKind,
} from "@repo/api/src/types/agent-component";
import { locPerDollarFromLines } from "@repo/api/src/utils/loc-per-dollar";
import {
  type SessionLocEntry,
  sumSessionLocDedupedByBranch,
} from "@repo/api/src/utils/session-loc";
import type { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import type { MergedComponent } from "./identity";

// ---------------------------------------------------------------------------
// LOC/$ efficiency metric (FEA-2923 follow-up; ISS-4667 unit reconciliation)
//
// Extracted from `service.ts` (FEA-4052 review, root AGENTS.md shrink-only rule):
// the per-component LOC/$ (cost-efficiency) load + compute + kind gate are a
// cohesive unit and live here so the 3,000-line service does not keep growing.
// ---------------------------------------------------------------------------

/**
 * The pooled Prisma client handed to a `withDb` callback — the reader shape the
 * LOC/cost loaders below issue their bounded query against.
 */
type KlocDbClient = Parameters<Parameters<typeof withDb>[0]>[0];

/**
 * Per-session local-git LOC + cost, keyed by session id (SessionDetail.artifactId).
 * `loc` is the total lines changed (linesAdded + linesRemoved) the session
 * produced — mirroring the org "totalLines" definition in
 * `apps/api/app/insights/service.ts` (added + deleted, not additions only).
 * `cost` is the session's `estimatedCost` in USD (Decimal → number).
 *
 * These are the *local-git enrichment* scalars synced from the desktop
 * (`SessionDetail.lines_added/lines_removed`, provenance `loc_source`); they are
 * the day-0 LOC signal available BEFORE any GitHub connection (governing design:
 * LOC is never gated behind GitHub — only Owner attribution is).
 */
// FEA-3633: extends the dedup helper's `SessionLocEntry` (loc + provenance:
// locSource / repositoryFullName / branch) with the session's `cost`, so the
// per-branch fallback-dedup shape is defined once in the SSOT and never drifts.
// When `locSource === "branch_fallback"` the `loc` is a whole-branch total shared
// across the branch's authoring sessions, so a cross-session sum must count it
// once per (repositoryFullName, branch), not once per session.
export type SessionLocCost = SessionLocEntry & { cost: number };

/**
 * Session ids per `artifactId: { in: … }` predicate.
 *
 * ISS-5738: the id list reaching {@link loadSessionLocCost} is genuinely
 * unbounded — it comes from a `groupBy` with no `take`, over a session set the
 * detail read leaves uncapped on purpose — and Prisma binds one parameter per
 * element, so Postgres rejects the whole statement past
 * `POSTGRES_MAX_BIND_PARAMETERS` (`./org-population-reads`, this repo's SSOT for
 * that ceiling — do not restate the number here). Matches how
 * `SESSION_COMMENT_ID_CHUNK_SIZE` and `SESSION_USAGE_BRANCH_ID_CHUNK_SIZE`
 * already bound the same kind of id list.
 */
export const SESSION_LOC_ID_CHUNK_SIZE = 1000;

/**
 * Load the local-git LOC + cost for a set of session ids (SessionDetail rows).
 * Sessions with no LOC scalars contribute 0 loc (and their cost still counts, so
 * a component whose sessions produced no measurable lines honestly reports
 * `locPerDollar = null` rather than a fabricated number).
 *
 * Read in {@link SESSION_LOC_ID_CHUNK_SIZE} chunks merged into ONE map, not one
 * statement per call. The chunking is a bind-parameter bound, NOT a truncation:
 * `locPerDollarForKind` folds LOC and cost over the full session set, so a
 * dropped chunk would silently understate the metric rather than fail loudly.
 *
 * Chunks run SEQUENTIALLY and the chunk count is deliberately unbounded. A
 * fan-out would demand one pooled connection per chunk, and this read is already
 * one arm of a concurrent batch on the detail path (bounds compose by addition —
 * see "Bounded fan-out" in `apps/api/AGENTS.md`); a work budget would be the
 * truncation the fold cannot take. So a session set past the bind ceiling costs
 * round trips instead of the outright 500 it used to cost — the same trade
 * `getSessionUsageByBranch` makes on the same shape of id list.
 *
 * FAIL-OPEN, as a whole. LOC/$ is optional enrichment on list and detail reads
 * whose core data is already loaded, so a failed chunk must not reject the
 * response ("Optional enrichment must not sit on a fatal path",
 * `apps/api/AGENTS.md`) — the more so now that one statement became many, each
 * able to time out. The empty map is the unavailable answer: `computeLocPerDollar`
 * skips ids it has no entry for and `locPerDollarFromLines` returns `null` for a
 * zero fold, so the surface shows no number rather than a wrong one. The
 * partially filled map is NOT returned — it would understate the fold with a
 * plausible number, the one outcome worse than unavailable.
 */
export async function loadSessionLocCost(
  db: KlocDbClient,
  organizationId: string,
  sessionIds: string[]
): Promise<Map<string, SessionLocCost>> {
  const progress = { chunksRead: 0 };
  try {
    // `await` inside the `try`, not a bare return: the rejection has to unwind
    // HERE for the catch below to be the enrichment boundary at all.
    return await readSessionLocCostChunks(
      db,
      organizationId,
      sessionIds,
      progress
    );
  } catch (error) {
    log.error("agent_components_loc_cost_load_failed", {
      // WHICH chunk failed is the actionable half: chunk 1 means this org never
      // gets a LOC/$ number, a late chunk is tail latency on a big one.
      chunkCount: Math.ceil(sessionIds.length / SESSION_LOC_ID_CHUNK_SIZE),
      chunksRead: progress.chunksRead,
      error: parseError(error),
      organizationId,
      sessionCount: sessionIds.length,
    });
    return new Map();
  }
}

/**
 * LOC/$ for one component = (lines produced by the sessions that used it) /
 * (their summed cost) — ISS-4667: raw lines per dollar, higher is better, no
 * divide-by-1000. Sessions are deduped by id (a component can carry multiple
 * usage rows per session — e.g. per-branch buckets — but each session's LOC +
 * cost must count exactly once). Returns null when the summed cost is 0 or the
 * sessions produced no measurable lines (never a fabricated or divide-by-zero
 * number).
 */
export function computeLocPerDollar(
  sessionIds: Iterable<string>,
  locCostBySession: Map<string, SessionLocCost>
): number | null {
  // FEA-3633: LOC is deduped PER BRANCH — a branch whose LOC came from the
  // branch/PR-total fallback contributes its total once, not once per authoring
  // session (which would count the same code N times). Commit-sourced LOC still
  // sums per-session. Cost always sums per-session (it is genuinely per-session).
  const locEntries: SessionLocEntry[] = [];
  let totalCost = 0;
  const seen = new Set<string>();
  for (const sessionId of sessionIds) {
    // Dedup by session id first: a component can carry multiple usage rows per
    // session, but each session's LOC + cost must count at most once here.
    if (seen.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);
    const entry = locCostBySession.get(sessionId);
    if (!entry) {
      continue;
    }
    locEntries.push({
      loc: entry.loc,
      locSource: entry.locSource,
      repositoryFullName: entry.repositoryFullName,
      branch: entry.branch,
    });
    totalCost += entry.cost;
  }
  const totalLoc = sumSessionLocDedupedByBranch(locEntries);
  // ISS-4667: raw lines per dollar via the shared SSOT — NO divide-by-1000, and
  // its guards return null (never a fabricated 0) for zero cost / zero lines.
  return locPerDollarFromLines(totalLoc, totalCost);
}

/**
 * FEA-4052: LOC/$ for one component, GATED on whether its kind has reliable
 * per-component attribution ({@link isLocPerDollarVerifiableKind}). A non-verifiable kind
 * returns null so the wire never carries a session-level number the surface would
 * have to hide anyway — the show/hide decision is one contract from the server
 * through both UIs. Only `subagent` is verifiable today: it governs the session
 * whose LOC/cost the metric measures. Skill/Command are excluded until a session
 * can be partitioned across the components co-invoked in it (see
 * {@link isLocPerDollarVerifiableKind} and `LOC_PER_DOLLAR_VERIFIABLE_KINDS`).
 */
export function locPerDollarForKind(
  kind: string,
  sessionIds: Iterable<string>,
  locCostBySession: Map<string, SessionLocCost>
): number | null {
  if (!isLocPerDollarVerifiableKind(kind as AgentComponentKind)) {
    return null;
  }
  return computeLocPerDollar(sessionIds, locCostBySession);
}

/**
 * Fetch the LOC + cost for every session referenced across the merged component
 * set (union of each entry's `sessionIds`). Returns the per-session lookup
 * consumed by {@link computeLocPerDollar} — and inherits {@link
 * loadSessionLocCost}'s contract whole: bind-safe chunks, and an empty map
 * rather than a throw when the load fails.
 */
export function loadLocCostForMerged(
  db: KlocDbClient,
  organizationId: string,
  mergedMap: Map<string, MergedComponent>
): Promise<Map<string, SessionLocCost>> {
  const allSessionIds = new Set<string>();
  for (const merged of mergedMap.values()) {
    for (const sessionId of merged.sessionIds) {
      allSessionIds.add(sessionId);
    }
  }
  return loadSessionLocCost(db, organizationId, [...allSessionIds]);
}

/**
 * The chunked read {@link loadSessionLocCost} wraps. Separate so the partially
 * filled map is unreachable by construction: it is local to this call, so a
 * throw from any chunk discards every merge made before it rather than handing
 * a short map back up to the enrichment boundary. `progress` carries only the
 * completed-chunk count back out, for the boundary's failure log.
 */
async function readSessionLocCostChunks(
  db: KlocDbClient,
  organizationId: string,
  sessionIds: string[],
  progress: { chunksRead: number }
): Promise<Map<string, SessionLocCost>> {
  const byId = new Map<string, SessionLocCost>();
  for (
    let start = 0;
    start < sessionIds.length;
    start += SESSION_LOC_ID_CHUNK_SIZE
  ) {
    const idChunk = sessionIds.slice(start, start + SESSION_LOC_ID_CHUNK_SIZE);
    const rows = await db.sessionDetail.findMany({
      where: {
        // SessionDetail has no organizationId column — org scope lives on the
        // parent Artifact (mirrors the usage-fold guards elsewhere in this file).
        artifact: { organizationId },
        artifactId: { in: idChunk },
      },
      select: {
        artifactId: true,
        linesAdded: true,
        linesRemoved: true,
        estimatedCost: true,
        // FEA-3633: provenance + branch identity for the per-branch fallback dedup.
        locSource: true,
        repositoryFullName: true,
        branch: true,
      },
      // No `take`: `artifactId` is SessionDetail's primary key, so the chunked
      // `in` list already caps the row count at `idChunk.length` and a LIMIT
      // restating it could never bind. Matches `getSessionUsageByBranch`, which
      // chunks the same way with no `take`.
    });
    for (const row of rows) {
      const loc = (row.linesAdded ?? 0) + (row.linesRemoved ?? 0);
      // `estimatedCost` is a Prisma Decimal; Number() is safe for the USD-scale
      // magnitudes here and keeps the DTO a plain number.
      const cost = Number(row.estimatedCost ?? 0);
      byId.set(row.artifactId, {
        loc,
        cost,
        locSource: row.locSource,
        repositoryFullName: row.repositoryFullName,
        branch: row.branch,
      });
    }
    progress.chunksRead += 1;
  }
  return byId;
}
