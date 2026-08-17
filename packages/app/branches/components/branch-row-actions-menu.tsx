"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { useCopyToClipboard } from "@repo/design-system/hooks/use-copy-to-clipboard";
import { Link } from "@repo/navigation/link";
import {
  CopyIcon,
  EllipsisVerticalIcon,
  ExternalLinkIcon,
  EyeIcon,
  UsersIcon,
} from "lucide-react";
import { isGithubPrUrl } from "../lib/branch-pr-url";
import type { BranchRow } from "../lib/branch-row";

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
  /**
   * FEA-4259: builds the href for the "View linked sessions" item — the branch
   * detail's Sessions & timeline tab, the same destination as the row's Linked
   * Sessions count chip. Supplied only when the surface can navigate there;
   * absent (or a 0-count row) → the item is hidden, never a dead action.
   */
  getSessionsHref?: (item: BranchRow) => string;
};

export function BranchRowActionsMenu({
  item,
  onOpenDetail,
  getSessionsHref,
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
        {getSessionsHref && item.sessionCount > 0 ? (
          <DropdownMenuItem asChild>
            <Link href={getSessionsHref(item)}>
              <UsersIcon className="size-3.5" />
              View linked sessions
            </Link>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
