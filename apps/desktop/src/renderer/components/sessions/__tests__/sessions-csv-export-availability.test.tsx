import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSessionsExportItem } from "../sessions-csv-export-availability";

const FACET_QUERY = { startDate: "2026-08-01T00:00:00.000Z" };

/**
 * FEA-4217. Getting this gate wrong is not cosmetic in either direction: the row
 * it returns owns a `useApiClient()` call that THROWS without an auth provider,
 * so returning it in local mode crashes the whole Sessions view; withholding it
 * from an authenticated cloud reader silently removes the export.
 *
 * `renderHook` alone is enough — the hook only CREATES the element, so the row
 * (and its `useApiClient`) never mounts here, which is exactly the property the
 * gate exists to guarantee.
 */
describe("useSessionsExportItem", () => {
  it("offers the export row only when the surface is in cloud mode, signed in, and restored", () => {
    const { result } = renderHook(() =>
      useSessionsExportItem({
        facetQuery: FACET_QUERY,
        isAuthenticated: true,
        isCloudMode: true,
        isViewReady: true,
      })
    );

    expect(result.current).not.toBeNull();
  });

  it("withholds it in local mode, and when signed out, and when neither holds", () => {
    for (const [isCloudMode, isAuthenticated] of [
      [false, true],
      [true, false],
      [false, false],
    ] as const) {
      const { result } = renderHook(() =>
        useSessionsExportItem({
          facetQuery: FACET_QUERY,
          isAuthenticated,
          isCloudMode,
          isViewReady: true,
        })
      );
      expect(result.current).toBeNull();
    }
  });

  it("withholds it until the saved view has restored (whitlockk review)", () => {
    // Before the restore effect lands, the window and facets this hook memoizes
    // are still the module defaults — an export taken here would be a file for a
    // range the table was never showing, named as the reader's view.
    const { rerender, result } = renderHook(
      ({ isViewReady }: { isViewReady: boolean }) =>
        useSessionsExportItem({
          facetQuery: FACET_QUERY,
          isAuthenticated: true,
          isCloudMode: true,
          isViewReady,
        }),
      { initialProps: { isViewReady: false } }
    );

    expect(result.current).toBeNull();

    // And it appears once the gate opens — a row that never came back would
    // satisfy the assertion above just as well as the correct behaviour.
    rerender({ isViewReady: true });
    expect(result.current).not.toBeNull();
  });
});
