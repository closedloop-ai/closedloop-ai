import type {
  ExecutionResultV2,
  RepoExecutionResult,
} from "@closedloop-ai/loops-api/execution-result";

export const DEFAULT_FIXTURE_FULL_NAME = "local/primary";

type SuccessOverrides = {
  status?: "success";
  fullName?: string;
  prUrl?: string;
  prNumber?: number;
  branchName?: string;
  baseBranch?: string;
  hasChanges?: boolean;
  prTitle?: string;
  commitSha?: string;
};

type SkippedOverrides = {
  status: "skipped";
  fullName?: string;
  reason?: string;
};

type FailedOverrides = {
  status: "failed";
  fullName?: string;
  error?: string;
};

type RepoOverrides = SuccessOverrides | SkippedOverrides | FailedOverrides;

export function makeRepoExecutionResult(
  overrides: RepoOverrides = {}
): RepoExecutionResult {
  if (overrides.status === "skipped") {
    return {
      status: "skipped",
      fullName: overrides.fullName ?? DEFAULT_FIXTURE_FULL_NAME,
      reason: overrides.reason ?? "no_changes",
    };
  }
  if (overrides.status === "failed") {
    return {
      status: "failed",
      fullName: overrides.fullName ?? DEFAULT_FIXTURE_FULL_NAME,
      error: overrides.error ?? "execution failed",
    };
  }
  const o = overrides;
  const fullName = o.fullName ?? DEFAULT_FIXTURE_FULL_NAME;
  const prNumber = o.prNumber ?? 1;
  const entry: RepoExecutionResult & { status: "success" } = {
    status: "success",
    fullName,
    prUrl: o.prUrl ?? `https://github.com/${fullName}/pull/${prNumber}`,
    prNumber,
    branchName: o.branchName ?? "feat/x",
    baseBranch: o.baseBranch ?? "main",
    hasChanges: o.hasChanges ?? true,
  };
  if (o.prTitle != null) {
    entry.prTitle = o.prTitle;
  }
  if (o.commitSha != null) {
    entry.commitSha = o.commitSha;
  }
  return entry;
}

export function makeV2ExecutionResult(
  results: RepoOverrides | RepoOverrides[] = {}
): ExecutionResultV2 {
  const arr = Array.isArray(results) ? results : [results];
  return {
    schemaVersion: 2,
    results: arr.map((r) => makeRepoExecutionResult(r)),
  };
}
