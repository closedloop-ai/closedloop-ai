"use client";

import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { branchesKeys } from "../../hooks/use-branches";
import { branchesOverlayKeys } from "./overlay-keys";

export type UseOverlayRefreshResult = {
  /** Re-fetch the live overlays AND the persisted list/detail reads. */
  refresh: () => void;
  /** True while any live overlay query is fetching. */
  isChecking: boolean;
};

/**
 * F5 — manual/programmatic refresh of the Branches LIVE overlays (Epic F /
 * FEA-1952). `refresh()` invalidates the overlay namespace
 * (`branchesOverlayKeys.all()` → F1 files + F2 status) AND the persisted
 * `branchesKeys.lists()`/`details()` so a refresh re-reads everything. A
 * same-key refetch keeps the cached data on screen, so a refresh patches new
 * values in without ever blanking the panel (no full-page spinner).
 */
export function useOverlayRefresh(): UseOverlayRefreshResult {
  const queryClient = useQueryClient();
  const isChecking = useIsFetching({ queryKey: branchesOverlayKeys.all() }) > 0;

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: branchesOverlayKeys.all() });
    queryClient.invalidateQueries({ queryKey: branchesKeys.lists() });
    queryClient.invalidateQueries({ queryKey: branchesKeys.details() });
  }, [queryClient]);

  return { refresh, isChecking };
}
