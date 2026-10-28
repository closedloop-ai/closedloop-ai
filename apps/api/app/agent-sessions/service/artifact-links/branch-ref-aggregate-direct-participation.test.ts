import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import {
  type BranchRefAggregate,
  mergeBranchRefAggregates,
} from "./branch-ref-aggregate";

function aggregate(
  overrides: Partial<BranchRefAggregate> = {}
): BranchRefAggregate {
  return {
    repositoryFullName: "acme/web",
    branchName: "feat/x",
    method: ArtifactRefMethod.GitCommand,
    relation: ArtifactRefRelation.Created,
    branchLifecycleEvents: [],
    ...overrides,
  };
}

describe("mergeBranchRefAggregates direct-participation evidence merge", () => {
  it("rejects incoming evidence ranked weaker than the existing direct participation", () => {
    const existing = aggregate({
      directParticipation: BranchParticipationKind.Wrote,
      directParticipationMethod: ArtifactRefMethod.GitCommand,
      directParticipationObservedAt: "2026-01-01T00:00:00.000Z",
    });
    const incoming = aggregate({
      directParticipation: BranchParticipationKind.Reviewed,
      directParticipationMethod: ArtifactRefMethod.PrReviewFeedbackCommand,
      directParticipationObservedAt: "2026-02-01T00:00:00.000Z",
    });

    const merged = mergeBranchRefAggregates(existing, incoming);

    expect(merged.directParticipation).toBe(BranchParticipationKind.Wrote);
    expect(merged.directParticipationMethod).toBe(ArtifactRefMethod.GitCommand);
    expect(merged.directParticipationObservedAt).toBe(
      "2026-01-01T00:00:00.000Z"
    );
  });

  it("falls back to the ref's general method when no direct-participation method is set", () => {
    const existing = aggregate({});
    const incoming = aggregate({
      method: ArtifactRefMethod.GitCommand,
      directParticipation: BranchParticipationKind.Wrote,
    });

    const merged = mergeBranchRefAggregates(existing, incoming);

    expect(merged.directParticipation).toBe(BranchParticipationKind.Wrote);
    expect(merged.directParticipationMethod).toBe(ArtifactRefMethod.GitCommand);
  });

  // pins current behavior; looks odd because a strictly stronger-priority
  // incoming ref (PR-review-feedback evidence) overwrites the existing
  // evidence's method even though both sides rank at the SAME participation
  // kind and there is no timestamp comparison at all for this path.
  it("lets objectively stronger equally-ranked evidence overwrite without a timestamp check", () => {
    const existing = aggregate({
      directParticipation: BranchParticipationKind.Reviewed,
      directParticipationMethod: ArtifactRefMethod.GitCommand,
    });
    const incoming = aggregate({
      directParticipation: BranchParticipationKind.Reviewed,
      directParticipationMethod: ArtifactRefMethod.PrReviewFeedbackCommand,
    });

    const merged = mergeBranchRefAggregates(existing, incoming);

    expect(merged.directParticipationMethod).toBe(
      ArtifactRefMethod.PrReviewFeedbackCommand
    );
  });

  it("does not adopt equally-ranked, equal-priority evidence lacking any timestamp", () => {
    const existing = aggregate({
      directParticipation: BranchParticipationKind.Reviewed,
    });
    const incoming = aggregate({
      directParticipation: BranchParticipationKind.Reviewed,
      method: ArtifactRefMethod.LaunchMetadata,
    });

    const merged = mergeBranchRefAggregates(existing, incoming);

    expect(merged.directParticipationMethod).toBeUndefined();
    expect(merged.directParticipationObservedAt).toBeUndefined();
  });

  it("does not adopt equally-ranked, equal-priority evidence that is not newer than the existing timestamp", () => {
    const existing = aggregate({
      directParticipation: BranchParticipationKind.Reviewed,
      directParticipationMethod: ArtifactRefMethod.GitCommand,
      directParticipationObservedAt: "2026-03-01T00:00:00.000Z",
    });
    const incoming = aggregate({
      directParticipation: BranchParticipationKind.Reviewed,
      method: ArtifactRefMethod.LaunchMetadata,
      directParticipationObservedAt: "2026-02-01T00:00:00.000Z",
    });

    const merged = mergeBranchRefAggregates(existing, incoming);

    expect(merged.directParticipationMethod).toBe(ArtifactRefMethod.GitCommand);
    expect(merged.directParticipationObservedAt).toBe(
      "2026-03-01T00:00:00.000Z"
    );
  });

  it("adopts equally-ranked, equal-priority evidence that is strictly newer than the existing timestamp", () => {
    const existing = aggregate({
      directParticipation: BranchParticipationKind.Reviewed,
      directParticipationMethod: ArtifactRefMethod.GitCommand,
      directParticipationObservedAt: "2026-01-01T00:00:00.000Z",
    });
    const incoming = aggregate({
      directParticipation: BranchParticipationKind.Reviewed,
      method: ArtifactRefMethod.LaunchMetadata,
      directParticipationObservedAt: "2026-04-01T00:00:00.000Z",
    });

    const merged = mergeBranchRefAggregates(existing, incoming);

    expect(merged.directParticipationMethod).toBe(
      ArtifactRefMethod.LaunchMetadata
    );
    expect(merged.directParticipationObservedAt).toBe(
      "2026-04-01T00:00:00.000Z"
    );
  });
});
