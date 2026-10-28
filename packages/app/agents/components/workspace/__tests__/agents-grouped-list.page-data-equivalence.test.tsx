import {
  AGENT_COMPONENT_INVENTORY_CAP,
  type AgentComponent,
  AgentComponentKind,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { reduceAgentComponentPageData } from "@repo/api/src/utils/agent-component-page-data";
import { makeComponent } from "@repo/app/agents/components/workspace/agent-component-fixtures";
import {
  AGENTS_BOUNDED_PAGE_DATA_FEATURE_FLAG_KEY,
  AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY,
  AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { AgentsGroupedList } from "../agents-grouped-list";

/**
 * ISS-6822 — the BOUNDED page-data read must render exactly what the three
 * full-population reads render.
 *
 * The ticket's acceptance is exactness, not speed: a version of this that is
 * faster and quietly changes a count has failed. So this suite renders the REAL
 * `AgentsGroupedList` twice against the SAME corpus — once on the legacy path
 * (three `list` calls, reduced in the renderer) and once on the bounded path
 * (one `pageData` call, reduced at the producer) — and compares what the user
 * actually sees: every row on the page, the summary card values and their delta
 * chips, the pager, and the filter menu's option counts.
 *
 * Three properties of the fixture are load-bearing, and dropping any one of them
 * turns this into a test that passes with or without the change:
 *
 *  1. **The corpus CROSSES the 5,000-row inventory cap.** A corpus under the cap
 *     never exercises truncation, which is the one place a reduction moved
 *     across a process boundary can silently see a different population than the
 *     one it is describing.
 *  2. **A bounded time window is selected.** With the "All" window the facet
 *     universe IS the current population and there is no prior period, so the
 *     two extra reads the bounded path replaces never happen and the comparison
 *     covers a third of what it claims to.
 *  3. **Both flag gates that change the NUMBERS are ON.** `honestSource` picks
 *     the Source projection the facet menu counts and the membership predicate
 *     match on; `dedupePluginRollups` picks the Invocations reduction. A run
 *     with both off would pass even if the bounded request dropped them.
 */

const RE_LAST_60_DAYS = /last 60 days/i;
/** Any corpus row's rendered name — used to wait for a populated table. */
const RE_CORPUS_ROW = /^Component \d{5}$/;
/** The same name found anywhere inside a whole-surface text capture. */
const RE_CORPUS_ROW_IN_TEXT = /Component \d{5}/;

/** Distinct facet values, so a dropped narrowing changes a visible count. */
const SOURCES = ["repo-alpha", "repo-beta", "pack-gamma"] as const;
const COLLABORATORS = ["Ada", "Grace", "Linus"] as const;

/**
 * An author whose components were ALL idle in the current window.
 *
 * FEA-3202's whole point: the facet option universe is the UNWINDOWED inventory,
 * so this author must stay in the Authors menu as a zero-count option instead of
 * vanishing when the window narrows. It is the discriminator for the one wiring
 * mistake the row comparison cannot see — a producer that reduces the facets
 * against the CURRENT population drops this option entirely, and every row,
 * total, and card still matches.
 */
const IDLE_COLLABORATOR = "Zoe";
const IDLE_SOURCE = "repo-zeta";
/** Every 101st row is idle-in-window, so the prior window has a real population. */
const IDLE_ROW_INTERVAL = 101;
const HARNESSES: readonly Harness[] = [
  Harness.Claude,
  Harness.Codex,
  Harness.Opencode,
  Harness.Both,
];
const KINDS: readonly AgentComponentKind[] = [
  AgentComponentKind.Subagent,
  AgentComponentKind.Command,
  AgentComponentKind.Skill,
  AgentComponentKind.Plugin,
  AgentComponentKind.Mcp,
  AgentComponentKind.Tool,
  AgentComponentKind.Hook,
  AgentComponentKind.Config,
];

/** Deliberately ABOVE `AGENT_COMPONENT_INVENTORY_CAP` (5,000). */
const CORPUS_SIZE = AGENT_COMPONENT_INVENTORY_CAP + 203;

const DAY_MS = 86_400_000;
/**
 * Usage timestamps are anchored to the RUN CLOCK, not to literals. The list
 * derives its 60-day window from `new Date()` at render, so a fixed date would
 * drift out of the window as the calendar moves and quietly turn this into a
 * comparison of two empty pages. In-window sits well inside 60 days; the prior
 * timestamp sits inside the PRECEDING 60-day window, so the baseline read has a
 * real population and the delta chips render.
 */
const IN_WINDOW_INVOKED_AT = new Date(Date.now() - 10 * DAY_MS).toISOString();
const PRIOR_WINDOW_INVOKED_AT = new Date(
  Date.now() - 75 * DAY_MS
).toISOString();

/**
 * One inventory row per index, cycling every facet dimension so no single
 * narrowing collapses the population and every kind/source/harness/author is
 * represented on both sides of the window boundary.
 *
 * A third of the rows carry a `honestSource` projection that DISAGREES with the
 * legacy `source` (including one with no provenance at all), so the ISS-5009
 * gate genuinely changes which options the Source facet offers and which rows
 * they select — the case a fixture of identical sources cannot reach.
 */
function corpusRow(index: number): AgentComponent {
  const kind = KINDS[index % KINDS.length];
  const idleInWindow = index % IDLE_ROW_INTERVAL === 0;
  const source = idleInWindow ? IDLE_SOURCE : SOURCES[index % SOURCES.length];
  const isPlugin = kind === AgentComponentKind.Plugin;
  const honestVariant = index % 3;
  return makeComponent({
    id: `component-${index}`,
    slug: `${kind}::component-${index}`,
    // Zero-padded so lexicographic Name order is stable and legible; the
    // comparator is `localeCompare`, and an unpadded index would interleave
    // "component-1000" between "component-1" and "component-2" in BOTH paths
    // (harmless for equivalence, unreadable in a failure diff).
    name: `Component ${String(index).padStart(5, "0")}`,
    kind,
    sourceType: SourceType.Repo,
    source,
    ...(honestVariant === 1
      ? {
          honestSource: {
            hasProvenance: true,
            source: `honest-${source}`,
            sourceType: SourceType.Repo,
          },
        }
      : {}),
    ...(honestVariant === 2
      ? {
          honestSource: {
            hasProvenance: false,
            source: null,
            sourceType: SourceType.Local,
          },
        }
      : {}),
    harness: HARNESSES[index % HARNESSES.length],
    invocations: (index % 17) * 3,
    sessions: index % 7,
    // A third of the rows carry no measurable ratio, so the LOC/$ card's
    // average and its sample size are both meaningful numbers to compare.
    locPerDollar: index % 3 === 0 ? null : (index % 23) / 4,
    collaborators: [
      idleInWindow
        ? IDLE_COLLABORATOR
        : COLLABORATORS[index % COLLABORATORS.length],
    ],
    // Plugins and their child kinds share a pack id, so the ISS-5534
    // de-duplication actually has a rollup to drop.
    ...(isPlugin || index % 5 === 0 ? { packIds: [`pack-${index % 11}`] } : {}),
    lastInvokedAt: idleInWindow
      ? PRIOR_WINDOW_INVOKED_AT
      : IN_WINDOW_INVOKED_AT,
  });
}

const CORPUS: AgentComponent[] = Array.from(
  { length: CORPUS_SIZE },
  (_unused, index) => corpusRow(index)
);

/**
 * The list read both paths share: honours the usage window on `lastInvokedAt`
 * and TRUNCATES at the requested limit, exactly as the API's capped population
 * read does. The truncation is what makes the over-cap corpus meaningful.
 */
function readPopulation(filters: {
  limit?: number;
  startDate?: string;
  endDate?: string;
}): AgentComponent[] {
  const start = filters.startDate ? Date.parse(filters.startDate) : undefined;
  const end = filters.endDate ? Date.parse(filters.endDate) : undefined;
  const windowed = CORPUS.filter((row) => {
    if (start === undefined && end === undefined) {
      return true;
    }
    const invokedAt = row.lastInvokedAt ? Date.parse(row.lastInvokedAt) : null;
    if (invokedAt === null) {
      return false;
    }
    if (start !== undefined && invokedAt < start) {
      return false;
    }
    return !(end !== undefined && invokedAt > end);
  });
  return windowed.slice(0, filters.limit ?? windowed.length);
}

/**
 * How many times each read shape was actually exercised.
 *
 * Without this the suite has a free pass of its own: if the component read the
 * wrong flag key — or the flag never reached it — the "bounded" render would
 * quietly take the legacy path and every equality assertion below would hold by
 * comparing legacy against legacy. Counting the reads is what makes the
 * comparison a comparison.
 */
type ReadCounts = { list: number; pageData: number };

/** The legacy source: `list` only, so the shared list takes the three-read path. */
function legacyDataSource(counts: ReadCounts): AgentComponentsDataSource {
  return {
    scope: WINDOWED_SCOPE,
    honorsDateWindow: true,
    list: (filters) => {
      counts.list += 1;
      const items = readPopulation(filters);
      return Promise.resolve({ items, total: items.length });
    },
    detail: () => Promise.reject(new Error("detail unused in list tests")),
  };
}

/**
 * The bounded source: the same `list`, plus a `pageData` that assembles the
 * three populations the way `agentComponentPageDataService` does and hands them
 * to the shared reduction. This stands in for the producer — the API route or
 * the desktop main process — and asserting the two renders agree is asserting
 * that assembly is right.
 */
function boundedDataSource(counts: ReadCounts): AgentComponentsDataSource {
  const source = legacyDataSource(counts);
  return {
    ...source,
    pageData: (request) => {
      counts.pageData += 1;
      const current = readPopulation({
        limit: AGENT_COMPONENT_INVENTORY_CAP,
        ...(request.startDate ? { startDate: request.startDate } : {}),
      });
      const universe = request.startDate
        ? readPopulation({ limit: AGENT_COMPONENT_INVENTORY_CAP })
        : current;
      const previous =
        request.prevStart && request.prevEnd
          ? readPopulation({
              limit: AGENT_COMPONENT_INVENTORY_CAP,
              startDate: request.prevStart,
              endDate: request.prevEnd,
            })
          : undefined;
      return Promise.resolve(
        reduceAgentComponentPageData(
          { current, universe, ...(previous ? { previous } : {}) },
          request
        )
      );
    },
  };
}

const WINDOWED_SCOPE = "agent-components:http";

const NUMBER_GATES = [
  AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY,
  AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY,
];

type Capture = {
  firstPage: string;
  secondPage: string;
  authorsMenu: string;
  reads: ReadCounts;
};

/**
 * Render the list, drive it to the state under comparison, and capture what is
 * on screen.
 *
 * The captures are the rendered TEXT of the whole surface, not a hand-picked
 * list of numbers: the point is that nothing the user can read differs, so
 * naming the fields would let the one that drifted be the one nobody named.
 */
function renderList(options: {
  flagOn: boolean;
  dataSource: AgentComponentsDataSource;
  persistKey: string;
}) {
  return render(
    <AppCoreStoryProviders
      enabledFlags={
        options.flagOn
          ? [...NUMBER_GATES, AGENTS_BOUNDED_PAGE_DATA_FEATURE_FLAG_KEY]
          : NUMBER_GATES
      }
    >
      <AgentComponentsDataSourceProvider dataSource={options.dataSource}>
        <AgentsGroupedList persistKey={options.persistKey} />
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

async function renderAndCapture(bounded: boolean): Promise<Capture> {
  const user = userEvent.setup();
  const reads: ReadCounts = { list: 0, pageData: 0 };
  const { container } = renderList({
    flagOn: bounded,
    dataSource: bounded ? boundedDataSource(reads) : legacyDataSource(reads),
    persistKey: `agents:equivalence:${bounded}`,
  });

  await screen.findAllByText(RE_CORPUS_ROW, undefined, { timeout: 30_000 });
  // A bounded window is what brings the unwindowed facet universe and the
  // preceding-window baseline into play at all.
  await user.click(screen.getByRole("radio", { name: RE_LAST_60_DAYS }));
  await waitFor(
    () =>
      expect(
        screen.getByRole("radio", { name: RE_LAST_60_DAYS })
      ).toBeChecked(),
    { timeout: 30_000 }
  );
  await waitFor(() => expect(container.textContent).toContain("Component"), {
    timeout: 30_000,
  });
  const firstPage = textOf(container);

  await user.click(screen.getByLabelText("Go to next page"));
  await waitFor(() => expect(textOf(container)).not.toBe(firstPage), {
    timeout: 30_000,
  });
  const secondPage = textOf(container);

  // The Authors submenu is where the facet option UNIVERSE is visible: it must
  // still list the author whose components were all idle in this window, at a
  // count of zero.
  await user.click(screen.getByRole("button", { name: "Filter" }));
  await user.click(await screen.findByRole("menuitem", { name: "Authors" }));
  const authorsMenu = document.body.textContent ?? "";

  return { firstPage, secondPage, authorsMenu, reads };
}

function textOf(container: HTMLElement): string {
  return container.textContent ?? "";
}

afterEach(() => {
  cleanup();
});

describe("AgentsGroupedList bounded page-data equivalence (ISS-6822)", () => {
  it("renders identically on the bounded read and the three-read path, over a corpus that crosses the 5,000-row cap", async () => {
    const legacy = await renderAndCapture(false);
    cleanup();
    const bounded = await renderAndCapture(true);

    // Guard the comparison against the way it could pass for free: if the list
    // had rendered its loading or empty state on BOTH paths, every field would
    // match and prove nothing. Pin that the legacy capture is a real, populated
    // page first.
    expect(legacy.firstPage).toMatch(RE_CORPUS_ROW_IN_TEXT);
    expect(legacy.firstPage).not.toContain("Loading components");
    expect(legacy.secondPage).not.toBe(legacy.firstPage);
    // The facet universe really is wider than the window, so comparing the two
    // menus is comparing something.
    expect(legacy.authorsMenu).toContain(IDLE_COLLABORATOR);
    // …and the two runs really took the two different read shapes. Without this
    // a component that read the wrong flag key would compare legacy to legacy.
    expect(legacy.reads.pageData).toBe(0);
    expect(legacy.reads.list).toBeGreaterThan(0);
    expect(bounded.reads.pageData).toBeGreaterThan(0);
    expect(bounded.reads.list).toBe(0);

    expect(bounded.firstPage).toBe(legacy.firstPage);
    expect(bounded.secondPage).toBe(legacy.secondPage);
    expect(bounded.authorsMenu).toBe(legacy.authorsMenu);
    // The generous budget is the fixture, not a hang: this case renders the real
    // list TWICE over an intentionally over-cap corpus, and the legacy half of
    // that pair reduces 5,000 rows in the renderer on every filter change —
    // which is precisely the cost this ticket removes. Shrinking the corpus
    // under the cap to make it quick would delete the property under test.
  }, 300_000);

  it("keeps reading the inventory when the flag is on but the source cannot serve a bounded page", async () => {
    // The version-skew case the optional `pageData` port exists for: an
    // installed desktop build whose preload predates the IPC method, a stub, or
    // any source that simply does not implement it. Deciding the read shape from
    // the FLAG alone turns the two independent gates against each other — the
    // legacy queries disabled because the flag is on, the bounded query disabled
    // because the method is missing — and the list renders forever empty while
    // reporting neither loading nor error. Assert ROWS, because an empty list is
    // exactly what the defect looks like.
    const reads: ReadCounts = { list: 0, pageData: 0 };
    const { container } = renderList({
      flagOn: true,
      dataSource: legacyDataSource(reads),
      persistKey: "agents:equivalence:no-page-data",
    });

    const rows = await screen.findAllByText(RE_CORPUS_ROW, undefined, {
      timeout: 30_000,
    });

    expect(rows.length).toBeGreaterThan(0);
    // It fell back to the inventory read rather than to nothing at all.
    expect(reads.list).toBeGreaterThan(0);
    expect(textOf(container)).not.toContain("Loading components");
    expect(textOf(container)).not.toContain("No components");
  }, 120_000);
});
