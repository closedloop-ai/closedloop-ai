/**
 * ISS-9414 AC4 (desktop half) — which component the ⌘K palette actually mounts,
 * under each combination of the two gates it sits behind.
 *
 * The gates are NESTED and answer different questions, so turning both off
 * would never exercise the inner one:
 *   - OUTER, pre-existing: the `docsHelp` Labs flag ANDed with the Labs
 *     container gate. It decides whether the docs CORPUS is reachable on this
 *     build at all. ISS-9414 neither adds nor removes it — withdrawing it would
 *     remove reach, which is a product decision.
 *   - INNER, new: the `portable-search-surface` PostHog key, default OFF. It
 *     decides WHICH component renders that corpus.
 * So the case that matters is OUTER ON, INNER OFF: the palette still works, and
 * still works the old way.
 *
 * THE LOCATOR IS THE POINT. Both branches render the string "Type to search the
 * documentation." — the surface deliberately keeps the palette's own copy — so
 * an assertion written against that copy passes on either branch and proves
 * nothing. Each case is pinned on a locator only ONE branch can emit: the
 * surface's root test id, and the legacy branch's `cmdk` empty slot.
 */

import { SEARCH_SURFACE_V2_TEST_ID } from "@repo/app/search/components/search-surface-v2";
import { PORTABLE_SEARCH_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { docsSearchMock, flagMock } = vi.hoisted(() => ({
  docsSearchMock: vi.fn(),
  flagMock: vi.fn(),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: flagMock,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => path,
}));

vi.mock("@repo/navigation/link", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("../use-docs-command-search", () => ({
  useDocsCommandSearch: docsSearchMock,
}));

import { DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY } from "../../../../shared/desktop-docs-help-flag";
import { DESKTOP_LABS_NAV_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags-labs-detail";
import { CommandPalette } from "../command-palette";
import { installPaletteJsdomShims } from "./palette-jsdom-shims";

let restoreJsdomShims: (() => void) | undefined;

/** Resolve every gate the palette reads, one by one, with no default. */
function gates({
  docsCorpus,
  portableSurface,
}: {
  docsCorpus: boolean;
  portableSurface: boolean;
}) {
  flagMock.mockImplementation((key: string) => {
    if (key === PORTABLE_SEARCH_SURFACE_FEATURE_FLAG_KEY) {
      return portableSurface;
    }
    if (
      key === DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY ||
      key === DESKTOP_LABS_NAV_FEATURE_FLAG_KEY
    ) {
      return docsCorpus;
    }
    return false;
  });
}

/**
 * Opens the palette and types, returning the input or null when the palette did
 * not mount at all.
 *
 * The caller must say which it expected. An earlier version typed only when the
 * input happened to exist, so drifting the placeholder string would have made
 * the "palette does not open" case pass trivially while the two cases that DO
 * open silently stopped typing.
 */
function openPaletteWithQuery(): HTMLElement | null {
  render(<CommandPalette />);
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const input = screen.queryByPlaceholderText("Search documentation…");
  if (input !== null) {
    fireEvent.change(input, { target: { value: "alpha" } });
  }
  return input;
}

beforeEach(() => {
  flagMock.mockReset();
  docsSearchMock.mockReset();
  docsSearchMock.mockReturnValue({
    hits: [],
    isSearching: false,
    hasFailed: false,
    retry: vi.fn(),
  });
  restoreJsdomShims = installPaletteJsdomShims();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
    writable: true,
  });
});

afterEach(() => {
  restoreJsdomShims?.();
});

/** The `cmdk` empty slot — rendered by the legacy branch and by nothing else. */
function legacyEmptySlot(): Element | null {
  return document.querySelector('[data-slot="command-empty"]');
}

describe("desktop command palette surface gate (AC4)", () => {
  it("mounts the shared surface when the key is on", () => {
    gates({ docsCorpus: true, portableSurface: true });

    // Non-null, asserted: the query below is only meaningful if it was typed.
    expect(openPaletteWithQuery()).not.toBeNull();

    expect(screen.queryByTestId(SEARCH_SURFACE_V2_TEST_ID)).not.toBeNull();
    expect(legacyEmptySlot()).toBeNull();
  });

  it("keeps the palette on its own Docs group when the key is off", () => {
    // The case a both-off test can never reach: the corpus IS reachable, and
    // the default-off key must leave the shipped palette exactly as it was.
    gates({ docsCorpus: true, portableSurface: false });

    expect(openPaletteWithQuery()).not.toBeNull();

    expect(legacyEmptySlot()).not.toBeNull();
    expect(screen.queryByTestId(SEARCH_SURFACE_V2_TEST_ID)).toBeNull();
  });

  it("does not open a palette at all while the docs corpus is withdrawn", () => {
    // The outer gate still decides reachability: turning the new key on must
    // not become a back door into a destination the shell has withdrawn.
    gates({ docsCorpus: false, portableSurface: true });

    const input = openPaletteWithQuery();

    expect(input).toBeNull();
    expect(screen.queryByTestId(SEARCH_SURFACE_V2_TEST_ID)).toBeNull();
    expect(legacyEmptySlot()).toBeNull();
  });
});
