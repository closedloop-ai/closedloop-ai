"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { ExternalLinkIcon } from "lucide-react";
import { DOCS_HELP_VIEW_ONLINE_LABEL } from "../lib/docs-help-payload";

/**
 * The one "read it on the live site" control, for every dead end a Help surface
 * has. `path` narrows it to the page in hand; without one it opens the docs root.
 *
 * A LEAF MODULE, and deliberately so (ISS-9731). This used to live in
 * `help-reader.tsx`, which imports `MarkdownContent` — react-markdown and its
 * highlighting. The desktop shell lazy-loads `HelpView` precisely to keep that
 * out of the eager chunk, so importing this control from the reader would have
 * dragged the whole markdown pipeline back in through the front door. Splitting
 * it out lets a bundle-sensitive caller take the control and nothing else,
 * which is the same rule `AGENTS.md` states for constants and label maps.
 *
 * Its three original callers import it from here; nothing is re-exported,
 * because a direct subpath import beats a barrel.
 */
const TRAILING_SLASH_RE = /\/+$/;

export function ViewOnlineAction({
  docsSiteUrl,
  path,
}: Readonly<{ docsSiteUrl: string; path?: string }>) {
  return (
    <Button asChild size="sm" variant="outline">
      <a
        href={
          path === undefined ? docsSiteUrl : viewOnlineHref(docsSiteUrl, path)
        }
        rel="noreferrer"
        target="_blank"
      >
        <ExternalLinkIcon aria-hidden className="size-3.5" />
        {DOCS_HELP_VIEW_ONLINE_LABEL}
      </a>
    </Button>
  );
}

/** The "View latest online" escape hatch for the current page. */
function viewOnlineHref(docsSiteUrl: string, path: string): string {
  const base = docsSiteUrl.replace(TRAILING_SLASH_RE, "");
  return `${base}/${path}`;
}
