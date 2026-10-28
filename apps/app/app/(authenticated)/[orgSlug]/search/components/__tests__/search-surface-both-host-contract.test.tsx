/**
 * ISS-9414 AC1 — the WEB half of the Search both-host contract.
 *
 * The cases are not written here: they live once in
 * `@repo/app/search/components/__tests__/search-surface-both-host-contract`,
 * and
 * `apps/desktop/src/renderer/components/command-palette/__tests__/search-surface-both-host-contract.test.tsx`
 * runs the identical cases over the identical fixture against the Electron
 * palette. This file owns only the web half: this app's URL-driven query, its
 * `useSearchPanelState` read, and its read of the SAME PostHog key the desktop
 * shell resolves. The navigation port is stubbed here, so the real org-slug
 * href is pinned by `e2e/search-surface-v2.spec.ts` rather than by this file.
 *
 * WHAT IS STUBBED, AND WHY IT IS THE RIGHT SEAM. The fixture is a
 * `SearchSurfaceResult[]` — the shared model — so each shell stands its own
 * boundary mapper down and hands the surface exactly that. Stubbing anything
 * further in (the surface, the row) would test the fixture; stubbing anything
 * further out (the FTS response) would make the two shells' fixtures
 * untranslatable, since Desktop's corpus is a local docs index and cannot
 * produce a `SearchHit`. The mapper IS the host boundary, so it is what moves.
 */

import {
  CONTRACT_READY_READ,
  SEARCH_SURFACE_BOTH_HOST_CONTRACT,
  type SearchSurfaceBothHostFixture,
} from "@repo/app/search/components/__tests__/search-surface-both-host-contract";
import { PORTABLE_SEARCH_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  runBothHostContract,
  WEB_HOST,
} from "@repo/app/shared/testing/both-host-render-contract";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, vi } from "vitest";

const { surfaceResultsMock, useSearchPanelStateMock } = vi.hoisted(() => ({
  surfaceResultsMock: vi.fn(),
  useSearchPanelStateMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "acme" }),
  usePathname: () => "/acme/search",
  useRouter: () => ({
    back: vi.fn(),
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
  // A committed query, so the panel is past its 2-char floor and the surface is
  // asked about a query that genuinely ran.
  useSearchParams: () => new URLSearchParams("q=alpha"),
}));

vi.mock("@/hooks/use-org-slug", () => ({ useOrgSlug: () => "acme" }));

// The intellisense bar is its own suite's business; a controlled input keeps
// this file on the results contract.
vi.mock("@repo/app/search/components/search-typeahead", () => ({
  SearchTypeahead: ({ value }: { value: string }) => (
    <input aria-label="Search query" readOnly value={value} />
  ),
}));

// A stand-in for the web adapter's org-slug prefix, which the desktop shell has
// no analogue for. The contract asserts a destination SUFFIX precisely so that
// prefix stays a host-boundary difference rather than a divergence.
vi.mock("@repo/navigation/link", () => ({
  Link: ({
    children,
    href,
    ...rest
  }: {
    children: ReactNode;
    href: string;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => `/acme${path}`,
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) =>
    key === PORTABLE_SEARCH_SURFACE_FEATURE_FLAG_KEY,
}));

vi.mock("@repo/app/search/hooks/use-search", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/app/search/hooks/use-search")
  >("@repo/app/search/hooks/use-search");
  return { ...actual, useSearchPanelState: useSearchPanelStateMock };
});

vi.mock("@repo/app/search/lib/search-surface-model", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/app/search/lib/search-surface-model")
  >("@repo/app/search/lib/search-surface-model");
  return { ...actual, searchHitsToSurfaceResults: surfaceResultsMock };
});

import { SearchResults } from "../search-results";

beforeEach(() => {
  useSearchPanelStateMock.mockReset();
  surfaceResultsMock.mockReset();
});

runBothHostContract<SearchSurfaceBothHostFixture>({
  contract: SEARCH_SURFACE_BOTH_HOST_CONTRACT,
  host: WEB_HOST,
  mount: (fixture) => {
    // The panel derives `resultCount` from the hits it read, so the stand-in
    // response carries one opaque hit per fixture result. A shorter list would
    // put the surface in a state the fixture does not describe.
    useSearchPanelStateMock.mockReturnValue({
      results: fixture.results.map(() => ({})),
      isLoading: CONTRACT_READY_READ.isLoading,
      isError: CONTRACT_READY_READ.isUnavailable,
      filterErrorMessage: undefined,
      nextCursor: null,
      refetch: vi.fn(),
    });
    surfaceResultsMock.mockReturnValue([...fixture.results]);
    render(<SearchResults />);
  },
});
