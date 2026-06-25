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
  ChevronDownIcon,
  CopyIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  RefreshCwIcon,
  StarIcon,
} from "lucide-react";
import { useCallback } from "react";

type SessionIdProps = {
  sessionId: string;
};

type SessionDetailActionsProps = SessionIdProps & {
  commentsRailOpen: boolean;
  isRefreshing: boolean;
  onRefresh: () => void;
  onToggleCommentsRail: () => void;
};

/**
 * Non-mutating session favorite affordance. Session favorites do not have a
 * persisted API yet, so this mirrors the detail-header visual without
 * pretending to store user preference.
 */
export function SessionDetailFavoriteButton() {
  return (
    <Button
      aria-disabled="true"
      aria-label="Favorite session"
      onClick={(event) => event.preventDefault()}
      size="icon-sm"
      title="Session favorites are not available yet"
      variant="ghost"
    >
      <StarIcon className="h-4 w-4" />
    </Button>
  );
}

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
  sessionId,
  commentsRailOpen,
  isRefreshing,
  onRefresh,
  onToggleCommentsRail,
}: Readonly<SessionDetailActionsProps>) {
  const [copiedId, copySessionId] = useCopyToClipboard();
  const copyIdIcon = copiedId ? CheckIcon : CopyIcon;
  const commentsLabel = commentsRailOpen
    ? "Hide comments rail"
    : "Show comments rail";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm">
            Actions
            <ChevronDownIcon className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={isRefreshing}
            onSelect={() => {
              onRefresh();
            }}
          >
            <RefreshCwIcon className="h-4 w-4" />
            Refresh details
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!sessionId}
            onSelect={() => {
              copySessionId(sessionId).catch(() => undefined);
            }}
          >
            <CopyStatusIcon Icon={copyIdIcon} />
            {copiedId ? "Copied session ID" : "Copy session ID"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
