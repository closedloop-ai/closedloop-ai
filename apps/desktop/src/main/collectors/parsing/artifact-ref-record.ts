import type {
  ArtifactRefConfidence,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";

/** Canonical parser-side artifact-reference record shared by every ref pass. */
export type ArtifactRefRecord = {
  targetKind: ArtifactRefTargetKind;
  targetIdentity: string;
  relation: ArtifactRefRelation;
  method: string;
  evidence: string;
  observedAt: string;
  confidence: ArtifactRefConfidence;
  extractorVersion: number;
  isPrimary: boolean;
  repoFullName?: string;
  prNumber?: number;
  prUrl?: string;
  branchName?: string;
  sha?: string;
  /** Commit subject parsed from the `[branch sha] subject` git output. */
  message?: string;
  /** Transcript event time of the commit, never the scan time. */
  committedAt?: string;
  /** Transport-only target that must not create generic Session relationships. */
  monitoredActivityOnly?: true;
  slug?: string;
};

/** Return the stable natural key used by ref dedupe and SQLite identity. */
export function canonicalKeyForRef(ref: ArtifactRefRecord): string {
  switch (ref.targetKind) {
    case "pull_request":
      return `${ref.repoFullName}#${ref.prNumber}`;
    case "branch":
      return `${ref.repoFullName ?? ""}:${ref.branchName}`;
    case "commit":
      return ref.sha ?? ref.targetIdentity;
    default:
      return ref.slug ?? ref.targetIdentity;
  }
}
