import { cn } from "@repo/design-system/lib/utils";

/**
 * The page's `<h1>`, visually hidden (ISS-5008).
 *
 * Eight of the nine authenticated routes measured in production shipped zero
 * `h1`: the page name lived only in the breadcrumb bar, which is a `nav`, not a
 * heading, so a screen-reader user navigating by heading landed with no entry
 * point at all. WCAG 2.1 SC 1.3.1 Info and Relationships, SC 2.4.6 Headings and
 * Labels.
 *
 * It is `sr-only` because the page name is already visible elsewhere on these
 * routes (the crumb, or the detail body's own title) — a second visible title
 * would duplicate it. The text is real DOM text, so heading navigation and the
 * accessible name both resolve to exactly what the user sees.
 *
 * One component so every surface that owes a page heading spells it the same
 * way, and a route's loading and error states can own one without each
 * re-deriving the markup.
 */
export function PageHeading({
  children,
  className,
}: Readonly<{ children: string; className?: string }>) {
  if (children.length === 0) {
    return null;
  }
  return <h1 className={cn("sr-only", className)}>{children}</h1>;
}
