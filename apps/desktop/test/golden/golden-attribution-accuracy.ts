/**
 * ISS-12552: attribution accuracy over the golden corpus.
 * Each annotated dossier's signed attribution block is the truth; the
 * production chain (claim extraction, receipt binding, classification and the
 * allocation run) is the prediction. Every figure carries its denominator, and
 * unresolved cases are counted rather than dropped.
 *
 * Implementation is measured by its write-to-commit join (PRD-800
 * "Proving usage"): each (branch, request) pair the production join finds is
 * scored against the pairs the block signs. The signed implementation
 * operations themselves are shell calls the server classifies from branch
 * participation, so they are not scored as operations here.
 */

import {
  ATTRIBUTION_CONTRACT_VERSION,
  AttributionRelationshipKind,
  OperationKind,
} from "@repo/api/src/types/attribution-evidence";
import { OPERATION_EVIDENCE_EXTRACTOR_VERSION } from "@repo/api/src/types/operation-claims";
import { computeTokenCost } from "@repo/cost/genai-cost";
import { UnprovenUsageReason } from "@repo/lib/attribution/associate-usage";
import { ATTRIBUTION_POLICY_VERSION } from "@repo/lib/attribution/classify-operation";
import { Harness, type NormalizedSession } from "@repo/lib/harness/types";
import { z } from "zod";
import {
  type AllocationRun,
  allocationRun,
} from "./golden-attribution-allocation.js";
import {
  type AttributionBlock,
  parseAttributionExpectations,
} from "./golden-attribution-facts.js";
import {
  joinAgreement,
  producedImplementationJoins,
  signedImplementationJoins,
} from "./golden-attribution-implementation.js";
import type { ActualOperation } from "./golden-attribution-layer1.js";
import type { GoldenDossier } from "./golden-corpus.js";

export type Counts = { tp: number; fp: number; fn: number };
type TruthOperation = Extract<
  NonNullable<AttributionBlock["operations"]>,
  readonly unknown[]
>[number];

export type DossierScore = {
  sessionId: string;
  harness: string;
  harnessVersion: string;
  heldOut: boolean;
  entities: Counts;
  durableWrites: Counts;
  byOperation: Record<string, Counts>;
  byTier: Record<string, Counts>;
  byRelationship: Record<string, Counts>;
  /** truth relationship, then predicted relationship (or `missing`), to count. */
  confusion: Record<string, Record<string, number>>;
  /** (branch, request) pairs of the write-to-commit join. */
  implementationJoins: Counts;
  correlation: { writeClaims: number; bound: number };
  usage: {
    totalTokens: number;
    provenTokens: number;
    estimatedTokens: number;
    unattributedTokens: number;
    unpricedTokens: number;
    /** Tokens no association proves, by why (PRD-800). */
    unprovenTokensByReason: Record<UnprovenUsageReason, number>;
    duplicateSourceEvents: number;
    conservationError: number | null;
    reconciliationFailure: string | null;
  };
  server: {
    /**
     * Receipt ids in the dossier's server capture, and those a claim bound. A
     * forked dossier's capture repeats its parent's receipts, so totals are a
     * union by id: a receipt is unbound only when no dossier's claim binds it.
     */
    apiKeyReceiptIds: string[];
    boundReceiptIds: string[];
    /** Shell writes: bound by a printed operation id, or calling the API without one. */
    shellWrites: { attributed: number; unattributed: number };
  };
};

const DURABLE: ReadonlySet<string> = new Set([
  AttributionRelationshipKind.Creation,
  AttributionRelationshipKind.Revision,
]);
const MISSING = "missing";
const EXTRA = "notInTruth";
const RECEIPT_TIER = "receipt";
const TRANSCRIPT_TIER = "transcriptOnly";

export const CORPUS_VERSION = {
  contract: ATTRIBUTION_CONTRACT_VERSION,
  extractor: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
  policy: ATTRIBUTION_POLICY_VERSION,
} as const;

export async function scoreDossier(
  d: GoldenDossier,
  heldOut: boolean
): Promise<DossierScore | null> {
  const parsed = parseAttributionExpectations(d.expectations);
  if (!(parsed.ok && parsed.attribution)) {
    return null;
  }
  const truth = parsed.attribution;
  const run = await allocationRun(d);
  const truthOps = asList(truth.operations);
  const measured = truthOps.filter(
    (op) => op.relationship !== AttributionRelationshipKind.Implementation
  );
  const predicted = new Map(
    run.production.operations.map((op) => [op.providerId, op])
  );
  const score: DossierScore = {
    sessionId: d.sessionId,
    harness: String(d.expectations.harness ?? "unknown"),
    harnessVersion: run.session.version ?? "unknown",
    heldOut,
    entities: entityCounts(truth, run),
    durableWrites: { tp: 0, fp: 0, fn: 0 },
    byOperation: {},
    byTier: {},
    byRelationship: {},
    confusion: {},
    implementationJoins: await implementationJoinCounts(truth, run.session, d),
    correlation: correlationOf(run),
    usage: usageOf(run),
    server: serverOf(run),
  };
  for (const want of measured) {
    scoreOperation(score, want, predicted.get(want.provider_id));
  }
  const truthIds = new Set(measured.map((op) => op.provider_id));
  for (const got of run.production.operations) {
    if (!truthIds.has(got.providerId)) {
      scoreExtra(score, got);
    }
  }
  return score;
}

function asList<T>(value: readonly T[] | string | undefined): T[] {
  return Array.isArray(value) ? [...value] : [];
}

function isDurable(relationship: string, committed: boolean): boolean {
  return committed && DURABLE.has(relationship);
}

function bump(
  record: Record<string, Counts>,
  key: string,
  field: keyof Counts
) {
  const counts = record[key] ?? { tp: 0, fp: 0, fn: 0 };
  counts[field] += 1;
  record[key] = counts;
}

function scoreOperation(
  score: DossierScore,
  want: TruthOperation,
  got: ActualOperation | undefined
): void {
  const row = score.confusion[want.relationship] ?? {};
  const predictedLabel = got?.relationship ?? MISSING;
  row[predictedLabel] = (row[predictedLabel] ?? 0) + 1;
  score.confusion[want.relationship] = row;
  const truthDurable = isDurable(want.relationship, want.committed);
  const gotDurable = got ? isDurable(got.relationship, got.committed) : false;
  const tier = got?.operationId ? RECEIPT_TIER : TRANSCRIPT_TIER;
  const field = durableField(truthDurable, gotDurable);
  if (field) {
    score.durableWrites[field] += 1;
    bump(score.byOperation, want.kind, field);
    bump(score.byTier, tier, field);
  }
  if (got?.relationship === want.relationship) {
    bump(score.byRelationship, want.relationship, "tp");
  } else {
    bump(score.byRelationship, want.relationship, "fn");
    if (got) {
      bump(score.byRelationship, got.relationship, "fp");
    }
  }
}

function scoreExtra(score: DossierScore, got: ActualOperation): void {
  const row = score.confusion[EXTRA] ?? {};
  row[got.relationship] = (row[got.relationship] ?? 0) + 1;
  score.confusion[EXTRA] = row;
  bump(score.byRelationship, got.relationship, "fp");
  if (isDurable(got.relationship, got.committed)) {
    score.durableWrites.fp += 1;
    bump(score.byOperation, got.kind, "fp");
    bump(score.byTier, got.operationId ? RECEIPT_TIER : TRANSCRIPT_TIER, "fp");
  }
}

function durableField(
  truthDurable: boolean,
  gotDurable: boolean
): keyof Counts | null {
  if (truthDurable && gotDurable) {
    return "tp";
  }
  if (truthDurable) {
    return "fn";
  }
  return gotDurable ? "fp" : null;
}

/** Artifacts named by slug, or by id where the truth names no slug. */
function entityCounts(truth: AttributionBlock, run: AllocationRun): Counts {
  const truthKeys = new Set(
    asList(truth.candidate_artifacts).flatMap((c) => c.slug ?? c.uuid ?? [])
  );
  const predicted = new Set<string>(run.production.references);
  for (const op of run.production.operations) {
    const slug = [...op.identity.slugs][0];
    if (slug) {
      predicted.add(slug);
    } else {
      for (const uuid of op.identity.uuids) {
        predicted.add(uuid);
      }
    }
  }
  const tp = [...truthKeys].filter((key) => predicted.has(key)).length;
  return { tp, fp: predicted.size - tp, fn: truthKeys.size - tp };
}

function correlationOf(run: AllocationRun): DossierScore["correlation"] {
  const writes = run.production.operations.filter(
    (op) =>
      op.kind !== OperationKind.Read &&
      op.kind !== OperationKind.List &&
      op.kind !== OperationKind.Search
  );
  return {
    writeClaims: writes.length,
    bound: writes.filter((op) => op.operationId !== undefined).length,
  };
}

function usageOf(run: AllocationRun): DossierScore["usage"] {
  const unprovenTokensByReason = unprovenTokensOf(run);
  const keys = run.units.map((unit) => unit.sourceKey);
  const duplicateSourceEvents = keys.length - new Set(keys).size;
  const unpricedTokens = run.events
    .filter(
      (event) =>
        !computeTokenCost({
          model: event.model,
          inputTokens: Number(event.inputTokens),
          outputTokens: Number(event.outputTokens),
          cacheReadTokens: Number(event.cacheReadTokens),
          cacheWriteTokens: Number(event.cacheWriteTokens),
        }).priced
    )
    .reduce(
      (sum, event) =>
        sum +
        Number(
          event.inputTokens +
            event.outputTokens +
            event.cacheReadTokens +
            event.cacheWriteTokens
        ),
      0
    );
  if (!run.allocation.ok) {
    return {
      totalTokens: run.sourceTokens,
      provenTokens: 0,
      estimatedTokens: 0,
      unattributedTokens: 0,
      unpricedTokens,
      unprovenTokensByReason,
      duplicateSourceEvents,
      conservationError: null,
      reconciliationFailure: run.allocation.error.kind,
    };
  }
  const allocation = run.allocation.value;
  const provenTokens = sumShares(allocation.recipients, "provenTokens");
  const estimatedTokens = sumShares(allocation.recipients, "estimatedTokens");
  return {
    totalTokens: run.sourceTokens,
    provenTokens,
    estimatedTokens,
    unattributedTokens: allocation.unattributedTokens,
    unpricedTokens,
    unprovenTokensByReason,
    duplicateSourceEvents,
    conservationError:
      run.sourceTokens -
      (provenTokens + estimatedTokens + allocation.unattributedTokens),
    reconciliationFailure: null,
  };
}

function unprovenTokensOf(
  run: AllocationRun
): Record<UnprovenUsageReason, number> {
  const tokensByKey = new Map(
    run.units.map((unit) => [unit.sourceKey, unit.tokens])
  );
  const byReason = emptyReasonTokens();
  for (const entry of run.unproven) {
    byReason[entry.reason] += tokensByKey.get(entry.sourceKey) ?? 0;
  }
  return byReason;
}

function emptyReasonTokens(): Record<UnprovenUsageReason, number> {
  return {
    [UnprovenUsageReason.MultiTargetRequest]: 0,
    [UnprovenUsageReason.NoQualifyingEvidence]: 0,
  } satisfies Record<UnprovenUsageReason, number>;
}

function sumShares(
  shares: readonly { provenTokens: number; estimatedTokens: number }[],
  field: "provenTokens" | "estimatedTokens"
): number {
  return shares.reduce((sum, share) => sum + share[field], 0);
}

function serverOf(run: AllocationRun): DossierScore["server"] {
  const bound = new Set(
    run.production.operations.flatMap((op) => op.operationId ?? [])
  );
  const apiKeyReceiptIds = [...run.production.receiptIds].sort();
  return {
    apiKeyReceiptIds,
    boundReceiptIds: apiKeyReceiptIds.filter((id) => bound.has(id)),
    shellWrites: {
      attributed: run.production.coverage.shellCallsWithOperationIds,
      unattributed: run.production.coverage.directApiShellCommands,
    },
  };
}

/** Wilson score interval at 95% for `successes` of `trials`; null when trials is 0. */
export function wilson95(
  successes: number,
  trials: number
): { low: number; high: number } | null {
  if (trials === 0) {
    return null;
  }
  const z = 1.959_963_984_540_054;
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * trials)) / trials);
  return {
    low: round4((centre - margin) / denominator),
    high: round4((centre + margin) / denominator),
  };
}

export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

type Rate = {
  numerator: number;
  denominator: number;
  value: number | null;
  wilson95?: { low: number; high: number } | null;
};

function rate(
  numerator: number,
  denominator: number,
  withInterval: boolean
): Rate {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : round4(numerator / denominator),
    ...(withInterval ? { wilson95: wilson95(numerator, denominator) } : {}),
  };
}

function precisionRecall(counts: Counts, withInterval: boolean) {
  return {
    ...counts,
    precision: rate(counts.tp, counts.tp + counts.fp, withInterval),
    recall: rate(counts.tp, counts.tp + counts.fn, withInterval),
  };
}

function addCounts(into: Counts, from: Counts): void {
  into.tp += from.tp;
  into.fp += from.fp;
  into.fn += from.fn;
}

function addKeyed(into: Record<string, Counts>, from: Record<string, Counts>) {
  for (const [key, counts] of Object.entries(from)) {
    const target = into[key] ?? { tp: 0, fp: 0, fn: 0 };
    addCounts(target, counts);
    into[key] = target;
  }
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b))
  );
}

/** One set's figures (regression or held-out), micro-totalled and broken down. */
function summarize(scores: readonly DossierScore[], withInterval: boolean) {
  const entities: Counts = { tp: 0, fp: 0, fn: 0 };
  const durable: Counts = { tp: 0, fp: 0, fn: 0 };
  const byOperation: Record<string, Counts> = {};
  const byTier: Record<string, Counts> = {};
  const byRelationship: Record<string, Counts> = {};
  const byHarness: Record<string, Counts> = {};
  const confusion: Record<string, Record<string, number>> = {};
  const usage = {
    total: 0,
    proven: 0,
    estimated: 0,
    unattributed: 0,
    unpriced: 0,
    duplicates: 0,
    conservationError: 0,
    failures: 0,
    unprovenByReason: emptyReasonTokens(),
  };
  const correlation = { writeClaims: 0, bound: 0 };
  const server = {
    receipts: new Set<string>(),
    bound: new Set<string>(),
    shellAttributed: 0,
    shellUnattributed: 0,
  };
  const implementationJoins = { tp: 0, fp: 0, fn: 0 };
  for (const s of scores) {
    addCounts(entities, s.entities);
    addCounts(durable, s.durableWrites);
    addKeyed(byOperation, s.byOperation);
    addKeyed(byTier, s.byTier);
    addKeyed(byRelationship, s.byRelationship);
    addKeyed(byHarness, {
      [`${s.harness}@${s.harnessVersion}`]: s.durableWrites,
    });
    for (const [truth, row] of Object.entries(s.confusion)) {
      const target = confusion[truth] ?? {};
      for (const [predicted, n] of Object.entries(row)) {
        target[predicted] = (target[predicted] ?? 0) + n;
      }
      confusion[truth] = target;
    }
    usage.total += s.usage.totalTokens;
    usage.proven += s.usage.provenTokens;
    usage.estimated += s.usage.estimatedTokens;
    usage.unattributed += s.usage.unattributedTokens;
    usage.unpriced += s.usage.unpricedTokens;
    usage.duplicates += s.usage.duplicateSourceEvents;
    for (const reason of Object.values(UnprovenUsageReason)) {
      usage.unprovenByReason[reason] += s.usage.unprovenTokensByReason[reason];
    }
    usage.conservationError += Math.abs(s.usage.conservationError ?? 0);
    usage.failures += s.usage.reconciliationFailure ? 1 : 0;
    correlation.writeClaims += s.correlation.writeClaims;
    correlation.bound += s.correlation.bound;
    for (const id of s.server.apiKeyReceiptIds) {
      server.receipts.add(id);
    }
    for (const id of s.server.boundReceiptIds) {
      server.bound.add(id);
    }
    server.shellAttributed += s.server.shellWrites.attributed;
    server.shellUnattributed += s.server.shellWrites.unattributed;
    addCounts(implementationJoins, s.implementationJoins);
  }
  const breakdown = (record: Record<string, Counts>) =>
    sortedRecord(
      Object.fromEntries(
        Object.entries(record).map(([k, v]) => [
          k,
          precisionRecall(v, withInterval),
        ])
      )
    );
  return {
    dossiers: scores.map((s) => s.sessionId).sort(),
    entities: precisionRecall(entities, withInterval),
    durableWrites: precisionRecall(durable, withInterval),
    durableWritesByHarness: breakdown(byHarness),
    durableWritesByOperation: breakdown(byOperation),
    durableWritesByEvidenceTier: breakdown(byTier),
    relationshipClasses: breakdown(byRelationship),
    confusionMatrix: sortedRecord(
      Object.fromEntries(
        Object.entries(confusion).map(([k, v]) => [k, sortedRecord(v)])
      )
    ),
    implementationJoins: precisionRecall(implementationJoins, withInterval),
    correlationCoverage: rate(
      correlation.bound,
      correlation.writeClaims,
      withInterval
    ),
    usage: {
      totalTokens: usage.total,
      usageCoverage: rate(usage.proven, usage.total, false),
      estimatedRemainder: rate(usage.estimated, usage.total, false),
      unattributed: rate(usage.unattributed, usage.total, false),
      unpriced: rate(usage.unpriced, usage.total, false),
      unprovenByReason: Object.fromEntries(
        Object.values(UnprovenUsageReason).map((reason) => [
          reason,
          rate(usage.unprovenByReason[reason], usage.total, false),
        ])
      ),
      duplicateSourceEvents: usage.duplicates,
      conservationErrorTokens: usage.conservationError,
      reconciliationFailures: usage.failures,
    },
    server: {
      receiptsNoClaimBound: rate(
        server.receipts.size - server.bound.size,
        server.receipts.size,
        false
      ),
      shellWrites: {
        attributed: server.shellAttributed,
        unattributed: server.shellUnattributed,
      },
    },
  };
}

export const HELD_OUT_SELECTION_STATEMENT =
  "The implementer chose the held-out set (packages/golden-sessions/attribution-holdout.csv).";

/** PRD-800 "Unpriced usage": why uniform-rate usage is not counted here. */
export const UNIFORM_RATE_STATEMENT =
  "Golden token events carry no stored cost, so usage priced at a per-model uniform rate (a stored cost on a model the pricing engine cannot price) is not measured here; the attribution comparison report counts it.";

export function buildAccuracyReport(scores: readonly DossierScore[]) {
  const ordered = [...scores].sort((a, b) =>
    a.sessionId.localeCompare(b.sessionId)
  );
  return {
    corpusVersion: CORPUS_VERSION,
    uniformRate: UNIFORM_RATE_STATEMENT,
    regression: summarize(
      ordered.filter((s) => !s.heldOut),
      false
    ),
    heldOut: {
      selection: HELD_OUT_SELECTION_STATEMENT,
      ...summarize(
        ordered.filter((s) => s.heldOut),
        true
      ),
    },
    perDossier: ordered,
  };
}

/** The production join's (branch, request) pairs scored against the signed ones. */
async function implementationJoinCounts(
  truth: AttributionBlock,
  session: NormalizedSession,
  d: GoldenDossier
): Promise<Counts> {
  const harness = z
    .enum([Harness.Claude, Harness.Codex])
    .parse(d.expectations.harness);
  const agreement = joinAgreement(
    signedImplementationJoins(truth),
    await producedImplementationJoins(truth, session, harness)
  );
  return { tp: agreement.matched, fp: agreement.extra, fn: agreement.missed };
}
