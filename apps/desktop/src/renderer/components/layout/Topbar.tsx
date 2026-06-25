import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { useSidebar } from "@closedloop-ai/design-system/components/ui/sidebar";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import {
  NAV_SECTION_LABELS,
  navEntryFor,
  navSectionFor,
} from "../../navigation/nav-config";
import type { NavId } from "../../navigation/route-table";
import { isMacOS } from "../../platform";

type TopbarProps = {
  navId: NavId;
};

export function Topbar({ navId }: TopbarProps) {
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  const entry = navEntryFor(navId);
  const section = navSectionFor(navId);
  const sectionLabel = section ? NAV_SECTION_LABELS[section] : null;
  const label = entry?.label ?? navId;
  const isMac = isMacOS();

  // On macOS the title bar is hidden and the window drags from app-region:drag
  // surfaces — the header doubles as a drag handle (interactive children opt
  // back out via app-region-no-drag). When the sidebar is collapsed, the
  // overlaid stoplight buttons sit over the header's left edge, so pad the
  // toggle clear of them.
  return (
    <header
      className={cn(
        "flex h-[42px] min-w-0 shrink-0 items-center gap-3 border-b bg-[var(--background)] px-3",
        isMac && "app-region-drag",
        isMac && collapsed && "pl-[5.25rem]"
      )}
    >
      <Button
        className="app-region-no-drag text-[var(--muted-foreground)]"
        onClick={toggleSidebar}
        size="icon-sm"
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        type="button"
        variant="ghost"
      >
        {collapsed ? (
          <PanelLeftOpen className="size-4" />
        ) : (
          <PanelLeftClose className="size-4" />
        )}
      </Button>

      {/* Breadcrumb is navigation, not a page heading — a labeled nav landmark
          with the current segment marked aria-current="page" is the accessible
          "you are here" cue, without competing with each page's own in-body
          <h1> (pages that render a PageShell title own the page heading;
          Sessions/Branches intentionally rely on this breadcrumb for their
          page name). */}
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 items-center gap-2 text-sm"
      >
        {sectionLabel && (
          <>
            <span className="shrink-0 text-[var(--muted-foreground)]">
              {sectionLabel}
            </span>
            <span className="shrink-0 text-[var(--muted-foreground)]">/</span>
          </>
        )}
        <span aria-current="page" className="truncate font-medium">
          {label}
        </span>
      </nav>

      <div className="flex-1" />
    </header>
  );
}
