"use client";

import type { Document } from "@repo/api/src/types/document";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import {
  CornerDownRightIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  Link2OffIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import { getDocumentRoute } from "@/lib/document-navigation";
import {
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_STATUS_TO_ICON,
  DOCUMENT_TYPE_BADGE_LABELS,
  DOCUMENT_TYPE_ICONS,
} from "@/lib/project-constants";

type ArtifactRowProps = {
  artifact: Document;
  /** 1-based nesting depth; rows at depth 1 render flush-left. */
  depth?: number;
  /** When provided, enables the "Detach Association" menu item. */
  linkId?: string | null;
  onDetach?: (linkId: string) => void;
};

/**
 * Standard single-line artifact row used across document detail pages —
 * Feature Context/Plan sections, Plan Context section, and PRD Associated
 * Artifacts. Entire row is clickable for navigation; interactive children
 * stop propagation so the menu doesn't re-trigger nav. Child rows (depth > 1)
 * are marked with a leading corner-down-right icon rather than left-indent.
 */
export function ArtifactRow({
  artifact,
  depth = 1,
  linkId = null,
  onDetach,
}: Readonly<ArtifactRowProps>) {
  const router = useRouter();

  const Icon = DOCUMENT_TYPE_ICONS[artifact.type];
  const badgeLabel = DOCUMENT_TYPE_BADGE_LABELS[artifact.type];
  const statusIconStatus = DOCUMENT_STATUS_TO_ICON[artifact.status];
  const statusLabel = DOCUMENT_STATUS_LABELS[artifact.status];
  const route = getDocumentRoute(artifact);
  const isChild = depth > 1;

  const handleNavigate = () => {
    if (route) {
      router.push(route);
    }
  };

  const handleDetach = () => {
    if (linkId && onDetach) {
      onDetach(linkId);
    }
  };

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: row-wide navigation, interactive children stop propagation
    // biome-ignore lint/a11y/noStaticElementInteractions: see above
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is conditionally "button" at runtime; linter can't see the conditional
    <div
      aria-label={`Open ${badgeLabel} ${artifact.title}`}
      className={cn(
        "group/row flex items-center gap-2 border-b py-2.5 pr-2 pl-2 hover:bg-accent/50",
        route ? "cursor-pointer" : "cursor-default"
      )}
      onClick={route ? handleNavigate : undefined}
      onKeyDown={(e) => {
        if (route && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          handleNavigate();
        }
      }}
      role={route ? "button" : undefined}
      tabIndex={route ? 0 : -1}
    >
      {isChild ? (
        <CornerDownRightIcon
          aria-hidden
          className="h-4 w-4 shrink-0 text-muted-foreground opacity-50"
        />
      ) : null}
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="mr-1.5 ml-1 inline-block min-w-[7ch] shrink-0 font-mono text-muted-foreground text-xs">
        {isDisplayableSlug(artifact.slug) ? artifact.slug : badgeLabel}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={statusLabel}
            className="inline-flex shrink-0 items-center"
            onClick={(e) => e.stopPropagation()}
            type="button"
          >
            <StatusIcon size={16} status={statusIconStatus} />
          </button>
        </TooltipTrigger>
        <TooltipContent>{statusLabel}</TooltipContent>
      </Tooltip>
      <span className="min-w-0 flex-1 truncate font-medium text-sm">
        {artifact.title}
      </span>
      <div className="flex shrink-0 items-center gap-4">
        <AssigneeAvatar assignee={artifact.assignee} />
        {artifact.priority ? (
          <div className="flex h-5 w-5 items-center justify-center">
            <PriorityIcon priority={artifact.priority} />
          </div>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="More actions"
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
              type="button"
            >
              <EllipsisIcon className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem disabled={!route} onClick={handleNavigate}>
              <ExternalLinkIcon className="h-4 w-4" />
              View {badgeLabel}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!(linkId && onDetach)}
              onClick={handleDetach}
            >
              <Link2OffIcon className="h-4 w-4" />
              Detach Association
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
