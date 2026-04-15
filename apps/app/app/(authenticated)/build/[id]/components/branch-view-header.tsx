"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  PanelRightIcon,
} from "lucide-react";
import Link from "next/link";
import {
  type BreadcrumbEntry,
  Header,
} from "@/app/(authenticated)/components/header";
import type { BranchViewData } from "../types";

type BranchViewHeaderProps = {
  data: BranchViewData;
  showChatPanel: boolean;
  onToggleChatPanel: () => void;
};

export function BranchViewHeader({
  data,
  showChatPanel,
  onToggleChatPanel,
}: Readonly<BranchViewHeaderProps>) {
  const breadcrumbs: BreadcrumbEntry[] = [
    ...(data.teamId && data.teamName
      ? [{ label: data.teamName, href: `/teams/${data.teamId}/projects` }]
      : []),
    ...(data.teamId && data.projectId && data.projectName
      ? [
          {
            label: data.projectName,
            href: `/teams/${data.teamId}/projects/${data.projectId}?tab=features`,
          },
        ]
      : []),
    ...(data.featureSlug && data.featureTitle
      ? [
          {
            label: data.featureTitle,
            href: `/features/${data.featureSlug}`,
          },
        ]
      : []),
    { label: data.prTitle },
  ];

  return (
    <Header breadcrumbs={breadcrumbs} className="px-3 py-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm">
            Actions
            <ChevronDownIcon className="ml-2 h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <a
              href={data.externalUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <ExternalLinkIcon className="mr-2 h-4 w-4" />
              Open in GitHub
            </a>
          </DropdownMenuItem>
          {data.producedByPlanSlug && data.producedByPlanTitle ? (
            <DropdownMenuItem asChild>
              <Link href={`/implementation-plans/${data.producedByPlanSlug}`}>
                View plan
              </Link>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        aria-label="Toggle chat panel"
        onClick={onToggleChatPanel}
        size="icon"
        title="Toggle chat panel"
        variant={showChatPanel ? "secondary" : "ghost"}
      >
        <PanelRightIcon className="h-4 w-4" />
      </Button>
    </Header>
  );
}
