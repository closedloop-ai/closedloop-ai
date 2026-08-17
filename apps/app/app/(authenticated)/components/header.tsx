import { PageHeading } from "@repo/app/shared/components/page-heading";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@repo/design-system/components/ui/breadcrumb";
import { SidebarTrigger } from "@repo/design-system/components/ui/sidebar";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { Fragment, type ReactNode } from "react";
import { MobileSearchOverlay } from "./mobile-search-overlay";

export type BreadcrumbEntry = {
  label: string;
  href?: string;
};

type HeaderProps = {
  breadcrumbs: BreadcrumbEntry[];
  afterBreadcrumbs?: ReactNode;
  /**
   * Ellipsis / "more" menu pinned to the left cluster, immediately after the
   * favorite button (`afterBreadcrumbs`) — or directly after the breadcrumb
   * when there is no favorite. Page-level overflow actions go here, not in
   * `children` (which stays on the right for primary actions).
   */
  moreMenu?: ReactNode;
  children?: ReactNode;
  className?: string;
  /**
   * Opt out of the page-level `<h1>` this header renders (ISS-5008), for the
   * routes that already render their own visible page heading inside `<main>`.
   *
   * The default is to render it, so a NEW route gets a heading outline for free
   * rather than shipping without one — which is how eight of the nine measured
   * authenticated routes ended up with zero `h1`. Set this only when you can
   * point at the page's own `h1`; two `h1`s is the same defect from the other
   * side.
   */
  suppressPageHeading?: boolean;
};

export const Header = ({
  breadcrumbs,
  afterBreadcrumbs,
  moreMenu,
  children,
  className,
  suppressPageHeading = false,
}: HeaderProps) => (
  <header
    className={cn(
      "flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2",
      className
    )}
  >
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <SidebarTrigger className="-ml-1 shrink-0" />
      {/* A breadcrumb is not a heading: screen-reader users navigating by
          heading (the primary mode on a data-dense app) landed on these pages
          with no entry point at all. This carries the same string as a real
          `h1`, outside the breadcrumb `nav` so the heading names the page and
          not the navigation. WCAG 2.1 SC 1.3.1 Info and Relationships, SC 2.4.6
          Headings and Labels.

          This is the a11y floor, NOT a claim that the crumb is a sufficient
          page title. It is not: it is navigation set at label size, and the
          split underneath it is real — Dashboard/Settings/Judges/Usage lead
          with a visible `text-2xl` title while Sessions/Inbox/My Tasks/
          Documents go straight from a label-size crumb into a table. That
          inconsistency is a design defect this accessibility fix does not
          address and must not be read as having addressed. */}
      {suppressPageHeading ? null : (
        <HeaderPageHeading breadcrumbs={breadcrumbs} />
      )}
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="flex-nowrap">
          {breadcrumbs.map((entry, index) => {
            const isLast = index === breadcrumbs.length - 1;
            // The crumb directly before the current page is the "back" target.
            // Keep it visible at every width (it carries the only back path on a
            // two-crumb detail page) — it just truncates hard under `md` so it
            // never crowds out the current-page crumb. Higher ancestors still
            // collapse below `md`.
            const isImmediateParent = index === breadcrumbs.length - 2;
            return (
              <Fragment key={entry.href ?? entry.label}>
                {index > 0 && (
                  <BreadcrumbSeparator
                    className={
                      isImmediateParent
                        ? "shrink-0"
                        : "hidden shrink-0 md:block"
                    }
                  />
                )}
                <BreadcrumbItem
                  className={breadcrumbItemClassName({
                    isLast,
                    isImmediateParent,
                  })}
                >
                  {isLast || !entry.href ? (
                    <BreadcrumbPage
                      className={isLast ? "block truncate" : undefined}
                      title={isLast ? entry.label : undefined}
                    >
                      {entry.label}
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      {/* Route the parent-crumb "back" link through the
                          navigation port, not the raw <a> BreadcrumbLink renders
                          by default: a bare <a href> dead-clicks under the
                          desktop renderer's Electron will-navigate guard, while
                          the port resolves to next/link on web and the hash-store
                          adapter on desktop. */}
                      <Link
                        className={
                          isImmediateParent ? "block truncate" : undefined
                        }
                        href={entry.href}
                        title={isImmediateParent ? entry.label : undefined}
                      >
                        {entry.label}
                      </Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
      {afterBreadcrumbs || moreMenu ? (
        <div className="flex shrink-0 items-center gap-0.5">
          {afterBreadcrumbs}
          {moreMenu}
        </div>
      ) : null}
    </div>
    <div className="flex items-center gap-2">
      {/* Touch-only global search entry. Always present so search is reachable
          at `< md` on every route (desktop keeps `cmd+k`); the button hides
          itself at `md+`. */}
      <MobileSearchOverlay />
      {children}
    </div>
  </header>
);

/**
 * The page's `<h1>`, named by the current (last) breadcrumb — the one string
 * that already identifies the page. Renders nothing when there is no crumb to
 * name it with, so a header with an empty trail cannot ship an empty heading.
 *
 * Delegates to the shared `PageHeading` so every surface that owes a page
 * heading — this header, and the detail routes' loading/error states — spells
 * it exactly one way.
 */
const HeaderPageHeading = ({
  breadcrumbs,
}: {
  breadcrumbs: BreadcrumbEntry[];
}) => {
  const label = breadcrumbs.at(-1)?.label;
  if (!label) {
    return null;
  }
  return <PageHeading>{label}</PageHeading>;
};

const breadcrumbItemClassName = ({
  isLast,
  isImmediateParent,
}: {
  isLast: boolean;
  isImmediateParent: boolean;
}) => {
  if (isLast) {
    return "min-w-0 flex-1";
  }
  // The back-target crumb stays visible at every width but shrinks/truncates so
  // it never squeezes out the current-page crumb; deeper ancestors collapse
  // below `md`.
  if (isImmediateParent) {
    return "min-w-0 shrink";
  }
  return "hidden shrink-0 md:block";
};
