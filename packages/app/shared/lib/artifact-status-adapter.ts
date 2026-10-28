import type { NormalizedArtifactStatus } from "@repo/api/src/types/artifact-status";
import {
  ArtifactStatusVocabulary,
  type ArtifactStatusVocabulary as ArtifactStatusVocabularyType,
} from "@repo/api/src/types/artifact-status-contract";
import {
  toArtifactStatusFromBranch,
  toArtifactStatusFromDocument,
  toArtifactStatusFromIssue,
  toArtifactStatusFromProject,
  toArtifactStatusFromPullRequestState,
  toArtifactStatusFromSession,
} from "@repo/api/src/types/artifact-status-mapping";
import { DocumentType } from "@repo/api/src/types/document";
import {
  GitHubPRState,
  type GitHubPRState as GitHubPRStateType,
} from "@repo/api/src/types/github-status";
import {
  foldToDisplayedSessionStatus,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import type {
  ArtifactStatusFacet,
  ArtifactStatusView,
} from "@repo/app/shared/lib/artifact-status-view-contract";

/** Builds a champion facet while preserving the canonical fold object by identity. */
export function artifactStatusFacet(
  vocabulary: ArtifactStatusVocabularyType,
  raw: string | null | undefined
): ArtifactStatusFacet {
  return {
    normalized: foldArtifactStatus(vocabulary, raw),
    raw: raw ?? null,
    vocabulary,
  };
}

/** Adds real artifact identity to a canonical status facet. */
export function artifactStatusView(
  artifactId: string,
  vocabulary: ArtifactStatusVocabularyType,
  raw: string | null | undefined
): ArtifactStatusView {
  return {
    ...artifactStatusFacet(vocabulary, raw),
    artifactId,
  };
}

/** Selects the persisted status vocabulary for a Document-table subtype. */
export function documentStatusVocabulary(
  documentType: DocumentType
): ArtifactStatusVocabularyType {
  return documentType === DocumentType.Feature
    ? ArtifactStatusVocabulary.Issue
    : ArtifactStatusVocabulary.Document;
}

/** Builds a Document/Issue champion facet from the owning subtype. */
export function documentStatusFacet(
  documentType: DocumentType,
  raw: string | null | undefined
): ArtifactStatusFacet {
  return artifactStatusFacet(documentStatusVocabulary(documentType), raw);
}

/** Builds a Document/Issue champion view from real row identity. */
export function documentStatusView(
  artifactId: string,
  documentType: DocumentType,
  raw: string | null | undefined
): ArtifactStatusView {
  return artifactStatusView(
    artifactId,
    documentStatusVocabulary(documentType),
    raw
  );
}

/**
 * Builds a Session facet from the displayed status, keeping the producer's raw
 * value as evidence only. ISS-10364 (operator ruling: "Unparsable status are
 * already converted to Active on import. Don't distinguish"): an unrecognized
 * or absent raw status never makes a Session read Unknown, so the normalized
 * value always comes from the folded displayed status.
 */
export function sessionStatusFacet(
  displayed: string | null | undefined,
  raw?: string | null
): ArtifactStatusFacet {
  const retainedRaw = raw === undefined ? displayed : raw;
  return {
    normalized: artifactStatusFacet(
      ArtifactStatusVocabulary.Session,
      foldToDisplayedSessionStatus(displayed ?? SESSION_STATUS.ACTIVE)
    ).normalized,
    raw: retainedRaw ?? null,
    vocabulary: ArtifactStatusVocabulary.Session,
  };
}

/** Adds real Session identity to the raw-plus-displayed facet. */
export function sessionStatusView(
  artifactId: string,
  displayed: string | null | undefined,
  raw?: string | null
): ArtifactStatusView {
  return { ...sessionStatusFacet(displayed, raw), artifactId };
}

/** Builds the Branch view used by mixed artifact rows that carry GitHub PR state. */
export function branchPullRequestStatusFacet(
  raw: string | null | undefined
): ArtifactStatusFacet {
  const normalized = isGitHubPullRequestState(raw)
    ? toArtifactStatusFromPullRequestState(raw)
    : toArtifactStatusFromPullRequestState(undefined);
  return {
    normalized,
    raw: raw ?? null,
    vocabulary: ArtifactStatusVocabulary.Branch,
  };
}

/** Builds the Branch view used by mixed artifact rows that carry GitHub PR state. */
export function branchPullRequestStatusView(
  artifactId: string,
  raw: string | null | undefined
): ArtifactStatusView {
  return { ...branchPullRequestStatusFacet(raw), artifactId };
}

function foldArtifactStatus(
  vocabulary: ArtifactStatusVocabularyType,
  raw: string | null | undefined
): NormalizedArtifactStatus {
  switch (vocabulary) {
    case ArtifactStatusVocabulary.Document:
      return toArtifactStatusFromDocument(raw);
    case ArtifactStatusVocabulary.Issue:
      return toArtifactStatusFromIssue(raw);
    case ArtifactStatusVocabulary.Branch:
      return toArtifactStatusFromBranch(raw);
    case ArtifactStatusVocabulary.Project:
      return toArtifactStatusFromProject(raw);
    case ArtifactStatusVocabulary.Session:
      return toArtifactStatusFromSession(raw);
    default: {
      const unhandled: never = vocabulary;
      return unhandled;
    }
  }
}

function isGitHubPullRequestState(
  raw: string | null | undefined
): raw is GitHubPRStateType {
  return (
    raw != null &&
    Object.values(GitHubPRState).includes(raw as GitHubPRStateType)
  );
}
