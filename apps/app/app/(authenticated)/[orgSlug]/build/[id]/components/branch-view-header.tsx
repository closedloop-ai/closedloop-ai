"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Link } from "@repo/navigation/link";
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  PanelRightIcon,
} from "lucide-react";
import {
  type BreadcrumbEntry,
  Header,
} from "@/app/(authenticated)/components/header";
import { useOrgSlug } from "@/hooks/use-org-slug";
import type { BranchViewData } from "../types";

type BranchViewHeaderProps = {
  data: BranchViewData;
  /**
   * Header-wide right-rail toggle. Flag-on builds pass the feed-sidebar
   * toggler; flag-off builds pass the chat-panel toggler. Decoupling
   * the header from the panel identity lets the same affordance reopen
   * whichever right rail the current build supports.
   */
  onTogglePanel: () => void;
  panelLabel: "Feed" | "Chat";
};

export function BranchViewHeader({
  data,
  onTogglePanel,
  panelLabel,
}: Readonly<BranchViewHeaderProps>) {
  const orgSlug = useOrgSlug();

  const breadcrumbs: BreadcrumbEntry[] = [
    ...(data.teamId && data.teamName
      ? [
          {
            label: data.teamName,
            href: `/${orgSlug}/teams/${data.teamId}/projects`,
          },
        ]
      : []),
    ...(data.teamId && data.projectId && data.projectName
      ? [
          {
            label: data.projectName,
            // FEA-4137: the project's Issues tab is `?tab=issues` now (legacy
            // `?tab=features` still resolves via the project page's tab alias).
            href: `/${orgSlug}/teams/${data.teamId}/projects/${data.projectId}?tab=issues`,
          },
        ]
      : []),
    ...(data.featureSlug && data.featureTitle
      ? [
          {
            label: data.featureTitle,
            href: `/${orgSlug}/issues/${data.featureSlug}`,
          },
        ]
      : []),
    { label: data.prTitle },
  ];

  const toggleLabel = `Toggle ${panelLabel.toLowerCase()} sidebar`;

  return (
    <Header breadcrumbs={breadcrumbs} className="px-3 py-2" suppressPageHeading>
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
              <Link
                href={`/${orgSlug}/implementation-plans/${data.producedByPlanSlug}`}
              >
                View plan
              </Link>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        aria-label={toggleLabel}
        onClick={onTogglePanel}
        size="icon-sm"
        title={toggleLabel}
        variant="ghost"
      >
        <PanelRightIcon className="h-4 w-4" />
      </Button>
    </Header>
  );
}
