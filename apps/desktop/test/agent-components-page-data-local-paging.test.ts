/**
 * @file agent-components-page-data-local-paging.test.ts
 * @description ISS-6891 — the desktop page-data read must follow EVERY page of
 * the local inventory, not reduce over the first one.
 *
 * The sibling `agent-components-page-data-local.test.ts` drives the real seeded
 * SQLite store, which is the right harness for the assembly questions it asks —
 * but its fixture is seven components against a page size of 5,000, so the
 * paging never executes there and deleting the page-follower leaves it green.
 * Reproducing the boundary with a real store would mean seeding past 5,000 rows;
 * the page reader is doubled instead, which is the only part of the production
 * path this case is about.
 *
 * What is NOT doubled is `agentComponentsPageDataLocal` itself: the real
 * function runs, so the assertion fails if the follower is removed from it.
 */

import {
  AGENT_COMPONENT_INVENTORY_CAP,
  type AgentComponent,
  AgentComponentKind,
  AgentComponentSortDir,
  AgentComponentSortKey,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import type { AgentComponentPageDataRequest } from "@repo/api/src/utils/agent-component-page-data";
import { beforeEach, expect, test, vi } from "vitest";

const listAgentComponentsLocal = vi.fn();

vi.mock("../src/main/dashboard/shared-agent-components-api.js", () => ({
  // ISS-6409 renamed the reader this caller uses; the IPC-facing
  // `listAgentComponentsLocal` is the fold-less wrapper the page-data path no
  // longer goes through. Doubling the wrapper would leave the production path
  // unmocked, so the double names the function actually called.
  listAgentComponentsLocalWithLocPerDollarFold: (...args: unknown[]) =>
    listAgentComponentsLocal(...args),
}));

const {
  agentComponentsPageDataLocal,
  AGENT_COMPONENTS_PAGE_DATA_PARTIAL_POPULATION_CODE,
} = await import("../src/main/dashboard/agent-components-page-data-local.js");

/**
 * A local inventory one page larger than the read's own page size, so a
 * first-page-only read is observably short. Derived from the shared bound so the
 * fixture keeps crossing it if that value is retuned.
 */
const POPULATION_SIZE = AGENT_COMPONENT_INVENTORY_CAP + 11;

/** The page size `agentComponentsPageDataLocal` asks its reader for. */
const READ_PAGE_SIZE = AGENT_COMPONENT_INVENTORY_CAP;

beforeEach(() => {
  vi.clearAllMocks();
});

test("ISS-6891: the desktop page-data read reduces over EVERY page, not the first", async () => {
  installPagingReader(POPULATION_SIZE);

  const result = await agentComponentsPageDataLocal(
    {} as never,
    request(),
    null
  );

  // Pinned to an independent literal. A first-page read reports exactly
  // AGENT_COMPONENT_INVENTORY_CAP here — the cap describing itself as the
  // machine's inventory, which is the defect one layer up from the server.
  expect(result.filteredTotal).toBe(POPULATION_SIZE);
  expect(result.current.components).toBe(POPULATION_SIZE);
  // #6483: two reads, and the SECOND one is the whole population from offset 0
  // — not the next window. A page walk would be `ceil(POPULATION_SIZE /
  // READ_PAGE_SIZE)` reads stitched from that many separate snapshots; reading
  // the remainder in one request is what makes the population atomic and what
  // stops each further page from costing another full rebuild.
  expect(listAgentComponentsLocal).toHaveBeenCalledTimes(2);
  expect(listAgentComponentsLocal.mock.calls[0]?.[1]).toMatchObject({
    limit: READ_PAGE_SIZE,
    offset: 0,
  });
  expect(listAgentComponentsLocal.mock.calls[1]?.[1]).toMatchObject({
    limit: POPULATION_SIZE,
    offset: 0,
  });
  // ISS-6409 x ISS-6891: the LOC/$ fold must come from the read whose rows were
  // kept. A fold retained from the short FIRST read reports READ_PAGE_SIZE here
  // — a summary card folded over a prefix, rendering an exact number with
  // nothing saying it is short. That is the half of the truncation the row
  // counts above cannot see.
  expect(result.current.locPerDollarSampleSize).toBe(POPULATION_SIZE);
});

test("#6483: the desktop page-data read FAILS rather than reducing a partial inventory", async () => {
  // A reader that stops short of its own `total`. Every value the reduction
  // emits — the facet counts, both summary aggregates, `filteredTotal` — would
  // otherwise be computed over a prefix and rendered as the machine's whole
  // inventory, with nothing on screen saying so.
  listAgentComponentsLocal.mockResolvedValue({
    items: [component("c-1")],
    total: 9,
    hasMore: false,
  });

  await expect(
    agentComponentsPageDataLocal({} as never, request(), null)
  ).rejects.toThrow(AGENT_COMPONENTS_PAGE_DATA_PARTIAL_POPULATION_CODE);
});

test("ISS-6891: a single-page local inventory still reads once", async () => {
  installPagingReader(3);

  const result = await agentComponentsPageDataLocal(
    {} as never,
    request(),
    null
  );

  // The other side of the branch: a machine inside one page must not pay a
  // second round trip, so the follower's termination is doing real work rather
  // than the test only proving it can loop.
  expect(result.filteredTotal).toBe(3);
  expect(listAgentComponentsLocal).toHaveBeenCalledTimes(1);
});

/** The page-data request shape, with the facets left wide open. */
function request(): AgentComponentPageDataRequest {
  return {
    filters: {
      kinds: [],
      collaborators: [],
      sources: [],
      harnesses: [],
      search: "",
    },
    sortBy: AgentComponentSortKey.Name,
    sortDir: AgentComponentSortDir.Asc,
    page: 0,
    pageSize: 3,
    honestSource: false,
    dedupePluginRollups: false,
  };
}

/** Back the local reader with a population it slices on `limit`/`offset`. */
function installPagingReader(size: number): void {
  const population = Array.from({ length: size }, (_unused, index) =>
    component(`c-${String(index).padStart(5, "0")}`)
  );
  listAgentComponentsLocal.mockImplementation(
    (_prisma: unknown, filters: { limit?: number; offset?: number }) => {
      const offset = filters.offset ?? 0;
      const items = population.slice(offset, offset + (filters.limit ?? 0));
      return Promise.resolve({
        items,
        total: population.length,
        hasMore: offset + items.length < population.length,
        // ISS-6409: the real reader's fold is scoped to the rows THAT read
        // returned (its session map is built from them), so the double reports
        // the same page-scoped sample. That is what makes a fold kept from the
        // short first read observable in `locPerDollarSampleSize`.
        foldLocPerDollar: () => ({
          locPerDollar: null,
          sampleSize: items.length,
        }),
      });
    }
  );
}

/** One list row, shaped enough for the shared reduction to count it. */
function component(id: string): AgentComponent {
  return {
    id,
    slug: `skill::${id}`,
    name: id,
    kind: AgentComponentKind.Skill,
    sourceType: SourceType.Repo,
    source: "acme/repo",
    harness: Harness.Claude,
    invocations: 1,
    sessions: 1,
    locPerDollar: null,
    trend: [],
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
  };
}
