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
 */
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandList,
} from "@closedloop-ai/design-system/components/ui/command";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useCallback, useEffect, useState } from "react";
import { helpPageHref } from "../../navigation/route-table";
import { useDocsHelpSurfaceEnabled } from "../../navigation/use-nav-gates";
import { DocsCommandGroup } from "./docs-command-group";

/** Does the platform-appropriate palette chord fire on this keydown? */
function isPaletteChord(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey);
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
        <CommandEmpty>
          {query.trim().length === 0
            ? "Type to search the documentation."
            : `No documentation matches “${query.trim()}”.`}
        </CommandEmpty>
        <DocsCommandGroup onSelectDoc={handleSelectDoc} query={query} />
      </CommandList>
    </CommandDialog>
  );
}
