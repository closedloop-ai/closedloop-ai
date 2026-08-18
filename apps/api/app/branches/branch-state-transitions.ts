import {
  BranchBaseBranchSource,
  BranchFileCacheStatus,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import {
  GitHubPRState,
  type GitHubPRState as GitHubPRStateValue,
} from "@repo/api/src/types/github";

export type HeadTransitionState = {
  headSha: string | null;
  headShaSource: BranchHeadShaSource | null;
  headShaObservedAt: Date | null;
  lastPushBeforeSha: string | null;
  deletedAt?: Date | null;
};

export type HeadTransitionResult = HeadTransitionState & {
  accepted: boolean;
  reason:
    | "no_head_input"
    | "first_observation"
    | "push_confirmed"
    | "sequential_push"
    | "duplicate_push"
    | "recreated_after_delete"
    | "stale_push"
    | "duplicate_harness_input"
    | "authoritative_refresh";
};

const baseBranchSourcePriority: Record<BranchBaseBranchSource, number> = {
  [BranchBaseBranchSource.PullRequestBase]: 50,
  [BranchBaseBranchSource.HarnessInput]: 40,
  [BranchBaseBranchSource.McpInput]: 30,
  [BranchBaseBranchSource.MigrationPrBase]: 20,
  [BranchBaseBranchSource.RepositoryDefault]: 10,
};

export function parseBranchBaseBranchSource(
  value: string | null
): BranchBaseBranchSource | null {
  return (
    Object.values(BranchBaseBranchSource).find((item) => item === value) ?? null
  );
}

export function parseBranchHeadShaSource(
  value: string | null
): BranchHeadShaSource | null {
  return (
    Object.values(BranchHeadShaSource).find((item) => item === value) ?? null
  );
}

export function parseGitHubPRState(value: string | null | undefined) {
  switch (value) {
    case GitHubPRState.Open:
      return GitHubPRState.Open;
    case GitHubPRState.Merged:
      return GitHubPRState.Merged;
    case GitHubPRState.Closed:
      return GitHubPRState.Closed;
    default:
      return null;
  }
}

/** Maps branch, PR, and delete state to the parent artifact status. */
export function decideBranchStatus(input: {
  isDelete?: boolean;
  pullRequestState?: GitHubPRStateValue | null;
  currentStatus?: string | null;
}): GitHubPRStateValue {
  if (input.pullRequestState) {
    return input.pullRequestState;
  }
  if (input.isDelete) {
    return parseGitHubPRState(input.currentStatus) === GitHubPRState.Merged
      ? GitHubPRState.Merged
      : GitHubPRState.Closed;
  }
  return parseGitHubPRState(input.currentStatus) ?? GitHubPRState.Open;
}

/** Applies base-branch source priority without weakening stored provenance. */
export function resolveBaseProvenance(
  input: {
    baseBranch?: string | null;
    baseBranchSource?: BranchBaseBranchSource | null;
  },
  existing: {
    baseBranch: string | null;
    baseBranchSource: BranchBaseBranchSource | null;
  } | null
): {
  baseBranch: string | null;
  baseBranchSource: BranchBaseBranchSource | null;
} {
  if (!(input.baseBranch && input.baseBranchSource)) {
    return {
      baseBranch: existing?.baseBranch ?? null,
      baseBranchSource: existing?.baseBranchSource ?? null,
    };
  }
  const existingSource = existing?.baseBranchSource ?? null;
  if (
    existingSource &&
    baseBranchSourcePriority[existingSource] >
      baseBranchSourcePriority[input.baseBranchSource]
  ) {
    return {
      baseBranch: existing?.baseBranch ?? null,
      baseBranchSource: existingSource,
    };
  }
  return {
    baseBranch: input.baseBranch,
    baseBranchSource: input.baseBranchSource,
  };
}

/** Applies the ordered and replay-safe branch-head transition contract. */
export function applyHeadTransition(
  input: {
    headSha?: string | null;
    headShaSource?: BranchHeadShaSource | null;
    beforeSha?: string | null;
    observedAt?: Date | null;
    isCreate?: boolean;
  },
  existing: HeadTransitionState | null
): HeadTransitionResult {
  const current = existing ?? {
    headSha: null,
    headShaSource: null,
    headShaObservedAt: null,
    lastPushBeforeSha: null,
  };
  if (!input.headSha) {
    return { ...current, accepted: true, reason: "no_head_input" };
  }
  const observedAt = input.observedAt ?? new Date();
  if (isAcceptedGitHubRecreate(input, current)) {
    return {
      headSha: input.headSha,
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: observedAt,
      lastPushBeforeSha: input.beforeSha ?? null,
      accepted: true,
      reason: "recreated_after_delete",
    };
  }
  if (isStaleGitHubRecreate(input, current)) {
    return { ...current, accepted: false, reason: "stale_push" };
  }
  if (
    input.headShaSource === BranchHeadShaSource.HarnessInput &&
    current.headSha === input.headSha
  ) {
    return { ...current, accepted: true, reason: "duplicate_harness_input" };
  }
  if (input.headShaSource !== BranchHeadShaSource.PushWebhook) {
    return {
      headSha: input.headSha,
      headShaSource: input.headShaSource ?? BranchHeadShaSource.ExplicitSync,
      headShaObservedAt: observedAt,
      lastPushBeforeSha: null,
      accepted: true,
      reason: "authoritative_refresh",
    };
  }
  if (!current.headSha) {
    return {
      headSha: input.headSha,
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: observedAt,
      lastPushBeforeSha: input.beforeSha ?? null,
      accepted: true,
      reason: "first_observation",
    };
  }
  if (
    current.headSha === input.headSha &&
    current.lastPushBeforeSha === (input.beforeSha ?? null)
  ) {
    return { ...current, accepted: true, reason: "duplicate_push" };
  }
  if (
    !current.deletedAt &&
    current.headSha === input.headSha &&
    current.headShaSource !== BranchHeadShaSource.PushWebhook
  ) {
    return {
      headSha: input.headSha,
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: latestDate(current.headShaObservedAt, observedAt),
      lastPushBeforeSha: input.beforeSha ?? null,
      accepted: true,
      reason: "push_confirmed",
    };
  }
  if (current.headSha === input.beforeSha) {
    return {
      headSha: input.headSha,
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: observedAt,
      lastPushBeforeSha: input.beforeSha ?? null,
      accepted: true,
      reason: "sequential_push",
    };
  }
  return { ...current, accepted: false, reason: "stale_push" };
}

/** Applies branch-delete state without forcing a file-cache refresh. */
export function applyDeleteTransition(input: {
  isDelete?: boolean;
  deletedAt?: Date | null;
  currentStatus?: string | null;
  beforeSha?: string | null;
  currentHeadSha?: string | null;
  currentHeadShaObservedAt?: Date | null;
}): { deletedAt: Date | null; status: GitHubPRStateValue } | null {
  if (!input.isDelete) {
    return null;
  }
  const deletedAt = input.deletedAt ?? new Date();
  if (isStaleGitHubDelete(input, deletedAt)) {
    return null;
  }
  return {
    deletedAt,
    status:
      parseGitHubPRState(input.currentStatus) === GitHubPRState.Merged
        ? GitHubPRState.Merged
        : GitHubPRState.Closed,
  };
}

/** Resolves whether a provider push should schedule file-cache refresh. */
export function scheduleFileChangeCacheRefresh(input: {
  isDelete?: boolean;
  headTransition: HeadTransitionResult;
}): { shouldSchedule: boolean; fileCacheStatus?: BranchFileCacheStatus } {
  if (input.headTransition.reason === "duplicate_harness_input") {
    return { shouldSchedule: false };
  }
  if (
    input.isDelete ||
    !input.headTransition.accepted ||
    !input.headTransition.headSha ||
    input.headTransition.headShaSource !== BranchHeadShaSource.PushWebhook
  ) {
    return { shouldSchedule: false };
  }
  return {
    shouldSchedule: true,
    fileCacheStatus: BranchFileCacheStatus.Scheduled,
  };
}

function isGitHubZeroSha(value: string | null | undefined): boolean {
  return value === "0000000000000000000000000000000000000000";
}

function isAcceptedGitHubRecreate(
  input: {
    beforeSha?: string | null;
    observedAt?: Date | null;
    isCreate?: boolean;
  },
  current: HeadTransitionState
): boolean {
  return Boolean(
    current.deletedAt &&
      input.isCreate &&
      isGitHubZeroSha(input.beforeSha) &&
      isAfter(input.observedAt, current.deletedAt)
  );
}

function isStaleGitHubRecreate(
  input: {
    beforeSha?: string | null;
    observedAt?: Date | null;
    isCreate?: boolean;
  },
  current: HeadTransitionState
): boolean {
  return Boolean(
    current.deletedAt &&
      input.isCreate &&
      isGitHubZeroSha(input.beforeSha) &&
      !isAfter(input.observedAt, current.deletedAt)
  );
}

function isStaleGitHubDelete(
  input: {
    beforeSha?: string | null;
    currentHeadSha?: string | null;
    currentHeadShaObservedAt?: Date | null;
  },
  deletedAt: Date
): boolean {
  if (!input.currentHeadSha) {
    return false;
  }
  if (input.beforeSha && input.beforeSha !== input.currentHeadSha) {
    return true;
  }
  return Boolean(
    input.currentHeadShaObservedAt &&
      !isAfter(deletedAt, input.currentHeadShaObservedAt)
  );
}

function isAfter(candidate: Date | null | undefined, reference: Date): boolean {
  return candidate ? candidate.getTime() > reference.getTime() : false;
}

function latestDate(first: Date | null, second: Date): Date {
  if (!first) {
    return second;
  }
  return first.getTime() > second.getTime() ? first : second;
}
