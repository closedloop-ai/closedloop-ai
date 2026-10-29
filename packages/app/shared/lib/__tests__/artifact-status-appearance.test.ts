/**
 * Behaviour of `resolveArtifactStatusMark` (PRD-714 / ISS-9301).
 *
 * These assert which ROW the resolver selects, never what a row contains.
 * Which glyph or tone a status draws is data; a test restating it would be the
 * table written a second time, and would pass for as long as the two copies
 * happened to agree rather than for as long as the code was right.
 *
 * The seven raw-keyed tables this registry will replace are NOT diffed here.
 * Nothing consumes the registry yet, so a divergence changes no pixel; the
 * reconciliation belongs to ISS-9304, at the point it re-points the consumers
 * and a mismatch becomes a real regression. The six Document/Issue tone
 * divergences already found are recorded on that ticket.
 */

import {
  ARTIFACT_STATUS_DETAIL,
  ARTIFACT_STATUS_ROOT,
  DISPLAYED_ARTIFACT_STATUS,
  type DisplayedArtifactStatus,
} from "@repo/api/src/types/artifact-status";
import { ArtifactStatusVocabulary } from "@repo/api/src/types/artifact-status-contract";
import { toArtifactStatusFromProject } from "@repo/api/src/types/artifact-status-mapping";
import { ProjectStatus } from "@repo/api/src/types/project";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_STATUS_DETAIL_APPEARANCE,
  ARTIFACT_STATUS_ROOT_APPEARANCE,
  ARTIFACT_STATUS_VOCABULARY_OVERRIDE,
  resolveArtifactStatusMark,
} from "../artifact-status-appearance";
import type { ArtifactStatusFacet } from "../artifact-status-view-contract";

describe("resolveArtifactStatusMark", () => {
  it("selects the detail's row over the override claiming the same root", () => {
    // Document CHANGES_REQUESTED folds to the `in_review` root the Document
    // override also claims. Consulting the override first would drop the
    // distinction the raw value carried, which is why detail precedes it.
    expect(
      resolveArtifactStatusMark(
        facetOf(ArtifactStatusVocabulary.Document, {
          detail: ARTIFACT_STATUS_DETAIL.DocumentChangesRequested,
          root: ARTIFACT_STATUS_ROOT.InReview,
        })
      )
    ).toBe(
      ARTIFACT_STATUS_DETAIL_APPEARANCE[
        ARTIFACT_STATUS_DETAIL.DocumentChangesRequested
      ]
    );
  });

  it("selects the vocabulary override when the root carries no detail", () => {
    expect(
      resolveArtifactStatusMark(
        facetOf(ArtifactStatusVocabulary.Document, {
          root: ARTIFACT_STATUS_ROOT.InReview,
        })
      )
    ).toBe(
      ARTIFACT_STATUS_VOCABULARY_OVERRIDE[ArtifactStatusVocabulary.Document]?.[
        ARTIFACT_STATUS_ROOT.InReview
      ]
    );
  });

  it("selects the plain root for a vocabulary the override does not cover", () => {
    // The counterfactual for the case above: the override exists precisely
    // because Document and Issue share this root and not its mark.
    expect(
      resolveArtifactStatusMark(
        facetOf(ArtifactStatusVocabulary.Issue, {
          root: ARTIFACT_STATUS_ROOT.InReview,
        })
      )
    ).toBe(ARTIFACT_STATUS_ROOT_APPEARANCE[ARTIFACT_STATUS_ROOT.InReview]);
  });

  it("refuses a detail belonging to another vocabulary", () => {
    // A facet is assembled by its caller from a fold plus a vocabulary, as two
    // separate fields, so the wrong fold paired with the right vocabulary is a
    // caller bug the types permit. Borrowing here would state a Document
    // outcome for a session nothing measured, so it falls back to the root.
    expect(
      resolveArtifactStatusMark(
        facetOf(ArtifactStatusVocabulary.Session, {
          detail: ARTIFACT_STATUS_DETAIL.DocumentApproved,
          root: ARTIFACT_STATUS_ROOT.Done,
        })
      )
    ).toBe(ARTIFACT_STATUS_ROOT_APPEARANCE[ARTIFACT_STATUS_ROOT.Done]);
  });

  it("falls back to the unknown row for a root it cannot place", () => {
    expect(
      resolveArtifactStatusMark(
        facetOf(ArtifactStatusVocabulary.Document, {
          root: "constructor" as DisplayedArtifactStatus,
        })
      )
    ).toBe(ARTIFACT_STATUS_ROOT_APPEARANCE[DISPLAYED_ARTIFACT_STATUS.Unknown]);
  });

  it("does not return a prototype member for a detail named like one", () => {
    // `raw` is a freeform column and the normalized value rode beside one, so a
    // bare index would hand back a FUNCTION where the caller expects a mark.
    expect(
      resolveArtifactStatusMark(
        facetOf(ArtifactStatusVocabulary.Issue, {
          detail: "toString" as never,
          root: ARTIFACT_STATUS_ROOT.Todo,
        })
      )
    ).toBe(ARTIFACT_STATUS_ROOT_APPEARANCE[ARTIFACT_STATUS_ROOT.Todo]);
  });

  it("keeps two values of one root apart when only one carries a detail", () => {
    // Through the real fold. Archived and Completed both fold to `done`, so the
    // detail row is the only thing between "archived" and "finished".
    const archived = resolveArtifactStatusMark(
      facetOf(
        ArtifactStatusVocabulary.Project,
        toArtifactStatusFromProject(ProjectStatus.Archived)
      )
    );

    expect(archived).toBe(
      ARTIFACT_STATUS_DETAIL_APPEARANCE[ARTIFACT_STATUS_DETAIL.ProjectArchived]
    );
    expect(archived).not.toBe(
      resolveArtifactStatusMark(
        facetOf(
          ArtifactStatusVocabulary.Project,
          toArtifactStatusFromProject(ProjectStatus.Completed)
        )
      )
    );
  });
});

function facetOf(
  vocabulary: ArtifactStatusVocabulary,
  normalized: ArtifactStatusFacet["normalized"]
): ArtifactStatusFacet {
  return { normalized, raw: null, vocabulary };
}
