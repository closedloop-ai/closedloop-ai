"use client";

import type { FeatureWithWorkstream } from "@repo/api/src/types/feature";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  ChevronDownIcon,
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

type FeatureEditorHeaderProps = {
  feature: FeatureWithWorkstream;
  displayTitle: string;
  hasPlan: boolean;
  isReady: boolean;
  showMetadataPanel: boolean;
  onToggleMetadataPanel: () => void;
  onGeneratePlan: () => void;
  onStartBuild: () => void;
  onDelete: () => void;
};

export function FeatureEditorHeader({
  feature,
  displayTitle,
  hasPlan,
  isReady,
  showMetadataPanel,
  onToggleMetadataPanel,
  onGeneratePlan,
  onStartBuild,
  onDelete,
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
            disabled={!isReady || hasPlan}
            onClick={onGeneratePlan}
          >
            <SparklesIcon className="h-4 w-4" />
            Generate Plan
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasPlan} onClick={onStartBuild}>
            <PlayIcon className="h-4 w-4" />
            Start Building
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
          <DropdownMenuItem onClick={onDelete} variant="destructive">
            <TrashIcon className="h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        aria-label="Toggle chat panel"
        onClick={onToggleMetadataPanel}
        size="icon"
        title="Toggle chat panel"
        variant={showMetadataPanel ? "secondary" : "ghost"}
      >
        <PanelRightIcon className="h-4 w-4" />
      </Button>
    </Header>
  );
}
