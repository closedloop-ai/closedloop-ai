import { describe, expect, it } from "vitest";
import {
  buildReviewFindingMetadataComment,
  REVIEW_FINDING_METADATA_TAG,
  ReviewFindingPriority,
  ReviewFindingSeverity,
  reviewFindingPriorityToSeverity,
  toReviewFindingPriority,
} from "./review-finding-priority";

describe("toReviewFindingPriority", () => {
  it("narrows each supported P0-P3 marker to itself", () => {
    expect(toReviewFindingPriority("P0")).toBe(ReviewFindingPriority.P0);
    expect(toReviewFindingPriority("P1")).toBe(ReviewFindingPriority.P1);
    expect(toReviewFindingPriority("P2")).toBe(ReviewFindingPriority.P2);
    expect(toReviewFindingPriority("P3")).toBe(ReviewFindingPriority.P3);
  });

  it("uppercases lowercase markers before matching", () => {
    expect(toReviewFindingPriority("p0")).toBe(ReviewFindingPriority.P0);
    expect(toReviewFindingPriority("p3")).toBe(ReviewFindingPriority.P3);
  });

  it("returns null for an out-of-range marker (P4) rather than casting it", () => {
    expect(toReviewFindingPriority("P4")).toBeNull();
  });

  it("returns null for an unrelated non-priority string", () => {
    expect(toReviewFindingPriority("critical")).toBeNull();
  });

  it("returns null for null and undefined input", () => {
    expect(toReviewFindingPriority(null)).toBeNull();
    expect(toReviewFindingPriority(undefined)).toBeNull();
  });

  it("returns null for the empty string", () => {
    expect(toReviewFindingPriority("")).toBeNull();
  });
});

describe("reviewFindingPriorityToSeverity", () => {
  it("maps P0 and P1 to the Critical tier", () => {
    expect(reviewFindingPriorityToSeverity(ReviewFindingPriority.P0)).toBe(
      ReviewFindingSeverity.Critical
    );
    expect(reviewFindingPriorityToSeverity(ReviewFindingPriority.P1)).toBe(
      ReviewFindingSeverity.Critical
    );
  });

  it("maps P2 to the Warning tier", () => {
    expect(reviewFindingPriorityToSeverity(ReviewFindingPriority.P2)).toBe(
      ReviewFindingSeverity.Warning
    );
  });

  it("maps P3 to the Info tier (the fallback branch)", () => {
    // P3 falls through both the Critical and Warning guards to the trailing
    // Info return. Asserting P3 !== Warning/Critical guards against the
    // fallback silently collapsing into a higher tier.
    const severity = reviewFindingPriorityToSeverity(ReviewFindingPriority.P3);
    expect(severity).toBe(ReviewFindingSeverity.Info);
    expect(severity).not.toBe(ReviewFindingSeverity.Warning);
    expect(severity).not.toBe(ReviewFindingSeverity.Critical);
  });
});

describe("buildReviewFindingMetadataComment", () => {
  it("emits the literal wire tag Branch View parses, independent of the exported constant", () => {
    // Pin the on-the-wire tag as a raw literal rather than interpolating
    // REVIEW_FINDING_METADATA_TAG. The builder and the other assertions here
    // both reference that constant, so renaming it would move them together and
    // stay green — while Branch View (apps/app/lib/markdown.tsx) would stop
    // recognizing historical/external `closedloop-review-finding` comments.
    // This assertion fails on any such rename so the compatibility break is caught.
    expect(REVIEW_FINDING_METADATA_TAG).toBe("closedloop-review-finding");
    expect(
      buildReviewFindingMetadataComment({
        priority: ReviewFindingPriority.P1,
        severity: ReviewFindingSeverity.Critical,
      })
    ).toBe("<!-- closedloop-review-finding priority=P1 severity=critical -->");
  });

  it("emits the tag with priority and severity when a priority is supplied", () => {
    expect(
      buildReviewFindingMetadataComment({
        priority: ReviewFindingPriority.P0,
        severity: ReviewFindingSeverity.Critical,
      })
    ).toBe(
      `<!-- ${REVIEW_FINDING_METADATA_TAG} priority=P0 severity=critical -->`
    );
  });

  it("omits the priority attribute entirely when no priority is supplied", () => {
    expect(
      buildReviewFindingMetadataComment({
        severity: ReviewFindingSeverity.Info,
      })
    ).toBe(`<!-- ${REVIEW_FINDING_METADATA_TAG} severity=info -->`);
  });

  it("round-trips a derived priority through severity into the comment", () => {
    const priority = toReviewFindingPriority("p2");
    expect(priority).toBe(ReviewFindingPriority.P2);
    const severity = reviewFindingPriorityToSeverity(
      priority ?? ReviewFindingPriority.P3
    );
    expect(
      buildReviewFindingMetadataComment({
        priority: priority ?? undefined,
        severity,
      })
    ).toBe(
      `<!-- ${REVIEW_FINDING_METADATA_TAG} priority=P2 severity=warning -->`
    );
  });
});
