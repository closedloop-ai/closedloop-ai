"use client";

import {
  Button,
  buttonVariants,
} from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { TriangleAlertIcon } from "lucide-react";

/**
 * ISS-5001: the terminal state for a route whose feature flag NEVER resolved.
 *
 * This is deliberately NOT the same surface as a flag that resolved OFF. A
 * resolved-off flag is a decision — the route is not available to you, and the
 * "Page not found" recovery state says that correctly. A flag that never
 * resolves is a failed read, and claiming the page does not exist would tell the
 * user something untrue about their access. The copy is therefore the house
 * failed-read vocabulary ("Couldn't load…"), which reads as an obviously
 * different fact from "Page not found".
 *
 * It fails CLOSED — the gated children are never rendered — while still stating
 * the fact and offering two ways forward, which is the part the previous
 * permanent `null` was missing. "Back to dashboard" matters because a reload
 * lands on another bounded wait: if the flag source is genuinely down, retrying
 * alone would be a loop with no exit.
 *
 * `role="alert"` is deliberate: this replaces a `role="status"` loading region,
 * so without it a screen-reader user is never told the wait ended.
 */
export function FeatureFlagUnavailable() {
  const buildOrgPath = useOrgPath();

  return (
    <div
      className="flex h-full flex-col items-center justify-center p-6"
      role="alert"
    >
      <EmptyState
        action={
          <div className="flex items-center gap-2">
            <Button
              onClick={() => {
                globalThis.location.reload();
              }}
              type="button"
            >
              Try again
            </Button>
            <Link
              className={buttonVariants({ variant: "ghost" })}
              href={buildOrgPath("/dashboard")}
            >
              Back to dashboard
            </Link>
          </div>
        }
        description="Something went wrong on our end. This is usually temporary."
        icon={TriangleAlertIcon}
        title="Couldn't load this page"
      />
    </div>
  );
}
