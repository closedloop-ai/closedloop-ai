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
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  RotateCcwIcon,
  TrashIcon,
} from "lucide-react";

type DocumentEditorHeaderProps = {
  document: DocumentWithProject;
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
 * to a generic document), as well as Move (the API files a DOC into a project
 * since ISS-12858; whether this header offers it is ISS-12859's Details work)
 * and a standalone Rename dialog (the inline `EditableDocumentTitle` owns
 * renaming the title in place).
 */
export function DocumentEditorHeader({
  document,
  isMetadataPanelOpen = false,
  showRestore = false,
  onCopyMarkdown,
  onExportMarkdown,
  onRestoreVersion,
  onDelete,
  onToggleMetadataPanel,
}: Readonly<DocumentEditorHeaderProps>) {
  const buildOrgPath = useOrgPath();

  const breadcrumbs: BreadcrumbEntry[] = [
    { label: "Documents", href: buildOrgPath("/documents") },
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
    </Header>
  );
}
