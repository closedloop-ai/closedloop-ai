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
  CheckIcon,
  CopyIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  RefreshCcwIcon,
} from "lucide-react";
import { useCallback } from "react";

type SessionIdProps = {
  sessionId: string;
};

type SessionDetailActionsProps = {
  commentsRailOpen: boolean;
  isRefreshing: boolean;
  onRefresh: () => void;
  onToggleCommentsRail: () => void;
};

/** Overflow utilities that sit next to the session breadcrumb. */
export function SessionDetailOverflowMenu({
  sessionId,
}: Readonly<SessionIdProps>) {
  const [copiedId, copySessionId] = useCopyToClipboard();
  const [copiedUrl, copySessionUrl] = useCopyToClipboard();
  const copyIdIcon = copiedId ? CheckIcon : CopyIcon;
  const copyUrlIcon = copiedUrl ? CheckIcon : LinkIcon;

  const handleCopyUrl = useCallback(() => {
    if (globalThis.location === undefined) {
      return;
    }
    copySessionUrl(globalThis.location.href).catch(() => undefined);
  }, [copySessionUrl]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="More session actions"
          size="icon-sm"
          variant="ghost"
        >
          <MoreHorizontalIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={!sessionId}
          onSelect={() => {
            copySessionId(sessionId).catch(() => undefined);
          }}
        >
          <CopyStatusIcon Icon={copyIdIcon} />
          {copiedId ? "Copied session ID" : "Copy session ID"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleCopyUrl}>
          <CopyStatusIcon Icon={copyUrlIcon} />
          {copiedUrl ? "Copied session URL" : "Copy session URL"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Primary session detail actions pinned to the right side of the header. */
export function SessionDetailActions({
  commentsRailOpen,
  isRefreshing,
  onRefresh,
  onToggleCommentsRail,
}: Readonly<SessionDetailActionsProps>) {
  const commentsLabel = commentsRailOpen
    ? "Hide comments rail"
    : "Show comments rail";

  return (
    <>
      {/* Match the branch-detail header: Refresh is a labeled outline button in
          the right slot, same RefreshCcw icon — not buried in a primary
          dropdown whose only payload was refresh + copy-ID (copy-ID now lives
          only in the left kebab, next to the ID context). */}
      <Button
        disabled={isRefreshing}
        onClick={onRefresh}
        size="sm"
        type="button"
        variant="outline"
      >
        <RefreshCcwIcon className="size-3.5" />
        Refresh
      </Button>
      <Button
        aria-label={commentsLabel}
        aria-pressed={commentsRailOpen}
        onClick={onToggleCommentsRail}
        size="icon-sm"
        title={commentsLabel}
        variant="ghost"
      >
        <PanelRightIcon className="h-4 w-4" />
      </Button>
    </>
  );
}

function CopyStatusIcon({
  Icon,
}: Readonly<{ Icon: typeof CheckIcon | typeof CopyIcon | typeof LinkIcon }>) {
  return <Icon className="h-4 w-4" />;
}
