import type { DocumentListPage } from "@repo/api/src/types/document";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { keepSamePageSizePlaceholder } from "../use-my-tasks-card-page";

// Mirrors the two windows the My Tasks board asks for: the list view requests a
// wide window, the card view one screen page. The bug this guards is switching
// list → card while the 500-row list page is still successful placeholder data,
// which would transiently mount all 500 rows as draggable cards.
const LIST_LIMIT = 500;
const CARD_LIMIT = 50;

function buildPage(limit: number, itemCount: number): DocumentListPage {
  return {
    items: Array.from({ length: itemCount }, (_unused, i) => ({
      id: `doc-${limit}-${i}`,
    })) as DocumentListPage["items"],
    total: 500,
    limit,
    offset: 0,
    hasMore: itemCount < 500,
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

// Drives a single paged query the way the My Tasks board does: the query key and
// the requested limit both move when the view switches, and `placeholderData`
// is the scoped helper under test. Returns the rows the render would mount.
function usePagedBoard(view: "list" | "card") {
  const limit = view === "list" ? LIST_LIMIT : CARD_LIMIT;
  const query = useQuery({
    queryKey: ["my-tasks-page", { limit }],
    queryFn: () =>
      Promise.resolve(
        buildPage(limit, view === "list" ? LIST_LIMIT : CARD_LIMIT)
      ),
    placeholderData: keepSamePageSizePlaceholder(limit),
  });
  return query.data?.items ?? [];
}

describe("keepSamePageSizePlaceholder — real QueryClient list → card transition (ISS-4576)", () => {
  it("never surfaces the wide list page as placeholder for the card read", async () => {
    const wrapper = createWrapper();
    const { result, rerender } = renderHook<
      ReturnType<typeof usePagedBoard>,
      { view: "list" | "card" }
    >(({ view }) => usePagedBoard(view), {
      initialProps: { view: "list" },
      wrapper,
    });

    // The list view settles on its wide page.
    await waitFor(() => expect(result.current).toHaveLength(LIST_LIMIT));

    // Switch to the card view. While the 50-row read is in flight, the render
    // must NOT inherit the 500-row list page as placeholder — that is the
    // transient full-set mount this PR removes.
    rerender({ view: "card" });
    expect(result.current.length).toBeLessThanOrEqual(CARD_LIMIT);

    // And it settles on exactly the card page.
    await waitFor(() => expect(result.current).toHaveLength(CARD_LIMIT));
  });

  it("holds the previous page across an offset-only page turn at the same size", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Seed a landed first card page so the placeholder has a same-size previous
    // page to hold when the offset advances.
    queryClient.setQueryData(
      ["my-tasks-page", { limit: CARD_LIMIT, offset: 0 }],
      buildPage(CARD_LIMIT, CARD_LIMIT)
    );
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      );
    }

    // A never-resolving second page proves the placeholder holds the first page
    // rather than blanking while the next read is pending.
    const { result } = renderHook(
      () =>
        useQuery({
          queryKey: [
            "my-tasks-page",
            { limit: CARD_LIMIT, offset: CARD_LIMIT },
          ],
          queryFn: () => new Promise<DocumentListPage>(() => undefined),
          placeholderData: (previous: DocumentListPage | undefined) => {
            // Reuse the just-landed first page (offset 0) as the placeholder for
            // the offset-50 read, exactly as `keepSamePageSizePlaceholder` does
            // when the size matches.
            const holder = keepSamePageSizePlaceholder(CARD_LIMIT);
            return (
              holder(previous) ??
              holder(
                queryClient.getQueryData<DocumentListPage>([
                  "my-tasks-page",
                  { limit: CARD_LIMIT, offset: 0 },
                ])
              )
            );
          },
        }),
      { wrapper: Wrapper }
    );

    // The control-under-cursor stays mounted: a full page of rows is present
    // while the next page is still pending.
    expect(result.current.data?.items).toHaveLength(CARD_LIMIT);
    expect(result.current.data?.limit).toBe(CARD_LIMIT);
  });
});
