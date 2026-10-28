// Source-resolution shim for bundlers that do not apply TypeScript's .js-to-.ts
// extension substitution when consuming workspace source directly.
import {
  GITHUB_ERROR_CODES as GITHUB_ERROR_CODES_CONTRACT,
  GitHubConnectReturnStatus as GitHubConnectReturnStatusContract,
  GitHubPRState as GitHubPRStateContract,
  StatusCheckRollupFailureReason as StatusCheckRollupFailureReasonContract,
} from "./github-status.ts";

export const GitHubPRState = GitHubPRStateContract;
export const StatusCheckRollupFailureReason =
  StatusCheckRollupFailureReasonContract;
export const GitHubConnectReturnStatus = GitHubConnectReturnStatusContract;
export const GITHUB_ERROR_CODES = GITHUB_ERROR_CODES_CONTRACT;
