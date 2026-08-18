import type { SearchHit } from "@repo/api/src/types/search";
import { SearchMode } from "@repo/api/src/types/search";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { navigate, mockUseUnifiedSearch, mockUseSearchIntellisense } =
  vi.hoisted(() => ({
    navigate: vi.fn(),
    mockUseUnifiedSearch: vi.fn(),
    mockUseSearchIntellisense: vi.fn(),
  }));

/** A closed intellisense view, the default, so FTS behavior is unchanged. */
function closedIntellisense() {
  return {
    isOpen: false,
    mode: "free-text" as const,
    rows: [],
    isLoading: false,
    isError: false,
    commitRow: vi.fn(),
  };
}

// Mock the navigation ports so no NavigationProvider is required in the test.
vi.mock("@repo/navigation/link", () => ({
  Link: ({
    children,
    href,
    onClick,
  }: {
    children: React.ReactNode;
    href: string;
    onClick?: () => void;
  }) => (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  ),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate, replace: vi.fn(), back: vi.fn() }),
}));

vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (orgRelativePath: string) => `/acme${orgRelativePath}`,
}));

vi.mock("@repo/app/search/hooks/use-search", () => ({
  useUnifiedSearch: (params: unknown, options?: { enabled?: boolean }) =>
    mockUseUnifiedSearch(params, options),
}));

// The intellisense controller is unit-tested separately; here it is mocked so
// each case controls whether the structured overlay or the FTS dropdown shows.
vi.mock("../../hooks/use-search-intellisense", () => ({
  useSearchIntellisense: (raw: string, caret: number) =>
    mockUseSearchIntellisense(raw, caret),
}));

import { SearchTypeahead } from "../search-typeahead";

const RE_ALPHA_LOOP = /Alpha loop/;
const RE_STATUS = /Status/;
const RE_ALPHA_PRD = /Alpha PRD/;

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    entityType: SearchEntityType.Loop,
    entityId: "loop-1",
    title: "Alpha loop",
    snippet: "run the <b>alpha</b> loop",
    rank: 0.5,
    updatedAt: new Date("2026-01-01"),
    deepLink: "/loops/loop-1",
    ...overrides,
  };
}

// SearchTypeahead is controlled, so drive it through a stateful host that mirrors
// the real sidebar adapter: typing updates `value`, which re-opens the dropdown.
function Harness({ onSelectHit }: { onSelectHit?: (h: SearchHit) => void }) {
  const [value, setValue] = useState("");
  return (
    <SearchTypeahead
      onClear={() => setValue("")}
      onSelectHit={onSelectHit}
      onSubmit={() => {
        /* noop */
      }}
      onValueChange={setValue}
      showClear={value.length > 0}
      value={value}
    />
  );
}

describe("SearchTypeahead", () => {
  beforeEach(() => {
    navigate.mockReset();
    mockUseUnifiedSearch.mockReset();
    mockUseSearchIntellisense.mockReset();
    // Default: intellisense closed, so the existing FTS-suggestion cases render
    // the free-text dropdown as before.
    mockUseSearchIntellisense.mockReturnValue(closedIntellisense());
  });

  it("does not fire the search query until the input is focused/typed", () => {
    mockUseUnifiedSearch.mockReturnValue({ data: undefined, isLoading: false });

    render(<Harness />);

    // Rendered idle (no interaction) → the query must be disabled so an unseen
    // dropdown never issues an FTS request.
    expect(mockUseUnifiedSearch).toHaveBeenCalled();
    const [, options] = mockUseUnifiedSearch.mock.calls.at(-1) ?? [];
    expect(options).toEqual({ enabled: false });
  });

  it("opens the dropdown with a chip, snippet and deep link per suggestion", async () => {
    const user = userEvent.setup();
    mockUseUnifiedSearch.mockReturnValue({
      data: {
        query: "al",
        mode: SearchMode.Prefix,
        results: [hit()],
        nextCursor: null,
      },
      isLoading: false,
    });

    render(<Harness />);
    await user.type(screen.getByLabelText("Search"), "al");

    // Type chip + highlighted snippet + org-scoped deep link.
    expect(screen.getByText("Loop")).toBeInTheDocument();
    expect(screen.getByText("alpha").tagName).toBe("MARK");
    expect(
      screen.getByRole("option", { name: RE_ALPHA_LOOP }).querySelector("a")
    ).toHaveAttribute("href", "/acme/loops/loop-1");
  });

  it("enables the query once focused past the 2-char threshold", async () => {
    const user = userEvent.setup();
    mockUseUnifiedSearch.mockReturnValue({
      data: {
        query: "al",
        mode: SearchMode.Prefix,
        results: [],
        nextCursor: null,
      },
      isLoading: false,
    });

    render(<Harness />);
    await user.type(screen.getByLabelText("Search"), "al");

    const [, options] = mockUseUnifiedSearch.mock.calls.at(-1) ?? [];
    expect(options).toEqual({ enabled: true });
  });

  it("shows the loading spinner while suggestions are fetching", async () => {
    const user = userEvent.setup();
    mockUseUnifiedSearch.mockReturnValue({ data: undefined, isLoading: true });

    render(<Harness />);
    await user.type(screen.getByLabelText("Search"), "al");

    expect(screen.getByLabelText("Loading suggestions")).toBeInTheDocument();
  });

  it("shows an empty state when there are no matches", async () => {
    const user = userEvent.setup();
    mockUseUnifiedSearch.mockReturnValue({
      data: {
        query: "zz",
        mode: SearchMode.Prefix,
        results: [],
        nextCursor: null,
      },
      isLoading: false,
    });

    render(<Harness />);
    await user.type(screen.getByLabelText("Search"), "zz");

    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("renders a non-routable hit (Document/Project) as a plain row, not a link", async () => {
    const user = userEvent.setup();
    mockUseUnifiedSearch.mockReturnValue({
      data: {
        query: "al",
        mode: SearchMode.Prefix,
        results: [
          hit({
            entityType: SearchEntityType.Document,
            entityId: "doc-1",
            title: "Alpha PRD",
            deepLink: "/documents/doc-1",
          }),
        ],
        nextCursor: null,
      },
      isLoading: false,
    });

    render(<Harness />);
    await user.type(screen.getByLabelText("Search"), "al");

    // The Document deep link can 404 today, so the option must NOT be a link.
    const option = screen.getByRole("option", { name: RE_ALPHA_PRD });
    expect(option.querySelector("a")).toBeNull();
    expect(screen.queryByRole("link", { name: RE_ALPHA_PRD })).toBeNull();
  });

  it("does not navigate on Enter for a highlighted non-routable hit", async () => {
    const user = userEvent.setup();
    mockUseUnifiedSearch.mockReturnValue({
      data: {
        query: "al",
        mode: SearchMode.Prefix,
        results: [
          hit({
            entityType: SearchEntityType.Document,
            entityId: "doc-1",
            title: "Alpha PRD",
            deepLink: "/documents/doc-1",
          }),
        ],
        nextCursor: null,
      },
      isLoading: false,
    });

    render(<Harness />);
    const input = screen.getByLabelText("Search");
    await user.type(input, "al");
    // Highlight the first suggestion, then commit with Enter.
    await user.keyboard("{ArrowDown}{Enter}");

    // A non-routable hit falls through to the native submit instead of routing
    // to a dead link.
    expect(navigate).not.toHaveBeenCalled();
  });

  it("closes the dropdown when focus leaves the typeahead entirely", async () => {
    const user = userEvent.setup();
    mockUseUnifiedSearch.mockReturnValue({
      data: {
        query: "al",
        mode: SearchMode.Prefix,
        results: [hit()],
        nextCursor: null,
      },
      isLoading: false,
    });

    render(
      <div>
        <Harness />
        <button type="button">Outside</button>
      </div>
    );
    await user.type(screen.getByLabelText("Search"), "al");
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    // Tabbing focus out to an element outside the typeahead must close it, not
    // leave the dropdown stuck open.
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("fires onSelectHit and closes the dropdown when a suggestion is clicked", async () => {
    const user = userEvent.setup();
    const onSelectHit = vi.fn();
    mockUseUnifiedSearch.mockReturnValue({
      data: {
        query: "al",
        mode: SearchMode.Prefix,
        results: [hit()],
        nextCursor: null,
      },
      isLoading: false,
    });

    render(<Harness onSelectHit={onSelectHit} />);
    await user.type(screen.getByLabelText("Search"), "al");

    // The row's interactivity is the inner Link (the option li is not itself
    // clickable), so click the link to commit the suggestion.
    await user.click(screen.getByRole("link", { name: RE_ALPHA_LOOP }));

    expect(onSelectHit).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "loop-1" })
    );
    // Selecting closes the dropdown, so the listbox is gone.
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("renders the intellisense filter-key surface instead of the FTS dropdown", async () => {
    const user = userEvent.setup();
    mockUseUnifiedSearch.mockReturnValue({ data: undefined, isLoading: false });
    // The intellisense controller reports the filter-keys surface for the typed
    // `stat` token; the structured overlay takes the popup slot.
    mockUseSearchIntellisense.mockReturnValue({
      ...closedIntellisense(),
      isOpen: true,
      mode: "filter-keys",
      rows: [
        {
          kind: "key",
          suggestion: {
            meta: { key: "status", label: "Status", operators: ["=", "!="] },
            operators: ["=", "!="],
          },
        },
      ],
    });

    render(<Harness />);
    await user.type(screen.getByLabelText("Search"), "stat");

    // The structured option renders (a key row), and the FTS query stayed
    // disabled because the intellisense overlay owns the popup.
    expect(screen.getByRole("option", { name: RE_STATUS })).toBeInTheDocument();
    const [, options] = mockUseUnifiedSearch.mock.calls.at(-1) ?? [];
    expect(options).toEqual({ enabled: false });
  });

  it("commits the highlighted intellisense row on ArrowDown + Enter", async () => {
    const user = userEvent.setup();
    const commitRow = vi.fn().mockReturnValue({ text: "status:", caret: 7 });
    mockUseUnifiedSearch.mockReturnValue({ data: undefined, isLoading: false });
    mockUseSearchIntellisense.mockReturnValue({
      ...closedIntellisense(),
      isOpen: true,
      mode: "filter-keys",
      rows: [
        {
          kind: "key",
          suggestion: {
            meta: { key: "status", label: "Status", operators: ["="] },
            operators: ["="],
          },
        },
      ],
      commitRow,
    });

    render(<Harness />);
    const input = screen.getByLabelText("Search");
    await user.type(input, "stat");
    await user.keyboard("{ArrowDown}{Enter}");

    // Enter on the highlighted row commits it (rewrites the token), not a submit.
    expect(commitRow).toHaveBeenCalledWith(0);
  });

  it("surfaces the members loading state while the `@` source resolves", async () => {
    const user = userEvent.setup();
    mockUseUnifiedSearch.mockReturnValue({ data: undefined, isLoading: false });
    mockUseSearchIntellisense.mockReturnValue({
      ...closedIntellisense(),
      isOpen: true,
      mode: "members",
      rows: [],
      isLoading: true,
    });

    render(<Harness />);
    await user.type(screen.getByLabelText("Search"), "@al");

    expect(screen.getByLabelText("Loading suggestions")).toBeInTheDocument();
  });
});
