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
import type { ReactNode } from "react";
import {
  BranchRowPolicyAction,
  resolveBranchRowActionApplicability,
} from "../lib/branch-action-policy";
import { isGithubPrUrl } from "../lib/branch-pr-url";
import type { BranchRow } from "../lib/branch-row";

export type BranchRowActionsMenuProps = {
  item: BranchRow;
  /** Rollout-only production capabilities; malformed or skewed input fails closed. */
  actionPolicyInput?: unknown;
  /**
   * Provided only when Branch Detail (Epic C1) is available — the action is
   * hidden otherwise, so the list never offers navigation it can't fulfill.
   */
  onOpenDetail?: (item: BranchRow) => void;
  /** Branch-detail destination when the host owns navigation as an href. */
  getBranchHref?: (item: BranchRow) => string;
  /**
   * FEA-4259: builds the href for the "View linked sessions" item — the branch
   * detail's Sessions & timeline tab, the same destination as the row's Linked
   * Sessions count chip. Supplied only when the surface can navigate there;
   * absent (or a 0-count row) → the item is hidden, never a dead action.
   */
  getSessionsHref?: (item: BranchRow) => string;
};

export function BranchRowActionsMenu({
  actionPolicyInput,
  item,
  getBranchHref,
  onOpenDetail,
  getSessionsHref,
}: BranchRowActionsMenuProps) {
  const [, copy] = useCopyToClipboard(1500);
  const applicability =
    actionPolicyInput === undefined
      ? null
      : resolveBranchRowActionApplicability(actionPolicyInput);
  const canOpenDetail = applicability
    ? applicability[BranchRowPolicyAction.OpenDetail]
    : Boolean(getBranchHref || onOpenDetail);
  const canCopyBranchName = applicability
    ? applicability[BranchRowPolicyAction.CopyBranchName]
    : true;
  const canOpenPullRequest = applicability
    ? applicability[BranchRowPolicyAction.OpenPullRequest]
    : item.prNumber !== null && isGithubPrUrl(item.prUrl);
  const canViewSessions = applicability
    ? applicability[BranchRowPolicyAction.ViewSessions]
    : Boolean(getSessionsHref) && item.sessionCount > 0;
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
        {renderOpenDetailAction({
          applicable: canOpenDetail,
          getBranchHref,
          item,
          onOpenDetail,
        })}
        <DropdownMenuItem
          disabled={!canCopyBranchName}
          onSelect={async () => {
            await copy(item.branchName);
          }}
        >
          <CopyIcon className="size-3.5" />
          Copy branch name
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!canOpenPullRequest}
          onSelect={() => openPullRequest(item.prUrl)}
        >
          <ExternalLinkIcon className="size-3.5" />
          Open PR
        </DropdownMenuItem>
        {getSessionsHref && item.sessionCount > 0 && canViewSessions ? (
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

function renderOpenDetailAction({
  applicable,
  getBranchHref,
  item,
  onOpenDetail,
}: {
  applicable: boolean;
  getBranchHref?: (item: BranchRow) => string;
  item: BranchRow;
  onOpenDetail?: (item: BranchRow) => void;
}): ReactNode {
  if (!applicable) {
    return null;
  }
  if (getBranchHref) {
    return (
      <DropdownMenuItem asChild>
        <Link href={getBranchHref(item)}>
          <EyeIcon className="size-3.5" />
          Open detail
        </Link>
      </DropdownMenuItem>
    );
  }
  if (onOpenDetail) {
    return (
      <DropdownMenuItem onSelect={() => onOpenDetail(item)}>
        <EyeIcon className="size-3.5" />
        Open detail
      </DropdownMenuItem>
    );
  }
  return null;
}

function openPullRequest(prUrl: string | null): void {
  if (isGithubPrUrl(prUrl)) {
    globalThis.open(prUrl, "_blank", "noopener,noreferrer");
  }
}
