"use client";

import { DocumentType } from "@repo/api/src/types/document";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { MyTasksRecencyEmptyState } from "@repo/app/my-tasks/components/my-tasks-recency-empty-state";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { CheckSquareIcon } from "lucide-react";
import { useState } from "react";
import { CreateDocumentModal } from "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/components/create-document-modal";
import { CreateIssueModal } from "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/components/create-issue-modal";
import { TeamModal } from "@/app/(authenticated)/[orgSlug]/teams/components/team-modal";

type MyTasksEmptyStateProps = {
  readonly projects: ProjectWithDetails[];
  /**
   * Set when a recency window is in force (FEA-1626). An empty board then means
   * "nothing in the window", NOT "queue is clear" — someone back from three
   * months of leave, or whose assigned work sits in an archived project, still
   * has all of it. Passing the escape hatch here rather than a boolean keeps the
   * claim and the way out of it in one prop.
   */
  readonly recencyWindow?: { readonly onShowAll: () => void } | null;
};

/**
 * The "queue is clear" zero-state for My Tasks, on BOTH of that page's views.
 * `page.tsx` renders it directly for the list view and hands the same component
 * to `MyTasksCardView` as its `emptyState` slot for the card board, so the two
 * surfaces have always shared this markup and both change together here. The
 * `EmptyState` in `my-tasks-kanban.tsx` is a different state, the signed-out
 * branch behind `!assigneeId`; the board itself has no queue-clear branch at
 * all.
 *
 * Built on the catalog `EmptyState` rather than hand-rolled markup to put the
 * surface on design-system tokens: the previous version boxed each lucide icon
 * in its own raw-palette chip (`bg-blue-500/10`, `bg-amber-500/10`), which
 * neither responds to theme tokens nor matches anything else in the catalog.
 * The two create paths now sit in the DS action slot as ranked buttons, a
 * primary and a secondary, rather than as two visually identical cards.
 *
 * The description is per-branch because the action slot is: with project
 * context the buttons name both create paths, so the copy stays short and does
 * not repeat them; without it the only door is team creation, so the copy names
 * that instead of promising two paths that are not on screen.
 */
export function MyTasksEmptyState({
  projects,
  recencyWindow,
}: MyTasksEmptyStateProps) {
  const [showPrdModal, setShowPrdModal] = useState(false);
  const [showFeatureModal, setShowFeatureModal] = useState(false);

  if (recencyWindow) {
    return <MyTasksRecencyEmptyState onShowAll={recencyWindow.onShowAll} />;
  }

  const defaultProject = projects[0];
  const defaultTeamId = defaultProject?.teams[0]?.id;

  const hasProjectContext = !!defaultProject && !!defaultTeamId;

  return (
    <>
      <EmptyState
        action={
          hasProjectContext ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button onClick={() => setShowPrdModal(true)}>Create PRD</Button>
              <Button
                onClick={() => setShowFeatureModal(true)}
                variant="outline"
              >
                Create Issue
              </Button>
            </div>
          ) : (
            <TeamModal
              trigger={<Button variant="outline">Create a Team</Button>}
            />
          )
        }
        description={
          hasProjectContext
            ? "Ready to start something new?"
            : "Create a team to start assigning work."
        }
        icon={CheckSquareIcon}
        title="Your queue is clear"
      />

      {hasProjectContext && (
        <>
          <CreateDocumentModal
            documentType={DocumentType.Prd}
            onOpenChange={setShowPrdModal}
            open={showPrdModal}
            projectId={defaultProject.id}
            teamId={defaultTeamId}
          />
          <CreateIssueModal
            onOpenChange={setShowFeatureModal}
            open={showFeatureModal}
            projectId={defaultProject.id}
            teamId={defaultTeamId}
          />
        </>
      )}
    </>
  );
}
