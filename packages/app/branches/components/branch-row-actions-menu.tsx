"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { useCopyToClipboard } from "@repo/design-system/hooks/use-copy-to-clipboard";
import {
  CopyIcon,
  EllipsisVerticalIcon,
  ExternalLinkIcon,
  EyeIcon,
  UsersIcon,
} from "lucide-react";
import { isGithubPrUrl } from "../lib/branch-pr-url";
import type { BranchRow } from "../lib/branch-sample-data";

/** Branch-scoped row actions (Epic B / B5c). No issues/docs/agents links. */
export const BranchRowAction = {
  OpenDetail: "open-detail",
  CopyName: "copy-name",
  OpenPr: "open-pr",
  ViewSessions: "view-sessions",
} as const;
export type BranchRowAction =
  (typeof BranchRowAction)[keyof typeof BranchRowAction];

export type BranchRowActionsMenuProps = {
  item: BranchRow;
  /**
   * Provided only when Branch Detail (Epic C1) is available — the action is
   * hidden otherwise, so the list never offers navigation it can't fulfill.
   */
  onOpenDetail?: (item: BranchRow) => void;
  /** Provided when the surface can navigate to the sessions view. */
  onViewSessions?: (item: BranchRow) => void;
};

export function BranchRowActionsMenu({
  item,
  onOpenDetail,
  onViewSessions,
}: BranchRowActionsMenuProps) {
  const [, copy] = useCopyToClipboard(1500);
  // Only enable "Open PR" for a canonical GitHub PR URL (persisted local data
  // can carry an arbitrary/unsafe URL).
  const hasPr = item.prNumber != null && isGithubPrUrl(item.prUrl);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Branch actions"
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <EllipsisVerticalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onOpenDetail ? (
          <DropdownMenuItem onSelect={() => onOpenDetail(item)}>
            <EyeIcon className="size-3.5" />
            Open detail
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={async () => {
            await copy(item.branchName);
          }}
        >
          <CopyIcon className="size-3.5" />
          Copy branch name
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!hasPr}
          onSelect={() => {
            if (isGithubPrUrl(item.prUrl)) {
              globalThis.open(item.prUrl, "_blank", "noopener,noreferrer");
            }
          }}
        >
          <ExternalLinkIcon className="size-3.5" />
          Open PR
        </DropdownMenuItem>
        {onViewSessions ? (
          <DropdownMenuItem
            disabled={item.sessionCount === 0}
            onSelect={() => onViewSessions(item)}
          >
            <UsersIcon className="size-3.5" />
            View linked sessions
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
