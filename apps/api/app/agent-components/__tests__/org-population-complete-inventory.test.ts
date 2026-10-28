/**
 * ISS-6891 regression suite: the org component inventory is a COMPLETE
 * population that filters narrow, never a per-facet top-N.
 *
 * The defect this pins is not "a big org loses its tail" — that was known and
 * accepted. It is that the tail each request lost DEPENDED on the request: the
 * identity spine applied `?kinds=`/`?search=` and only then took its 5,000, so
 * the All read spent that budget on the org's noisiest kind while a
 * `?kinds=subagent` read started from a far smaller set and truncated nothing.
 * An older subagent was therefore absent from All and present under its own
 * filter — narrowing the filter REVEALED a record the broader query hid.
 *
 * The fixture is the one the ticket specifies, and its size is the whole test:
 * 5,000 recent `command` identities plus one older `subagent`. Below the former
 * cap every assertion here passes with or without the fix, because the cap never
 * binds; the corpus has to cross it for the truncation to be reachable at all.
 *
 * Every case drives the real `agentComponentsService.listForOrg` — the
 * production entry point the catalog route, the page-data reducer, the MCP read
 * tool, and the ranking leaderboard all reach this population through.
 */

import { AGENT_COMPONENT_INVENTORY_CAP } from "@repo/api/src/types/agent-component";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  listByArtifactIds: vi.fn(),
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

// The population reads emit an oversize-population signal on a corpus this
// size; stub the lane so the suite does not write to the real logger. Nothing
// here asserts on it — that contract belongs to the reads' own suite.
vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: mocks.listByArtifactIds },
}));

import type { AgentComponentListResponse } from "@repo/api/src/types/agent-component";
import { agentComponentsService } from "../service";
import {
  buildPopulationDb,
  type InventoryFixture,
  makeInventoryRow,
  ORG_A,
} from "./org-population-fixtures";

/**
 * Recent `command` identities, sized to fill the former cap exactly. Derived
 * from the shared constant so the fixture keeps crossing the boundary if that
 * value is ever retuned, rather than silently going vacuous.
 */
const COMMAND_IDENTITIES = AGENT_COMPONENT_INVENTORY_CAP;

/** The one older subagent — the record the pre-fix All read truncated away. */
const SUBAGENT_KEY = "off-cap-reviewer";

/** Recent enough to outrank the subagent under a `lastSeenAt desc` spine. */
const RECENT_SEEN_AT = new Date("2026-08-20T00:00:00.000Z");
/** Older than every command, so a recency-ordered cap drops it first. */
const STALE_SEEN_AT = new Date("2026-02-01T00:00:00.000Z");

/** Every kind the fixture org installs — the catalog's per-tab facets. */
const FIXTURE_KINDS = ["command", "subagent"] as const;

/** Distinct component families the fixture org owns, in total. */
const TOTAL_IDENTITIES = COMMAND_IDENTITIES + 1;

/** Small enough that the population needs SIX pages, large enough to stay cheap. */
const PAGE_SIZE = 1000;

/** Budget for the multi-page walk; see the case that uses it. */
const PAGING_TEST_TIMEOUT_MS = 60_000;

/** A second org, whose rows this org's reads must never see. */
const ORG_B = "org-bbbb-2222";
const FOREIGN_KEY = "other-orgs-secret-command";

describe("ISS-6891 — an above-cap inventory stays complete under every facet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
    installPopulation(overCapInventory());
  });

  it("surfaces the older subagent in All AND under its own kind filter", async () => {
    const all = await listAllPages();
    const filtered = await listAllPages(["subagent"]);

    // The ticket's exact counterexample. Pre-fix this read
    // `{ inAll: false, inFiltered: true }`: the All spine spent its 5,000
    // identities on the recent commands and never reached the subagent, while
    // the kind-filtered spine started from one identity and truncated nothing.
    expect({
      inAll: keysOf(all).has(SUBAGENT_KEY),
      inFiltered: keysOf(filtered).has(SUBAGENT_KEY),
    }).toEqual({ inAll: true, inFiltered: true });
  });

  it("reports the complete population as `total`, not a capped view of it", async () => {
    const all = await firstPage();

    // Pinned to an independent literal, never re-derived from the pagination
    // helper under test. Pre-fix this was exactly AGENT_COMPONENT_INVENTORY_CAP
    // — the cap reporting itself as the org's size.
    expect(all.total).toBe(TOTAL_IDENTITIES);
    expect(all.total).toBeGreaterThan(AGENT_COMPONENT_INVENTORY_CAP);
  });

  it("keeps every filtered result a SUBSET of All", async () => {
    const allKeys = keysOf(await listAllPages());

    for (const kind of FIXTURE_KINDS) {
      for (const key of keysOf(await listAllPages([kind]))) {
        expect(allKeys).toContain(key);
      }
    }
  });

  it("never lets a narrower filter GROW a count, and never exceeds the parent", async () => {
    const all = await listAllPages();
    const allTotal = (await firstPage()).total;

    let perKindSum = 0;
    for (const kind of FIXTURE_KINDS) {
      const filteredTotal = (await firstPage([kind])).total;
      const withinAll = all.items.filter((item) => item.kind === kind).length;

      // Monotonicity: a facet only ever REMOVES identities, so its count can
      // never exceed the same kind's count inside All.
      expect(filteredTotal).toBeLessThanOrEqual(withinAll);
      // And no count may exceed its parent population.
      expect(filteredTotal).toBeLessThanOrEqual(allTotal);
      perKindSum += filteredTotal;
    }

    // The reconciliation the whole surface rests on: the tabs sum to All.
    expect(perKindSum).toBe(allTotal);
  });

  it(
    "reaches the off-cap subagent by PAGING, not only by asking for one huge page",
    async () => {
      const pages: string[][] = [];
      for (let offset = 0; offset < TOTAL_IDENTITIES; offset += PAGE_SIZE) {
        const page = await agentComponentsService.listForOrg(ORG_A, {
          limit: PAGE_SIZE,
          offset,
        });
        pages.push(page.items.map(componentKeyOf));
      }

      // A page is a WINDOW over the population, so the record past the former
      // cap has to be reachable through ordinary pagination — the property a
      // terminal cap cannot provide no matter how the pages are requested.
      expect(pages.flat()).toContain(SUBAGENT_KEY);
      expect(pages.flat()).toHaveLength(TOTAL_IDENTITIES);
    },
    // Each page rebuilds the whole above-cap population, so six of them is real
    // work. Stated explicitly rather than left to the runner's default, which on
    // a loaded machine fails this as a timeout and reads as a behavior break.
    PAGING_TEST_TIMEOUT_MS
  );

  it("reports `hasMore` against the complete population", async () => {
    const first = await agentComponentsService.listForOrg(ORG_A, {
      limit: PAGE_SIZE,
      offset: 0,
    });
    const last = await agentComponentsService.listForOrg(ORG_A, {
      limit: PAGE_SIZE,
      offset: TOTAL_IDENTITIES - 1,
    });

    // `hasMore` is only honest if `total` is: pre-fix the final page of a capped
    // population reported `hasMore: false` while records the caller could still
    // have been served sat beyond it.
    expect(first.hasMore).toBe(true);
    expect(last.hasMore).toBe(false);
    expect(last.items).toHaveLength(1);
  });
});

describe("ISS-6891 — completeness never widens the ORG scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
    installPopulation([...overCapInventory(), foreignOrgRow()]);
  });

  it("excludes another org's component from the complete population", async () => {
    const all = await listAllPages();

    // The counterfactual that matters for a read whose bound was just removed:
    // the ONLY thing still narrowing it is the org predicate. A double that
    // honors `where.organizationId` is what makes this a real exclusion rather
    // than an assertion that the predicate was written somewhere.
    expect(keysOf(all)).not.toContain(FOREIGN_KEY);
    expect(all.items).toHaveLength(TOTAL_IDENTITIES);
  });
});

/** The `componentKey` a response row was built from (the fixture sets it as `name`). */
function componentKeyOf(item: { name: string }): string {
  return item.name;
}

/** Every component key one response carries. */
function keysOf(response: AgentComponentListResponse): Set<string> {
  return new Set(response.items.map(componentKeyOf));
}

/** One page of the list, at the largest page the validator admits. */
function firstPage(
  kinds?: readonly string[]
): Promise<AgentComponentListResponse> {
  return agentComponentsService.listForOrg(ORG_A, {
    limit: AGENT_COMPONENT_INVENTORY_CAP,
    offset: 0,
    ...(kinds ? { kinds: [...kinds] } : {}),
  });
}

/**
 * Read the whole population the way a complete-population consumer must — by
 * following pages until the server stops reporting more.
 */
async function listAllPages(
  kinds?: readonly string[]
): Promise<AgentComponentListResponse> {
  const pageSize = AGENT_COMPONENT_INVENTORY_CAP;
  const items: AgentComponentListResponse["items"] = [];
  let offset = 0;
  let total = 0;
  let hasMore = true;
  while (hasMore) {
    const page = await agentComponentsService.listForOrg(ORG_A, {
      limit: pageSize,
      offset,
      ...(kinds ? { kinds: [...kinds] } : {}),
    });
    items.push(...page.items);
    total = page.total;
    offset += pageSize;
    hasMore = page.items.length > 0 && page.hasMore === true;
  }
  return { items, total, hasMore: false };
}

/**
 * The ticket's org: 5,000 recent `command` identities and ONE older `subagent`.
 * One row per identity, so the only thing that could ever have dropped the
 * subagent is the identity bound, not a row bound.
 */
function overCapInventory(): InventoryFixture[] {
  const rows: InventoryFixture[] = [];
  for (let index = 0; index < COMMAND_IDENTITIES; index++) {
    const key = `command-${index}`;
    rows.push(
      makeInventoryRow({
        id: `c-${key}`,
        componentKind: "command",
        componentKey: key,
        name: key,
        computeTargetId: `${ORG_A}-target-0`,
        lastSeenAt: RECENT_SEEN_AT,
      })
    );
  }
  rows.push(
    makeInventoryRow({
      id: `c-${SUBAGENT_KEY}`,
      componentKind: "subagent",
      componentKey: SUBAGENT_KEY,
      name: SUBAGENT_KEY,
      computeTargetId: `${ORG_A}-target-0`,
      lastSeenAt: STALE_SEEN_AT,
    })
  );
  return rows;
}

/** One component owned by a DIFFERENT org, seeded into the same fixture table. */
function foreignOrgRow(): InventoryFixture {
  return makeInventoryRow({
    id: `c-${FOREIGN_KEY}`,
    organizationId: ORG_B,
    componentKind: "command",
    componentKey: FOREIGN_KEY,
    name: FOREIGN_KEY,
    computeTargetId: `${ORG_B}-target-0`,
    lastSeenAt: RECENT_SEEN_AT,
  });
}

/**
 * Install a fresh population double over one inventory fixture, which backs both
 * the row read and every downstream lane — the same list the real reads see.
 */
function installPopulation(inventory: InventoryFixture[]) {
  const built = buildPopulationDb({ inventory });
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(built.db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(built.db)
  );
  return built;
}
