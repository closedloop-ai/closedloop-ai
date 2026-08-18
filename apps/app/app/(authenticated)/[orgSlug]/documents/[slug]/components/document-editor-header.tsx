"use client";

import type { DocumentWithProject } from "@repo/api/src/types/document";
import { FavoriteButton } from "@repo/app/documents/components/favorite-button";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  RotateCcwIcon,
  TrashIcon,
} from "lucide-react";
import {
  type BreadcrumbEntry,
  Header,
} from "@/app/(authenticated)/components/header";
import { useOrgSlug } from "@/hooks/use-org-slug";

type DocumentEditorHeaderProps = {
  document: DocumentWithProject;
  canShowPanel?: boolean;
  isMetadataPanelOpen?: boolean;
  showRestore?: boolean;
  onCopyMarkdown: () => void;
  onExportMarkdown: () => void;
  onRestoreVersion?: () => void;
  onDelete: () => void;
  onToggleMetadataPanel: () => void;
};

/**
 * Header for the org-level Document (DOC) editor (ISS-4382).
 *
 * A DOC is a plain evergreen document with no PRD/plan generation pipeline, so
 * this header is intentionally lean: it carries the back-to-Documents
 * breadcrumb, the favorite toggle, an overflow menu of content actions
 * (export/copy markdown, restore, delete), and the metadata-panel toggle. It
 * deliberately omits the Approve/Execute/Regenerate/Evaluate "Actions" menu
 * that PRD and Implementation Plan headers carry (none of those commands apply
 * to a generic document), as well as Move (a DOC is org-level and cannot live
 * in a project) and a standalone Rename dialog (the inline
 * `EditableDocumentTitle` owns renaming the title in place).
 */
export function DocumentEditorHeader({
  document,
  canShowPanel = true,
  isMetadataPanelOpen = false,
  showRestore = false,
  onCopyMarkdown,
  onExportMarkdown,
  onRestoreVersion,
  onDelete,
  onToggleMetadataPanel,
}: Readonly<DocumentEditorHeaderProps>) {
  const orgSlug = useOrgSlug();

  const breadcrumbs: BreadcrumbEntry[] = [
    { label: "Documents", href: `/${orgSlug}/documents` },
    { label: document.title },
  ];

  const overflowMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label="More options" size="icon" variant="ghost">
          <MoreHorizontalIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[280px]">
        <DropdownMenuItem onClick={() => onExportMarkdown()}>
          <DownloadIcon className="h-4 w-4" />
          Export Markdown
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onCopyMarkdown()}>
          <CopyIcon className="h-4 w-4" />
          Copy Markdown
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
          Delete Document
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <Header
      afterBreadcrumbs={<FavoriteButton artifactId={document.id} />}
      breadcrumbs={breadcrumbs}
      moreMenu={overflowMenu}
    >
      {canShowPanel && (
        <Button
          aria-expanded={isMetadataPanelOpen}
          aria-label="Toggle side panel"
          onClick={() => onToggleMetadataPanel()}
          size="icon"
          title="Toggle side panel"
          variant="ghost"
        >
          <PanelRightIcon className="h-4 w-4" />
        </Button>
      )}
    </Header>
  );
}
