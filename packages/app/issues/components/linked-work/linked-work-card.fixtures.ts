// gardener-support: test and story data, not shipped
import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import { GitHubPRState } from "@repo/api/src/types/github";
import type { LinkedWorkBranch } from "./linked-work-card";

/**
 * ISS-12580 (DI-10) fixtures: one branch per state the card shows, with
 * fixture names and addresses (story data of a design-only component, exempt
 * from the no-placeholder rule, 2026-10-15).
 */

const NO_CHECKS = {
  checksPassed: null,
  checksStatus: null,
  checksTotal: null,
} as const;

/** A branch with no pull request yet. */
export const BRANCH_IN_PROGRESS: LinkedWorkBranch = {
  ...NO_CHECKS,
  key: "branch-in-progress",
  name: "iss-12580-linked-work-card",
  href: "/branches/fixture-in-progress",
  repoShortName: "closedloop-ai",
  pullRequest: null,
  additions: 214,
  deletions: 12,
};

/** A branch whose pull request is open. */
export const BRANCH_IN_REVIEW: LinkedWorkBranch = {
  key: "branch-in-review",
  name: "iss-12572-details-fields",
  href: "/branches/fixture-in-review",
  repoShortName: "closedloop-ai",
  pullRequest: {
    number: 8902,
    title: "ISS-12572: Add Repositories to document and issue Details",
    state: GitHubPRState.Open,
    url: "https://closedloop.invalid/pull/8902",
  },
  checksPassed: 6,
  checksStatus: ChecksStatus.Passing,
  checksTotal: 6,
  additions: 35,
  deletions: 1,
};

/** A branch whose pull request merged. */
export const BRANCH_MERGED: LinkedWorkBranch = {
  key: "branch-merged",
  name: "iss-12586-doc-issue-page-shells",
  href: "/branches/fixture-merged",
  repoShortName: "closedloop-ai",
  pullRequest: {
    number: 8850,
    title: "ISS-12586: Document and Issue page shells",
    state: GitHubPRState.Merged,
    url: "https://closedloop.invalid/pull/8850",
  },
  checksPassed: 54,
  checksStatus: ChecksStatus.Passing,
  checksTotal: 54,
  additions: 2140,
  deletions: 310,
};

/** A branch whose pull request nobody has observed: a number, no state. */
export const BRANCH_UNCONFIRMED: LinkedWorkBranch = {
  ...BRANCH_MERGED,
  key: "branch-unconfirmed",
  href: "/branches/fixture-unconfirmed",
  pullRequest: {
    number: 8851,
    title: "ISS-12586: Document and Issue page shells",
    state: null,
    url: "https://closedloop.invalid/pull/8851",
  },
};

/** A branch whose pull request closed without merging. */
export const BRANCH_CLOSED: LinkedWorkBranch = {
  key: "branch-closed",
  name: "iss-12580-first-attempt",
  href: "/branches/fixture-closed",
  repoShortName: "closedloop-ai",
  pullRequest: {
    number: 8890,
    title: "Fixture: an earlier attempt",
    state: GitHubPRState.Closed,
    url: "https://closedloop.invalid/pull/8890",
  },
  checksPassed: 3,
  checksStatus: ChecksStatus.Failing,
  checksTotal: 6,
  additions: 88,
  deletions: 40,
};

/** A branch that implements a sub-issue of this issue. */
export const BRANCH_ON_SUB_ISSUE: LinkedWorkBranch = {
  ...BRANCH_IN_REVIEW,
  key: "branch-sub-issue",
  name: "iss-12579-activity-brief",
  href: "/branches/fixture-sub-issue",
  subIssue: { slug: "ISS-12579", href: "/issues/ISS-12579" },
  pullRequest: {
    number: 8915,
    title: "ISS-12579: Add the issue page's Activity brief",
    state: GitHubPRState.Open,
    url: "https://closedloop.invalid/pull/8915",
  },
};
