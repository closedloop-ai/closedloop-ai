"use client";

import { buttonVariants } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { SearchX } from "lucide-react";

/**
 * In-shell 404 boundary for the authenticated app. A `notFound()` raised by any
 * route under this segment — e.g. the removed `/documents` index (FEA-3964) or a
 * flagged-off route reached by direct URL — lands here and renders inside the
 * sidebar chrome the layout provides, so a stale bookmark keeps a way back into
 * the product instead of dumping the user onto Next's bare, out-of-shell system
 * 404.
 *
 * The screen composes the catalog `EmptyState` (icon + title + description +
 * action) so it inherits the design-system spacing and type rhythm every other
 * full-page zero-state uses. `titleAs="h1"` is passed because here the empty
 * state IS the page: `EmptyState` renders a styled `div` by default, which is
 * correct inside a panel that already has a heading but would leave this screen
 * with no heading at all, so heading navigation would skip the only content on
 * it. `useOrgPath` builds the org-scoped dashboard href
 * (not raw slug interpolation), and the recovery affordance is a real `<Link>`
 * so browser navigation gestures (middle-click, cmd/ctrl-click, context menu)
 * keep working.
 *
 * Copy: the title keeps the neutral 404 framing ("Page not found") so a
 * flag-gated route never leaks that a flag or an entitlement is the reason it is
 * unreachable. The description is the deliberately vague "This page isn't
 * available" rather than "doesn't exist or has moved" — the latter reads oddly
 * on a route a teammate uses every day (flag-gated case), while the former is
 * accurate for both a genuine 404 and a gated route without leaking anything.
 */
export default function AuthenticatedNotFound() {
  const buildOrgPath = useOrgPath();

  return (
    <div className="flex h-full flex-col items-center justify-center p-6">
      <EmptyState
        action={
          <Link className={buttonVariants()} href={buildOrgPath("/dashboard")}>
            Back to dashboard
          </Link>
        }
        description="This page isn't available."
        icon={SearchX}
        title="Page not found"
        titleAs="h1"
      />
    </div>
  );
}
