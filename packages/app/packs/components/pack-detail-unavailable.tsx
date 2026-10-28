"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { BlocksIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The two states a pack detail can be in once it is ADDRESSABLE (ISS-6925) that
 * it could never be in while selection was component state: a direct load whose
 * detail read has not landed, and a route naming a pack this org's catalog does
 * not carry.
 *
 * Both exist because the workspace's pre-route behavior — fall through to the
 * discovery grid when the selected id resolves to nothing — becomes a lie at a
 * detail URL. A still-fetching load would render as "here is the catalog", and a
 * stale bookmark would silently answer a question the user did not ask. Neither
 * may reuse the other's treatment: a skeleton claims the pack is coming, and the
 * empty state claims it is not there.
 */

/** A direct load whose per-pack detail read is still in flight. */
function PackDetailPending({ backSlot }: { backSlot: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      {backSlot}
      <div
        aria-label="Loading pack"
        aria-live="polite"
        className="flex flex-col gap-4"
        role="status"
      >
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

/** A route naming a pack the loaded catalog does not carry. */
function PackDetailNotFound({ backSlot }: { backSlot: ReactNode }) {
  return (
    <EmptyState
      action={backSlot}
      className="py-16"
      description="This pack isn't in your organization's catalog. It may have been archived, or the link may be out of date."
      icon={BlocksIcon}
      title="Pack not found"
    />
  );
}

/** A detail read that failed — a transport fault, not a missing pack. */
function PackDetailLoadFailed({
  backSlot,
  onRetry,
}: {
  readonly backSlot: ReactNode;
  readonly onRetry?: () => void;
}) {
  return (
    <EmptyState
      action={
        onRetry ? (
          <div className="flex items-center gap-2">
            <Button onClick={onRetry} size="sm" variant="outline">
              Try again
            </Button>
            {backSlot}
          </div>
        ) : (
          backSlot
        )
      }
      className="py-16"
      description="Something went wrong loading this pack. It may still be in your organization's catalog."
      icon={BlocksIcon}
      title="Couldn't load this pack"
    />
  );
}

/**
 * The one entry point the workspace renders for a routed selection it cannot
 * resolve. Owning the choice here keeps the two states from being told apart at
 * the call site — and keeps "still loading" from ever being reported as "not
 * found", which is the whole distinction.
 */
export function PackDetailUnavailable({
  pending,
  failed,
  backSlot,
  onRetry,
}: {
  readonly pending: boolean;
  readonly failed: boolean;
  readonly backSlot: ReactNode;
  readonly onRetry?: () => void;
}) {
  if (pending) {
    return <PackDetailPending backSlot={backSlot} />;
  }
  // Ordered before not-found on purpose: a failed read is evidence about the
  // REQUEST, and says nothing about whether the catalog carries the pack.
  if (failed) {
    return <PackDetailLoadFailed backSlot={backSlot} onRetry={onRetry} />;
  }
  return <PackDetailNotFound backSlot={backSlot} />;
}
