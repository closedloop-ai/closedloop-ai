/**
 * Story substitute for `issue-detail.stories.tsx`'s header, split into its
 * own file to keep every file in this Surface under the repo's 1,000-line
 * ceiling (`noExcessiveLinesPerFile`), not for any reuse reason. See that
 * file's own doc comment (CONFIRMED WALLS #2) for the full account of the
 * walls this Surface hits; the short version for the export here:
 *
 * - `StoryIssueEditorHeader` — `IssueEditorHeader`
 *   (`packages/app/documents/editors/issues/detail/components/issue-editor-header.tsx`), copied
 *   verbatim with `useOrgSlug()` swapped for the constant `ORG_SLUG`. The
 *   real `Header`, the real `FavoriteButton`, and the same overflow menu
 *   are unchanged.
 */

import type { DocumentWithProject } from "@repo/api/src/types/document";
import { FavoriteButton } from "@repo/app/documents/components/favorite-button";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  FolderInputIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  TrashIcon,
} from "lucide-react";
import {
  type BreadcrumbEntry,
  Header,
} from "@/app/(authenticated)/components/header";
import { ORG_SLUG } from "./app-shell";

type IssueEditorHeaderProps = {
  feature: DocumentWithProject;
  displayTitle: string;
  onToggleMetadataPanel: () => void;
  onMoveToProject: () => void;
  onDelete: () => void;
};

/** Story substitute for `IssueEditorHeader`
 * (`packages/app/documents/editors/issues/detail/components/issue-editor-header.tsx`) — the real
 * component verbatim, with `useOrgSlug()` swapped for the constant
 * `ORG_SLUG`. The real `Header`, the real `FavoriteButton`, and the same
 * overflow menu, unchanged. */
export function StoryIssueEditorHeader({
  feature,
  displayTitle,
  onToggleMetadataPanel,
  onMoveToProject,
  onDelete,
}: Readonly<IssueEditorHeaderProps>) {
  const orgSlug = ORG_SLUG;
  const teamId = feature.project?.teams?.[0]?.id;
  const projectId = feature.project?.id;
  const teamName = feature.project?.teams?.[0]?.name;
  const projectName = feature.project?.name;

  const breadcrumbs: BreadcrumbEntry[] = [
    ...(teamId && teamName
      ? [{ label: teamName, href: `/${orgSlug}/teams/${teamId}/projects` }]
      : []),
    ...(teamId && projectId && projectName
      ? [
          {
            label: projectName,
            href: `/${orgSlug}/teams/${teamId}/projects/${projectId}`,
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
