"use client";

import { useEffect } from "react";

/**
 * ISS-5574: the application-wide browser tab title suffix. Matches the root
 * layout's `metadata.title` (`apps/app/app/layout.tsx`) so a page-titled tab and
 * an untitled one still read as the same product.
 */
export const DOCUMENT_TITLE_SUFFIX = "Closedloop.ai";

/**
 * Name the browser tab for the page currently rendered.
 *
 * Every Sessions and Branches route in this repo is a `"use client"` component,
 * and Next forbids a `metadata` export on one — so the Agents surface's static
 * `metadata` pattern is not reachable from these pages without adding a server
 * layout per route. This hook is the one seam both surfaces use instead, which
 * also means the desktop renderer (no Next at all) titles its tabs by the exact
 * same rule rather than a parallel implementation. It follows the precedent the
 * loop detail container already set (`loop-detail-container.tsx`).
 *
 * Pass `null` to leave the title alone — that is how a caller keeps the page on
 * the root layout's default while the feature is flagged off. It is NOT how a
 * caller says "still loading": a detail page whose record has not resolved
 * should pass its generic kind ("Session", "Branch"), which is true at every
 * moment, rather than holding a stale or invented name.
 *
 * Setting `document.title` is a DOM side effect on already-loaded client data,
 * so it belongs in an effect. The previous title is restored on unmount, so a
 * page that titles the tab cannot leave its name behind on a page that does not.
 *
 * `globalThis.document` rather than a bare `document`: this module sits under
 * `packages/app/`, a server-capable root where the `no-bare-browser-globals`
 * gate requires the explicit global.
 */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (title === null || typeof globalThis.document === "undefined") {
      return;
    }
    const previous = globalThis.document.title;
    globalThis.document.title = `${title} | ${DOCUMENT_TITLE_SUFFIX}`;
    return () => {
      globalThis.document.title = previous;
    };
  }, [title]);
}
