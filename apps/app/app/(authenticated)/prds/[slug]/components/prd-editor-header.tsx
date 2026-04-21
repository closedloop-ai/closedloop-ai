"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import {
  DocumentType,
  type DocumentWithWorkstream,
} from "@repo/api/src/types/document";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  BoxIcon,
  ChevronDownIcon,
  DownloadIcon,
  FolderIcon,
  GaugeIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  PencilIcon,
  RotateCcwIcon,
  TrashIcon,
} from "lucide-react";
import {
  type BreadcrumbEntry,
  Header,
} from "@/app/(authenticated)/components/header";
import { DOCUMENT_TYPE_ICONS } from "@/lib/project-constants";

type PRDEditorHeaderProps = {
  prd: DocumentWithWorkstream;
  canShowPanel?: boolean;
  onToggleMetadataPanel: () => void;
  onDecomposeFeatures: () => void;
  onEvaluatePrd: () => void;
  onGeneratePlan: () => void;
  onGeneratePrd: () => void;
  onRequestChanges: () => void;
  isGenerating?: boolean;
  isEvaluating?: boolean;
  isRequestingChanges?: boolean;
  onRename: () => void;
  onExport: () => void;
  onMove: () => void;
  showRestore?: boolean;
  onRestoreVersion?: () => void;
  onDelete: () => void;
  isPending?: boolean;
};

export function PRDEditorHeader({
  prd,
  canShowPanel = true,
  onToggleMetadataPanel,
  onDecomposeFeatures,
  onEvaluatePrd,
  onGeneratePlan,
  onGeneratePrd,
  onRequestChanges,
  isGenerating = false,
  isEvaluating = false,
  isRequestingChanges = false,
  onRename,
  onExport,
  onMove,
  showRestore = false,
  onRestoreVersion,
  onDelete,
  isPending = false,
}: Readonly<PRDEditorHeaderProps>) {
  const requestChangesFlag = useFeatureFlag("prd-request-changes");

  const breadcrumbs: BreadcrumbEntry[] = prd.project?.teams?.[0]?.id
    ? [
        {
          label: prd.project.teams[0].name,
          href: `/teams/${prd.project.teams[0].id}/projects`,
        },
        {
          label: prd.project.name,
          href: `/teams/${prd.project.teams[0].id}/projects/${prd.project.id}`,
        },
        { label: prd.title },
      ]
    : [{ label: "Library", href: "/prds" }, { label: prd.title }];

  const overflowMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost">
          <MoreHorizontalIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[160px]">
        <DropdownMenuItem onClick={() => onRename()}>
          <PencilIcon className="h-4 w-4" />
          Rename
        </DropdownMenuItem>
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

  const PrdIcon = DOCUMENT_TYPE_ICONS[DocumentType.Prd];
  const PlanIcon = DOCUMENT_TYPE_ICONS[DocumentType.ImplementationPlan];

  return (
    <Header breadcrumbs={breadcrumbs}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button disabled={isPending} size="sm">
            Actions
            <ChevronDownIcon className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={isGenerating}
            onClick={() => onGeneratePrd()}
          >
            <PrdIcon className="h-4 w-4" />
            {isGenerating ? "Generating PRD..." : "Generate PRD"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onDecomposeFeatures()}>
            <BoxIcon className="h-4 w-4" />
            Decompose into Features
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isEvaluating}
            onClick={() => onEvaluatePrd()}
          >
            <GaugeIcon className="mr-2 h-4 w-4" />
            {isEvaluating ? "Evaluating PRD..." : "Evaluate PRD"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onGeneratePlan()}>
            <PlanIcon className="h-4 w-4" />
            Generate Implementation Plan
          </DropdownMenuItem>
          {requestChangesFlag?.enabled && (
            <DropdownMenuItem
              disabled={isGenerating || isRequestingChanges}
              onClick={() => onRequestChanges()}
            >
              <MessageSquareIcon className="h-4 w-4" />
              {isRequestingChanges ? "Amending PRD..." : "Amend PRD"}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {overflowMenu}

      {canShowPanel && (
        <Button
          aria-label="Toggle chat panel"
          onClick={() => onToggleMetadataPanel()}
          size="icon"
          title="Toggle chat panel"
          variant="ghost"
        >
          <PanelRightIcon className="h-4 w-4" />
        </Button>
      )}
    </Header>
  );
}
