/**
 * ISS-9414 — the DESKTOP producer of AC2's three states.
 *
 * `SearchSurfaceV2` can only tell "nothing matched" from "nothing was answered"
 * if its host distinguishes them, and before this ticket the palette's hook
 * reported BOTH as `hits: []`. Everything below is about the axis that closes
 * that: `hasFailed`, and the retry that has to be visible while it runs.
 *
 * Driven through `window.desktopApi.docsHelp.search` — the real bridge the hook
 * reads — rather than by mocking the hook's own module, which is what every
 * other suite in this directory does and is why this axis had no coverage.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocsHelpSearchResult } from "../../../../shared/docs-help-contract";
import { useDocsCommandSearch } from "../use-docs-command-search";

const HIT_RESULT: DocsHelpSearchResult = {
  query: "api key",
  hits: [
    {
      path: "getting-started/api-keys",
      title: "API keys",
      group: "Getting Started",
      matchField: "heading",
      score: 30,
      excerpt: "Create an API key to authenticate…",
      headingSlug: "create-a-key",
    },
  ],
};

let originalDesktopApi: PropertyDescriptor | undefined;

function installDocsHelp(search: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { docsHelp: { search } },
  });
  return search;
}

beforeEach(() => {
  originalDesktopApi = Object.getOwnPropertyDescriptor(window, "desktopApi");
});

afterEach(() => {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
});

describe("useDocsCommandSearch failure reporting (AC2)", () => {
  it("reports a settled SUCCESS as hits with no failure", async () => {
    // The positive sibling of both failure cases below: without it, a hook that
    // reported `hasFailed` for everything would satisfy them.
    installDocsHelp(vi.fn(async () => HIT_RESULT));

    const { result } = renderHook(() => useDocsCommandSearch("api key"));

    await waitFor(() => {
      expect(result.current.hits).toHaveLength(1);
    });
    expect(result.current.hasFailed).toBe(false);
    expect(result.current.isSearching).toBe(false);
  });

  it("reports a REJECTED search as a failure, not as an empty corpus", async () => {
    installDocsHelp(vi.fn(() => Promise.reject(new Error("ipc exploded"))));

    const { result } = renderHook(() => useDocsCommandSearch("api key"));

    await waitFor(() => {
      expect(result.current.hasFailed).toBe(true);
    });
    // Empty AND failed: the surface must read the failure, because the empty
    // list alone is what used to render "No documentation matches".
    expect(result.current.hits).toHaveLength(0);
  });

  it("reports an ABSENT bridge as a failure — nothing was searched", async () => {
    Reflect.deleteProperty(window, "desktopApi");

    const { result } = renderHook(() => useDocsCommandSearch("api key"));

    await waitFor(() => {
      expect(result.current.hasFailed).toBe(true);
    });
    expect(result.current.isSearching).toBe(false);
  });

  it("clears the failure once a query settles successfully", async () => {
    const search = vi
      .fn()
      .mockRejectedValueOnce(new Error("ipc exploded"))
      .mockResolvedValue(HIT_RESULT);
    installDocsHelp(search);

    const { rerender, result } = renderHook(
      ({ query }) => useDocsCommandSearch(query),
      { initialProps: { query: "api key" } }
    );
    await waitFor(() => {
      expect(result.current.hasFailed).toBe(true);
    });

    rerender({ query: "loops" });

    await waitFor(() => {
      expect(result.current.hits).toHaveLength(1);
    });
    expect(result.current.hasFailed).toBe(false);
  });

  it("shows a retry of an UNCHANGED query as in flight, not as the settled failure", async () => {
    // The whole point of the retry. `isSearching` is "the live query differs
    // from the one the current results belong to", and a failure makes them
    // equal — so a retry that only re-issued the IPC left the surface rendering
    // "Couldn't load results" for the entire round trip, and a second failure
    // changed nothing on screen at all.
    const search = vi
      .fn()
      .mockRejectedValueOnce(new Error("ipc exploded"))
      .mockResolvedValue(HIT_RESULT);
    installDocsHelp(search);

    const { result } = renderHook(() => useDocsCommandSearch("api key"));
    await waitFor(() => {
      expect(result.current.hasFailed).toBe(true);
    });

    act(() => {
      result.current.retry();
    });

    // The surface reads `isUnavailable: hasFailed`, so this is the assertion
    // that the reader stops seeing a settled failure.
    expect(result.current.isSearching).toBe(true);
    expect(result.current.hasFailed).toBe(false);

    await waitFor(() => {
      expect(result.current.hits).toHaveLength(1);
    });
    expect(search).toHaveBeenCalledTimes(2);
  });
});
