import { BRANCHES_LISTING_LOADING_PARITY_FLAG_KEY } from "@repo/api/src/types/branches-listing-loading-parity-flag";
import type { ListLoadingCopy } from "@repo/app/shared/components/list-loading-body";

/** Default-off shared flag for the Branches listing loading-parity treatment. */
export const BRANCHES_LISTING_LOADING_PARITY_FEATURE_FLAG_KEY =
  BRANCHES_LISTING_LOADING_PARITY_FLAG_KEY;

/**
 * ISS-10645: the Branches listing's nouns for the shared loading ladder.
 *
 * Deliberately free of React and of any desktop type, so the Playwright specs
 * that assert this copy can import the constants rather than restate them —
 * the same reason `sessions-list-loading-labels.ts` is React-free.
 */
export const BRANCHES_LIST_LOADING_LABEL = "Loading branches...";

export const BRANCHES_LIST_LOADING_COPY: ListLoadingCopy = {
  loadingLabel: BRANCHES_LIST_LOADING_LABEL,
};
