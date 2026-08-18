"use client";

import type { AgentComponent } from "@repo/api/src/types/agent-component";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { useCopyToClipboard } from "@repo/design-system/hooks/use-copy-to-clipboard";
import { Link } from "@repo/navigation/link";
import { CopyIcon, EllipsisVerticalIcon, EyeIcon } from "lucide-react";

/**
 * Agent-component row overflow (kebab) menu (FEA-3220). Wires the agents-table
 * actions column — previously a bare no-op `<button>` — to a real
 * `DropdownMenu`, mirroring the established `BranchRowActionsMenu` pattern (same
 * DS primitives, same ghost `icon-sm`
 * trigger, same `align="end"` content). The menu is domain composition, so it
 * lives in the `agents` feature slice rather than `@repo/design-system`.
 *
 * Only actions with a real existing destination on the agents surface are
 * offered — no invented routes:
 *   • "Open detail" — navigates to the per-component detail page via the host's
 *     `getComponentHref` factory (web: `/{org}/agents/{slug}`; desktop: a virtual
 *     org-relative path `/agents/{slug}` that the desktop route table resolves to
 *     the detail view). Rendered as the surface-agnostic `Link` from
 *     `@repo/navigation/link` via `asChild`: it emits a real anchor (so
 *     middle-click / Cmd-click / context-menu affordances still defer to the
 *     browser) but routes a plain left-click through the active navigation
 *     adapter. On desktop the Electron navigation guard blocks raw-anchor
 *     document navigation to `/agents/…` before the hash-store adapter sees it,
 *     so a bare `<a>` would be a no-op there; `Link` drives the adapter's
 *     `navigate` so the detail view actually opens on both surfaces. Hidden when
 *     the host supplies no href (the list is then non-navigable, e.g. pre-fetch).
 *   • "Copy component name" — surface-agnostic clipboard copy of the component's
 *     display name, identical on the web shell and the desktop renderer.
 */
export type AgentRowActionsMenuProps = {
  item: AgentComponent;
  /**
   * Href factory for the per-component detail page. When provided, "Open detail"
   * renders as a link to it; when absent the action is omitted so the menu never
   * offers navigation it cannot fulfill. Mirrors the table's own
   * `getComponentHref` gating.
   */
  getComponentHref?: (item: AgentComponent) => string;
};

export function AgentRowActionsMenu({
  item,
  getComponentHref,
}: AgentRowActionsMenuProps) {
  const [, copy] = useCopyToClipboard(1500);
  const detailHref = getComponentHref?.(item);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Component actions"
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <EllipsisVerticalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {detailHref ? (
          <DropdownMenuItem asChild>
            <Link href={detailHref}>
              <EyeIcon className="size-3.5" />
              Open detail
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={async () => {
            await copy(item.name);
          }}
        >
          <CopyIcon className="size-3.5" />
          Copy component name
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
