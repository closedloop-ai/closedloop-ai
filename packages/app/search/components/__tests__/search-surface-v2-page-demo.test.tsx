import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/document";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { parseSearchQuery } from "@repo/api/src/types/search-query";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SearchSurfaceV2PageDemo } from "../search-surface-v2-page-demo";
import {
  matchesSearchDemoQuery,
  SEARCH_DEMO_HITS,
  type SearchDemoHit,
} from "../search-surface-v2-page-demo-fixtures";

const QUERY_INPUT = "Search query";
const NO_MATCH_QUERY = "zzzz";
const ON_RAMP_EXAMPLE = "priority>=HIGH status:BLOCKED";
const MALFORMED_FILTER_QUERY = "agent status:huge";
// Not imported from a constant on purpose: the message under test is the
// canonical parser's own wire text (the search route 400s with
// `parsed.errors[0].message`), so building the expectation from our own source
// would agree with our own mistake.
const RE_PARSER_FILTER_ERROR = /Unknown status value: huge/;
const RE_COUNT_STRIP = /results for/;
const RE_TYPE_TRIGGER = /Filter by type/;

// `toHaveTextContent` matches a SUBSTRING, so an unanchored `4 results for`
// is satisfied by the un-narrowed `14 results for` — the exact mutation these
// assertions exist to catch. Anchor the count at the start of the sentence.
function countStripRe(count: number): RegExp {
  return new RegExp(`^${count} results for`);
}

/** The `N+` shape, for a host that still has a cursor and cannot know the total. */
function tooManyCountStripRe(count: number): RegExp {
  return new RegExp(`^${count}\\+ results for`);
}

function matchCount(query: string): number {
  const parsed = parseSearchQuery(query);
  return SEARCH_DEMO_HITS.filter((hit) => matchesSearchDemoQuery(hit, parsed))
    .length;
}

// The prototype route mounts this demo inside `PrototypeShell`, which owns the
// same mock-only memory adapter; the rows' `useOrgPath` needs one either way.
function renderDemo() {
  return render(
    <NavigationProvider
      adapter={
        createMemoryNavigation({ initialPath: "/search", orgSlug: "acme" })
          .adapter
      }
    >
      <SearchSurfaceV2PageDemo />
    </NavigationProvider>
  );
}

function hit(overrides: Partial<SearchDemoHit>): SearchDemoHit {
  return {
    destination: null,
    entityType: SearchEntityType.Document,
    icon: SEARCH_DEMO_HITS[0].icon,
    key: "document:fixture",
    kindLabel: "Document",
    meta: "Updated now",
    priority: Priority.High,
    snippet: "A <b>fixture</b> snippet",
    status: IssueStatus.Blocked,
    title: "Fixture document",
    ...overrides,
  };
}

describe("matchesSearchDemoQuery (ISS-10345)", () => {
  it("narrows on free text, so a query that matches nothing returns nothing", () => {
    expect(matchCount("agent")).toBe(SEARCH_DEMO_HITS.length);
    expect(matchCount(NO_MATCH_QUERY)).toBe(0);
  });

  it("narrows the on-ramp's status+priority example instead of showing the corpus", () => {
    const count = matchCount(ON_RAMP_EXAMPLE);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(SEARCH_DEMO_HITS.length);
  });

  it("evaluates status equality and negation against the hit's own status", () => {
    const parsedEq = parseSearchQuery("status:BLOCKED");
    const parsedNeq = parseSearchQuery("status!=BLOCKED");
    const blocked = hit({ status: IssueStatus.Blocked });
    const done = hit({ status: IssueStatus.Done });

    expect(matchesSearchDemoQuery(blocked, parsedEq)).toBe(true);
    expect(matchesSearchDemoQuery(done, parsedEq)).toBe(false);
    expect(matchesSearchDemoQuery(blocked, parsedNeq)).toBe(false);
    expect(matchesSearchDemoQuery(done, parsedNeq)).toBe(true);
  });

  it("orders priority by ordinal, and excludes an unset priority from every comparison", () => {
    const parsed = parseSearchQuery("priority>=HIGH");
    expect(
      matchesSearchDemoQuery(hit({ priority: Priority.Urgent }), parsed)
    ).toBe(true);
    expect(
      matchesSearchDemoQuery(hit({ priority: Priority.High }), parsed)
    ).toBe(true);
    expect(
      matchesSearchDemoQuery(hit({ priority: Priority.Low }), parsed)
    ).toBe(false);
    expect(matchesSearchDemoQuery(hit({ priority: null }), parsed)).toBe(false);
  });

  it("answers priority:none on the unset arm rather than ordinal-comparing it", () => {
    const parsed = parseSearchQuery("priority:none");
    expect(matchesSearchDemoQuery(hit({ priority: null }), parsed)).toBe(true);
    expect(
      matchesSearchDemoQuery(hit({ priority: Priority.Low }), parsed)
    ).toBe(false);
  });

  it("ANDs the type filter with the rest", () => {
    const parsed = parseSearchQuery("type:branch");
    expect(
      matchesSearchDemoQuery(
        hit({ entityType: SearchEntityType.Branch }),
        parsed
      )
    ).toBe(true);
    expect(
      matchesSearchDemoQuery(
        hit({ entityType: SearchEntityType.Document }),
        parsed
      )
    ).toBe(false);
  });
});

describe("SearchSurfaceV2PageDemo (ISS-10345)", () => {
  it("renders the shared count strip for the committed query, never a fabricated total", async () => {
    renderDemo();
    const strip = await screen.findByText(RE_COUNT_STRIP, { selector: "p" });
    expect(strip).toHaveTextContent(countStripRe(SEARCH_DEMO_HITS.length));
    expect(strip).toHaveTextContent('"agent"');
    expect(
      screen.getByRole("button", { name: "Clear search" })
    ).toBeInTheDocument();
  });

  it("commits on Enter and offers no submit affordance the real page does not have", async () => {
    const user = userEvent.setup();
    const { container } = renderDemo();

    // Not `queryByRole("button", { name: "Search" })`: that pins one label, so
    // re-adding the affordance under any other word passes. The bar's contract
    // is that the FORM carries exactly one control — the in-field Clear — and
    // commits on Enter/native submit, as `SearchTypeahead` does on the real
    // page. The Type control is the form's sibling, not inside it.
    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    expect(within(form as HTMLFormElement).getAllByRole("button")).toHaveLength(
      1
    );
    expect(
      within(form as HTMLFormElement).getByRole("button", {
        name: "Clear query",
      })
    ).toBeInTheDocument();

    const input = screen.getByLabelText(QUERY_INPUT);
    await user.clear(input);
    await user.type(input, `${NO_MATCH_QUERY}{Enter}`);

    expect(
      await screen.findByText(RE_COUNT_STRIP, { selector: "p" })
    ).toHaveTextContent(countStripRe(0));
  });

  it("surfaces the canonical parser's filter-error message for a malformed token", async () => {
    const user = userEvent.setup();
    renderDemo();

    const input = screen.getByLabelText(QUERY_INPUT);
    await user.clear(input);
    await user.type(input, `${MALFORMED_FILTER_QUERY}{Enter}`);

    expect(await screen.findByText(RE_PARSER_FILTER_ERROR)).toBeInTheDocument();
    // The strip must not assert a count beside a query that failed.
    expect(screen.queryByText(RE_COUNT_STRIP, { selector: "p" })).toBeNull();
  });

  it("narrows the visible rows when the Type control writes a type: token", async () => {
    const user = userEvent.setup();
    renderDemo();

    const before = await screen.findByText(RE_COUNT_STRIP, { selector: "p" });
    expect(before).toHaveTextContent(countStripRe(SEARCH_DEMO_HITS.length));

    await user.click(screen.getByRole("button", { name: RE_TYPE_TRIGGER }));
    await user.click(await screen.findByRole("button", { name: "Document" }));

    const narrowed = matchCount("agent type:document");
    // More than one, so the strip's singular/plural rule is not what is under
    // test here — the narrowing is.
    expect(narrowed).toBeGreaterThan(1);
    expect(narrowed).toBeLessThan(SEARCH_DEMO_HITS.length);
    expect(
      await screen.findByText(RE_COUNT_STRIP, { selector: "p" })
    ).toHaveTextContent(countStripRe(narrowed));
  });

  it("says N+ in the too-many state, because the host cannot know the total", async () => {
    const user = userEvent.setup();
    renderDemo();

    await user.click(
      screen.getByRole("radio", { name: "Show Too many state" })
    );

    expect(
      await screen.findByText(RE_COUNT_STRIP, { selector: "p" })
    ).toHaveTextContent(tooManyCountStripRe(SEARCH_DEMO_HITS.length));
  });
});
