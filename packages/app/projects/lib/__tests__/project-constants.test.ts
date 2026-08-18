import { ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import { PROJECT_COMPLETION_ARTIFACT_TYPE } from "@repo/api/src/types/project";
import {
  DOCUMENT_TYPE_BADGE_LABELS,
  DOCUMENT_TYPE_LABELS,
  formatProjectCompletionSummary,
  PROJECT_COMPLETION_EMPTY_SUMMARY,
  PROJECT_COMPLETION_POPULATION_NOUN,
  PROJECT_COMPLETION_POPULATION_PARTS,
} from "@repo/app/projects/lib/project-constants";
import { describe, expect, test } from "vitest";

describe("artifact type labels (FEA-3954: Features → Issues copy)", () => {
  test("the FEATURE artifact type displays as 'Issue'", () => {
    expect(DOCUMENT_TYPE_LABELS[DocumentType.Feature]).toBe("Issue");
    expect(DOCUMENT_TYPE_BADGE_LABELS[DocumentType.Feature]).toBe("Issue");
  });

  test("other artifact type labels are unchanged", () => {
    expect(DOCUMENT_TYPE_LABELS[DocumentType.Prd]).toBe("PRD");
    expect(DOCUMENT_TYPE_LABELS[DocumentType.ImplementationPlan]).toBe(
      "Implementation Plan"
    );
    expect(DOCUMENT_TYPE_LABELS[DocumentType.Template]).toBe("Template");
    expect(DOCUMENT_TYPE_BADGE_LABELS[DocumentType.ImplementationPlan]).toBe(
      "Plan"
    );
  });
});

/**
 * ISS-4636 drift guard. The completion ring renders one number over one
 * population, and its copy names that population. The number's population is
 * decided in `apps/api` (the artifacts include filters on
 * `PROJECT_COMPLETION_ARTIFACT_TYPE`) while the copy lives here, so the two are
 * pinned to each other: widening the counted population, or renaming the type
 * labels the copy borrows, fails here instead of shipping a label that
 * describes a different set than the one counted.
 */
describe("project completion copy (ISS-4636)", () => {
  test("the counted population is DOCUMENT artifacts", () => {
    expect(PROJECT_COMPLETION_ARTIFACT_TYPE).toBe(ArtifactType.Document);
  });

  test("the noun names every product vocabulary that population spans", () => {
    // A DOCUMENT artifact is either an Issue (subtype FEATURE) or one of the
    // document subtypes; the product labels those two families separately, so
    // the copy has to name both.
    const issueLabel = DOCUMENT_TYPE_LABELS[DocumentType.Feature];
    const documentLabel = DOCUMENT_TYPE_LABELS[DocumentType.Doc];

    expect(PROJECT_COMPLETION_POPULATION_NOUN).toContain(
      `${documentLabel.toLowerCase()}s`
    );
    expect(PROJECT_COMPLETION_POPULATION_NOUN).toContain(
      `${issueLabel.toLowerCase()}s`
    );
  });

  test("the noun claims nothing the percentage does not count", () => {
    // "artifacts" is the word that broke: it swept in the project's branch and
    // session artifacts, which the percentage never sees.
    expect(PROJECT_COMPLETION_POPULATION_NOUN).not.toContain("artifact");
    expect(PROJECT_COMPLETION_POPULATION_NOUN).not.toContain("branch");
    expect(PROJECT_COMPLETION_POPULATION_NOUN).not.toContain("session");
  });

  test("formats the ring summary from that noun, rounded", () => {
    expect(formatProjectCompletionSummary(48.6)).toBe(
      `49% of ${PROJECT_COMPLETION_POPULATION_NOUN} complete`
    );
  });

  test("the empty summary names the same population parts and claims no percentage (ISS-4679)", () => {
    // The empty state names the same population parts as the positive summary,
    // and must not read as a real 0% completion. Both parts survive the
    // negation; only the conjunction changes.
    for (const part of PROJECT_COMPLETION_POPULATION_PARTS) {
      expect(PROJECT_COMPLETION_EMPTY_SUMMARY).toContain(part);
    }
    expect(PROJECT_COMPLETION_EMPTY_SUMMARY).not.toContain("0%");
    expect(PROJECT_COMPLETION_EMPTY_SUMMARY).not.toContain("complete");
  });

  test("the empty summary flips the conjunction under negation (ISS-4679)", () => {
    // "No documents or issues yet" — English negation turns the positive
    // "and" into "or"; the negated sentence must NOT carry "and".
    expect(PROJECT_COMPLETION_EMPTY_SUMMARY).toBe("No documents or issues yet");
    expect(PROJECT_COMPLETION_EMPTY_SUMMARY).not.toContain(
      PROJECT_COMPLETION_POPULATION_NOUN
    );
  });
});
