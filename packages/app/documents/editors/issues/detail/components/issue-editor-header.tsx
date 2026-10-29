"use client";

import type { DocumentWithProject } from "@repo/api/src/types/document";
import { FavoriteButton } from "@repo/app/documents/components/favorite-button";
import {
  type BreadcrumbEntry,
  Header,
} from "@repo/app/documents/editors/shared/header";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { useOrgPath } from "@repo/navigation/use-org-path";
import {
  FolderInputIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  TrashIcon,
} from "lucide-react";

type IssueEditorHeaderProps = {
  feature: DocumentWithProject;
  displayTitle: string;
  onToggleMetadataPanel: () => void;
  onMoveToProject: () => void;
  onDelete: () => void;
};

export function IssueEditorHeader({
  feature,
  displayTitle,
  onToggleMetadataPanel,
  onMoveToProject,
  onDelete,
}: Readonly<IssueEditorHeaderProps>) {
  const buildOrgPath = useOrgPath();
  const teamId = feature.project?.teams?.[0]?.id;
  const projectId = feature.project?.id;
  const teamName = feature.project?.teams?.[0]?.name;
  const projectName = feature.project?.name;

  const breadcrumbs: BreadcrumbEntry[] = [
    ...(teamId && teamName
      ? [{ label: teamName, href: buildOrgPath(`/teams/${teamId}/projects`) }]
      : []),
    ...(teamId && projectId && projectName
      ? [
          {
            label: projectName,
            // ISS-8396: land on the project's default "All Artifacts" view, not
            // a pre-filtered Issues tab — matching the PRD and Plan editor
            // breadcrumbs, which link to the bare project path.
            href: buildOrgPath(`/teams/${teamId}/projects/${projectId}`),
          },
        ]
      : []),
    { label: displayTitle },
  ];

  return (
    <Header
      afterBreadcrumbs={<FavoriteButton artifactId={feature.id} />}
      breadcrumbs={breadcrumbs}
      moreMenu={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button aria-label="More options" size="icon-sm" variant="ghost">
              <MoreHorizontalIcon className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[160px]">
            <DropdownMenuItem onClick={() => onMoveToProject()}>
              <FolderInputIcon className="h-4 w-4" />
              Move to Project
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onDelete()} variant="destructive">
              <TrashIcon className="h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <Button
        aria-label="Toggle chat panel"
        onClick={() => onToggleMetadataPanel()}
        size="icon-sm"
        title="Toggle chat panel"
        variant="ghost"
      >
        <PanelRightIcon className="h-4 w-4" />
      </Button>
    </Header>
  );
}
