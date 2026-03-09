"use client";

import {
  ArtifactType,
  type ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  BoxIcon,
  ChevronDownIcon,
  DownloadIcon,
  FolderIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  PencilIcon,
  RotateCcwIcon,
  SparklesIcon,
  TrashIcon,
} from "lucide-react";
import {
  type BreadcrumbEntry,
  Header,
} from "@/app/(authenticated)/components/header";
import { ARTIFACT_TYPE_ICONS } from "@/lib/project-constants";

type PRDEditorHeaderProps = {
  prd: ArtifactWithWorkstream;
  showMetadataPanel: boolean;
  onToggleMetadataPanel: () => void;
  onDecomposeFeatures: () => void;
  onGeneratePlan: () => void;
  onQuickGenerate: () => void;
  onDeepGenerate: () => void;
  isGenerating?: boolean;
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
  showMetadataPanel,
  onToggleMetadataPanel,
  onDecomposeFeatures,
  onGeneratePlan,
  onQuickGenerate,
  onDeepGenerate,
  isGenerating = false,
  onRename,
  onExport,
  onMove,
  showRestore = false,
  onRestoreVersion,
  onDelete,
  isPending = false,
}: PRDEditorHeaderProps) {
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
        { label: prd.fileName ?? prd.title },
      ]
    : [
        { label: "Library", href: "/prds" },
        { label: prd.fileName ?? prd.title },
      ];

  const overflowMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost">
          <MoreHorizontalIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[160px]">
        <DropdownMenuItem onClick={onRename}>
          <PencilIcon className="mr-2 h-4 w-4" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onExport}>
          <DownloadIcon className="mr-2 h-4 w-4" />
          Export .md
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onMove}>
          <FolderIcon className="mr-2 h-4 w-4" />
          Move...
        </DropdownMenuItem>
        {showRestore ? (
          <DropdownMenuItem onClick={onRestoreVersion}>
            <RotateCcwIcon className="mr-2 h-4 w-4" />
            Restore Version
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={onDelete}
        >
          <TrashIcon className="mr-2 h-4 w-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const PrdIcon = ARTIFACT_TYPE_ICONS[ArtifactType.Prd];
  const PlanIcon = ARTIFACT_TYPE_ICONS[ArtifactType.ImplementationPlan];

  return (
    <Header breadcrumbs={breadcrumbs}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button disabled={isPending} size="sm">
            Actions
            <ChevronDownIcon className="ml-2 h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isGenerating ? (
            <DropdownMenuItem disabled>
              <SparklesIcon className="mr-2 h-4 w-4" />
              Generating PRD...
            </DropdownMenuItem>
          ) : (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <PrdIcon className="mr-2 h-4 w-4" />
                Generate PRD
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onClick={onQuickGenerate}>
                  Quick PRD
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onDeepGenerate}>
                  Deep PRD
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuItem onClick={onDecomposeFeatures}>
            <BoxIcon className="mr-2 h-4 w-4" />
            Decompose into Features
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onGeneratePlan}>
            <PlanIcon className="mr-2 h-4 w-4" />
            Generate Implementation Plan
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {overflowMenu}

      <Button
        onClick={onToggleMetadataPanel}
        size="icon"
        variant={showMetadataPanel ? "secondary" : "ghost"}
      >
        <PanelRightIcon className="h-4 w-4" />
      </Button>
    </Header>
  );
}
