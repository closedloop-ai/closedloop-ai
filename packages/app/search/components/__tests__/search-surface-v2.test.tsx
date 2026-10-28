/**
 * ISS-9414 AC2 and AC3 — the state ladder, and the keyboard contract in each
 * mode.
 *
 * AC2 is the false-green home for this ticket: three of the five states render
 * "nothing to show" and an assertion satisfied by the wrong one proves nothing.
 * So every state case asserts its own copy AND the absence of the two it is
 * confusable with, and every absence has a sibling that positively asserts the
 * same locator. Both MODES get that treatment, because the palette is the shell
 * where the distinctions did not previously exist at all.
 */
import {
  Command,
  CommandInput,
  CommandList,
} from "@repo/design-system/components/ui/command";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FileTextIcon } from "lucide-react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigateMock = vi.hoisted(() => vi.fn());

// The navigation port, standing in for each shell's adapter. Which PREFIX a
// shell adds is the both-host contract's business; that a row NAVIGATES at all
// is this file's.
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
vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: navigateMock }),
}));

import type { SearchSurfaceResult } from "../../lib/search-surface-model";
import { SearchSurfaceV2 } from "../search-surface-v2";
import {
  type SearchSurfaceMode,
  SearchSurfaceModeKind,
} from "../search-surface-v2-props";

beforeEach(() => {
  navigateMock.mockReset();
});

const FIRST: SearchSurfaceResult = {
  key: "first",
  kindLabel: "Plan",
  title: "First result",
  snippet: "the <b>first</b> context",
  destination: "/plns/first",
  meta: "Updated 4 Sep 2026",
  icon: FileTextIcon,
};

const SECOND: SearchSurfaceResult = {
  key: "second",
  kindLabel: "Session",
  title: "Second result",
  snippet: "the <b>second</b> context",
  destination: "/sessions/second",
  icon: FileTextIcon,
};

const PAGE_MODE: SearchSurfaceMode = {
  kind: SearchSurfaceModeKind.Page,
  onRunExample: () => undefined,
};

const OVERLAY_MODE: SearchSurfaceMode = {
  kind: SearchSurfaceModeKind.Overlay,
  groupHeading: "Docs",
  notRunPrompt: "Type to search the documentation.",
};

/** A read with every axis stated, so a test only overrides what it is about. */
function read(
  overrides: Partial<{
    hasRun: boolean;
    isLoading: boolean;
    isUnavailable: boolean;
    unavailableReason: string | null;
    resultCount: number;
  }> = {}
) {
  return {
    hasRun: true,
    isLoading: false,
    isUnavailable: false,
    unavailableReason: null,
    resultCount: 0,
    ...overrides,
  };
}

function renderPage(
  props: Partial<Parameters<typeof SearchSurfaceV2>[0]> = {}
) {
  const onActivateResult = vi.fn();
  const onRetry = vi.fn();
  render(
    <SearchSurfaceV2
      mode={PAGE_MODE}
      onActivateResult={onActivateResult}
      onRetry={onRetry}
      query="alpha"
      read={read()}
      results={[]}
      {...props}
    />
  );
  return { onActivateResult, onRetry };
}

function renderOverlay(
  props: Partial<Parameters<typeof SearchSurfaceV2>[0]> = {}
) {
  const onActivateResult = vi.fn();
  const onRetry = vi.fn();
  render(
    <Command shouldFilter={false}>
      <CommandInput placeholder="Search documentation…" />
      <CommandList>
        <SearchSurfaceV2
          mode={OVERLAY_MODE}
          onActivateResult={onActivateResult}
          onRetry={onRetry}
          query="alpha"
          read={read()}
          results={[]}
          {...props}
        />
      </CommandList>
    </Command>
  );
  return { onActivateResult, onRetry };
}

/** The claims AC2 forbids collapsing, as the copy each one renders. */
const NOT_RUN_PAGE = "Search everything";
const NOT_RUN_OVERLAY = "Type to search the documentation.";
const NO_RESULTS = "No results";
const UNAVAILABLE = "Couldn't load results";
const REJECTED_QUERY = "Couldn't run that query";
const RETRY = "Try again";
/** The no-results copy must echo the QUERY, not just say "no results". */
const RE_QUERY_ECHO = /Nothing matched “alpha”/;
const RE_OVERLAY_REJECTED =
  /Couldn't run that query: Unknown priority value: huge/;

const RE_NOTHING_MATCHED = /Nothing matched/;
const RE_REMOVING_A_FILTER = /removing a filter/;

describe("SearchSurfaceV2 page state ladder (AC2)", () => {
  it("says the query has not run — and does NOT say the corpus is empty or broken", () => {
    // The exact shape that produced the defect: zero results, because nothing
    // was asked. A surface that reads `resultCount` first renders "No results".
    renderPage({ read: read({ hasRun: false, resultCount: 0 }) });

    expect(screen.getByText(NOT_RUN_PAGE)).toBeInTheDocument();
    expect(screen.queryByText(NO_RESULTS)).not.toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE)).not.toBeInTheDocument();
  });

  it("says the corpus answered with nothing — and does NOT offer the on-ramp or claim a failure", () => {
    renderPage({ read: read({ hasRun: true, resultCount: 0 }) });

    expect(screen.getByText(NO_RESULTS)).toBeInTheDocument();
    expect(screen.getByText(RE_QUERY_ECHO)).toBeInTheDocument();
    expect(screen.queryByText(NOT_RUN_PAGE)).not.toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE)).not.toBeInTheDocument();
  });

  it("says the read failed, with a retry — and does NOT claim the corpus is empty", () => {
    renderPage({
      read: read({ hasRun: true, isUnavailable: true, resultCount: 0 }),
    });

    expect(screen.getByText(UNAVAILABLE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: RETRY })).toBeInTheDocument();
    expect(screen.queryByText(NO_RESULTS)).not.toBeInTheDocument();
    expect(screen.queryByText(NOT_RUN_PAGE)).not.toBeInTheDocument();
  });

  it("names a rejected query with the server's own reason and offers NO retry", () => {
    // The malformed-filter 400. Retrying an unchanged bad query cannot fix it,
    // so the affordance the transport failure gets is withheld here.
    renderPage({
      read: read({
        hasRun: true,
        isUnavailable: true,
        unavailableReason: "Unknown priority value: huge",
        resultCount: 0,
      }),
    });

    expect(screen.getByText(REJECTED_QUERY)).toBeInTheDocument();
    expect(
      screen.getByText("Unknown priority value: huge")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RETRY })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE)).not.toBeInTheDocument();
  });

  it("shows progress while a retry is in flight rather than freezing on the failure", () => {
    // `isUnavailable` is still latched from the failed attempt; the in-flight
    // read outranks it, or the retry button sits under its own spinner.
    renderPage({
      read: read({
        hasRun: true,
        isLoading: true,
        isUnavailable: true,
        resultCount: 0,
      }),
    });

    expect(screen.getByLabelText("Searching…")).toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE)).not.toBeInTheDocument();
    expect(screen.queryByText(NO_RESULTS)).not.toBeInTheDocument();
  });

  it("keeps an unasked query unasked even while the host reports loading AND failure", () => {
    // `NotRun` outranks everything: a query nobody issued cannot be in flight
    // and cannot have failed. Both stale axes are set at once, so neither
    // precedence edge can pass on the other's account.
    renderPage({
      read: read({
        hasRun: false,
        isLoading: true,
        isUnavailable: true,
        resultCount: 0,
      }),
    });

    expect(screen.getByText(NOT_RUN_PAGE)).toBeInTheDocument();
    expect(screen.queryByLabelText("Searching…")).not.toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE)).not.toBeInTheDocument();
  });

  it("runs the retry the host wired", () => {
    const { onRetry } = renderPage({
      read: read({ hasRun: true, isUnavailable: true, resultCount: 0 }),
    });

    fireEvent.click(screen.getByRole("button", { name: RETRY }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("SearchSurfaceV2 overlay state ladder (AC2)", () => {
  // The palette is the shell where these distinctions are NEW: before ISS-9414
  // a rejected docs IPC and an empty corpus were the same `hits: []`.
  it("prompts for a query — and does NOT claim the corpus is empty or broken", () => {
    renderOverlay({ read: read({ hasRun: false, resultCount: 0 }) });

    expect(screen.getByText(NOT_RUN_OVERLAY)).toBeInTheDocument();
    expect(screen.queryByText(NO_RESULTS)).not.toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE)).not.toBeInTheDocument();
  });

  /**
   * marisolashgrove review: the empty body suggested "removing a filter" in BOTH
   * modes, and the palette has no filter to remove — a next move the reader
   * cannot make.
   */
  it("does not tell a palette reader to remove a filter it does not have", () => {
    renderOverlay({ read: read({ hasRun: true, resultCount: 0 }) });

    expect(screen.getByText(RE_NOTHING_MATCHED)).toBeTruthy();
    expect(screen.queryByText(RE_REMOVING_A_FILTER)).toBeNull();
  });

  it("says the corpus answered with nothing, echoing the query", () => {
    renderOverlay({ read: read({ hasRun: true, resultCount: 0 }) });

    expect(screen.getByText(NO_RESULTS)).toBeInTheDocument();
    expect(screen.getByText(RE_QUERY_ECHO)).toBeInTheDocument();
    expect(screen.queryByText(NOT_RUN_OVERLAY)).not.toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE)).not.toBeInTheDocument();
  });

  it("says the docs index could not answer, and offers a retry the palette's own keys reach", async () => {
    const { onRetry } = renderOverlay({
      read: read({ hasRun: true, isUnavailable: true, resultCount: 0 }),
    });

    expect(screen.getByText(UNAVAILABLE)).toBeInTheDocument();
    expect(screen.queryByText(NO_RESULTS)).not.toBeInTheDocument();

    // REACHABLE, not merely present: a loose button inside a cmdk listbox is
    // invisible to the arrow keys the palette is actually driven by.
    const palette = document.querySelector("[cmdk-root]");
    await waitFor(() => {
      expect(selectedRowText()).toContain(RETRY);
    });
    fireEvent.keyDown(palette as Element, { key: "Enter" });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("names a rejected query with the server's reason and offers NO retry", () => {
    renderOverlay({
      read: read({
        hasRun: true,
        isUnavailable: true,
        unavailableReason: "Unknown priority value: huge",
        resultCount: 0,
      }),
    });

    expect(screen.getByText(RE_OVERLAY_REJECTED)).toBeInTheDocument();
    expect(screen.queryByText(RETRY)).not.toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE)).not.toBeInTheDocument();
  });
});

describe("SearchSurfaceV2 keyboard and focus (AC3)", () => {
  it("puts page rows in the tab order, in rank order, each linking to its destination", () => {
    renderPage({
      read: read({ resultCount: 2 }),
      results: [FIRST, SECOND],
    });

    const rows = screen.getAllByRole("link");
    expect(rows.map((row) => row.getAttribute("href"))).toEqual([
      "/acme/plns/first",
      "/acme/sessions/second",
    ]);
    // Reachable by Tab: a page has no roving selection, so the rows ARE the
    // keyboard contract. The overlay sibling below asserts the opposite on the
    // same attribute, so neither reading is trivially satisfied.
    for (const row of rows) {
      expect(row).not.toHaveAttribute("tabindex", "-1");
    }
    rows[0]?.focus();
    expect(document.activeElement).toBe(rows[0]);
  });

  it("activates a page row on click, so a hosting container can dismiss itself", () => {
    const { onActivateResult } = renderPage({
      read: read({ resultCount: 2 }),
      results: [FIRST, SECOND],
    });

    fireEvent.click(screen.getByText(SECOND.title));

    expect(onActivateResult).toHaveBeenCalledWith(SECOND);
  });

  it("navigates to the selected row's destination when the palette's Enter fires", async () => {
    // THE ASSERTION IS THE DESTINATION, not the dismiss callback. cmdk handles
    // Enter by preventing the default and dispatching a private event on the
    // OPTION, which never reaches a descendant anchor — so a row carrying only
    // an href would close the palette and navigate nowhere, and a test watching
    // `onActivateResult` alone would stay green through exactly that.
    const { onActivateResult } = renderOverlay({
      read: read({ resultCount: 2 }),
      results: [FIRST, SECOND],
    });
    const palette = document.querySelector("[cmdk-root]");
    expect(palette).not.toBeNull();

    await waitFor(() => {
      expect(selectedRowText()).toContain(FIRST.title);
    });

    fireEvent.keyDown(palette as Element, { key: "ArrowDown" });
    await waitFor(() => {
      expect(selectedRowText()).toContain(SECOND.title);
    });

    fireEvent.keyDown(palette as Element, { key: "Enter" });
    expect(navigateMock).toHaveBeenCalledWith("/acme/sessions/second");
    expect(onActivateResult).toHaveBeenLastCalledWith(SECOND);
  });

  it("navigates exactly once when a palette row is clicked", () => {
    // The mouse path belongs to the anchor; the option must not navigate a
    // second time off the same click.
    const { onActivateResult } = renderOverlay({
      read: read({ resultCount: 2 }),
      results: [FIRST, SECOND],
    });

    fireEvent.click(screen.getByText(SECOND.title));

    expect(onActivateResult).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  /**
   * davetho review: the dismiss ran before `Link` decided whether the browser
   * should take the click, so Cmd/Ctrl/Shift/Alt and middle clicks opened the
   * real href AND closed the palette, clearing the query behind it — against the
   * row's own promise of modifier/middle-click support.
   */
  it.each([
    ["meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
    ["middle-button", { button: 1 }],
  ])("leaves the palette open on a %s click", (_name, modifier) => {
    const { onActivateResult } = renderOverlay({
      read: read({ resultCount: 2 }),
      results: [FIRST, SECOND],
    });

    fireEvent.click(screen.getByText(SECOND.title), modifier);

    expect(onActivateResult).not.toHaveBeenCalled();
    // Still not the option's job either — the anchor keeps the click.
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("keeps overlay rows out of the tab order so focus stays on the palette input", () => {
    // The counterpart of the page assertion above: a focusable anchor inside a
    // cmdk list lets Tab walk the selection and the focus ring apart.
    renderOverlay({
      read: read({ resultCount: 2 }),
      results: [FIRST, SECOND],
    });

    for (const row of screen.getAllByRole("link")) {
      expect(row).toHaveAttribute("tabindex", "-1");
    }
  });
});

describe("SearchSurfaceV2 rows", () => {
  it("renders a result with no safe route as a plain row, never a dead link", () => {
    renderPage({
      read: read({ resultCount: 2 }),
      results: [{ ...FIRST, destination: null }, SECOND],
    });

    // One link, not two: the routeless result is present as text and absent as
    // a link, and the sibling result proves the list still links what it can.
    expect(screen.getByText(FIRST.title)).toBeInTheDocument();
    expect(
      screen.getAllByRole("link").map((row) => row.getAttribute("href"))
    ).toEqual(["/acme/sessions/second"]);
  });
});

/** The palette row cmdk currently has selected, by its text. */
function selectedRowText(): string {
  return document.querySelector('[aria-selected="true"]')?.textContent ?? "";
}
