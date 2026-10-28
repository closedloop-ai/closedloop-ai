import {
  AGENT_COMPONENT_INVENTORY_CAP,
  type AgentComponent,
  AgentComponentKind,
  AgentComponentSortDir,
  AgentComponentSortKey,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentComponentPageDataQueryParams } from "../validators";

/**
 * ISS-6822 — what `GET /agent-components/page-data` actually returns.
 *
 * The reduction itself is shared with the client and covered end-to-end by
 * `agents-grouped-list.page-data-equivalence.test.tsx`, which renders both read
 * paths and compares the screen. What only THIS layer can get wrong is the
 * assembly: which populations it reads, which window each one carries, and
 * whether an absent prior window is absent or merely zero. Each case below
 * asserts a RETURNED VALUE that changes when that assembly is wrong — never that
 * a read was called.
 */

const listForOrg = vi.fn();
/**
 * ISS-6409: the LOC/$ fold the current-window read now returns. Overridable per
 * case; the default reports the metric unavailable, which is what a population
 * with no verifiable components folds to.
 */
let foldLocPerDollar: (
  components: readonly unknown[],
  windowStart: string | undefined
) => {
  locPerDollar: number | null;
  sampleSize: number;
} = () => ({ locPerDollar: null, sampleSize: 0 });

vi.mock("../../service", () => ({
  agentComponentsService: {
    listForOrg: (organizationId: string, query: unknown) =>
      listForOrg(organizationId, query),
    // ISS-6409: the current window reads through this one so the union fold can
    // come back with the rows. It delegates to the SAME `listForOrg` spy, so
    // every existing assertion about the query shape still describes the call
    // the service actually makes.
    listForOrgWithLocPerDollarFold: async (
      organizationId: string,
      query: unknown
    ) => ({
      ...(await listForOrg(organizationId, query)),
      // Each window's read returns a fold BOUND TO THAT WINDOW, the way the
      // real service closes over the session maps it just loaded. A single
      // shared closure here would hide the bug this models.
      foldLocPerDollar: (components: readonly unknown[]) =>
        foldLocPerDollar(
          components,
          (query as { startDate?: string }).startDate
        ),
    }),
  },
}));

const ORG_ID = "org-1";
const CURRENT_START = "2026-06-01T00:00:00.000Z";
const PREV_START = "2026-04-01T00:00:00.000Z";
const PREV_END = "2026-06-01T00:00:00.000Z";

/** An author whose components exist but had no usage in the current window. */
const IDLE_AUTHOR = "Zoe";

/**
 * A population one page larger than the service's own page size, so a read that
 * stops at the first page is observably short. Derived from the shared page
 * bound so the fixture keeps crossing it if that value is retuned.
 */
const PAGED_POPULATION_SIZE = AGENT_COMPONENT_INVENTORY_CAP + 7;

/**
 * The failure a caller sees when the population could not be exhausted. Carries
 * the two numbers that make it actionable, so a message narrowed to "failed"
 * fails this case.
 */
const PARTIAL_POPULATION_FAILURE = /partial_population: read 1 of a reported 9/;

function component(overrides: Partial<AgentComponent>): AgentComponent {
  return {
    id: overrides.id ?? "id",
    slug: overrides.slug ?? "subagent::id",
    name: overrides.name ?? "Component",
    kind: overrides.kind ?? AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "repo-a",
    harness: Harness.Claude,
    invocations: 10,
    sessions: 2,
    locPerDollar: 1,
    trend: [],
    collaborators: ["Ada"],
    computeTargetIds: [],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Three in-window rows plus, unwindowed only, one row authored by Zoe. */
const CURRENT_ROWS: AgentComponent[] = [
  component({ id: "a", slug: "subagent::a", name: "Alpha" }),
  component({ id: "b", slug: "subagent::b", name: "Bravo" }),
  component({ id: "c", slug: "subagent::c", name: "Charlie" }),
];
const UNWINDOWED_ROWS: AgentComponent[] = [
  ...CURRENT_ROWS,
  component({
    id: "z",
    slug: "subagent::z",
    name: "Zulu",
    collaborators: [IDLE_AUTHOR],
  }),
];
const PRIOR_ROWS: AgentComponent[] = [
  component({ id: "p", slug: "subagent::p", name: "Papa", invocations: 40 }),
];

/**
 * Stand in for the real population read.
 *
 * Answers by WINDOW, so a request that reads the wrong window gets visibly wrong
 * rows back — and TRUNCATES at the requested `limit`, so a service that stopped
 * asking for the full capped population would visibly return fewer rows and a
 * smaller total. That is what keeps the "it still reads the whole bounded
 * inventory" property assertable as a VALUE rather than as a call argument.
 */
function installPopulations(): void {
  listForOrg.mockImplementation(
    (
      _organizationId: string,
      query: { startDate?: string; endDate?: string; limit?: number }
    ) => {
      const population = windowPopulation(query);
      const items = population.slice(0, query.limit ?? population.length);
      return Promise.resolve({ items, total: items.length, hasMore: false });
    }
  );
}

function windowPopulation(query: {
  startDate?: string;
  endDate?: string;
}): AgentComponent[] {
  if (query.endDate) {
    return PRIOR_ROWS;
  }
  return query.startDate ? CURRENT_ROWS : UNWINDOWED_ROWS;
}

function query(
  overrides: Partial<AgentComponentPageDataQueryParams> = {}
): AgentComponentPageDataQueryParams {
  return {
    kinds: [],
    collaborators: [],
    sources: [],
    harnesses: [],
    search: "",
    sortBy: AgentComponentSortKey.Name,
    sortDir: AgentComponentSortDir.Asc,
    page: 0,
    pageSize: 2,
    honestSource: false,
    dedupePluginRollups: false,
    // ISS-6888: what the validator produces for EVERY real request to this
    // endpoint — it defaults the ask OPEN so a client that predates the field
    // keeps the unwindowed facet menu it has always had. Stated here so this
    // builder describes a request the route could actually deliver.
    unwindowedFacetUniverse: true,
    ...overrides,
  } as AgentComponentPageDataQueryParams;
}

async function getPageData(
  overrides: Partial<AgentComponentPageDataQueryParams> = {}
) {
  const { agentComponentPageDataService } = await import("../service");
  return agentComponentPageDataService.getPageDataForOrg(
    ORG_ID,
    query(overrides)
  );
}

beforeEach(() => {
  listForOrg.mockReset();
  foldLocPerDollar = () => ({ locPerDollar: null, sampleSize: 0 });
  installPopulations();
});

describe("agentComponentPageDataService (ISS-6822)", () => {
  it("returns only the requested page of the current window, with the full matched total", async () => {
    const result = await getPageData({ startDate: CURRENT_START, pageSize: 2 });

    // The page is bounded; the total describes the whole narrowed set.
    expect(result.items.map((row) => row.name)).toEqual(["Alpha", "Bravo"]);
    expect(result.filteredTotal).toBe(3);
    expect(result.totalPages).toBe(2);
    expect(result.current.components).toBe(3);
  });

  it("clamps a page past the end to the last page instead of returning nothing", async () => {
    // FEA-2540's invariant, moved to the producer: a viewer whose corpus shrank
    // must land on a populated page, not an empty one.
    const result = await getPageData({
      startDate: CURRENT_START,
      pageSize: 2,
      page: 99,
    });

    expect(result.page).toBe(1);
    expect(result.items.map((row) => row.name)).toEqual(["Charlie"]);
  });

  it("builds the facet universe from the UNWINDOWED inventory, so an idle author keeps a zero-count option", async () => {
    // FEA-3202. This is the assembly mistake the row/total assertions above
    // cannot see: reducing the facets against the current window drops Zoe from
    // the menu entirely while every row and count stays correct.
    const result = await getPageData({ startDate: CURRENT_START });

    const zoe = result.facets.collaborators.find(
      (option) => option.id === IDLE_AUTHOR
    );
    expect(zoe).toBeDefined();
    expect(zoe?.count).toBe(0);
    // And the in-window author is counted over the rows actually returned.
    expect(
      result.facets.collaborators.find((option) => option.id === "Ada")?.count
    ).toBe(3);
  });

  it("withholds the unwindowed universe when the caller does not ask for it (ISS-6888)", async () => {
    // The negative sibling of the case above, on the same window and the same
    // locator. The ask is EXPLICIT rather than inferred from `startDate`, because
    // a bounded window narrows the ROWS and says nothing about whether the
    // caller's source honors it — desktop, whose local reader shares this
    // contract, sends `startDate` on every windowed read while its rollout gate
    // is still closed. Without this the second population build fires for a
    // caller that never wanted it and the idle author's option leaks past the
    // gate; asserting only the OPEN case would not notice.
    const result = await getPageData({
      startDate: CURRENT_START,
      unwindowedFacetUniverse: false,
    });

    expect(
      result.facets.collaborators.find((option) => option.id === IDLE_AUTHOR)
    ).toBeUndefined();
    // The rows and the in-window counts are untouched — only the universe is.
    expect(
      result.facets.collaborators.find((option) => option.id === "Ada")?.count
    ).toBe(3);
  });

  it("uses the current population as its own facet universe when no window is selected", async () => {
    // With no `startDate` the current read IS unwindowed, so there is no second
    // population to read — and the universe must still be the full one.
    const result = await getPageData({});

    expect(result.filteredTotal).toBe(UNWINDOWED_ROWS.length);
    expect(
      result.facets.collaborators.find((option) => option.id === IDLE_AUTHOR)
        ?.count
    ).toBe(1);
  });

  it("reduces a prior-window aggregate only when both bounds are supplied", async () => {
    const withPrior = await getPageData({
      startDate: CURRENT_START,
      prevStart: PREV_START,
      prevEnd: PREV_END,
    });

    expect(withPrior.previous?.components).toBe(1);
    expect(withPrior.previous?.invocations).toBe(40);
  });

  it("OMITS the prior aggregate — never a zeroed one — when there is no prior window", async () => {
    const withoutPrior = await getPageData({ startDate: CURRENT_START });

    // `previous: null` or a zeroed aggregate would make the summary cards render
    // a delta against a baseline that was never read. Absence is the contract.
    expect("previous" in withoutPrior).toBe(false);
    expect(withoutPrior.previous).toBeUndefined();
  });

  it("still reads the WHOLE capped inventory per window, not a page-sized slice", async () => {
    // The bounded read is bounded at the RESPONSE, not at the population: every
    // aggregate and facet count describes the full windowed set. A service that
    // asked its population read for `pageSize` rows would return a page that
    // still looked right while every total silently shrank to it, so the
    // discriminator is a population LARGER than the requested page.
    const many = Array.from({ length: 12 }, (_unused, index) =>
      component({
        id: `many-${index}`,
        slug: `subagent::many-${index}`,
        name: `Row ${String(index).padStart(2, "0")}`,
      })
    );
    listForOrg.mockImplementation(
      (_organizationId: string, q: { limit?: number }) =>
        Promise.resolve({
          items: many.slice(0, q.limit ?? many.length),
          total: many.length,
          hasMore: false,
        })
    );

    const result = await getPageData({ pageSize: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.filteredTotal).toBe(many.length);
    expect(result.current.components).toBe(many.length);
  });

  it("applies the Source-provenance gate the caller asked for", async () => {
    // ISS-5009's gate changes which value a row participates in the Source facet
    // AS, so it decides both the option universe and which rows a selection
    // matches. A service that dropped it would build the menu under one
    // projection while the membership predicate used the other — an option with
    // a positive count that selects zero rows.
    const echoed = component({
      id: "echo",
      slug: "skill::python",
      name: "Python Skill",
      kind: AgentComponentKind.Skill,
      source: "skill::python",
      honestSource: {
        hasProvenance: true,
        source: "user",
        sourceType: SourceType.Local,
      },
    });
    listForOrg.mockResolvedValue({ items: [echoed], total: 1, hasMore: false });

    const legacy = await getPageData({ honestSource: false });
    const honest = await getPageData({ honestSource: true });

    expect(legacy.facets.sources.map((option) => option.id)).toEqual([
      "skill::python",
    ]);
    expect(honest.facets.sources.map((option) => option.id)).toEqual(["user"]);
    // And the membership predicate agrees with the menu it was given: selecting
    // the honest option keeps the row.
    const selected = await getPageData({
      honestSource: true,
      sources: ["user"],
    });
    expect(selected.filteredTotal).toBe(1);
  });

  it("reduces over EVERY page of a population larger than one page (ISS-6891)", async () => {
    // The list read is paginated, so taking its first page and reducing over the
    // array is a silent truncation: every facet count, both summary aggregates,
    // and `filteredTotal` would describe a prefix while presenting it as the org.
    // The double pages honestly here, so a service that stops at page one returns
    // a visibly smaller total.
    const population = Array.from({ length: PAGED_POPULATION_SIZE }, (_u, i) =>
      component({ id: `p-${i}`, slug: `subagent::p-${i}`, name: `P${i}` })
    );
    listForOrg.mockImplementation(
      (_organizationId: string, q: { limit?: number; offset?: number }) => {
        const offset = q.offset ?? 0;
        const items = population.slice(offset, offset + (q.limit ?? 0));
        return Promise.resolve({
          items,
          total: population.length,
          hasMore: offset + items.length < population.length,
        });
      }
    );

    const result = await getPageData({ pageSize: 2 });

    // Pinned to an independent literal. One page of the request's own limit
    // would report `AGENT_COMPONENT_INVENTORY_CAP` here.
    expect(result.filteredTotal).toBe(PAGED_POPULATION_SIZE);
    // #6483: two reads, the second covering the whole population from offset 0.
    // A page walk would rebuild the org population once per page, against up to
    // three windows concurrently, and stitch the result from that many snapshots.
    expect(listForOrg).toHaveBeenCalledTimes(2);
    expect(listForOrg.mock.calls[1]?.[1]).toMatchObject({
      limit: PAGED_POPULATION_SIZE,
      offset: 0,
    });
  });

  it("#6483: FAILS rather than reducing a population it could not exhaust", async () => {
    // A read that stops short of its own `total`. Reducing over that prefix
    // publishes facet counts, both summary aggregates, and `filteredTotal` as
    // the org's — exact-looking numbers that are short by an unknown amount,
    // with nothing in the response saying so. Logging it and reducing anyway
    // discards the signal the service had just established.
    listForOrg.mockResolvedValue({
      items: [component({ id: "only", slug: "subagent::only" })],
      total: 9,
      hasMore: false,
    });

    await expect(getPageData({})).rejects.toThrow(PARTIAL_POPULATION_FAILURE);
  });

  it("applies the Invocations de-duplication gate the caller asked for", async () => {
    // A plugin and one of its children in the same population: the flat sum
    // counts the child's calls twice, the deduped sum once. If the gate did not
    // reach the reduction, both branches would return the same number.
    const plugin = component({
      id: "plug",
      slug: "plugin::pack-1",
      name: "Pack One",
      kind: AgentComponentKind.Plugin,
      invocations: 60,
      packIds: ["pack-1"],
    });
    const child = component({
      id: "child",
      slug: "skill::child",
      name: "Child Skill",
      kind: AgentComponentKind.Skill,
      invocations: 60,
      packIds: ["pack-1"],
    });
    listForOrg.mockResolvedValue({
      items: [plugin, child],
      total: 2,
      hasMore: false,
    });

    const flat = await getPageData({ dedupePluginRollups: false });
    const deduped = await getPageData({ dedupePluginRollups: true });

    expect(flat.current.invocations).toBe(120);
    expect(deduped.current.invocations).toBe(60);
  });
});

/**
 * ISS-6409 (#6417 review): the LOC/$ the card shows comes from the producer's
 * union fold, and nothing else asserted that it survives the trip.
 *
 * Deleting the fold argument at the reduce call, or reading the metric from the
 * rows again, leaves every other case in this file green — which is exactly the
 * "delete the wiring and the suite stays green" gap raised on the previous
 * revision.
 */
describe("LOC/$ comes from the current window's fold (ISS-6409)", () => {
  it("carries the fold's figure and sample onto the current aggregate", async () => {
    foldLocPerDollar = () => ({ locPerDollar: 30.26, sampleSize: 2 });

    const result = await getPageData({ startDate: CURRENT_START });

    expect(result.current.locPerDollar).toBeCloseTo(30.26, 2);
    expect(result.current.locPerDollarSampleSize).toBe(2);
  });

  it("folds the FILTERED rows, not the whole inventory", async () => {
    // The card describes the rows it sits above, so a facet filter has to reach
    // the fold — otherwise the headline number silently describes a different
    // population from the table under it.
    const foldedNames: string[][] = [];
    foldLocPerDollar = (components) => {
      foldedNames.push(
        (components as { name: string }[]).map((row) => row.name)
      );
      return { locPerDollar: 1, sampleSize: components.length };
    };

    await getPageData({ startDate: CURRENT_START, search: "Alpha" });

    // Every fold saw a narrowed population, and none saw the unfiltered set.
    expect(foldedNames.length).toBeGreaterThan(0);
    for (const names of foldedNames) {
      expect(names).not.toContain("Bravo");
    }
  });

  it("folds the preceding window with ITS OWN sessions, not the current window's", async () => {
    // ISS-6409 (#6417 review): the two windows were reduced with ONE closure —
    // the current window's — so `previous.locPerDollar` was the current
    // window's own figure and the card's delta chip read a confident 0%
    // against itself. Each window's producer must answer for its own sessions.
    foldLocPerDollar = (_components, windowStart) =>
      windowStart === PREV_START
        ? { locPerDollar: 10, sampleSize: 1 }
        : { locPerDollar: 40, sampleSize: 2 };

    const result = await getPageData({
      startDate: CURRENT_START,
      prevStart: PREV_START,
      prevEnd: PREV_END,
    });

    expect(result.current.locPerDollar).toBe(40);
    expect(result.previous?.locPerDollar).toBe(10);
    // The shape of the old bug: both windows reporting the same figure.
    expect(result.previous?.locPerDollar).not.toBe(result.current.locPerDollar);
  });

  it("reports the metric unavailable, never zero, when the fold has none", async () => {
    foldLocPerDollar = () => ({ locPerDollar: null, sampleSize: 0 });

    const result = await getPageData({ startDate: CURRENT_START });

    expect(result.current.locPerDollar).toBeNull();
    expect(result.current.locPerDollar).not.toBe(0);
  });
});
