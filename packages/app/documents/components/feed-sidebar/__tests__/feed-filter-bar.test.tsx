import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Activity, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CommentPermalinkProvider } from "../comment-permalink-context";
import { eraseFeedSource } from "../erase-feed-source";
import { FeedFilterBar } from "../feed-filter-bar";
import { FeedFilterProvider } from "../feed-filter-context";
import { FeedItemKind } from "../feed-item";
import type { AnyFeedSource } from "../feed-source";
import { FeedSourcesProvider } from "../feed-sources-context";
import { FeedRuntime } from "../source-items-registry";

const FILTER_TRIGGER_NAME = "Filter feed by source";
const SORT_OLDEST_LABEL = "Sort oldest first";
const SORT_NEWEST_LABEL = "Sort newest first";
const HIDE_ODD_LABEL = "Hide odd items";

type StubItem = {
  id: string;
  kind: typeof FeedItemKind.PrComment | typeof FeedItemKind.Activity;
  sourceId: string;
  createdAt: Date;
  odd: boolean;
};

type OddFilter = { hideOdd: boolean };

function makeItems(
  sourceId: string,
  kind: StubItem["kind"],
  count: number
): StubItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${sourceId}-${index}`,
    kind,
    sourceId,
    createdAt: new Date("2026-05-18T14:00:00Z"),
    odd: index % 2 === 1,
  }));
}

function OddToggle({
  state,
  onChange,
}: Readonly<{ state: OddFilter; onChange: (next: OddFilter) => void }>) {
  return (
    <button
      aria-pressed={state.hideOdd}
      onClick={() => onChange({ hideOdd: !state.hideOdd })}
      type="button"
    >
      {HIDE_ODD_LABEL}
    </button>
  );
}

function makeSource(
  id: string,
  kind: StubItem["kind"],
  items: readonly StubItem[],
  options: Readonly<{
    defaultFilterState?: OddFilter;
    withFilterControl?: boolean;
  }> = {}
): AnyFeedSource {
  return eraseFeedSource<StubItem, OddFilter>({
    id,
    kind,
    label: `${id} label`,
    Icon: kind === FeedItemKind.Activity ? Activity : MessageSquare,
    useItems: () => ({ items, isLoading: false, isError: false }),
    defaultFilterState: options.defaultFilterState ?? { hideOdd: false },
    applyFilter: (all, state) =>
      state.hideOdd ? all.filter((item) => !item.odd) : all,
    isFiltered: (state) => state.hideOdd,
    FilterControl: options.withFilterControl ? OddToggle : undefined,
    renderItem: () => null,
  });
}

function Harness({
  sources,
  registered = sources,
  withFilterProvider = true,
}: Readonly<{
  sources: readonly AnyFeedSource[];
  registered?: readonly AnyFeedSource[];
  withFilterProvider?: boolean;
}>) {
  const bar: ReactNode = withFilterProvider ? (
    <FeedFilterProvider>
      <FeedFilterBar />
    </FeedFilterProvider>
  ) : (
    <FeedFilterBar />
  );
  return (
    <CommentPermalinkProvider
      buildPermalinkUrl={undefined}
      scrollToThreadId={undefined}
    >
      <FeedSourcesProvider sources={sources}>
        <FeedRuntime fallback={null} sources={registered}>
          {bar}
        </FeedRuntime>
      </FeedSourcesProvider>
    </CommentPermalinkProvider>
  );
}

function filterTrigger() {
  return screen.getByRole("button", { name: FILTER_TRIGGER_NAME });
}

async function chooseKind(
  user: ReturnType<typeof userEvent.setup>,
  label: string
) {
  await user.click(filterTrigger());
  const menu = await screen.findByRole("menu");
  const item = within(menu)
    .getAllByRole("menuitem")
    .find((node) => node.textContent?.startsWith(label));
  if (!item) {
    throw new Error(`menu item ${label} not rendered`);
  }
  await user.click(item);
}

const PR_SOURCE = makeSource(
  "pr",
  FeedItemKind.PrComment,
  makeItems("pr", FeedItemKind.PrComment, 3),
  { withFilterControl: true }
);
const ACTIVITY_SOURCE = makeSource(
  "activity",
  FeedItemKind.Activity,
  makeItems("activity", FeedItemKind.Activity, 2)
);
const BOTH_SOURCES: readonly AnyFeedSource[] = [PR_SOURCE, ACTIVITY_SOURCE];

describe("FeedFilterBar", () => {
  afterEach(() => {
    cleanup();
  });

  it("totals every source's filtered count under All and lists each source's own count", async () => {
    const user = userEvent.setup();
    render(<Harness sources={BOTH_SOURCES} />);

    expect(filterTrigger()).toHaveTextContent("All 5");
    // The trigger keeps its icon (ISS-12919 reaches the menu items only).
    expect(filterTrigger().querySelector("svg")).not.toBeNull();

    await user.click(filterTrigger());
    const items = within(await screen.findByRole("menu")).getAllByRole(
      "menuitem"
    );
    expect(items.map((item) => item.textContent)).toEqual([
      "All5",
      "pr label3",
      "activity label2",
    ]);
    // ISS-12919: filter menu items carry no icons.
    expect(items.every((item) => item.querySelector("svg") === null)).toBe(
      true
    );
  });

  it("counts a source that has not registered its items as zero", () => {
    render(<Harness registered={[ACTIVITY_SOURCE]} sources={BOTH_SOURCES} />);

    expect(filterTrigger()).toHaveTextContent("All 2");
  });

  it("applies each source's default filter state when no filter provider is mounted", () => {
    const hidingSource = makeSource(
      "pr",
      FeedItemKind.PrComment,
      makeItems("pr", FeedItemKind.PrComment, 3),
      { defaultFilterState: { hideOdd: true } }
    );
    render(<Harness sources={[hidingSource]} withFilterProvider={false} />);

    // Items 0 and 2 survive the default `hideOdd` state.
    expect(filterTrigger()).toHaveTextContent("All 2");
    // Outside a provider the active kind is always "All", so no sub-filter.
    expect(screen.queryByRole("button", { name: HIDE_ODD_LABEL })).toBeNull();
  });

  it("narrows to a chosen kind and renders that source's sub-filter, which updates the count", async () => {
    const user = userEvent.setup();
    render(<Harness sources={BOTH_SOURCES} />);

    expect(screen.queryByRole("button", { name: HIDE_ODD_LABEL })).toBeNull();

    await chooseKind(user, "pr label");

    expect(filterTrigger()).toHaveTextContent("pr label 3");
    const toggle = screen.getByRole("button", { name: HIDE_ODD_LABEL });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);

    expect(filterTrigger()).toHaveTextContent("pr label 2");
    expect(
      screen.getByRole("button", { name: HIDE_ODD_LABEL })
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("renders no sub-filter for a chosen kind whose source has none", async () => {
    const user = userEvent.setup();
    render(<Harness sources={BOTH_SOURCES} />);

    await chooseKind(user, "activity label");

    expect(filterTrigger()).toHaveTextContent("activity label 2");
    expect(screen.queryByRole("button", { name: HIDE_ODD_LABEL })).toBeNull();
  });

  it("flips the sort toggle between oldest-first and newest-first", async () => {
    const user = userEvent.setup();
    render(<Harness sources={BOTH_SOURCES} />);

    await user.click(screen.getByRole("button", { name: SORT_OLDEST_LABEL }));
    const newest = screen.getByRole("button", { name: SORT_NEWEST_LABEL });
    expect(
      screen.queryByRole("button", { name: SORT_OLDEST_LABEL })
    ).toBeNull();

    await user.click(newest);
    expect(
      screen.getByRole("button", { name: SORT_OLDEST_LABEL })
    ).toBeInTheDocument();
  });
});
