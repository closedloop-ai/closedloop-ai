/**
 * ISS-12288 — `contentViewportClasses` makes the desktop App-shell content
 * viewport a scroll container on a list route and not on any detail arm.
 *
 * The decision is EXECUTED, not pattern-matched: the production class string is
 * resolved to the `overflow-y` it means, applied to a real element, and handed to
 * the real `resolveScrollParent`. jsdom loads no Tailwind, which is the only
 * reason the utility→declaration step is written out here; it is Tailwind's
 * stable mapping, not a contract this repo owns.
 */

import { resolveScrollParent } from "@closedloop-ai/design-system/lib/scroll-parent";
import { afterEach, describe, expect, it } from "vitest";
import { contentViewportClasses } from "../content-viewport-classes";

/** A route with nothing open — the Sessions list is this shape. */
const LIST_ROUTE = {
  detailSessionId: null,
  detailBranchId: null,
  detailDocumentSlug: null,
  agentDetailOpen: false,
} as const;

/**
 * One per input that opens a detail, each on its own: the arm is an OR, so a
 * single combined case would still pass if three of the four stopped counting.
 */
const DETAIL_ROUTES = [
  { ...LIST_ROUTE, detailSessionId: "session-1" },
  { ...LIST_ROUTE, detailBranchId: "branch-1" },
  { ...LIST_ROUTE, detailDocumentSlug: "PRD-1" },
  { ...LIST_ROUTE, agentDetailOpen: true },
] as const;

/** What each Tailwind overflow utility sets `overflow-y` to. */
const OVERFLOW_UTILITY_DECLARATIONS: Readonly<Record<string, string>> = {
  "overflow-auto": "auto",
  "overflow-hidden": "hidden",
  "overflow-scroll": "scroll",
  "overflow-y-auto": "auto",
  "overflow-y-hidden": "hidden",
  "overflow-y-scroll": "scroll",
};
const WHITESPACE_PATTERN = /\s+/;

afterEach(() => {
  document.body.replaceChildren();
});

describe("desktop content viewport — list vs detail scroll ownership", () => {
  it("scrolls on a list route", () => {
    const { child, viewport } = mountViewport(
      contentViewportClasses(LIST_ROUTE)
    );
    expect(resolveScrollParent(child)).toBe(viewport);
  });

  it.each(DETAIL_ROUTES)(
    "does not scroll while a detail owns the route (%o)",
    (route) => {
      const { child } = mountViewport(contentViewportClasses(route));
      // A detail route manages its own scrolling regions; the walk must fall
      // past this element rather than stop at a non-scrolling one.
      expect(resolveScrollParent(child)).toBeNull();
    }
  );
});

/**
 * The viewport element the shell renders, carrying the `overflow-y` its classes
 * mean, plus the descendant a window's anchor stands in for.
 */
function mountViewport(className: string): {
  child: HTMLElement;
  viewport: HTMLElement;
} {
  const viewport = document.createElement("div");
  viewport.style.overflowY = resolveOverflowY(className);
  const child = document.createElement("div");
  viewport.append(child);
  document.body.append(viewport);
  return { child, viewport };
}

/**
 * The `overflow-y` a class list resolves to. Throws rather than defaulting:
 * dropping the overflow utility is the same regression as changing it, and a
 * silent fallback here would be the one that makes this suite unable to fail.
 */
function resolveOverflowY(className: string): string {
  const declarations = className
    .split(WHITESPACE_PATTERN)
    .filter((token) => token in OVERFLOW_UTILITY_DECLARATIONS)
    .map((token) => OVERFLOW_UTILITY_DECLARATIONS[token]);
  if (declarations.length !== 1) {
    throw new Error(
      `expected exactly one overflow utility in "${className}", found ${declarations.length}`
    );
  }
  return declarations[0] ?? "";
}
