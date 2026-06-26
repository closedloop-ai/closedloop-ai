/**
 * @file identity-key.ts
 * @description FEA-1899 (AC-4): canonical dedup key for the artifacts table.
 *
 * An artifact is stored once per identity_key. The key is `<kind>:<scope>:<id>`
 * where scope is the repo's `owner/repo` when known (resolve via the repos
 * registry FIRST so the same underlying repo never yields two keys) and falls
 * back to the absolute primary git_dir for local-only repos. Closedloop docs are
 * repo-agnostic and key off the slug alone.
 *
 * The natural per-kind id mirrors `canonicalKeyForRef` in the artifact-ref
 * extractor (reused, not forked) — this module only adds the kind/scope framing.
 */

import { createHash } from "node:crypto";

export const ArtifactKind = {
  Commit: "commit",
  Branch: "branch",
  PullRequest: "pull_request",
  ClosedloopArtifact: "closedloop_artifact",
} as const;
export type ArtifactKind = (typeof ArtifactKind)[keyof typeof ArtifactKind];

export type IdentityKeyInput = {
  kind: ArtifactKind;
  /** owner/repo when known — preferred scope (resolve via repos registry first). */
  repoFullName?: string | null;
  /** absolute primary .git path — scope fallback for local-only repos. */
  gitDir?: string | null;
  sha?: string | null;
  branchName?: string | null;
  prNumber?: number | null;
  slug?: string | null;
};

/** Scope segment: owner/repo when known, else the primary git_dir, else "". */
export function identityScope(
  repoFullName?: string | null,
  gitDir?: string | null
): string {
  return repoFullName ?? gitDir ?? "";
}

export function computeIdentityKey(input: IdentityKeyInput): string {
  const scope = identityScope(input.repoFullName, input.gitDir);
  switch (input.kind) {
    case "commit":
      return `commit:${scope}:${input.sha ?? ""}`;
    case "branch":
      return `branch:${scope}:${input.branchName ?? ""}`;
    case "pull_request":
      return `pr:${scope}:${input.prNumber ?? ""}`;
    default:
      // closedloop_artifact — repo-agnostic, keyed on slug alone.
      return `cldoc:${input.slug ?? ""}`;
  }
}

/**
 * Deterministic surrogate id for an artifacts row, derived from identity_key so
 * the migration backfill and live persistArtifactLinks produce the same id for
 * the same artifact (no orphaned FK between session_artifact_links.artifact_id
 * and artifacts.id). Uses md5 (not sha256) because SQLite lacks pgcrypto — the
 * SQL migration uses `left(md5(identity_key), 16)` and the JS path must match.
 */
export function artifactIdFromIdentityKey(identityKey: string): string {
  return createHash("md5").update(identityKey).digest("hex").slice(0, 16);
}
