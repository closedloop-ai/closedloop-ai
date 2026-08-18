import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { BranchAssociatedPullRequestSelectionReason } from "@repo/api/src/types/branch-associated-pull-request";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  ACTIVE_PR,
  detailFor,
  REPOSITORY,
} from "./branch-details-comprehensive-data";

/** Named ISS-5729 states shared by authenticated web and Electron regressions. */
export const BranchDeliveredIdentityScenario = {
  NoSelected: "no-selected",
  NullBody: "null-body",
  NullableIdentity: "nullable-identity",
  SelectedIdentity: "selected-identity",
  WhitespaceBody: "whitespace-body",
} as const;
export type BranchDeliveredIdentityScenario =
  (typeof BranchDeliveredIdentityScenario)[keyof typeof BranchDeliveredIdentityScenario];

/** Selected identity used to detect compatibility number leakage. */
export const SELECTED_PR_NUMBER = 22;
/** Compatibility identity used to detect selected number leakage. */
export const COMPATIBILITY_PR_NUMBER = 11;
/** Selected title paired with pull request #22. */
export const SELECTED_PR_TITLE = "Selected pull request";
/** Compatibility title paired with pull request #11. */
export const COMPATIBILITY_PR_TITLE = "Compatibility pull request";
/** Selected URL paired with pull request #22. */
export const SELECTED_PR_URL =
  "https://github.com/closedloop-ai/symphony-alpha/pull/22";
/** Compatibility URL paired with pull request #11. */
export const COMPATIBILITY_PR_URL =
  "https://github.com/closedloop-ai/symphony-alpha/pull/11";
/** Explicit selected description used by non-fallback scenarios. */
export const SELECTED_PR_BODY = "Selected body";
/** Legacy compatibility description used by fallback scenarios. */
export const COMPATIBILITY_PR_BODY = "Compatibility body";

/** Builds the five ISS-5729 projection states without changing API acquisition. */
export function deliveredIdentityDetail(
  scenario: BranchDeliveredIdentityScenario
): BranchPageDetail {
  const base = detailFor(ACTIVE_PR);
  const selected = {
    ...base.selectedPullRequest!,
    body: SELECTED_PR_BODY,
    id: `${REPOSITORY}#${SELECTED_PR_NUMBER}`,
    number: SELECTED_PR_NUMBER,
    state: GitHubPRState.Open,
    title: SELECTED_PR_TITLE,
    url: SELECTED_PR_URL,
  };
  const compatibility = {
    ...selected,
    body: COMPATIBILITY_PR_BODY,
    closedAt: "2026-08-02T00:00:00.000Z",
    id: `${REPOSITORY}#${COMPATIBILITY_PR_NUMBER}`,
    mergedAt: "2026-08-02T00:00:00.000Z",
    number: COMPATIBILITY_PR_NUMBER,
    state: GitHubPRState.Merged,
    title: COMPATIBILITY_PR_TITLE,
    url: COMPATIBILITY_PR_URL,
  };
  const detail: BranchPageDetail = {
    ...base,
    associatedPullRequests: {
      ...base.associatedPullRequests!,
      items: [selected, compatibility],
      selectedId: selected.id,
      selectionReason: BranchAssociatedPullRequestSelectionReason.Active,
    },
    prBody: COMPATIBILITY_PR_BODY,
    prNumber: COMPATIBILITY_PR_NUMBER,
    prState: GitHubPRState.Merged,
    prTitle: COMPATIBILITY_PR_TITLE,
    prUrl: COMPATIBILITY_PR_URL,
    selectedPullRequest: selected,
  };

  if (scenario === BranchDeliveredIdentityScenario.NoSelected) {
    return {
      ...detail,
      associatedPullRequests: undefined,
      selectedPullRequest: null,
    };
  }
  if (scenario === BranchDeliveredIdentityScenario.NullBody) {
    return {
      ...detail,
      selectedPullRequest: { ...selected, body: null },
    };
  }
  if (scenario === BranchDeliveredIdentityScenario.NullableIdentity) {
    return {
      ...detail,
      associatedPullRequests: {
        ...detail.associatedPullRequests!,
        items: [{ ...selected, title: null, url: null }, compatibility],
      },
      selectedPullRequest: { ...selected, title: null, url: null },
    };
  }
  if (scenario === BranchDeliveredIdentityScenario.WhitespaceBody) {
    return {
      ...detail,
      selectedPullRequest: { ...selected, body: "   " },
    };
  }
  return detail;
}
