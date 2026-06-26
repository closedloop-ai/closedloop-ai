"use client";

import { useQuery } from "@tanstack/react-query";
import {
  type OverlayUnavailableReason,
  OverlayUnavailableReason as Reason,
  resolveOverlayUnavailableReason,
} from "../lib/live-overlays/live-pr-overlay-error";
import {
  type LivePrStatusResult,
  livePrStatusOptions,
} from "../lib/live-overlays/live-pr-status";
import {
  derivePrIdentity,
  type PrIdentity,
  type PrIdentityInput,
} from "../lib/live-overlays/pr-identity";

export type LivePrStatusInput = PrIdentityInput;

export type UseLivePrStatusResult = {
  data: LivePrStatusResult | null;
  isLoading: boolean;
  reason: OverlayUnavailableReason | null;
};

/**
 * Derive the `/pr/reviews` identity from a branch's persisted fields. Thin alias
 * over the shared {@link derivePrIdentity} so F2 (status) and F1 (files) gate on
 * the same owner/repo/PR rules.
 */
export function deriveStatusIdentity(
  input: LivePrStatusInput
): PrIdentity | null {
  return derivePrIdentity(input);
}

export function useLivePrStatus(
  input: LivePrStatusInput
): UseLivePrStatusResult {
  const identity = deriveStatusIdentity(input);
  const query = useQuery(livePrStatusOptions(identity));

  let reason: OverlayUnavailableReason | null = null;
  if (query.isError) {
    reason = resolveOverlayUnavailableReason(query.error);
  } else if (identity === null) {
    reason = Reason.NoRepoIdentity;
  }

  return {
    // Only trust data for the CURRENT identity — when gated (identity null) the
    // query is disabled, so never surface another branch's cached/previous data.
    data: identity ? (query.data ?? null) : null,
    isLoading: query.isLoading,
    reason,
  };
}
