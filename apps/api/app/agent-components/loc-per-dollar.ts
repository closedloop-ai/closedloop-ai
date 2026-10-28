import "server-only";

import {
  type AgentComponent,
  type AgentComponentKind,
  isLocPerDollarVerifiableKind,
} from "@repo/api/src/types/agent-component";
import {
  InvocationLocPerDollarUncoveredOperand,
  resolveInvocationLocPerDollar,
} from "@repo/api/src/types/agent-component-invocation-lines";
import {
  computeLocPerDollarTerms,
  locPerDollarCostMeasured,
  locPerDollarFromCoercedLines,
  measuredCostSessionIds,
} from "@repo/api/src/utils/loc-per-dollar";
import {
  LOC_SOURCE_BRANCH_FALLBACK,
  type SessionLocEntry,
} from "@repo/api/src/utils/session-loc";
import { resolveSessionTokenTotal } from "@repo/api/src/utils/session-token-total";
import type { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import type { MergedComponent } from "./identity";
import {
  loadSessionLocBranchIdentities,
  type SessionLocBranchIdentity,
  sessionLocEntryBranchIdentity,
} from "./session-loc-branch-identity";

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
export type SessionLocCost = SessionLocEntry & {
  cost: number;
  /**
   * ISS-10467 (operator ruling 2026-09-26): the session's whole-session token
   * total — input + output + cache read + cache write, resolved by
   * {@link resolveSessionTokenTotal} so this surface cannot drop a term the
   * Sessions strip counts.
   *
   * `number | null`, and the null is NOT the columns being nullable — they are
   * `BigInt NOT NULL DEFAULT 0`, so a present row's `0` is a MEASURED zero (the
   * sync reported no model spend) and must stay one. The null is for a row whose
   * counters could not be READ as numbers: a caller that narrowed the select
   * without them, or a malformed value reaching the coercion. Folding that to `0`
   * publishes a total short by exactly those terms, and coercing it through
   * `Number(undefined)` publishes `NaN` — which is what the first cut of this
   * field did, caught by `loc-per-dollar-chunking.test.ts` in CI.
   *
   * There is still no `tokensMeasured` sibling, because ABSENCE FROM THIS MAP is
   * the coverage signal for a session with no row at all; this null is the
   * narrower "the row is here and its counters are not".
   */
  tokens: number | null;
  /**
   * Whether `cost` is a MEASURED figure rather than a stand-in for an absent
   * one.
   *
   * `SessionDetail.estimatedCost` is `Decimal?` with NO default (ISS-8515 dropped
   * the `DEFAULT 0`), so a row can carry a real null — and now routinely does,
   * because the ingest writes null rather than fabricating $0 for a session it
   * cannot price. The read below still surfaces `cost: 0` for those (every
   * existing consumer sums it), but records the difference here — without it a
   * measured $0 and an unmeasured cost are the same number, and a population
   * fold cannot tell "this was free" from "we never priced this".
   */
  costMeasured: boolean;
};

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
 *
 * ISS-9980 (RULED 2026-09-11) made a zero numerator divide into a real `0` for
 * the SESSION ratio, which resolves its numerator through a tri-state. This fold
 * has none — `linesAdded`/`linesRemoved` are NULL until a sync lands and are
 * coerced to `0` below — so a zero here stays NOT KNOWABLE and this path keeps
 * returning null. {@link locPerDollarFromCoercedLines} carries that reasoning.
 */
export function computeLocPerDollar(
  sessionIds: Iterable<string>,
  locCostBySession: Map<string, SessionLocCost>
): number | null {
  const terms = computeLocPerDollarTerms(sessionIds, locCostBySession);
  // ISS-4667: raw lines per dollar via the shared SSOT — NO divide-by-1000.
  return locPerDollarFromCoercedLines(terms.lines, terms.cost);
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
        // ISS-10467: the token counters ride the read that is already selecting
        // this exact row set, so the per-version token total costs no statement.
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        // FEA-3633: provenance + branch identity for the per-branch fallback dedup.
        locSource: true,
        repositoryFullName: true,
      },
      // No `take`: `artifactId` is SessionDetail's primary key, so the chunked
      // `in` list already caps the row count at `idChunk.length` and a LIMIT
      // restating it could never bind. Matches `getSessionUsageByBranch`, which
      // chunks the same way with no `take`.
    });
    const fallbackBranchBySession = await loadFallbackBranchIdentities(
      db,
      organizationId,
      rows
    );
    for (const row of rows) {
      const loc = (row.linesAdded ?? 0) + (row.linesRemoved ?? 0);
      // `estimatedCost` is a Prisma Decimal; Number() is safe for the USD-scale
      // magnitudes here and keeps the DTO a plain number.
      // Null stays 0 for the summing consumers; `costMeasured` is what carries
      // the distinction they do not need and the fold does.
      const { cost, costMeasured } = storedSessionCostCoverage(
        row.estimatedCost === null ? null : Number(row.estimatedCost)
      );
      const branchIdentity = sessionLocEntryBranchIdentity(
        row.artifactId,
        fallbackBranchBySession,
        row.repositoryFullName
      );
      byId.set(row.artifactId, {
        loc,
        cost,
        costMeasured,
        // The shared four-term list (ISS-7175), not a fifth hand-written sum:
        // dropping a term here is a typecheck failure rather than a silent
        // under-report that only shows up as a wrong number on the panel.
        //
        // `resolveSessionTokenTotal` and NOT `sumSessionTokenCounters`, which is
        // the DB-AGGREGATE resolver: its null term means "no rows matched" and
        // folds to 0, which is right for a `_sum` and wrong for a ROW. Here a
        // term that cannot be read is a term nobody measured, and this resolver
        // is the one that answers null for it rather than a confident short total.
        tokens: resolveSessionTokenTotal({
          input: tokenColumnCount(row.inputTokens),
          output: tokenColumnCount(row.outputTokens),
          cacheRead: tokenColumnCount(row.cacheReadTokens),
          cacheWrite: tokenColumnCount(row.cacheWriteTokens),
        }),
        locSource: row.locSource,
        repositoryFullName: branchIdentity.repositoryFullName,
        branch: branchIdentity.branch,
      });
    }
    progress.chunksRead += 1;
  }
  return byId;
}

function loadFallbackBranchIdentities(
  db: KlocDbClient,
  organizationId: string,
  rows: readonly { artifactId: string; locSource: string | null }[]
): Promise<Map<string, SessionLocBranchIdentity>> {
  const fallbackSessionIds = rows
    .filter((row) => row.locSource === LOC_SOURCE_BRANCH_FALLBACK)
    .map((row) => row.artifactId);
  return loadSessionLocBranchIdentities(db, organizationId, fallbackSessionIds);
}

/**
 * ISS-6409: the population LOC/$ fold — total lines over total cost across the
 * UNION of the population's sessions.
 *
 * The union is the whole point (#6417 review). One session can invoke several
 * subagents, and each component's own terms count that session's full LOC and
 * cost, so adding per-component terms weights a shared session once per
 * component that used it. That is neither the union's rate nor the rate the
 * Sessions and Branches cards compute, and producing a third estimand under the
 * shared "LOC / $" label is the defect this issue exists to remove. Folding the
 * union counts each session exactly once, which is what makes the three cards
 * comparable.
 *
 * `sampleSize` names the population the figure was folded OVER — every
 * verifiable component that put at least one COST-MEASURED session into the
 * union —
 * not the components that happen to carry their own measurable ratio.
 *
 * Counting the latter let the two fields contradict each other in both
 * directions. Systematically it understated: 500 components' sessions in the
 * union, "across 23 components" underneath. And it was reachable outright —
 * one component with LOC but no priced spend nulls on `cost <= 0`, another
 * with spend but no git LOC nulls on `lines <= 0`, so neither is counted while
 * the union carries both terms and renders a real number above "across 0
 * components". A ratio of sums has no per-component sample to count; the honest
 * disclosure is the population that fed the sums. When the fold yields nothing,
 * the count goes to zero with it rather than claiming a measured sample.
 */
export function foldPopulationLocPerDollar(
  components: readonly Pick<AgentComponent, "slug" | "kind">[],
  sessionIdsBySlug: Map<string, Iterable<string>>,
  locCostBySession: Map<string, SessionLocCost>
): { locPerDollar: number | null; sampleSize: number } {
  const unionSessionIds = new Set<string>();
  let sampleSize = 0;
  for (const component of components) {
    if (!isLocPerDollarVerifiableKind(component.kind)) {
      continue;
    }
    const sessionIds = sessionIdsBySlug.get(component.slug);
    if (!sessionIds) {
      continue;
    }
    const measured = measuredCostSessionIds(sessionIds, locCostBySession);
    if (measured.length === 0) {
      continue;
    }
    for (const sessionId of measured) {
      unionSessionIds.add(sessionId);
    }
    sampleSize += 1;
  }
  const locPerDollar = computeLocPerDollar(unionSessionIds, locCostBySession);
  return {
    locPerDollar,
    sampleSize: locPerDollar === null ? 0 : sampleSize,
  };
}

/**
 * ISS-10730 — the operand a LOC/$ suppression could not cover, for ONE
 * component, derived from the TERMS rather than from the kind alone.
 *
 * The kind gate is only half the population. A verifiable (`subagent`) kind
 * proceeds to the division and still returns null when the summed cost is 0 or
 * the sessions produced no measurable lines — and at that point the producer
 * knows WHICH half failed. Naming it only for the kinds whose ratio was never
 * attempted left the rows a reader most needs an explanation for carrying a
 * bare null, which is the silently-absent slot the field exists to remove.
 *
 * Returns `undefined` when the ratio resolved (a reason beside a real number
 * would state a shortfall that did not occur) and when the spend was MEASURED
 * at exactly $0 — that is an undefined ratio, not an uncovered operand, and
 * calling it `cost` would report a known figure as unknown.
 */
export function locPerDollarUncoveredOperand(
  kind: string,
  sessionIds: Iterable<string>,
  locCostBySession: Map<string, SessionLocCost>
): InvocationLocPerDollarUncoveredOperand | undefined {
  if (!isLocPerDollarVerifiableKind(kind as AgentComponentKind)) {
    return InvocationLocPerDollarUncoveredOperand.Lines;
  }
  const terms = computeLocPerDollarTerms(sessionIds, locCostBySession);
  // whitlockk (#7718 review): a MEASURED $0 is a known figure, so it must reach the
  // resolver as 0 and come back `undefinedRatio`/`zero_cost` — not be collapsed
  // to null here, which would publish `cost` as UNCOVERED and tell the reader we
  // could not price work we know was free. `measuredCostSessionIds` is the same
  // null-versus-zero SSOT the population fold already uses, so "no session
  // reported a cost" still reaches the resolver as null. The LINES term keeps
  // its `> 0` collapse deliberately: its numerator coerces never-synced NULL
  // columns to 0, so a zero there stays NOT KNOWABLE.
  const costMeasured =
    measuredCostSessionIds(sessionIds, locCostBySession).length > 0;
  const resolved = resolveInvocationLocPerDollar({
    lines: terms.lines > 0 ? terms.lines : null,
    costUsd: costMeasured ? terms.cost : null,
  });
  return resolved.state === "suppressed"
    ? resolved.uncoveredOperand
    : undefined;
}

/**
 * ISS-11226 (review: whitlockk): the stored-cost half of a {@link SessionLocCost} —
 * the number the summing consumers take, and whether it is a MEASUREMENT.
 *
 * Extracted from the chunk loop so the CLOUD half of the Local/Cloud parity
 * case can drive this code rather than a copy of it. A parity test that
 * re-derives one side proves the test agrees with itself and nothing about the
 * two surfaces.
 *
 * `cost` folds an absent cost to `0` because every summing consumer takes a
 * plain number; `costMeasured` is the distinction they do not need and the fold
 * does, and it is decided by `locPerDollarCostMeasured` — the one owner the
 * desktop resolver and both folds read.
 */
export function storedSessionCostCoverage(estimatedCost: number | null): {
  cost: number;
  costMeasured: boolean;
} {
  return {
    cost: estimatedCost ?? 0,
    costMeasured: locPerDollarCostMeasured(estimatedCost),
  };
}

/**
 * ISS-10467: one `BigInt` token column narrowed to the JS number the token
 * resolver reads, or `null` when it is not a readable count.
 *
 * `Number(undefined)` is `NaN`, so a bare cast here put `NaN` on a `number`
 * field for any caller whose select omitted the columns — a bad value persisted
 * into a record, which root AGENTS.md forbids outright. `null` instead routes
 * the whole total to the resolver's unmeasured answer, which is what a term
 * nobody read actually is. The columns are NOT NULL in the schema, so on the
 * production read path this always returns a number.
 */
function tokenColumnCount(
  value: bigint | number | null | undefined
): number | null {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
