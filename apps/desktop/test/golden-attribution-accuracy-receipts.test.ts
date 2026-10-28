/**
 * ISS-12552: a forked dossier's server capture repeats its
 * parent's receipts, so the corpus "receipts no claim bound" rate counts each
 * receipt id once, and a receipt is unbound only when no dossier's claim binds
 * it. Summing per dossier would report the parent's receipts as unbound a
 * second time under the fork.
 */
import { UnprovenUsageReason } from "@repo/lib/attribution/associate-usage";
import { describe, expect, it } from "vitest";
import {
  buildAccuracyReport,
  type DossierScore,
} from "./golden/golden-attribution-accuracy.js";

const NONE = { tp: 0, fp: 0, fn: 0 };

function score(
  sessionId: string,
  apiKeyReceiptIds: string[],
  boundReceiptIds: string[]
): DossierScore {
  return {
    sessionId,
    harness: "claude",
    harnessVersion: "2.1.303",
    heldOut: false,
    entities: NONE,
    durableWrites: NONE,
    byOperation: {},
    byTier: {},
    byRelationship: {},
    confusion: {},
    implementationJoins: { tp: 0, fp: 0, fn: 0 },
    correlation: { writeClaims: 0, bound: 0 },
    usage: {
      totalTokens: 0,
      provenTokens: 0,
      estimatedTokens: 0,
      unattributedTokens: 0,
      unpricedTokens: 0,
      unprovenTokensByReason: {
        [UnprovenUsageReason.MultiTargetRequest]: 0,
        [UnprovenUsageReason.NoQualifyingEvidence]: 0,
      },
      duplicateSourceEvents: 0,
      conservationError: 0,
      reconciliationFailure: null,
    },
    server: {
      apiKeyReceiptIds,
      boundReceiptIds,
      shellWrites: { attributed: 0, unattributed: 0 },
    },
  };
}

describe("accuracy report receipt binding across dossiers", () => {
  it("counts a receipt shared by a parent and its fork once, bound by either", () => {
    const report = buildAccuracyReport([
      score("parent", ["clop_a", "clop_b"], ["clop_a", "clop_b"]),
      score("fork", ["clop_a", "clop_b", "clop_c"], ["clop_c"]),
    ]);
    expect(report.regression.server.receiptsNoClaimBound).toMatchObject({
      numerator: 0,
      denominator: 3,
    });
  });

  it("still reports a receipt no dossier binds", () => {
    const report = buildAccuracyReport([
      score("parent", ["clop_a", "clop_b"], ["clop_a"]),
      score("fork", ["clop_a", "clop_b", "clop_c"], ["clop_c"]),
    ]);
    expect(report.regression.server.receiptsNoClaimBound).toMatchObject({
      numerator: 1,
      denominator: 3,
    });
  });
});

describe("accuracy report unproven usage", () => {
  it("sums each unproven reason across dossiers, multi-target requests on their own row", () => {
    const withUnproven = (
      sessionId: string,
      multiTarget: number,
      noEvidence: number
    ): DossierScore => {
      const base = score(sessionId, [], []);
      return {
        ...base,
        usage: {
          ...base.usage,
          totalTokens: 1000,
          unprovenTokensByReason: {
            [UnprovenUsageReason.MultiTargetRequest]: multiTarget,
            [UnprovenUsageReason.NoQualifyingEvidence]: noEvidence,
          },
        },
      };
    };

    const report = buildAccuracyReport([
      withUnproven("a", 300, 100),
      withUnproven("b", 0, 50),
    ]);

    expect(report.regression.usage.unprovenByReason).toMatchObject({
      [UnprovenUsageReason.MultiTargetRequest]: {
        numerator: 300,
        denominator: 2000,
      },
      [UnprovenUsageReason.NoQualifyingEvidence]: {
        numerator: 150,
        denominator: 2000,
      },
    });
  });
});
