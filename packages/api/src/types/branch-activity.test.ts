import { describe, expect, it } from "vitest";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
  branchActivityAtomProducerValidator,
  normalizeBranchActivityAtom,
} from "./branch-activity";

const PULL_REQUEST_ID = "019ff6d4-51f8-7ad0-8a95-40d1f06400dc";
const OCCURRED_AT = "2026-08-12T10:00:00.000Z";

describe("Branch activity atom contract", () => {
  it("normalizes the exact producer identity that is later persisted", () => {
    const parsed = branchActivityAtomProducerValidator.parse({
      ...branchAtom(),
      sourceEventId: "  delivery-1  ",
    });

    expect(parsed.sourceEventId).toBe("delivery-1");
    expect(parsed).not.toHaveProperty("sourceIdentity");
  });

  it("rejects compatibility-only and malformed producer fields", () => {
    expect(
      branchActivityAtomProducerValidator.safeParse({
        ...branchAtom(),
        source: BranchActivitySource.Unknown,
        sourceIdentity: "future_lane",
      }).success
    ).toBe(false);
    expect(
      branchActivityAtomProducerValidator.safeParse({
        ...branchAtom(),
        attribution: {
          kind: BranchActivityAttributionKind.Branch,
          pullRequestId: PULL_REQUEST_ID,
        },
      }).success
    ).toBe(false);
    expect(
      branchActivityAtomProducerValidator.safeParse({
        ...branchAtom(),
        completeness: BranchActivityEvidenceCompleteness.Unavailable,
      }).success
    ).toBe(false);
    expect(
      branchActivityAtomProducerValidator.safeParse({
        ...branchAtom(),
        occurredAt: "not-a-date",
      }).success
    ).toBe(false);
  });

  it("keeps distinct future raw sources separate while downgrading coverage", () => {
    const first = normalizeBranchActivityAtom({
      ...branchAtom(),
      source: "future_lane_a",
      completeness: "future_complete",
    });
    const second = normalizeBranchActivityAtom({
      ...branchAtom(),
      source: "future_lane_b",
      completeness: "future_complete",
    });

    expect(first).toMatchObject({
      source: BranchActivitySource.Unknown,
      sourceIdentity: "future_lane_a",
      completeness: BranchActivityEvidenceCompleteness.Partial,
    });
    expect(second).toMatchObject({
      source: BranchActivitySource.Unknown,
      sourceIdentity: "future_lane_b",
      completeness: BranchActivityEvidenceCompleteness.Partial,
    });
    expect(first?.sourceIdentity).not.toBe(second?.sourceIdentity);
  });

  it("accepts an explicit raw identity from an older unknown envelope", () => {
    expect(
      normalizeBranchActivityAtom({
        ...branchAtom(),
        source: BranchActivitySource.Unknown,
        sourceIdentity: "future_lane",
      })
    ).toMatchObject({
      source: BranchActivitySource.Unknown,
      sourceIdentity: "future_lane",
      completeness: BranchActivityEvidenceCompleteness.Partial,
    });
  });

  it("rejects a literal unknown classification without raw source identity", () => {
    expect(
      normalizeBranchActivityAtom({
        ...branchAtom(),
        source: BranchActivitySource.Unknown,
      })
    ).toBeUndefined();
  });

  it("does not fabricate missing attribution, identity, or time", () => {
    expect(
      normalizeBranchActivityAtom({
        ...branchAtom(),
        sourceEventId: "",
      })
    ).toBeUndefined();
    expect(
      normalizeBranchActivityAtom({
        ...branchAtom(),
        attribution: { kind: "future_attribution" },
      })
    ).toBeUndefined();
    expect(
      normalizeBranchActivityAtom({
        ...branchAtom(),
        occurredAt: null,
      })
    ).toBeUndefined();
  });

  it("preserves associated-PR attribution as a strict discriminated shape", () => {
    expect(
      branchActivityAtomProducerValidator.parse({
        ...branchAtom(),
        source: BranchActivitySource.PullRequestLifecycle,
        attribution: {
          kind: BranchActivityAttributionKind.PullRequest,
          pullRequestId: PULL_REQUEST_ID,
        },
      }).attribution
    ).toEqual({
      kind: BranchActivityAttributionKind.PullRequest,
      pullRequestId: PULL_REQUEST_ID,
    });
  });
});

function branchAtom() {
  return {
    version: BranchActivityAtomVersion.V1,
    source: BranchActivitySource.GitHubWebhook,
    sourceEventId: "delivery-1",
    occurredAt: OCCURRED_AT,
    attribution: { kind: BranchActivityAttributionKind.Branch },
    completeness: BranchActivityEvidenceCompleteness.Complete,
  } as const;
}
