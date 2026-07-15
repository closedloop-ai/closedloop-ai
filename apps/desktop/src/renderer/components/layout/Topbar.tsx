import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { useSidebar } from "@closedloop-ai/design-system/components/ui/sidebar";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Fragment } from "react";
import { isMacOS } from "../../platform";

/**
 * One breadcrumb segment. A segment with an `href` renders as a navigation link
 * (parent segments, e.g. "Sessions" on a session detail page); the final
 * segment is always rendered as the current page and carries `aria-current`.
 */
export type TopbarBreadcrumb = {
  label: string;
  href?: string;
};

type TopbarProps = {
  breadcrumbs: TopbarBreadcrumb[];
};

export function Topbar({ breadcrumbs }: TopbarProps) {
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
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
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
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
          page name). Parent segments (e.g. "Sessions" on a session detail
          page) link back to their list, mirroring the web app's breadcrumb. */}
      <nav
        aria-label="Breadcrumb"
        className="app-region-no-drag flex min-w-0 items-center gap-2 text-sm"
      >
        {breadcrumbs.map((crumb, index) => (
          <Fragment key={crumb.href ?? crumb.label}>
            {index > 0 && (
              <span className="shrink-0 text-[var(--muted-foreground)]">/</span>
            )}
            <BreadcrumbSegment
              crumb={crumb}
              isLast={index === breadcrumbs.length - 1}
            />
          </Fragment>
        ))}
      </nav>

      <div className="flex-1" />
    </header>
  );
}

/**
 * One breadcrumb segment: the final segment is the current page (aria-current),
 * a non-final segment with an href is a link back to its list, and a non-final
 * segment without an href (a nav section label) is plain muted text.
 */
function BreadcrumbSegment({
  crumb,
  isLast,
}: {
  crumb: TopbarBreadcrumb;
  isLast: boolean;
}) {
  if (isLast) {
    return (
      <span aria-current="page" className="truncate font-medium">
        {crumb.label}
      </span>
    );
  }
  if (crumb.href) {
    return (
      <Link
        className="shrink-0 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
        href={crumb.href}
      >
        {crumb.label}
      </Link>
    );
  }
  return (
    <span className="shrink-0 text-[var(--muted-foreground)]">
      {crumb.label}
    </span>
  );
}
