import { describe, expect, it } from "vitest";
import {
  SelectedPullRequestContentAvailability,
  SelectedPullRequestContentClassification,
  SelectedPullRequestContentUnavailableReason,
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
  SelectedPullRequestFileCompleteness,
  SelectedPullRequestFileContentEvidenceAvailability,
  SelectedPullRequestFilePartialReason,
  SelectedPullRequestFileStatus,
  SelectedPullRequestPatchAvailability,
} from "./selected-pull-request-evidence";

describe("selected pull request evidence contract", () => {
  it("pins the canonical availability and completeness literals", () => {
    expect(SelectedPullRequestEvidenceAvailability).toEqual({
      Available: "available",
      Unavailable: "unavailable",
    });
    expect(SelectedPullRequestFileCompleteness).toEqual({
      Complete: "complete",
      Partial: "partial",
    });
    expect(SelectedPullRequestPatchAvailability).toEqual({
      Available: "patch_available",
      Omitted: "patch_omitted",
    });
    expect(SelectedPullRequestContentAvailability).toEqual({
      Available: "content_available",
      NotApplicable: "not_applicable",
      Unavailable: "content_unavailable",
    });
    expect(SelectedPullRequestContentClassification).toEqual({
      Binary: "binary",
      Text: "text",
      Unknown: "unknown",
    });
    expect(SelectedPullRequestFileContentEvidenceAvailability).toEqual({
      Available: "available",
      Unavailable: "unavailable",
    });
  });

  it("keeps provider, partial, file, and content reasons semantically distinct", () => {
    expect(SelectedPullRequestEvidenceUnavailableReason.StaleRevision).toBe(
      "stale_revision"
    );
    expect(SelectedPullRequestFilePartialReason.ProviderCapped).toBe(
      "provider_capped"
    );
    expect(SelectedPullRequestFileStatus.Unknown).toBe("unknown");
    expect(SelectedPullRequestContentUnavailableReason.MissingContent).toBe(
      "missing_content"
    );
    expect(SelectedPullRequestContentUnavailableReason.BinaryContent).toBe(
      "binary_content"
    );
    expect(
      SelectedPullRequestContentUnavailableReason.ContentClassificationUnknown
    ).toBe("content_classification_unknown");
    expect(
      SelectedPullRequestEvidenceUnavailableReason.PullRequestMissingOrInaccessible
    ).toBe("pull_request_missing_or_inaccessible");
  });
});
