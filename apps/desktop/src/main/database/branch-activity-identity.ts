import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import type { BranchCanonicalActivityKey } from "./branch-activity-read.js";

/** Canonical lookup-only identity; returned rows retain their persisted bytes. */
export type NormalizedBranchActivityScope = {
  repoFullName: string;
  branchName: string;
};

/** Normalize one repository identity and reject incomplete owner/repo values. */
export function normalizeActivityRepository(
  value: unknown
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeRepoFullName(value);
  return REPOSITORY_FULL_NAME_RE.test(normalized) ? normalized : undefined;
}

/** Normalize the lookup form of a Branch name without changing case. */
export function normalizeActivityBranchName(
  value: unknown
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/** Stable lookup key for a normalized repository and Branch name. */
export function branchActivityLookupKey(
  branch: NormalizedBranchActivityScope
): string {
  return `${branch.repoFullName}\u0000${branch.branchName}`;
}

/** Stable lookup key for a normalized repository and PR number. */
export function pullRequestActivityLookupKey(
  repoFullName: string,
  prNumber: number
): string {
  return `${repoFullName}\u0000${prNumber}`;
}

/** Normalize and deduplicate the eligible Branch scope sent to SQLite. */
export function normalizeBranchActivityScopes(
  branchKeys: readonly BranchCanonicalActivityKey[]
): NormalizedBranchActivityScope[] {
  const scopes = new Map<string, NormalizedBranchActivityScope>();
  for (const branch of branchKeys) {
    const repoFullName = normalizeActivityRepository(branch.repoFullName);
    const branchName = normalizeActivityBranchName(branch.branchName);
    if (!(repoFullName && branchName)) {
      continue;
    }
    const scope = { repoFullName, branchName };
    scopes.set(branchActivityLookupKey(scope), scope);
  }
  return [...scopes.values()];
}

const REPOSITORY_FULL_NAME_RE = /^[^/\s]+\/[^/\s]+$/;
