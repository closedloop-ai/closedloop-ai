import { UNKNOWN_ARTIFACT_STATUS } from "@repo/api/src/types/artifact-status";
import { ArtifactStatusVocabulary } from "@repo/api/src/types/artifact-status-contract";
import {
  toArtifactStatusFromDocument,
  toArtifactStatusFromIssue,
  toArtifactStatusFromPullRequestState,
  toArtifactStatusFromSession,
} from "@repo/api/src/types/artifact-status-mapping";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";
import {
  artifactStatusFacet,
  artifactStatusView,
  branchPullRequestStatusFacet,
  branchPullRequestStatusView,
  documentStatusFacet,
  documentStatusView,
  documentStatusVocabulary,
  sessionStatusFacet,
} from "../artifact-status-adapter";

describe("artifact status adapters", () => {
  it("preserves the canonical fold object by identity", () => {
    const normalized = toArtifactStatusFromDocument(DocumentStatus.Draft);

    expect(
      artifactStatusFacet(
        ArtifactStatusVocabulary.Document,
        DocumentStatus.Draft
      ).normalized
    ).toBe(normalized);
  });

  it("adds real artifact identity without changing the facet", () => {
    expect(
      artifactStatusView(
        "doc-1",
        ArtifactStatusVocabulary.Document,
        DocumentStatus.Obsolete
      )
    ).toEqual({
      artifactId: "doc-1",
      normalized: toArtifactStatusFromDocument(DocumentStatus.Obsolete),
      raw: DocumentStatus.Obsolete,
      vocabulary: ArtifactStatusVocabulary.Document,
    });
  });

  it("selects issue vocabulary only for Feature rows", () => {
    expect(documentStatusVocabulary(DocumentType.Feature)).toBe(
      ArtifactStatusVocabulary.Issue
    );
    expect(documentStatusVocabulary(DocumentType.Prd)).toBe(
      ArtifactStatusVocabulary.Document
    );
  });

  it("folds Feature and Document rows through their owning vocabularies", () => {
    expect(
      documentStatusFacet(DocumentType.Feature, IssueStatus.Blocked).normalized
    ).toBe(toArtifactStatusFromIssue(IssueStatus.Blocked));
    expect(
      documentStatusView(
        "plan-1",
        DocumentType.ImplementationPlan,
        DocumentStatus.InReview
      )
    ).toEqual({
      artifactId: "plan-1",
      normalized: toArtifactStatusFromDocument(DocumentStatus.InReview),
      raw: DocumentStatus.InReview,
      vocabulary: ArtifactStatusVocabulary.Document,
    });
  });

  it("folds Branch mixed-table PR states through the canonical PR composition", () => {
    for (const state of Object.values(GitHubPRState)) {
      expect(branchPullRequestStatusFacet(state)).toEqual({
        normalized: toArtifactStatusFromPullRequestState(state),
        raw: state,
        vocabulary: ArtifactStatusVocabulary.Branch,
      });
    }

    expect(
      branchPullRequestStatusView("branch-1", GitHubPRState.Closed)
    ).toEqual({
      artifactId: "branch-1",
      normalized: toArtifactStatusFromPullRequestState(GitHubPRState.Closed),
      raw: GitHubPRState.Closed,
      vocabulary: ArtifactStatusVocabulary.Branch,
    });
  });

  it("fails closed for missing and version-skewed raw values", () => {
    expect(
      artifactStatusFacet(ArtifactStatusVocabulary.Session, undefined)
        .normalized
    ).toBe(UNKNOWN_ARTIFACT_STATUS);
    expect(
      artifactStatusFacet(
        ArtifactStatusVocabulary.Session,
        "future_session_status"
      ).normalized
    ).toBe(UNKNOWN_ARTIFACT_STATUS);
    expect(branchPullRequestStatusFacet("REVIEW").normalized).toBe(
      UNKNOWN_ARTIFACT_STATUS
    );
  });

  it("keeps derived session states in the session vocabulary", () => {
    expect(
      artifactStatusFacet(
        ArtifactStatusVocabulary.Session,
        DISPLAYED_SESSION_STATUS.INACTIVE
      ).normalized
    ).toBe(toArtifactStatusFromSession(DISPLAYED_SESSION_STATUS.INACTIVE));
  });

  // ISS-10364 (operator ruling): absent, null or unrecognized raw evidence
  // never makes a Session read Unknown; the displayed status decides, and the
  // raw value is kept as evidence only.
  it("reads the displayed Session status whatever the raw evidence is", () => {
    for (const raw of [undefined, null, "future_session_status"]) {
      const facet = sessionStatusFacet(SESSION_STATUS.ACTIVE, raw);
      expect(facet.normalized).toEqual(
        toArtifactStatusFromSession(SESSION_STATUS.ACTIVE)
      );
      expect(facet.normalized).not.toBe(UNKNOWN_ARTIFACT_STATUS);
    }
    expect(sessionStatusFacet(SESSION_STATUS.ACTIVE, null).raw).toBeNull();
    expect(
      sessionStatusFacet(SESSION_STATUS.ACTIVE, "future_session_status").raw
    ).toBe("future_session_status");
  });

  it("folds an unrecognized displayed Session status to Active", () => {
    expect(sessionStatusFacet("future_session_status").normalized).toEqual(
      toArtifactStatusFromSession(SESSION_STATUS.ACTIVE)
    );
  });

  // The regression this closes: the row's raw evidence is what decides whether
  // the facet keeps the displayed verdict or forces the unknown singleton, so a
  // legacy stored `waiting` losing its table row moved these rows from In
  // progress to Unknown even though the server folds them to `active`. Literal,
  // because the input is a value a stored row holds.
  it("ISS-10364: keeps the displayed verdict for a legacy stored `waiting` row", () => {
    const facet = sessionStatusFacet(SESSION_STATUS.ACTIVE, "waiting");
    expect(facet.normalized).not.toBe(UNKNOWN_ARTIFACT_STATUS);
    expect(facet.normalized).toEqual(
      toArtifactStatusFromSession(SESSION_STATUS.ACTIVE)
    );
    expect(facet.raw).toBe("waiting");
  });
});
