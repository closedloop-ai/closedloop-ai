/**
 * Fixture identity for the assigned-artifact-tree suites.
 *
 * Its own module so the SQL readers can scope-filter bound uuids without
 * importing the harness that imports them.
 */

export const ORGANIZATION_ID = "11111111-1111-7111-8111-111111111111";
export const OTHER_ORGANIZATION_ID = "99999999-9999-7999-8999-999999999999";
export const ASSIGNEE_ID = "22222222-2222-7222-8222-222222222222";
export const PROJECT_ID = "33333333-3333-7333-8333-333333333333";
export const OTHER_PROJECT_ID = "44444444-4444-7444-8444-444444444444";

export const ROOT_ID = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
export const MIDDLE_ID = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
export const ASSIGNED_ID = "cccccccc-cccc-7ccc-8ccc-cccccccccccc";
export const SECOND_ASSIGNED_ID = "dddddddd-dddd-7ddd-8ddd-dddddddddddd";
export const THIRD_ASSIGNED_ID = "eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee";
export const FOREIGN_PARENT_ID = "ffffffff-ffff-7fff-8fff-ffffffffffff";
export const BRANCH_ID = "77777777-7777-7777-8777-777777777777";
export const SESSION_ID = "88888888-8888-7888-8888-888888888888";
export const DEPLOYMENT_ID = "55555555-5555-7555-8555-555555555555";

/**
 * The READER, never the assignee whose tree is served. A plain id since
 * ISS-12463 deleted the feature-flag identity this used to carry; ISS-10471's
 * favorites facet is what still needs it.
 */
export const VIEWER_USER_ID = "66666666-6666-7666-8666-666666666666";

/**
 * Mirrors `MAX_CHAIN_DEPTH` / `MAX_TREE_ANCHORS` in the production modules.
 * Kept as local expectations rather than imported from production code so a
 * change to a production bound has to be acknowledged here instead of silently
 * satisfying its own assertion.
 */
export const MAX_CHAIN_DEPTH_BOUND = 20;
export const MAX_TREE_ANCHORS_BOUND = 500;
export const DEEP_CHAIN_LENGTH = MAX_CHAIN_DEPTH_BOUND + 6;
