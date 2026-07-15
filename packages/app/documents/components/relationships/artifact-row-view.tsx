"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import {
  CornerDownRightIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  Link2OffIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

type ArtifactRowViewProps = {
  title: string;
  slug: string;
  typeIcon: ReactNode;
  typeLabel: string;
  /** Rendered status icon (e.g. DocumentStatusIcon / FeatureStatusIcon). */
  statusIcon: ReactNode;
  statusLabel: string;
  priority?: ComponentProps<typeof PriorityIcon>["priority"] | null;
  assignee?: ReactNode;
  href?: string | null;
  depth?: number;
  onDetach?: () => void;
  className?: string;
};

export function ArtifactRowView({
  title,
  slug,
  typeIcon,
  typeLabel,
  statusIcon,
  statusLabel,
  priority,
  assignee,
  href,
  depth = 1,
  onDetach,
  className,
}: Readonly<ArtifactRowViewProps>) {
  const isChild = depth > 1;

  return (
    <div
      className={cn(
        "group/row relative flex items-center gap-2 border-b py-2.5 pr-2 pl-2 hover:bg-accent/50",
        href ? "cursor-pointer" : "cursor-default",
        className
      )}
    >
      {isChild ? (
        <CornerDownRightIcon
          aria-hidden
          className="h-4 w-4 shrink-0 text-muted-foreground opacity-50"
        />
      ) : null}
      <span className="flex shrink-0 items-center text-muted-foreground">
        {typeIcon}
      </span>
      <span className="mr-1.5 ml-1 inline-block min-w-[7ch] shrink-0 font-mono text-muted-foreground text-xs">
        {slug}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={statusLabel}
            className="relative z-10 inline-flex shrink-0 items-center"
            type="button"
          >
            {statusIcon}
          </button>
        </TooltipTrigger>
        <TooltipContent>{statusLabel}</TooltipContent>
      </Tooltip>
      {href ? (
        <Link
          className="min-w-0 flex-1 truncate font-medium text-sm after:absolute after:inset-0"
          href={href}
        >
          {title}
        </Link>
      ) : (
        <span className="min-w-0 flex-1 truncate font-medium text-sm">
          {title}
        </span>
      )}
      <div className="relative z-10 flex shrink-0 items-center gap-4">
        {assignee}
        {priority ? (
          <div className="flex h-5 w-5 items-center justify-center">
            <PriorityIcon priority={priority} />
          </div>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="More actions"
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
              type="button"
            >
              <EllipsisIcon className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {href ? (
              <DropdownMenuItem asChild>
                <Link href={href}>
                  <ExternalLinkIcon className="h-4 w-4" />
                  View {typeLabel}
                </Link>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled>
                <ExternalLinkIcon className="h-4 w-4" />
                View {typeLabel}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem disabled={!onDetach} onClick={onDetach}>
              <Link2OffIcon className="h-4 w-4" />
              Detach Association
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
