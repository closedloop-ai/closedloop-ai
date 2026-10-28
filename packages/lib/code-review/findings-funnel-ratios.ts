/**
 * ISS-7797 — the ratios, wired to the ingest that produces their numerator
 * today.
 *
 * `@repo/api/src/types/agent-component-findings-ratios` owns the arithmetic and
 * the unknown-vs-zero rules; this module is the join that feeds it: one parsed
 * code-review ingest (ISS-10724) in, one ratio per PRODUCER out, plus the
 * invocation-grain refuted-finding waste across the run set.
 *
 * SPEND IS RESOLVED BY CALLBACK, NOT READ HERE. The per-invocation cost
 * ISS-7795 captures is not exposed on a read row yet (ISS-10727), and this
 * module must stay importable from every surface, so the caller that owns the
 * invocation rows answers `{runId, reviewerId, componentKey}` with that
 * invocation's spend or with nothing. Answering with nothing is a counted
 * outcome, never a $0.
 *
 * ONLY AN EXACTLY MATCHED PRODUCER ENTERS THE WASTE POPULATION, and there are
 * now three ways to fall out of it. A deterministic helper has no invocation by
 * construction; an unmatched reviewer is a join we failed; and an AMBIGUOUS
 * match is a key that does not single out an invocation — several reviewers run
 * as one subagent type within a run, and a role can span worker types across
 * plugin releases, so ISS-10724 reports the association rather than pretending
 * the key is an id. Asking for that producer's spend would get the same row's
 * dollars back once per reviewer sharing the key, which multiplies the waste,
 * or nothing back every time, which buries them in `invocationsWithoutSpend`;
 * neither is a number worth publishing. All three are counted separately
 * instead. Their PRECISION is still reported — that ratio needs no cost —
 * because a producer we could not attribute still emitted and still refuted
 * findings.
 *
 * THE INGEST'S OWN SHORTFALLS TRAVEL WITH THE RATIOS. A pass that could not
 * read a run, that declined to fold one past its findings-count budget, or that
 * saw findings no producer claimed, has lost input the ratios below are silent
 * about, so `unreadableRuns`, `countCappedRuns` and `unattributedFindings` are
 * carried onto the result. A consumer holding only this object can then say what
 * the rates were measured over, rather than publishing a precision for a partial
 * run set with no sign that anything went missing.
 *
 * ISS-11310 ADDED THE THIRD SHORTFALL AND IT STAYS A THIRD ONE. A count-capped
 * run is one the ingest sized exactly and never folded, which is a different
 * fact from a run it could not read, and folding it into `unreadableRuns` here
 * would erase at this boundary exactly the distinction the ingest keeps at its
 * own. Its producers are simply absent from `producers` and `waste`, so without
 * a counter of its own a whole withheld run is indistinguishable from a complete
 * pass — and `fullyAdjudicated` alone cannot carry it, because a floor says
 * nothing about how much was withheld.
 */

import { readAgentComponentFindingsFunnel } from "@repo/api/src/types/agent-component-findings-funnel";
import {
  type AgentComponentFindingsCarriedRate,
  type AgentComponentFindingsPrecision,
  type AgentComponentInvocationSpend,
  type AgentComponentRefutedFindingWaste,
  type AgentComponentRefutedFindingWasteEntry,
  agentComponentFindingsCarriedRate,
  agentComponentFindingsPrecision,
  agentComponentRefutedFindingWaste,
} from "@repo/api/src/types/agent-component-findings-ratios";
import {
  CodeReviewComponentAssociation,
  type CodeReviewMatchedReviewerFunnel,
  CodeReviewReviewerAttribution,
  type CodeReviewReviewerFunnel,
} from "./findings-funnel-attribution.ts";
import type { CodeReviewFindingsIngest } from "./findings-funnel-ingest.ts";

/** What the caller is asked about, to find the invocation that produced it. */
export type CodeReviewInvocationSpendQuery = {
  runId: string;
  reviewerId: string;
  /** `null` for a producer with no invocation to look up. */
  componentKey: string | null;
};

/**
 * The caller's two lookups. Both may answer `undefined`, which is the honest
 * answer when the value does not exist and is reported as such.
 */
export type CodeReviewFindingsRatioSources = {
  /**
   * Asked ONLY for producers whose component association is exact, because a
   * query the caller cannot resolve to one invocation has no right answer.
   *
   * The spend handed back must be the row's PERSISTED value, verbatim — the
   * ratios module holds it to the ingest boundary's own predicate, which
   * includes the column's six-decimal scale, so a figure the caller apportioned
   * or averaged would be counted as corrupt data rather than as a number
   * nobody rounded. Round at the producer that owns the derivation.
   */
  resolveSpend?: (
    query: CodeReviewInvocationSpendQuery
  ) => AgentComponentInvocationSpend | undefined;
  /**
   * The retired third funnel stage (ISS-7796). No producer emits it today, so
   * the default is "not produced" and `carriedRate` reads unknown naming it.
   * The hook exists so the ratio has a wire the day one does.
   *
   * Asked for EVERY producer, deliberately unlike `resolveSpend`: carried
   * findings are a property of the findings, not of an invocation, so a
   * deterministic helper or an unmatched reviewer can have them even though no
   * invocation exists to carry a cost. Such a query arrives with
   * `componentKey: null`.
   */
  resolveFindingsCarried?: (
    query: CodeReviewInvocationSpendQuery
  ) => number | undefined;
};

/** One producer's ratios within one run. */
export type CodeReviewProducerRatios = {
  runId: string;
  reviewerId: string;
  attribution: CodeReviewReviewerAttribution;
  componentKey: string | null;
  /** `null` for a producer with no component to associate. */
  association: CodeReviewComponentAssociation | null;
  precision: AgentComponentFindingsPrecision;
  carriedRate: AgentComponentFindingsCarriedRate;
  /**
   * False when this producer left a finding awaiting a verdict, so every ratio
   * above is a floor rather than a final count.
   */
  fullyAdjudicated: boolean;
};

export type CodeReviewFindingsRatios = {
  producers: readonly CodeReviewProducerRatios[];
  waste: AgentComponentRefutedFindingWaste;
  /** Producers excluded from the waste population, by why (see module docs). */
  deterministicProducers: number;
  unmatchedProducers: number;
  /** Matched, but the key does not single out an invocation to cost. */
  ambiguousProducers: number;
  /** Runs the ingest could not read at all. Never read as empty runs. */
  unreadableRuns: number;
  /**
   * ISS-11310: runs the ingest READ, sized, and declined to fold because doing
   * so would have cost more than the pass's findings budget. Their producers are
   * missing from every ratio above.
   */
  countCappedRuns: number;
  /**
   * Bucket entries across those runs — the exact figure the ingest measured off
   * the bucket lengths, so a consumer can say HOW MUCH was withheld rather than
   * only that something was.
   */
  findingsPresentInCappedRuns: number;
  /** Findings no producer claimed, so no ratio above counts them. */
  unattributedFindings: number;
  /**
   * False when any parsed run still had a finding awaiting a verdict, when a run
   * could not be read, or when a run was withheld by the ingest's findings-count
   * budget. Carried from the ingest so a consumer reading only this result still
   * learns that every ratio in it is a floor.
   */
  fullyAdjudicated: boolean;
};

function producerRatios(
  runId: string,
  entry: CodeReviewReviewerFunnel,
  attribution: CodeReviewReviewerAttribution,
  componentKey: string | null,
  association: CodeReviewComponentAssociation | null,
  sources: CodeReviewFindingsRatioSources
): CodeReviewProducerRatios {
  const reading = readAgentComponentFindingsFunnel(entry.funnel);
  const query: CodeReviewInvocationSpendQuery = {
    runId,
    reviewerId: entry.reviewerId,
    componentKey,
  };
  return {
    runId,
    reviewerId: entry.reviewerId,
    attribution,
    componentKey,
    association,
    precision: agentComponentFindingsPrecision(reading),
    carriedRate: agentComponentFindingsCarriedRate(
      reading,
      sources.resolveFindingsCarried?.(query)
    ),
    fullyAdjudicated: entry.unadjudicatedFindings === 0,
  };
}

function wasteEntry(
  runId: string,
  matched: CodeReviewMatchedReviewerFunnel,
  sources: CodeReviewFindingsRatioSources
): AgentComponentRefutedFindingWasteEntry {
  return {
    funnel: readAgentComponentFindingsFunnel(matched.funnel),
    spend: sources.resolveSpend?.({
      runId,
      reviewerId: matched.reviewerId,
      componentKey: matched.componentKey,
    }),
    // A producer with findings still awaiting a verdict cannot have its whole
    // turn called wasted, nor called a measured zero: unadjudicated findings
    // are in neither stored count, so its funnel reads confirmed 0 while a
    // verdict may yet confirm one.
    fullyAdjudicated: matched.unadjudicatedFindings === 0,
  };
}

/**
 * Fold one ingest into per-producer ratios plus the run set's refuted-finding
 * waste.
 *
 * Deterministic order: producers come out in the ingest's own run order and,
 * within a run, matched before deterministic before unmatched, each already
 * sorted by reviewer id upstream. The same runs therefore fold to a
 * byte-identical result on a reparse, exactly as the ingest does.
 */
export function codeReviewFindingsRatios(
  ingest: CodeReviewFindingsIngest,
  sources: CodeReviewFindingsRatioSources = {}
): CodeReviewFindingsRatios {
  const producers: CodeReviewProducerRatios[] = [];
  const wasteEntries: AgentComponentRefutedFindingWasteEntry[] = [];
  let deterministicProducers = 0;
  let unmatchedProducers = 0;
  let ambiguousProducers = 0;
  for (const run of ingest.runs) {
    for (const matched of run.matched) {
      producers.push(
        producerRatios(
          run.runId,
          matched,
          CodeReviewReviewerAttribution.Matched,
          matched.componentKey,
          matched.association,
          sources
        )
      );
      if (matched.association !== CodeReviewComponentAssociation.Exact) {
        ambiguousProducers += 1;
        continue;
      }
      wasteEntries.push(wasteEntry(run.runId, matched, sources));
    }
    for (const entry of run.deterministic) {
      deterministicProducers += 1;
      producers.push(
        producerRatios(
          run.runId,
          entry,
          CodeReviewReviewerAttribution.Deterministic,
          null,
          null,
          sources
        )
      );
    }
    for (const entry of run.unmatched) {
      unmatchedProducers += 1;
      producers.push(
        producerRatios(
          run.runId,
          entry,
          CodeReviewReviewerAttribution.Unmatched,
          null,
          null,
          sources
        )
      );
    }
  }
  return {
    producers,
    waste: agentComponentRefutedFindingWaste(wasteEntries),
    deterministicProducers,
    unmatchedProducers,
    ambiguousProducers,
    unreadableRuns: ingest.unreadableRuns.length,
    countCappedRuns: ingest.countCappedRuns.length,
    findingsPresentInCappedRuns: ingest.countCappedRuns.reduce(
      (total, run) => total + run.findingsPresent,
      0
    ),
    unattributedFindings: ingest.unattributedFindingCount,
    fullyAdjudicated: ingest.fullyAdjudicated,
  };
}
