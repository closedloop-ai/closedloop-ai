"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ProjectGridContainment } from "./project-grid-containment";

type ProjectArtifactsRegionProps = {
  /** Whether a tree read the active tab depends on failed. */
  hasReadFailed: boolean;
  /** Retry every read the active tab depends on. */
  onRetry: () => void;
  /** The artifact table, rendered when the reads succeeded. */
  children: ReactNode;
};

/**
 * The project page's artifact region: the table, or — when a tree read FAILED —
 * a degraded state INSTEAD of it (whitlockk, PR #6745).
 *
 * A failed read and an empty project are different facts a reader acts on
 * differently (retry versus create something), and a rejected TanStack query
 * clears loading and leaves no data — so rendering the table anyway hands the
 * empty state a corpus it never fetched and tells a viewer whose category read
 * failed that their project has no PRDs. Same shape and vocabulary as
 * `MyTasksLoadFailedState`, which answers the same question on the sibling
 * board; kept local because the copy names this surface's noun.
 *
 * The switch lives here rather than in `page.tsx` so that orchestrator stays
 * under the cognitive-complexity ceiling.
 */
export function ProjectArtifactsRegion({
  hasReadFailed,
  onRetry,
  children,
}: Readonly<ProjectArtifactsRegionProps>) {
  if (hasReadFailed) {
    return (
      <div className="p-4">
        <EmptyState
          action={
            <Button onClick={onRetry} variant="outline">
              Try again
            </Button>
          }
          description="We couldn't load this project's artifacts. Check your connection and try again."
          icon={TriangleAlertIcon}
          title="Couldn't load artifacts"
        />
      </div>
    );
  }
  return <ProjectGridContainment>{children}</ProjectGridContainment>;
}
