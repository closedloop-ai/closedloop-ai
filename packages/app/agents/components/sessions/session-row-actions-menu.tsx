"use client";

import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { useCopyToClipboard } from "@repo/design-system/hooks/use-copy-to-clipboard";
import { EllipsisVerticalIcon, GitBranchIcon, HashIcon } from "lucide-react";

/**
 * Sessions row overflow (kebab) menu (FEA-2507). Composes the design system's
 * generic `DropdownMenu` primitive to give each Sessions row the same
 * discoverable, keyboard-accessible per-row action affordance the Branches page
 * already exposes via `BranchRowActionsMenu`. The menu is domain composition, so
 * it lives in the `agents` feature slice rather than `@repo/design-system`.
 *
 * The trigger sits in its own grid cell (never overlapping the leading
 * session-name link), so opening the menu never triggers row navigation. The
 * actions are surface-agnostic — clipboard copies that behave identically on the
 * web shell and the desktop renderer; navigation stays owned by the row's
 * platform-specific name link.
 */
export type SessionRowActionsMenuProps = {
  item: AgentSessionListItem;
};

export function SessionRowActionsMenu({ item }: SessionRowActionsMenuProps) {
  const [, copy] = useCopyToClipboard(1500);
  // Producer-owned branch can be null/blank; only offer the copy when present.
  const branch = item.branch?.trim() ? item.branch : null;
  // SES-* artifact slug when allocated, else the external session id — there is
  // always a stable identifier to copy.
  const sessionId = item.slug ?? item.externalSessionId;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Session actions"
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <EllipsisVerticalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={!branch}
          onSelect={async () => {
            if (branch) {
              await copy(branch);
            }
          }}
        >
          <GitBranchIcon className="size-3.5" />
          Copy branch name
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={async () => {
            await copy(sessionId);
          }}
        >
          <HashIcon className="size-3.5" />
          Copy session ID
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
