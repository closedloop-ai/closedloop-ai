"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Link } from "@repo/navigation/link";
import { CalendarClockIcon } from "lucide-react";
import { useOrgSlug } from "@/hooks/use-org-slug";

/**
 * Web Routines index (PRD-566 / FEA-4348; the renamed "Scheduled Tasks"
 * feature).
 *
 * Routines are authored and run desktop-locally today — the crewd scheduler
 * daemon lives in the desktop app, and the cloud `GET /routines` list returns
 * an empty set until cloud-side persistence lands. So the web surface is
 * intentionally read-only: it names the feature, points the user to the desktop
 * app where routines are actually managed, and hands them the next step
 * (connect the desktop app) rather than dead-ending — matching every other
 * full-page empty state we ship. The interactive create/edit/run surface is the
 * desktop `RoutinesView`.
 */
export function RoutinesIndexView() {
  const orgSlug = useOrgSlug();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      <EmptyState
        action={
          <Button asChild>
            <Link href={`/${orgSlug}/settings/compute-targets`}>
              Connect the desktop app
            </Link>
          </Button>
        }
        description="Create and manage them there. Routines aren't on the web yet."
        icon={CalendarClockIcon}
        title="Routines run in the desktop app"
      />
    </div>
  );
}
