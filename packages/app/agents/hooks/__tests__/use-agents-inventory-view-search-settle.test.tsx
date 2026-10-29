/**
 * ISS-6822 — the search box must not cost one bounded read per keystroke.
 *
 * In the bounded branch every distinct `filters.search` value is a distinct
 * React Query key, and every distinct key is a request that reaches
 * `getPageDataForOrg`, which concurrently rebuilds up to three inventory-cap
 * populations. Undamped, typing a normal word issues one database-heavy read per
 * character and the superseded ones are not cancelled.
 *
 * These cases pin the read COUNT, not the debounce mechanism, so they fail for
 * the reason that matters: remove the settle in
 * `use-agents-inventory-view.ts` and the bounded case below goes red with one
 * read per character.
 */

import {
  AgentComponentSortDir,
  AgentComponentSortKey,
} from "@repo/api/src/types/agent-component";
import type {
  AgentComponentPageDataRequest,
  AgentComponentPageDataResult,
} from "@repo/api/src/utils/agent-component-page-data";
import { DEFAULT_AGENT_COMPONENT_FILTERS } from "@repo/api/src/utils/agent-component-reduce";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../data-source/provider";
import {
  AGENT_INVENTORY_SEARCH_SETTLE_MS,
  useAgentsInventoryView,
} from "../use-agents-inventory-view";

/** The word a user types — long enough that per-keystroke reads are unmistakable. */
const TYPED_TERM = "orchestrator";

/** How long the box sits still after the last character, in the user's hands. */
const PAUSE_AFTER_TYPING_MS = AGENT_INVENTORY_SEARCH_SETTLE_MS * 4;

function makeResult(): AgentComponentPageDataResult {
  return {
    items: [],
    filteredTotal: 0,
    totalPages: 1,
    page: 0,
    facets: { collaborators: [], sources: [], harnesses: [] },
    current: {
      components: 0,
      invocations: 0,
      locPerDollar: null,
      locPerDollarSampleSize: 0,
      collaborators: 0,
      hasVerifiableLocPerDollar: false,
      invocationsExact: true,
      invocationsPluginCoverage: [],
    },
  };
}

/**
 * A source that records the search term of every bounded read it is asked for.
 *
 * The terms, not just the count, so a failure says WHICH reads were issued —
 * "one per prefix" is a different bug from "one per render".
 */
function recordingSource(searches: string[]): AgentComponentsDataSource {
  return {
    scope: "agent-components:test",
    honorsDateWindow: false,
    list: () => Promise.resolve({ items: [], total: 0 }),
    detail: () => Promise.reject(new Error("not used")),
    pageData: (request: AgentComponentPageDataRequest) => {
      searches.push(request.filters.search);
      return Promise.resolve(makeResult());
    },
  };
}

function wrapperFor(dataSource: AgentComponentsDataSource) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AppCoreStoryProviders>
        <AgentComponentsDataSourceProvider dataSource={dataSource}>
          {children}
        </AgentComponentsDataSourceProvider>
      </AppCoreStoryProviders>
    );
  };
}

function renderInventoryView(
  dataSource: AgentComponentsDataSource,
  boundedPageDataEnabled: boolean
) {
  return renderHook(
    () =>
      useAgentsInventoryView({
        supportsDateWindow: false,
        isViewReady: true,
        sortKey: AgentComponentSortKey.Name,
        sortDir: AgentComponentSortDir.Asc,
        pageSize: 50,
        initialFilters: DEFAULT_AGENT_COMPONENT_FILTERS,
        honestSourceEnabled: false,
        dedupePluginRollups: false,
        boundedPageDataEnabled,
      }),
    { wrapper: wrapperFor(dataSource) }
  );
}

describe("useAgentsInventoryView search settling (ISS-6822)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-16T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues a bounded number of reads while a word is typed, not one per character", async () => {
    const searches: string[] = [];
    const { result } = renderInventoryView(recordingSource(searches), true);

    await waitFor(() => expect(searches.length).toBeGreaterThan(0));
    const beforeTyping = searches.length;

    // Type the word one character at a time, with no pause between keystrokes —
    // the cadence that produced one read per character.
    for (let index = 1; index <= TYPED_TERM.length; index += 1) {
      const prefix = TYPED_TERM.slice(0, index);
      act(() => {
        result.current.handleFiltersChange({
          ...result.current.filters,
          search: prefix,
        });
      });
    }

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAUSE_AFTER_TYPING_MS);
    });
    await waitFor(() => expect(searches.at(-1)).toBe(TYPED_TERM));

    // The settle admits the leading edge plus the final term; the eleven
    // intermediate prefixes never reach the producer. Asserted as a bound rather
    // than an exact count so an extra render cannot make this brittle, but the
    // bound is far below the 12 an undamped box issues.
    const typingReads = searches.length - beforeTyping;
    expect(typingReads).toBeLessThanOrEqual(3);
    // The box still ends up asking the question the user actually typed.
    expect(searches.at(-1)).toBe(TYPED_TERM);
    // …and it never asked most of the prefixes in between.
    expect(searches).not.toContain("orchestrato");
    expect(searches).not.toContain("orchestrat");
    expect(searches).not.toContain("orchestra");
  });

  it("does not settle the LEGACY branch, where the narrowing costs no read", () => {
    // The other half of the gate. With the bounded read off, `useSettledValue` is
    // passed `0` and returns the term verbatim, so the in-memory filter still
    // reacts on the keystroke rather than a settle later. Without this, a change
    // that settled unconditionally would look identical to the case above.
    const searches: string[] = [];
    const { result } = renderInventoryView(recordingSource(searches), false);

    act(() => {
      result.current.handleFiltersChange({
        ...result.current.filters,
        search: "orc",
      });
    });

    // Applied to the live filter state immediately — no timer advance.
    expect(result.current.filters.search).toBe("orc");
    // And the legacy branch issued no bounded read at all.
    expect(searches).toEqual([]);
  });

  it("keeps the facet narrowing immediate — only the search term settles", async () => {
    // A facet is a discrete click, not a keystroke, so delaying it would be felt
    // as lag for no saved read. This fails if the settle is applied to the whole
    // filters object instead of to `search`.
    const searches: string[] = [];
    const { result } = renderInventoryView(recordingSource(searches), true);

    await waitFor(() => expect(searches.length).toBeGreaterThan(0));
    const beforeClick = searches.length;

    act(() => {
      result.current.handleFiltersChange({
        ...result.current.filters,
        harnesses: [],
        collaborators: ["Ada"],
      });
    });

    // No timer advance: the read must already have been issued.
    await waitFor(() => expect(searches.length).toBeGreaterThan(beforeClick));
  });
});
