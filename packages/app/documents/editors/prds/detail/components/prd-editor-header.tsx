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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { useOrgPath } from "@repo/navigation/use-org-path";
import {
  DownloadIcon,
  FolderIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  RotateCcwIcon,
  TrashIcon,
} from "lucide-react";

type PRDEditorHeaderProps = {
  prd: DocumentWithProject;
  onToggleMetadataPanel: () => void;
  onExport: () => void;
  onMove: () => void;
  showRestore?: boolean;
  onRestoreVersion?: () => void;
  onDelete: () => void;
};

export function PRDEditorHeader({
  prd,
  onToggleMetadataPanel,
  onExport,
  onMove,
  showRestore = false,
  onRestoreVersion,
  onDelete,
}: Readonly<PRDEditorHeaderProps>) {
  const buildOrgPath = useOrgPath();

  const breadcrumbs: BreadcrumbEntry[] = prd.project?.teams?.[0]?.id
    ? [
        {
          label: prd.project.teams[0].name,
          href: buildOrgPath(`/teams/${prd.project.teams[0].id}/projects`),
        },
        {
          label: prd.project.name,
          href: buildOrgPath(
            `/teams/${prd.project.teams[0].id}/projects/${prd.project.id}`
          ),
        },
        { label: prd.title },
      ]
    : [{ label: "Library", href: buildOrgPath("/prds") }, { label: prd.title }];

  const overflowMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label="More options" size="icon" variant="ghost">
          <MoreHorizontalIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[160px]">
        <DropdownMenuItem onClick={() => onExport()}>
          <DownloadIcon className="h-4 w-4" />
          Export .md
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onMove()}>
          <FolderIcon className="h-4 w-4" />
          Move...
        </DropdownMenuItem>
        {showRestore ? (
          <DropdownMenuItem onClick={() => onRestoreVersion?.()}>
            <RotateCcwIcon className="h-4 w-4" />
            Restore Version
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onDelete()} variant="destructive">
          <TrashIcon className="h-4 w-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <Header
      afterBreadcrumbs={<FavoriteButton artifactId={prd.id} />}
      breadcrumbs={breadcrumbs}
      moreMenu={overflowMenu}
    >
      <Button
        aria-label="Toggle chat panel"
        onClick={() => onToggleMetadataPanel()}
        size="icon"
        title="Toggle chat panel"
        variant="ghost"
      >
        <PanelRightIcon className="h-4 w-4" />
      </Button>
    </Header>
  );
}
