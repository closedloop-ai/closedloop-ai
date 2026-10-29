/**
 * ISS-9414 AC1 — the DESKTOP half of the Search both-host contract.
 *
 * The cases live once in
 * `@repo/app/search/components/__tests__/search-surface-both-host-contract`;
 * `apps/app/app/(authenticated)/[orgSlug]/search/components/__tests__/search-surface-both-host-contract.test.tsx`
 * runs the identical cases over the identical fixture against the web route.
 * This file owns only the Electron adapter — the ⌘K palette, the `cmdk` dialog
 * the rows land in, the REAL desktop navigation adapter (so an href is the
 * same-document hash this shell actually renders), and its read of the SAME
 * PostHog key web resolves. There is no desktop Labs gate for that key to pair
 * with; the palette's pre-existing `docsHelp` Labs gate is the DOCS CORPUS's,
 * and it is turned on here so the surface branch is reachable at all.
 *
 * The two halves put the same rows inside different containers — a page's
 * `<ul>` of links, and a `cmdk` option list — through different navigation
 * adapters. That is exactly the divergence one shell's suite cannot see.
 */

import {
  DESKTOP_HOST,
  runBothHostContract,
} from "@repo/app/shared/testing/both-host-render-contract";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

const { docsSearchMock, surfaceResultsMock } = vi.hoisted(() => ({
  docsSearchMock: vi.fn(),
  surfaceResultsMock: vi.fn(),
}));

// Every gate the palette consults resolves ON: the two Labs flags that decide
// whether the docs corpus is reachable on this build, and the PostHog key that
// decides which component renders it. The gate SELECTION itself is pinned by
// `search-surface-mount.test.tsx`, not restated here.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => typeof key === "string" && key !== "",
}));

vi.mock("../use-docs-command-search", () => ({
  useDocsCommandSearch: docsSearchMock,
}));

vi.mock("../docs-search-surface-results", () => ({
  docsHitsToSurfaceResults: surfaceResultsMock,
}));

import {
  CONTRACT_READY_READ,
  SEARCH_SURFACE_BOTH_HOST_CONTRACT,
  type SearchSurfaceBothHostFixture,
} from "@repo/app/search/components/__tests__/search-surface-both-host-contract";
import { createDesktopNavigation } from "../../../navigation/desktop-adapter";
import { CommandPalette } from "../command-palette";
import { installPaletteJsdomShims } from "./palette-jsdom-shims";

let restoreJsdomShims: (() => void) | undefined;
let navigation: ReturnType<typeof createDesktopNavigation> | undefined;

beforeEach(() => {
  docsSearchMock.mockReset();
  surfaceResultsMock.mockReset();
  restoreJsdomShims = installPaletteJsdomShims();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
    writable: true,
  });
});

afterEach(() => {
  navigation?.dispose();
  navigation = undefined;
  restoreJsdomShims?.();
});

runBothHostContract<SearchSurfaceBothHostFixture>({
  contract: SEARCH_SURFACE_BOTH_HOST_CONTRACT,
  host: DESKTOP_HOST,
  mount: (fixture) => {
    // `resultCount` is the hit count the palette read, so the stand-in response
    // carries one opaque hit per fixture result.
    docsSearchMock.mockReturnValue({
      hits: fixture.results.map(() => ({})),
      isSearching: CONTRACT_READY_READ.isLoading,
      hasFailed: CONTRACT_READY_READ.isUnavailable,
      retry: vi.fn(),
    });
    surfaceResultsMock.mockReturnValue([...fixture.results]);

    // The real adapter, not a stub: a desktop href is a same-document hash, and
    // the contract's suffix check is what lets that differ from web's org
    // prefix without either shell being allowed to change the destination.
    navigation = createDesktopNavigation();
    render(
      <NavigationProvider adapter={navigation.adapter}>
        <CommandPalette />
      </NavigationProvider>
    );
    // ⌘K, then a query: the palette's own entry point, and the surface only
    // treats a query as RUN once it is non-empty.
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.change(screen.getByPlaceholderText("Search documentation…"), {
      target: { value: "alpha" },
    });
  },
});
