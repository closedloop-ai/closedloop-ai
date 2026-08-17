"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { ClockAlertIcon, TriangleAlertIcon } from "lucide-react";
import { ApiError } from "../../shared/api/api-error";

/** Copy for a read the server answered with a failure. */
const FAILED_TITLE = "Couldn't load packs";
const FAILED_DESCRIPTION =
  "We couldn't load your packs. Check your connection and try again.";

/**
 * Copy for a read the CLIENT stopped waiting on (ISS-5013). The title names what
 * happened to the LOAD, not to the packs — "Packs timed out" reads like the
 * packs themselves did something.
 */
const TIMED_OUT_TITLE = "Packs took too long to load";
const TIMED_OUT_DESCRIPTION = "We stopped waiting for a response.";

type PacksLoadFailedProps = {
  /**
   * The failure, when the surface has one. A client-deadline `ApiError` gets the
   * timeout treatment; anything else (including `undefined`, for a surface that
   * only knows `isError`) gets the generic failed-read treatment.
   */
  error?: unknown;
  /** Omit to render the state without a retry affordance. */
  onRetry?: () => void;
};

/**
 * Shared failure state for every Packs surface (ISS-5002).
 *
 * Lives beside {@link PacksWorkspaceSkeleton} so the two halves of the same
 * story — "still loading" and "it didn't load" — stay in lockstep instead of
 * each surface telling a different story about the same event. Wired today by
 * the web admin dashboard (`CatalogDashboard`), the `PacksPage` spine, and
 * `MemberView`'s "Your packs" region.
 *
 * The desktop plugins panel is the one holdout: it tracks a `LoadState` string
 * rather than an error object, so folding it in needs a real error threaded
 * through `window.desktopApi.db` first and is left as separate work.
 *
 * It separates the two ways a read can fail, because they are different facts a
 * user can act on differently: a client-side deadline means we stopped waiting,
 * while a server error means the request was answered and the answer was a
 * failure. It never renders a raw `error.message`, which can surface a
 * "Failed to fetch" or a truncated parse error to a customer.
 *
 * `role="alert"` is deliberate: this state replaces a `role="status"` loading
 * region, so without it a screen-reader user is never told the wait ended.
 */
export function PacksLoadFailed({ error, onRetry }: PacksLoadFailedProps) {
  const timedOut = error instanceof ApiError && error.isTimeout();
  return (
    <div role="alert">
      <EmptyState
        action={
          onRetry ? (
            <Button onClick={onRetry} size="sm" type="button" variant="outline">
              Try again
            </Button>
          ) : undefined
        }
        description={timedOut ? TIMED_OUT_DESCRIPTION : FAILED_DESCRIPTION}
        icon={timedOut ? ClockAlertIcon : TriangleAlertIcon}
        title={timedOut ? TIMED_OUT_TITLE : FAILED_TITLE}
      />
    </div>
  );
}
