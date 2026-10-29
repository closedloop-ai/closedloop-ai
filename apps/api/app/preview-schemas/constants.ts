import { vibeBranchPrefix } from "@repo/database/scripts/vibe-environment-retention";

const PREVIEW_SCHEMA_SOURCE_REPO_OWNER = "closedloop-ai";
const PREVIEW_SCHEMA_SOURCE_REPO_NAME = "closedloop-ai";

export const PreviewSchemaSourceRepo = {
  owner: PREVIEW_SCHEMA_SOURCE_REPO_OWNER,
  name: PREVIEW_SCHEMA_SOURCE_REPO_NAME,
  fullName: `${PREVIEW_SCHEMA_SOURCE_REPO_OWNER}/${PREVIEW_SCHEMA_SOURCE_REPO_NAME}`,
} as const;

/**
 * Caps the body every branch-only route on this surface will buffer (the
 * ISS-12048 flag-snapshot route carries a whole snapshot and declares its own
 * cap), so a valid or replayed
 * token cannot make a function read and normalize an arbitrarily large payload
 * (review: davetho, ISS-6804; extended to `ensure` and the cleanup route by
 * ISS-6985).
 *
 * Every field these routes accept is a branch name bounded by the shared
 * `BRANCH_NAME_MAX_LENGTH` plus a short flag, and 2 KiB clears that worst case
 * (each character escaped to `\uXXXX` costs six bytes) with room to spare.
 * `BRANCH_NAME_MAX_LENGTH` has a different owner and can be raised without
 * anyone reading this file, so the relationship is pinned by
 * `__tests__/unit/preview-schemas-request-cap.test.ts` rather than by this
 * comment — if it is ever outgrown, that test fails before this cap can
 * silently start rejecting a legitimate branch.
 */
export const PREVIEW_SCHEMA_REQUEST_MAX_BYTES = 2048;

/**
 * The branch prefix of a vibe session's environment (ISS-12135, Daveth Oakhurst's
 * A5 ruling, renamed from `andy/` so it holds for anyone running the vibe
 * skill). The daily sweep never drops a schema on such a branch; the vibe
 * workflows and scripts under scripts/deploy and apps/prototypes keep their own
 * copies of this literal.
 * So does the pin table in scripts/ci/prototype-pin-alias.ts (ISS-12213).
 */
export const VIBE_BRANCH_PREFIX = vibeBranchPrefix;
