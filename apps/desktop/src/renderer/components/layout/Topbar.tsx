import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@closedloop-ai/design-system/components/ui/breadcrumb";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { useSidebar } from "@closedloop-ai/design-system/components/ui/sidebar";
import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import type { DocsAnchor } from "../../navigation/docs-anchor";
import { isMacOS, macStoplightClearance } from "../../platform";
import { HelpOnThisButton } from "../help/help-on-this-button";
import {
  InviteSpotlightAnchor,
  InviteSpotlightPopover,
  useInviteSpotlightHighlight,
} from "../onboarding/invite-spotlight";

/**
 * One breadcrumb segment. A segment with an `href` renders as a navigation link
 * (parent segments, e.g. "Sessions" on a session detail page); the final
 * segment is always rendered as the current page and carries `aria-current`.
 *
 * ISS-4839: a final segment may instead be `pending` — the page is known but its
 * NAME has not resolved yet. It keeps the slot (so the trail does not reflow
 * when the name lands) and renders a skeleton in place of the text, with `label`
 * demoted to the accessible name. It is deliberately still a segment rather than
 * being omitted: dropping it would make the PARENT the final segment, and a
 * final segment renders as `aria-current="page"` with its link suppressed — so a
 * loading session detail would announce itself as the Sessions list and lose the
 * breadcrumb back affordance for the whole load.
 */
export type TopbarBreadcrumb = {
  label: string;
  href?: string;
  pending?: boolean;
};

type TopbarProps = {
  breadcrumbs: TopbarBreadcrumb[];
  /** Route-owned primary actions rendered at the prototype's header position. */
  actions?: ReactNode;
  /**
   * Docs anchor the active screen declared (FEA-3846 / PRD-555 M4), or null.
   * When set (and the `docsHelp` flag is on) the trailing "Help on this"
   * affordance deep-links the Help view to that page/section.
   */
  docsAnchor?: DocsAnchor | null;
};

export function Topbar({
  actions,
  breadcrumbs,
  docsAnchor = null,
}: TopbarProps) {
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  const isMac = isMacOS();
  const spotlightHighlight = useInviteSpotlightHighlight(
    InviteSpotlightAnchor.Topbar
  );

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
        collapsed && macStoplightClearance()
      )}
    >
      {/* ISS-5489 (PLN-1694 M2): below 768px the sidebar — and its "Invite your
          team" item — is an offcanvas sheet, so the invite spotlight anchors
          here instead, to the control that reveals it. Renders the bare button
          at every other breakpoint and whenever the nudge is not showing. */}
      <InviteSpotlightPopover anchor={InviteSpotlightAnchor.Topbar}>
        <Button
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "app-region-no-drag text-[var(--muted-foreground)]",
            spotlightHighlight
          )}
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
      </InviteSpotlightPopover>

      {/* Breadcrumb is navigation, not a page heading — the DS Breadcrumb (a
          labeled nav landmark with the current segment marked aria-current)
          is the accessible "you are here" cue, without competing with each
          page's own in-body <h1> (pages that render a PageShell title own the
          page heading; Sessions/Branches intentionally rely on this breadcrumb
          for their page name). Composing the same DS primitives as the web
          `Header` keeps the two surfaces visually identical — chevron
          separator, token muted color, font-normal current crumb. Parent
          segments (e.g. "Sessions" on a session detail page) link back to
          their list. */}
      <Breadcrumb className="app-region-no-drag min-w-0">
        <BreadcrumbList className="flex-nowrap">
          {breadcrumbs.map((crumb, index) => (
            <Fragment key={crumb.href ?? crumb.label}>
              {index > 0 && <BreadcrumbSeparator className="shrink-0" />}
              <BreadcrumbSegment
                crumb={crumb}
                isLast={index === breadcrumbs.length - 1}
              />
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex-1" />

      {actions ? (
        <div className="app-region-no-drag flex items-center gap-2">
          {actions}
        </div>
      ) : null}

      {/* FEA-3846 / PRD-555 M4: contextual "Help on this" — deep-links the Help
          view to the docs page/section the active screen declared. Self-gates on
          the `docsHelp` Labs flag and on an anchor being present, so it renders
          null on screens without one. */}
      <HelpOnThisButton anchor={docsAnchor} />
    </header>
  );
}

/**
 * One breadcrumb segment, composed from the DS Breadcrumb primitives so the
 * desktop Topbar matches the web `Header` exactly: the final segment is the
 * current page (`BreadcrumbPage`, aria-current), a non-final segment with an
 * href links back to its list through the navigation port (a raw `<a>`
 * dead-clicks under Electron's will-navigate guard), and a non-final segment
 * without an href (a nav section label) is a plain muted page crumb.
 */
function BreadcrumbSegment({
  crumb,
  isLast,
}: {
  crumb: TopbarBreadcrumb;
  isLast: boolean;
}) {
  if (isLast) {
    // ISS-4839: the page is known, its name is not. Hold the slot with a
    // skeleton the width of a typical name so the trail does not reflow when the
    // real name lands, and hand the label to assistive tech as the accessible
    // name instead of rendering a placeholder noun the user would have to
    // re-read. A LOADING state — never an empty or unavailable one.
    if (crumb.pending) {
      return (
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage aria-label={crumb.label} aria-live="polite">
            <Skeleton className="h-4 w-32" />
          </BreadcrumbPage>
        </BreadcrumbItem>
      );
    }
    return (
      <BreadcrumbItem className="min-w-0">
        <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
      </BreadcrumbItem>
    );
  }
  if (crumb.href) {
    return (
      <BreadcrumbItem className="shrink-0">
        <BreadcrumbLink asChild>
          <Link href={crumb.href}>{crumb.label}</Link>
        </BreadcrumbLink>
      </BreadcrumbItem>
    );
  }
  return (
    <BreadcrumbItem className="shrink-0">
      <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
    </BreadcrumbItem>
  );
}
