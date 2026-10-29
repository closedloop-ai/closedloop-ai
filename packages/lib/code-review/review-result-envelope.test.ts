import { describe, expect, it } from "vitest";
import {
  CodeReviewResultBucket,
  CodeReviewResultEnvelopeRejection,
  codeReviewFindingReviewerId,
  codeReviewFindingVerdict,
  codeReviewResultFindingsPresent,
  parseCodeReviewResultEnvelope,
} from "./review-result-envelope.ts";

describe("parseCodeReviewResultEnvelope", () => {
  it("reads a missing bucket as empty and keeps the review id", () => {
    const parsed = parseCodeReviewResultEnvelope({
      review_id: "8517be45",
      verified: [{ reviewer: "bhb" }],
    });
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) {
      return;
    }
    expect(parsed.envelope.reviewId).toBe("8517be45");
    expect(
      parsed.envelope.buckets[CodeReviewResultBucket.PendingVerification]
    ).toEqual([]);
  });

  it("refuses a corrupt bucket rather than coercing it to no findings", () => {
    expect(parseCodeReviewResultEnvelope({ verified: "one finding" })).toEqual({
      ok: false,
      rejection: CodeReviewResultEnvelopeRejection.BucketNotAnArray,
    });
  });

  it("names the top-level failure when the value is not an envelope", () => {
    for (const value of [null, 7, "envelope", [{ reviewer: "bhb" }]]) {
      expect(parseCodeReviewResultEnvelope(value)).toEqual({
        ok: false,
        rejection: CodeReviewResultEnvelopeRejection.NotAnObject,
      });
    }
  });

  it("keeps a run whose non-bucket fields a newer release reshaped", () => {
    const parsed = parseCodeReviewResultEnvelope({
      review_id: 42,
      schema_version: "2",
      some_future_bucket: { not: "an array" },
      verified: [{ reviewer: "bhb" }],
    });
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) {
      return;
    }
    expect(parsed.envelope.reviewId).toBeNull();
    expect(
      parsed.envelope.buckets[CodeReviewResultBucket.Verified]
    ).toHaveLength(1);
  });

  it("refuses an envelope carrying none of the four buckets", () => {
    // A rename in a newer plugin or a truncated write would otherwise read as
    // a run with zero producers and be COUNTED AS READ.
    expect(
      parseCodeReviewResultEnvelope({ review_id: "8517be45", stats: {} })
    ).toEqual({
      ok: false,
      rejection: CodeReviewResultEnvelopeRejection.NoKnownBucket,
    });
    expect(
      parseCodeReviewResultEnvelope({ pending_verification: [] })
    ).toMatchObject({ ok: true });
  });

  it("keeps a run whose finding entries are unusable", () => {
    const parsed = parseCodeReviewResultEnvelope({
      verified: [{ reviewer: null }, { reviewer: 7 }, "not an object", null],
    });
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) {
      return;
    }
    expect(
      parsed.envelope.buckets[CodeReviewResultBucket.Verified]
    ).toHaveLength(4);
  });
});

describe("codeReviewFindingReviewerId", () => {
  it("names a producer only when the finding actually carries one", () => {
    expect(codeReviewFindingReviewerId({ reviewer: "  bhb  " })).toBe("bhb");
    for (const finding of [
      { reviewer: null },
      { reviewer: 7 },
      {},
      "not an object",
      null,
    ]) {
      expect(codeReviewFindingReviewerId(finding)).toBe("");
    }
  });
});

describe("codeReviewFindingVerdict", () => {
  it("reports a verdict only when the finding actually carries one", () => {
    expect(
      codeReviewFindingVerdict({ verifier_verdict: "  CONFIRMED  " })
    ).toBe("CONFIRMED");
    for (const finding of [
      { verifier_verdict: null },
      { verifier_verdict: 7 },
      {},
      "not an object",
      null,
    ]) {
      expect(codeReviewFindingVerdict(finding)).toBe("");
    }
  });
});

describe("codeReviewResultFindingsPresent", () => {
  it("sums the four bucket lengths and ignores everything else", () => {
    expect(
      codeReviewResultFindingsPresent({
        review_id: "8517be45",
        schema_version: "2",
        verified: [1, 2, 3],
        justified: [1],
        rejected: [],
        pending_verification: [1, 2],
        // A newer plugin's own array key must not be counted as findings.
        signals: [1, 2, 3, 4, 5, 6, 7, 8],
      })
    ).toBe(6);
  });

  it("counts a corrupt bucket as nothing rather than guessing at its size", () => {
    // The parse refuses this envelope outright, so the only thing this
    // behaviour decides is that a corrupt bucket cannot inflate the budget.
    expect(
      codeReviewResultFindingsPresent({
        verified: "one finding",
        rejected: [1],
      })
    ).toBe(1);
  });

  it("is zero for a value that is not an envelope at all", () => {
    for (const value of [null, undefined, 7, "envelope", [1, 2, 3]]) {
      expect(codeReviewResultFindingsPresent(value)).toBe(0);
    }
  });
});
