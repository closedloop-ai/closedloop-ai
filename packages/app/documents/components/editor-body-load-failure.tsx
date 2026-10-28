"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { ClockAlertIcon } from "lucide-react";

/**
 * Names what happened to the LOAD, and claims only what the code actually
 * observed. The one input behind this state is a client-side deadline — nothing
 * here watches the Liveblocks room, so "it failed" would be a fact we never
 * checked, and the state is retractable (a slow session that lands afterwards
 * clears it), which a terminal failure would not be. Same wording split as
 * `PacksLoadFailed`'s timed-out treatment, for the same reason.
 */
export const EDITOR_LOAD_TIMEOUT_TITLE = "The editor took too long to load";
const EDITOR_LOAD_TIMEOUT_DESCRIPTION = "We stopped waiting for a response.";

type EditorBodyLoadFailureProps = {
  /** Omit to render the state without a recovery affordance. */
  onRetry?: () => void;
};

/**
 * Shown when the editor never became ready (ISS-7058). Before this, the wait
 * had no end: the scaffold kept the editor body at `invisible h-0
 * overflow-hidden` forever, which reads as "this artifact has no description
 * field" rather than "loading failed" — so the artifact looked like it simply
 * could not be written to.
 *
 * Follows the `PacksLoadFailed` / `MyTasksLoadFailedState` shape rather than
 * inventing a fourth failure treatment, and never renders a raw error message.
 *
 * `role="alert"` is deliberate, for the same reason it is on those siblings:
 * this state replaces the scaffold's `role="status"` loading region, so without
 * it a screen-reader user is never told the wait ended.
 */
export function EditorBodyLoadFailure({
  onRetry,
}: Readonly<EditorBodyLoadFailureProps>) {
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
        description={EDITOR_LOAD_TIMEOUT_DESCRIPTION}
        icon={ClockAlertIcon}
        title={EDITOR_LOAD_TIMEOUT_TITLE}
      />
    </div>
  );
}
