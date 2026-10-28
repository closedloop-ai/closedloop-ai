"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

type ListReadErrorAlertProps = {
  /**
   * Names the failure plainly — "Couldn't load <things>". A string, not a
   * `ReactNode`: `AlertTitle` is `line-clamp-1`, so anything richer would be
   * silently truncated to one line by a component that never warns. Same split
   * the DS `EmptyState` uses — `string` title/description, `ReactNode` action.
   */
  title: string;
  /** Existing failure detail when the host has one. */
  description?: string;
  /**
   * The single recovery affordance, or nothing. The HOST owns what this is:
   * the two list surfaces deliberately differ (see the module docstring), and
   * a shared default here would silently pick one of them.
   */
  action?: ReactNode;
};

/**
 * ISS-7521: the one errored-read alert treatment for a zero-row list surface,
 * shared by the Sessions empty state, the Branches empty state and the listing
 * stalled-load surface, on both shells.
 *
 * ISS-10645: that third consumer is now every listing's, not just Sessions' —
 * the stall ladder moved into one shared module and the hand-rolled copy of this
 * alert it was carrying became a call to this component.
 *
 * These were near-verbatim copies of one `Alert` — same variant, icon,
 * icon size, and `AlertDescription` layout — under a comment on the Branches
 * side asserting that parity held. It had already stopped holding, which is the
 * SSOT-drift-by-copy failure this consolidates: the copy was the only thing
 * keeping them equal, and nothing failed when one moved.
 *
 * The Alert sits FLUSH at full width: the host container (a `CardContent` on
 * web, the desktop panel) owns the inset, matching the sibling `EmptyState`
 * surfaces — no self-inset that would land it off a `px-6` card edge while its
 * siblings sit at 24px (review cid 3653690781).
 *
 * WHAT THIS DOES NOT UNIFY, deliberately: the `action`. The two surfaces render
 * a differently-sized Retry today (Sessions `size="sm"`, Branches the default),
 * and Sessions additionally prefers a host-supplied recovery Link over Retry.
 * Collapsing that here would be a visual change neither ticket authorized, so
 * the action stays the host's and the difference is now VISIBLE at the two call
 * sites instead of buried in duplicated markup. Which size should win is an
 * operator call, raised on the PR rather than decided here.
 */
export function ListReadErrorAlert({
  title,
  description,
  action,
}: Readonly<ListReadErrorAlertProps>): ReactNode {
  return (
    <Alert variant="error">
      {/* No `size-4` here: the DS `Alert` root already sizes its direct svg
          child (`[&>svg]:size-4`). lucide-react marks a childless icon
          `aria-hidden` itself, and the adjacent title carries the meaning. */}
      <TriangleAlertIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        {description}
        {action}
      </AlertDescription>
    </Alert>
  );
}
