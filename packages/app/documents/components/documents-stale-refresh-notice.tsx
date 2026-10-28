"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { TriangleAlertIcon } from "lucide-react";

/**
 * Says that the Documents index's rows are the last ones that loaded, and that
 * the attempt to refresh them failed (ISS-8940 AC3).
 *
 * The rows below it are real but no longer known to be current, and nothing
 * about the rows themselves tells a reader that — so the surface says it rather
 * than presenting stale data as settled.
 *
 * `role="status"` with `aria-live="polite"`, not the `Alert` default of
 * `role="alert"`: a background refresh retries on window focus, so an assertive
 * announcement would interrupt a screen-reader user on every return to the tab
 * while the outage lasts. Same reasoning, and the same visual chrome, as
 * `select-pr-dialog.tsx`. The rows stay usable throughout, which is what makes
 * polite the honest register here.
 */
export type DocumentsStaleRefreshNoticeProps = {
  /** Retry the failed refresh. */
  onRetry: () => void;
  noun?: "documents" | "issues";
};

export function DocumentsStaleRefreshNotice({
  onRetry,
  noun = "documents",
}: Readonly<DocumentsStaleRefreshNoticeProps>) {
  return (
    <div className="px-4 pt-4 pb-3">
      <Alert aria-live="polite" role="status" variant="warning">
        <TriangleAlertIcon />
        <AlertTitle>Showing your last loaded {noun}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          <span>We couldn't refresh them just now.</span>
          <Button onClick={onRetry} size="sm" variant="outline">
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}
