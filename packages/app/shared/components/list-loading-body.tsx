import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import type { LoadingStallPhase } from "../lib/loading-stall-phase";

/** Listing-specific copy for a request that has not settled. */
export type ListLoadingCopy = { loadingLabel: string };

/** Pending requests remain loading. Retry belongs to the settled error state. */
export function renderListLoadingBody({
  copy,
  hasData,
  isLoading,
  loadingLabel,
  quietLoadingBody,
  stallAction,
  stallPhase,
}: {
  copy: ListLoadingCopy;
  hasData: boolean;
  isLoading: boolean;
  loadingLabel: string | undefined;
  quietLoadingBody?: ReactNode;
  /** Existing account connection action for a slow load. */
  stallAction?: ReactNode;
  stallPhase: LoadingStallPhase;
}): ReactNode {
  const quietBody = quietLoadingBody ?? (
    <ListLoadingState label={copy.loadingLabel} />
  );
  if (isLoading && !hasData) {
    // Elapsed time is not a request failure. Keep the loading treatment and
    // any account CTA, without allowing another read while this one is pending.
    if (stallAction && stallPhase !== "none") {
      return (
        <div aria-live="polite" className={CENTERED_STATE_CLASS} role="status">
          <Loader2 aria-hidden="true" className="size-5 animate-spin" />
          <span className="font-medium">
            {loadingLabel ?? copy.loadingLabel}
          </span>
          {stallAction}
        </div>
      );
    }
    return loadingLabel ? <ListLoadingState label={loadingLabel} /> : quietBody;
  }

  // A keep-previous refetch: the rows stay, and the label says why they are
  // being replaced. No escalation — nothing is blocked.
  return loadingLabel ? <ListLoadingState label={loadingLabel} /> : null;
}

const CENTERED_STATE_CLASS =
  "flex min-h-80 flex-col items-center justify-center gap-3 border-t px-4 text-center text-muted-foreground text-sm";

/** Accessible loading label retained while the request remains pending. */
function ListLoadingState({ label }: { label: string }): ReactNode {
  return (
    <div aria-live="polite" className={CENTERED_STATE_CLASS} role="status">
      <Loader2 aria-hidden="true" className="size-5 animate-spin" />
      <span className="font-medium">{label}</span>
    </div>
  );
}
