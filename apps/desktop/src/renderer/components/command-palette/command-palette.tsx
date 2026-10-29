/**
 * Desktop command palette (FEA-3845 / PRD-555 M3).
 *
 * A ⌘K / Ctrl+K quick-search dialog whose first result group is Docs: as the
 * user types, the group queries the M1 `docsHelp.search` IPC (debounced) and
 * surfaces matching pages (title + facet + snippet); Enter opens the pick in the
 * M2 Help view by navigating to `/help?page=…&heading=…`, reusing the Help view's
 * existing page-select seam rather than duplicating the reader.
 *
 * Gated on the `docsHelp` Labs flag AND the Labs container gate above it
 * (ISS-5037): with either off the palette does not mount and the ⌘K listener is
 * not attached (the Docs group is the palette's only content today, so an empty
 * palette would be dead UI — and with Labs off it would be a keyboard jump to a
 * destination the shell has withdrawn). Built on the
 * design-system `CommandDialog` catalog (cmdk) — no hand-rolled dialog/list.
 *
 * The `portable-search-surface` PostHog key, read once below, then chooses
 * between `SearchSurfaceV2` and this palette's own `DocsCommandGroup`. The two
 * gates are not a pair: the Labs gate decides whether the docs CORPUS is
 * reachable on this build at all, the PostHog key decides which component
 * renders it. Neither branch knows either gate exists.
 */

import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandList,
} from "@closedloop-ai/design-system/components/ui/command";
import { normalizedEventKey } from "@closedloop-ai/design-system/lib/keyboard-event-key";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { PORTABLE_SEARCH_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useCallback, useEffect, useState } from "react";
import { helpPageHref } from "../../navigation/route-table";
import { useDocsHelpSurfaceEnabled } from "../../navigation/use-nav-gates";
import { DocsCommandGroup } from "./docs-command-group";
import {
  DOCS_NOT_RUN_PROMPT,
  DocsSearchSurfaceGroup,
} from "./docs-search-surface-group";

/** Does the platform-appropriate palette chord fire on this keydown? */
function isPaletteChord(event: KeyboardEvent): boolean {
  // ISS-7493: the listener is on `window`, so what it is handed is not
  // constrained by the DOM type — see `normalizedEventKey` for the RUM evidence.
  return normalizedEventKey(event) === "k" && (event.metaKey || event.ctrlKey);
}

export function CommandPalette() {
  const flagOn = useDocsHelpSurfaceEnabled();
  // The Docs group is the palette's only content in M3; with the surface gated
  // off there is nothing to show, so skip mounting (and binding ⌘K) entirely.
  if (!flagOn) {
    return null;
  }
  return <CommandPaletteInner />;
}

function CommandPaletteInner() {
  const { navigate } = useNavigation();
  const portableSearchSurface = useFeatureFlagEnabled(
    PORTABLE_SEARCH_SURFACE_FEATURE_FLAG_KEY
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // ⌘K / Ctrl+K toggles the palette. Bound once for the window lifetime.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isPaletteChord(event)) {
        return;
      }
      event.preventDefault();
      setOpen((prev) => !prev);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Start each open with a clean query so the palette never reopens onto stale
  // results.
  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
    }
  }, []);

  // Enter on a Docs hit: close the palette and open the Help view at that page
  // (and heading anchor, when the hit matched a heading).
  const handleSelectDoc = useCallback(
    (path: string, headingSlug?: string) => {
      setOpen(false);
      setQuery("");
      navigate(helpPageHref(path, headingSlug));
    },
    [navigate]
  );

  // The surface's rows are real links that navigate themselves, so the host
  // only has to dismiss — and it must dismiss even when the destination is
  // already current, where no navigation event fires at all.
  const handleDismiss = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  return (
    <CommandDialog
      // cmdk filters items by their text against the input; our Docs hits are
      // already ranked server-side by the local index, so disable client
      // filtering and show exactly what the IPC returned in its order.
      commandProps={{ shouldFilter: false }}
      description="Search the docs and jump to a page."
      onOpenChange={handleOpenChange}
      open={open}
      title="Command palette"
    >
      <CommandInput
        onValueChange={setQuery}
        placeholder="Search documentation…"
        value={query}
      />
      <CommandList>
        {/* cmdk renders `CommandEmpty` whenever the list holds no items, which
            is also every non-`Ready` state of the surface — so on the surface
            branch it would stack a second, blunter empty line under the one the
            surface already owns. The surface branch omits it entirely. */}
        {portableSearchSurface ? (
          <DocsSearchSurfaceGroup onDismiss={handleDismiss} query={query} />
        ) : (
          <>
            <CommandEmpty>
              {query.trim().length === 0
                ? DOCS_NOT_RUN_PROMPT
                : `No documentation matches “${query.trim()}”.`}
            </CommandEmpty>
            <DocsCommandGroup onSelectDoc={handleSelectDoc} query={query} />
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
