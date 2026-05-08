"use client";

import type {
  DocumentWithWorkstream,
  GenerationStatus,
} from "@repo/api/src/types/document";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  ChevronDownIcon,
  FolderInputIcon,
  GaugeIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  PlayIcon,
  SparklesIcon,
  TrashIcon,
} from "lucide-react";
import {
  type BreadcrumbEntry,
  Header,
} from "@/app/(authenticated)/components/header";
import { isCommandDisabled } from "@/lib/generation-status-utils";

type FeatureEditorHeaderProps = {
  feature: DocumentWithWorkstream;
  displayTitle: string;
  hasPlan: boolean;
  isReady: boolean;
  isEvaluating?: boolean;
  generationStatus?: GenerationStatus;
  generationStatusLoading?: boolean;
  onToggleMetadataPanel: () => void;
  onGeneratePlan: () => void;
  onStartBuild: () => void;
  onMoveToProject: () => void;
  onDelete: () => void;
  onEvaluateFeature: () => void;
};

export function FeatureEditorHeader({
  feature,
  displayTitle,
  hasPlan,
  isReady,
  isEvaluating = false,
  generationStatus,
  generationStatusLoading = false,
  onToggleMetadataPanel,
  onGeneratePlan,
  onStartBuild,
  onMoveToProject,
  onDelete,
  onEvaluateFeature,
}: Readonly<FeatureEditorHeaderProps>) {
  const teamId = feature.project?.teams?.[0]?.id;
  const projectId = feature.project?.id;
  const teamName = feature.project?.teams?.[0]?.name;
  const projectName = feature.project?.name;

  const breadcrumbs: BreadcrumbEntry[] = [
    ...(teamId && teamName
      ? [{ label: teamName, href: `/teams/${teamId}/projects` }]
      : []),
    ...(teamId && projectId && projectName
      ? [
          {
            label: projectName,
            href: `/teams/${teamId}/projects/${projectId}?tab=features`,
          },
        ]
      : []),
    { label: displayTitle },
  ];

  return (
    <Header breadcrumbs={breadcrumbs}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm">
            Actions
            <ChevronDownIcon className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={
              !isReady ||
              hasPlan ||
              isCommandDisabled({
                generationStatus,
                isLoading: generationStatusLoading,
                targetCommand: "plan",
              })
            }
            onClick={() => onGeneratePlan()}
          >
            <SparklesIcon className="h-4 w-4" />
            Generate Plan
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={
              !hasPlan ||
              isCommandDisabled({
                generationStatus,
                isLoading: generationStatusLoading,
                targetCommand: "execute",
              })
            }
            onClick={() => onStartBuild()}
          >
            <PlayIcon className="h-4 w-4" />
            Start Building
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isCommandDisabled({
              generationStatus,
              isLoading: generationStatusLoading,
              targetCommand: "evaluate_feature",
              localMutationPending: isEvaluating,
            })}
            onClick={() => onEvaluateFeature()}
          >
            <GaugeIcon className="h-4 w-4" />
            {isEvaluating ? "Evaluating Feature..." : "Evaluate Feature"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost">
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
