"use client";

import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
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
  issue: IssueWithWorkstream;
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
  issue,
  displayTitle,
  hasPlan,
  isReady,
  showMetadataPanel,
  onToggleMetadataPanel,
  onGeneratePlan,
  onStartBuild,
  onDelete,
}: Readonly<FeatureEditorHeaderProps>) {
  const teamId = issue.project?.teams?.[0]?.id;
  const projectId = issue.project?.id;
  const teamName = issue.project?.teams?.[0]?.name;
  const projectName = issue.project?.name;

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
            <ChevronDownIcon className="ml-2 h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={!isReady || hasPlan}
            onClick={onGeneratePlan}
          >
            <SparklesIcon className="mr-2 h-4 w-4" />
            Generate Plan
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasPlan} onClick={onStartBuild}>
            <PlayIcon className="mr-2 h-4 w-4" />
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
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={onDelete}
          >
            <TrashIcon className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
