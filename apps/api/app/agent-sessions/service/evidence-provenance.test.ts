/**
 * ISS-12552: with the attribution flag on, Related Sessions labels a session
 * by the strongest eligible relationship it holds on an artifact (PLN-2191 UI
 * plan, "labeled by strongest class"), dated by its newest so recency still
 * orders the list.
 */
import { ProvenanceRelationshipKind } from "@repo/api/src/types/provenance-relationship";
import { describe, expect, it } from "vitest";
import { strongestContributionsBySession } from "./evidence-provenance";

const CREATED = new Date("2026-10-19T19:29:55.000Z");
const COMMENTED = new Date("2026-10-19T19:30:15.000Z");

function row(
  sessionArtifactId: string,
  kind: ProvenanceRelationshipKind,
  occurredAt: Date,
  targetId = "document-1"
) {
  return { targetId, sessionArtifactId, kind, occurredAt };
}

describe("strongestContributionsBySession", () => {
  it("labels a session that created and later commented as a contribution, dated by the comment", () => {
    expect(
      strongestContributionsBySession(
        [
          row("session-a", ProvenanceRelationshipKind.Contribution, CREATED),
          row("session-a", ProvenanceRelationshipKind.Comment, COMMENTED),
          row("session-a", ProvenanceRelationshipKind.Usage, COMMENTED),
        ],
        [
          ProvenanceRelationshipKind.Contribution,
          ProvenanceRelationshipKind.Comment,
        ]
      )
    ).toEqual([
      row("session-a", ProvenanceRelationshipKind.Contribution, COMMENTED),
    ]);
  });
});
