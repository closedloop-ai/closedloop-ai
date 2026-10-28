/** Provider observations that can identify a successful Branch pusher. */
export const BranchPushContributionSource = {
  Webhook: "push_webhook",
  GraphqlPush: "graphql_push",
  RestPushEvent: "rest_push_event",
  HeadRefForcePushed: "head_ref_force_pushed",
} as const;
export type BranchPushContributionSource =
  (typeof BranchPushContributionSource)[keyof typeof BranchPushContributionSource];

/** SHA shape accepted by the receipt; this alone does not prove new commits. */
export const BRANCH_PUSH_SHA_PATTERN = "^[0-9a-f]{40}([0-9a-f]{24})?$" as const;
export const BRANCH_PUSH_ZERO_SHA_PATTERN = "^0+$" as const;
export const BRANCH_PUSH_SHA_RE = new RegExp(BRANCH_PUSH_SHA_PATTERN, "i");
const ZERO_SHA_RE = new RegExp(BRANCH_PUSH_ZERO_SHA_PATTERN);

/** Reject impossible receipt ranges at persisted and read boundaries. */
export function isPlausibleBranchPushTransition(
  beforeSha: string,
  afterSha: string
): boolean {
  return (
    BRANCH_PUSH_SHA_RE.test(beforeSha) &&
    BRANCH_PUSH_SHA_RE.test(afterSha) &&
    !ZERO_SHA_RE.test(afterSha) &&
    beforeSha.toLowerCase() !== afterSha.toLowerCase()
  );
}
