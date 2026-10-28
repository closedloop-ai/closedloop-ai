"use client";

import { type ReactNode, useEffect, useRef } from "react";

/**
 * Demotes the top-level headings a third-party embed injects into a page the
 * app already owns the outline of (ISS-5151).
 *
 * Settings → Profile and Settings → Organization each rendered THREE `h1`s in
 * production: the app's own `Settings` page heading, plus `Account` and
 * `Profile details` (resp. `Organization` / `General`) supplied by Clerk's
 * embedded account UI. A document has exactly one top-level heading; three
 * gives a screen-reader user navigating by heading no single "this is the page"
 * anchor and no structural relationship between the page and the embed inside
 * it. WCAG 2.2 SC 1.3.1 Info and Relationships (Level A).
 *
 * WHY THIS IS DONE AT THE DOM AND NOT IN THE EMBED'S PROPS. `@clerk/ui` renders
 * its headings through one primitive whose call sites pass `as="h1"` as a
 * literal (verified against the installed `@clerk/ui` 1.6.5 bundle), and the
 * `appearance` API this repo already themes the embed with
 * (`packages/auth/components/appearance.ts`) reaches styles only — there is no
 * heading-level prop, element descriptor, or localization key that changes the
 * tag. The app therefore owns the correction at the only boundary it controls:
 * the element it mounts the embed into.
 *
 * WHY `role="heading"` + `aria-level` AND NOT A NEW `h2` ELEMENT. The nodes
 * belong to the embed's own React tree. Swapping the element would leave that
 * tree holding a detached node — text updates would land on nothing and the
 * unmount `removeChild` would throw — so the fix that is safe under the embed's
 * re-renders is the one ARIA defines for exactly this: an explicit `role` plus
 * `aria-level` overrides the implicit level of an `h1`, so the accessibility
 * tree exposes one level-1 heading (the app's) and the embed's headings beneath
 * it at {@link ThirdPartyHeadingScopeProps.level}. The `h1` ELEMENTS remain in
 * the markup; what a user's assistive technology computes from them does not.
 *
 * The observer is required rather than defensive: the embed mounts
 * asynchronously and swaps its whole content on every inner navigation (Account
 * → Security → …), so a one-shot pass on mount would demote the first page only.
 */
export function ThirdPartyHeadingScope({
  children,
  className,
  level = 2,
}: Readonly<ThirdPartyHeadingScopeProps>) {
  const scopeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scope = scopeRef.current;
    if (scope === null) {
      return;
    }
    const requestedLevel = String(level);
    const demoteHeadings = () => {
      for (const heading of scope.querySelectorAll("h1")) {
        // The marker records the level it was demoted TO, not merely that it
        // was demoted, so a scope re-rendered at a new `level` — or a marked
        // node moved in from a scope configured at a different one — is
        // corrected rather than skipped as already-final.
        if (
          heading.getAttribute(DEMOTED_HEADING_ATTRIBUTE) === requestedLevel
        ) {
          continue;
        }
        heading.setAttribute("role", "heading");
        heading.setAttribute("aria-level", requestedLevel);
        heading.setAttribute(DEMOTED_HEADING_ATTRIBUTE, requestedLevel);
      }
    };

    demoteHeadings();
    const observer = new MutationObserver(demoteHeadings);
    observer.observe(scope, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [level]);

  return (
    <div className={className} ref={scopeRef}>
      {children}
    </div>
  );
}

export type ThirdPartyHeadingScopeProps = {
  children: ReactNode;
  className?: string;
  /**
   * The level the embed's `h1`s are exposed at. Defaults to 2 — one step below
   * the page's own `h1` — so the outline never skips a level.
   */
  level?: 2 | 3 | 4 | 5 | 6;
};

/**
 * Marks a heading this scope has already demoted, so the observer's re-entrant
 * passes are cheap and so a test can observe that the demotion ran rather than
 * inferring it from the attributes it happens to set.
 */
export const DEMOTED_HEADING_ATTRIBUTE = "data-third-party-heading-demoted";
