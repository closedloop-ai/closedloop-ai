import { BRANCH_NAME_REGEX } from "@closedloop-ai/loops-api/execution-result";
import { BRANCH_NAME_MAX_LENGTH } from "@repo/api/src/types/artifact";
import { z } from "zod";

/**
 * Shared Zod building blocks for validators that accept repository selections
 * (Loop dispatch, document creation, etc.). Centralizing avoids drift between
 * the various repo-input surfaces — e.g. document creation's
 * `repositorySelection` and Loop dispatch's `repo` / `additionalRepos` must
 * apply the same constraints so values are interoperable round-trip.
 */

export const REPO_FULL_NAME_MAX_LENGTH = 256;
export const REPO_FULL_NAME_REGEX = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
export const REPO_FULL_NAME_ERROR = "Must be in 'owner/repo' format";
export const BRANCH_NAME_ERROR = "Branch name contains invalid characters";

export const repoFullNameSchema = z
  .string()
  .max(REPO_FULL_NAME_MAX_LENGTH)
  .regex(REPO_FULL_NAME_REGEX, REPO_FULL_NAME_ERROR);

export const repoBranchSchema = z
  .string()
  .max(BRANCH_NAME_MAX_LENGTH)
  .regex(BRANCH_NAME_REGEX, BRANCH_NAME_ERROR);
