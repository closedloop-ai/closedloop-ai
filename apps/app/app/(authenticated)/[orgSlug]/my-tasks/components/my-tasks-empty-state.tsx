"use client";

import { DocumentType } from "@repo/api/src/types/document";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { Button } from "@repo/design-system/components/ui/button";
import { Card } from "@repo/design-system/components/ui/card";
import { BoxIcon, FileTextIcon } from "lucide-react";
import { useState } from "react";
import { CreateDocumentModal } from "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/components/create-document-modal";
import { CreateFeatureModal } from "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/components/create-feature-modal";
import { TeamModal } from "@/app/(authenticated)/[orgSlug]/teams/components/team-modal";

type MyTasksEmptyStateProps = {
  readonly projects: ProjectWithDetails[];
};

export function MyTasksEmptyState({ projects }: MyTasksEmptyStateProps) {
  const [showPrdModal, setShowPrdModal] = useState(false);
  const [showFeatureModal, setShowFeatureModal] = useState(false);

  const defaultProject = projects[0];
  const defaultTeamId = defaultProject?.teams[0]?.id;

  const hasProjectContext = !!defaultProject && !!defaultTeamId;

  return (
    <div className="flex flex-col items-center px-6 py-6">
      <h2 className="font-semibold text-xl tracking-tight">
        Your queue is clear
      </h2>
      <p className="mt-2 max-w-2xl text-center text-muted-foreground text-sm">
        Ready to start something new? Define what you want to build or kick off
        a new feature.
      </p>

      {hasProjectContext ? (
        <div className="mt-6 grid w-full grid-cols-1 gap-3 sm:grid-cols-[minmax(0,350px)_minmax(0,350px)] sm:justify-center">
          <Card
            className="cursor-pointer gap-0 py-4 shadow-none transition-colors hover:bg-accent/50"
            onClick={() => setShowPrdModal(true)}
          >
            <div className="flex flex-col items-center gap-2 px-4 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-blue-500/10">
                <FileTextIcon className="h-5 w-5 text-blue-500" />
              </div>
              <p className="font-semibold text-md">Write a Requirements Doc</p>
              <p className="text-muted-foreground text-sm">
                Describe what you need built. AI can help draft and refine it.
              </p>
            </div>
          </Card>

          <Card
            className="cursor-pointer gap-0 py-4 shadow-none transition-colors hover:bg-accent/50"
            onClick={() => setShowFeatureModal(true)}
          >
            <div className="flex flex-col items-center gap-2 px-4 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-amber-500/10">
                <BoxIcon className="h-5 w-5 text-amber-500" />
              </div>
              <p className="font-semibold text-md">Create a Feature</p>
              <p className="text-muted-foreground text-sm">
                Track a unit of work. Assign it, set priority, and link related
                docs.
              </p>
            </div>
          </Card>
        </div>
      ) : (
        <TeamModal
          trigger={
            <Button className="mt-8" variant="outline">
              Create a Team
            </Button>
          }
        />
      )}

      {hasProjectContext && (
        <>
          <CreateDocumentModal
            documentType={DocumentType.Prd}
            onOpenChange={setShowPrdModal}
            open={showPrdModal}
            projectId={defaultProject.id}
            teamId={defaultTeamId}
          />
          <CreateFeatureModal
            onOpenChange={setShowFeatureModal}
            open={showFeatureModal}
            projectId={defaultProject.id}
            teamId={defaultTeamId}
          />
        </>
      )}
    </div>
  );
}
