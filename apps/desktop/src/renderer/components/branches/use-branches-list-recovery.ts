import {
  LIST_LOADING_STALL_THRESHOLDS,
  useLoadingStall,
} from "@repo/app/shared/hooks/use-loading-stall";
import type { LoadingStallPhase } from "@repo/app/shared/lib/loading-stall-phase";
import { useCallback, useRef, useState } from "react";

export function useBranchesListRecovery({
  isBlockingLoad,
  refetch,
}: {
  isBlockingLoad: boolean;
  refetch: () => Promise<unknown> | unknown;
}): BranchesListRecovery {
  const [retryToken, setRetryToken] = useState(0);
  const retryInFlight = useRef<Promise<unknown> | null>(null);
  const handleRetry = useCallback(() => {
    if (retryInFlight.current) {
      return retryInFlight.current;
    }
    if (isBlockingLoad) {
      return Promise.resolve();
    }
    setRetryToken((token) => token + 1);
    // Synchronous for the same reason as the Sessions hook: a microtask hop
    // hides the read from any caller observing the press in its own turn.
    const pending = Promise.resolve(refetch()).catch(() => undefined);
    retryInFlight.current = pending;
    return pending.finally(() => {
      retryInFlight.current = null;
    });
  }, [isBlockingLoad, refetch]);
  const stallPhase = useLoadingStall(
    isBlockingLoad,
    LIST_LOADING_STALL_THRESHOLDS,
    retryToken
  );
  return { handleRetry, stallPhase };
}

export type BranchesListRecovery = {
  /** Retry a failed request; pending reads are never cancelled or duplicated. */
  handleRetry: () => Promise<unknown>;
  stallPhase: LoadingStallPhase;
};
