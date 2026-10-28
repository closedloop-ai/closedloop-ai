"use client";

import type { ProjectSummaryRow } from "@repo/app/projects/lib/project-summary-row"; // Cross-slice: project pages render the shipped project list (ISS-12938).
import { Button } from "@repo/design-system/components/ui/button";
import { GridInteractionContract } from "@repo/design-system/components/ui/grid-interaction-contract";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { getStringRouteParam } from "@repo/navigation/route-param";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useRouteParams } from "@repo/navigation/use-route-params";
import { Columns3Icon, ListIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { PageChrome } from "../components/page-chrome";
import { ProjectArtifactBoardPreview } from "./project-artifact-board-preview";
import { artifactsForProject, projectArtifactHref } from "./project-artifacts";
import { ProjectDocumentsViewAdapter } from "./project-documents-view-adapter";
import { findProject } from "./project-model";

export function ProjectDetail() {
  const params = useRouteParams();
  const [addIssueOpen, setAddIssueOpen] = useState(false);
  const project = findProject(
    decodeURIComponent(getStringRouteParam(params, "projectId"))
  );

  if (!project) {
    return (
      <PageChrome
        breadcrumbs={[
          { href: "/p/web-master", label: "Home" },
          { href: "/p/web-master/projects", label: "Projects" },
          { isCurrent: true, label: "Project not found" },
        ]}
      >
        <div className="p-6">
          <h1 className="font-semibold text-xl">Project not found</h1>
          <p className="mt-2 text-muted-foreground text-sm">
            Return to Projects and select another project.
          </p>
        </div>
      </PageChrome>
    );
  }

  return (
    <PageChrome
      actions={
        <Button onClick={() => setAddIssueOpen(true)} size="sm" type="button">
          <PlusIcon />
          Add issue
        </Button>
      }
      breadcrumbs={[
        { href: "/p/web-master", label: "Home" },
        { href: "/p/web-master/projects", label: "Projects" },
        { isCurrent: true, label: project.name },
      ]}
    >
      <GridInteractionContract>
        <ProjectArtifacts
          addIssueOpen={addIssueOpen}
          onAddIssueOpenChange={setAddIssueOpen}
          project={project}
        />
      </GridInteractionContract>
    </PageChrome>
  );
}

function ProjectArtifacts({
  addIssueOpen,
  onAddIssueOpenChange,
  project,
}: {
  addIssueOpen: boolean;
  onAddIssueOpenChange: (open: boolean) => void;
  project: ProjectSummaryRow;
}) {
  const navigation = useNavigation();
  const [layout, setLayout] = useState<"board" | "list">("board");
  const [artifacts] = useState(() => artifactsForProject(project));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex justify-end border-b px-4 py-2">
        <ToggleGroup
          aria-label="Artifact layout"
          onValueChange={(value) => {
            if (value === "board" || value === "list") {
              setLayout(value);
            }
          }}
          type="single"
          value={layout}
          variant="outline"
        >
          <ToggleGroupItem aria-label="List view" value="list">
            <ListIcon />
            List
          </ToggleGroupItem>
          <ToggleGroupItem aria-label="Board view" value="board">
            <Columns3Icon />
            Board
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {layout === "board" ? (
        <ProjectArtifactBoardPreview
          artifacts={artifacts}
          onOpenArtifact={(artifact) =>
            navigation.navigate(projectArtifactHref(project, artifact))
          }
        />
      ) : (
        <ProjectDocumentsViewAdapter
          addIssueOpen={addIssueOpen}
          key={project.id}
          onAddIssueOpenChange={onAddIssueOpenChange}
          project={project}
        />
      )}
    </div>
  );
}
