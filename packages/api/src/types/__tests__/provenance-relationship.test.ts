import { describe, expect, it } from "vitest";
import {
  ARTIFACT_SESSIONS_TAB_ELIGIBLE_KINDS,
  isRelatedSessionEligibleKind,
  PROVENANCE_RELATIONSHIP_KIND_LABELS,
  ProvenanceRelationshipKind,
  RELATED_SESSION_ELIGIBLE_KINDS,
} from "../provenance-relationship";

/**
 * ISS-7234 AC1. The expected values are hand-written literals on purpose: a
 * test that derived them by iterating the const under test would stay green
 * when a kind is deleted, which is the one regression it exists to catch.
 */
describe("ProvenanceRelationshipKind (ISS-7234 AC1)", () => {
  it("distinguishes exactly the six eligibility kinds", () => {
    expect([...Object.values(ProvenanceRelationshipKind)].sort()).toEqual([
      "comment",
      "contribution",
      "invocation",
      "production",
      "reference",
      "usage",
    ]);
  });

  it("pins each wire value", () => {
    expect(ProvenanceRelationshipKind.Contribution).toBe("contribution");
    expect(ProvenanceRelationshipKind.Comment).toBe("comment");
    expect(ProvenanceRelationshipKind.Invocation).toBe("invocation");
    expect(ProvenanceRelationshipKind.Usage).toBe("usage");
    expect(ProvenanceRelationshipKind.Production).toBe("production");
    expect(ProvenanceRelationshipKind.Reference).toBe("reference");
  });

  it("labels every kind", () => {
    expect(PROVENANCE_RELATIONSHIP_KIND_LABELS).toEqual({
      comment: "Commented",
      contribution: "Contributed",
      invocation: "Invoked",
      production: "Produced",
      reference: "Referenced",
      usage: "Used",
    });
  });
});

describe("eligible kind sets (ISS-7234 AC3)", () => {
  it("admits only contribution and comment to Related Sessions", () => {
    expect([...RELATED_SESSION_ELIGIBLE_KINDS]).toEqual([
      "contribution",
      "comment",
    ]);
  });

  it("excludes invocation from Related Sessions but keeps it on the Sessions tab", () => {
    expect(
      isRelatedSessionEligibleKind(ProvenanceRelationshipKind.Invocation)
    ).toBe(false);
    expect([...ARTIFACT_SESSIONS_TAB_ELIGIBLE_KINDS]).toContain("invocation");
  });

  it("treats usage and reference as touch evidence, not contribution", () => {
    expect(isRelatedSessionEligibleKind(ProvenanceRelationshipKind.Usage)).toBe(
      false
    );
    expect(
      isRelatedSessionEligibleKind(ProvenanceRelationshipKind.Reference)
    ).toBe(false);
    expect(
      isRelatedSessionEligibleKind(ProvenanceRelationshipKind.Contribution)
    ).toBe(true);
    expect(
      isRelatedSessionEligibleKind(ProvenanceRelationshipKind.Comment)
    ).toBe(true);
  });

  it("covers every kind on the Sessions tab", () => {
    expect([...ARTIFACT_SESSIONS_TAB_ELIGIBLE_KINDS].sort()).toEqual([
      "comment",
      "contribution",
      "invocation",
      "production",
      "reference",
      "usage",
    ]);
  });
});
