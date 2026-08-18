// Source-resolution shim for bundlers that do not apply TypeScript's .js-to-.ts
// extension substitution when consuming workspace source directly.
import {
  GitHubConnectReturnStatus as GitHubConnectReturnStatusContract,
  GitHubPRState as GitHubPRStateContract,
  StatusCheckRollupFailureReason as StatusCheckRollupFailureReasonContract,
} from "./github-status.ts";

export const GitHubPRState = GitHubPRStateContract;
export const StatusCheckRollupFailureReason =
  StatusCheckRollupFailureReasonContract;
export const GitHubConnectReturnStatus = GitHubConnectReturnStatusContract;
