import type { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";

export class ReplayDetectedError extends Error {
  constructor(message = "Replay detected") {
    super(message);
    this.name = "ReplayDetectedError";
  }
}

export function isReplayDetectedError(
  error: unknown
): error is ReplayDetectedError {
  return error instanceof ReplayDetectedError;
}

export class InvalidStatusTransitionError extends Error {
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string) {
    super(`Invalid status transition: ${from} → ${to}`);
    this.name = "InvalidStatusTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function isInvalidStatusTransitionError(
  error: unknown
): error is InvalidStatusTransitionError {
  return error instanceof InvalidStatusTransitionError;
}

export class ConcurrentLoopLimitError extends Error {
  readonly activeCount: number;
  readonly limit: number;
  constructor(activeCount: number, limit: number) {
    super(
      `Too many active loops (${activeCount}). Maximum ${limit} concurrent loops allowed. ` +
        "Wait for existing loops to complete or cancel them."
    );
    this.name = "ConcurrentLoopLimitError";
    this.activeCount = activeCount;
    this.limit = limit;
  }
}

export function isConcurrentLoopLimitError(
  error: unknown
): error is ConcurrentLoopLimitError {
  return error instanceof ConcurrentLoopLimitError;
}

export class LoopAlreadyActiveError extends Error {
  readonly existingLoopId: string;
  readonly existingCommand: LoopCommand;
  readonly existingStatus: LoopStatus;
  constructor(
    existingLoopId: string,
    existingCommand: LoopCommand,
    existingStatus: LoopStatus
  ) {
    super(
      `A ${existingCommand} loop is already active (id: ${existingLoopId}, status: ${existingStatus}). ` +
        "Cancel or wait for the existing loop to complete before starting a new one."
    );
    this.name = "LoopAlreadyActiveError";
    this.existingLoopId = existingLoopId;
    this.existingCommand = existingCommand;
    this.existingStatus = existingStatus;
  }
}

export function isLoopAlreadyActiveError(
  error: unknown
): error is LoopAlreadyActiveError {
  return error instanceof LoopAlreadyActiveError;
}

export class NestedManualLoopError extends Error {
  constructor(documentId: string) {
    super(
      `Cannot create a manual loop while a platform-managed loop is already running for this document (${documentId}). ` +
        "Wait for the existing loop to complete or cancel it first."
    );
    this.name = "NestedManualLoopError";
  }
}

export function isNestedManualLoopError(
  error: unknown
): error is NestedManualLoopError {
  return error instanceof NestedManualLoopError;
}

export class UnauthorizedRepoError extends Error {
  readonly unauthorizedRepos: string[];
  constructor(unauthorizedRepos: string[]) {
    super(
      `GitHub App installation does not have access to the following repositories: ${unauthorizedRepos.join(", ")}`
    );
    this.name = "UnauthorizedRepoError";
    this.unauthorizedRepos = unauthorizedRepos;
  }
}

export function isUnauthorizedRepoError(
  error: unknown
): error is UnauthorizedRepoError {
  return error instanceof UnauthorizedRepoError;
}

export class BranchNotFoundError extends Error {
  readonly repoFullName: string;
  readonly branch: string;
  constructor(repoFullName: string, branch: string) {
    super(`Branch "${branch}" does not exist in repository ${repoFullName}`);
    this.name = "BranchNotFoundError";
    this.repoFullName = repoFullName;
    this.branch = branch;
  }
}

export function isBranchNotFoundError(
  error: unknown
): error is BranchNotFoundError {
  return error instanceof BranchNotFoundError;
}
