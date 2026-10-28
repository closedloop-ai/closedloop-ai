import assert from "node:assert/strict";
import {
  SESSION_COST_FILTER_OPTIONS,
  SESSION_UNKNOWN_COST_BUCKET_ID,
  SessionChangePresenceId,
  SessionPrAssociationId,
} from "@repo/api/src/agent-session-filters";
import { SESSION_AUTONOMY_TIER_FILTER_OPTIONS } from "@repo/api/src/session-autonomy-tiers";
import { describe, test } from "vitest";
import { SessionListCursorSortKey } from "../src/main/agent-sync/agent-session-read-model.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  canPageWindowAndSortBeforeHydration,
  hasNoLocalFacetFilters,
  lightweightUsageLoadFitsQuery,
} from "../src/main/session/session-read-fast-paths.js";
import type { SanitizedQuery } from "../src/main/session/shared-agent-sessions-query.js";
import { SESSIONS_SURFACE_DATE_WINDOW_FIELD } from "../src/shared/session-date-window-contract.js";

/**
 * ISS-7563: the admission predicates in `session-read-fast-paths.ts`, driven
 * directly rather than through a read.
 *
 * The load-bearing part is the cost table below. The ISS-4481 exhaustive-cost
 * carve-out — an "every cost state" selection excludes no row, so it must be
 * treated as NO cost facet instead of forcing the 5,000-capped fallback that
 * drops older sessions for a filter that filters nothing — is written out twice
 * in that file, once inside `hasNoLocalFacetFilters` and once inside
 * `lightweightUsageLoadFitsQuery`. Each copy is reached by a DIFFERENT
 * API-level suite, so changing one and not the other stays green. One table,
 * asserted against both, is what makes them fall together.
 *
 * The `admitted` column is written by hand, NOT derived from
 * `isExhaustiveCostFilter`. Deriving it would re-implement the boundary being
 * pinned: both copies could drift the same way and the table would follow them.
 * The SELECTIONS are derived from `SESSION_COST_FILTER_OPTIONS` so a new cost
 * option cannot leave the "exhaustive" row quietly non-exhaustive.
 *
 * This file deliberately asserts NOTHING about which read path a query then
 * takes — the cursor-page-vs-hydration outcomes are owned end to end by
 * `shared-agent-sessions-usage-repository-fast-path.test.ts` (the ISS-4481
 * lightweight case), `shared-agent-sessions-repository-population.test.ts`, and
 * `shared-agent-sessions-date-window-reconciliation.test.ts`. Re-asserting them
 * here would duplicate their fixtures without adding a claim.
 *
 * A third copy of the same carve-out lives in `matchesListQuery`
 * (`shared-agent-sessions-api.ts`, the `matchesLocalCostBucketFilter` skip both
 * docstrings here promise agreement with). It takes a hydrated session rather
 * than a query, so it cannot join this table; the ISS-4481 case in the usage
 * fast-path suite covers it through a real read.
 */

const ALL_COST_OPTION_IDS = SESSION_COST_FILTER_OPTIONS.map(
  (option) => option.id
);
const NUMERIC_COST_OPTION_IDS = ALL_COST_OPTION_IDS.filter(
  (id) => id !== SESSION_UNKNOWN_COST_BUCKET_ID
);

/**
 * One canonical Autonomy selection, taken from the facet's own option list
 * rather than spelled out here, so a renamed or retired tier reaches these
 * tables by typecheck instead of leaving them asserting an unselectable id.
 */
const ONE_AUTONOMY_TIER = SESSION_AUTONOMY_TIER_FILTER_OPTIONS.map(
  (option) => option.value
).slice(0, 1);

type CostSelectionCase = {
  name: string;
  costBuckets: string[];
  /** Hand-written. See the file docstring for why this is not derived. */
  admitted: boolean;
};

const COST_SELECTION_CASES: readonly CostSelectionCase[] = [
  { name: "no cost selection", costBuckets: [], admitted: true },
  {
    name: "every cost state (exhaustive)",
    costBuckets: [...ALL_COST_OPTION_IDS],
    admitted: true,
  },
  {
    name: "every cost state, duplicated",
    costBuckets: [...ALL_COST_OPTION_IDS, ...ALL_COST_OPTION_IDS],
    admitted: true,
  },
  {
    name: "every cost state plus an unrecognized id",
    costBuckets: [...ALL_COST_OPTION_IDS, "not_a_bucket"],
    admitted: true,
  },
  {
    name: "every numeric bucket but not Unknown",
    costBuckets: [...NUMERIC_COST_OPTION_IDS],
    admitted: false,
  },
  {
    name: "Unknown alone",
    costBuckets: [SESSION_UNKNOWN_COST_BUCKET_ID],
    admitted: false,
  },
  {
    name: "one numeric bucket alone",
    costBuckets: [NUMERIC_COST_OPTION_IDS[0] ?? ""],
    admitted: false,
  },
  {
    name: "one short of exhaustive",
    costBuckets: ALL_COST_OPTION_IDS.slice(1),
    admitted: false,
  },
  {
    name: "an unrecognized id alone",
    costBuckets: ["not_a_bucket"],
    admitted: false,
  },
  {
    name: "as many unrecognized ids as there are cost states",
    costBuckets: ALL_COST_OPTION_IDS.map((_, index) => `junk_${index}`),
    admitted: false,
  },
];

describe("the ISS-4481 exhaustive-cost carve-out, in both copies", () => {
  test("the cost vocabulary still has the shape this table assumes", () => {
    // Guards the derived rows: "every numeric bucket but not Unknown" and "one
    // short of exhaustive" only mean anything while Unknown is one option among
    // several. A vocabulary change that invalidated them would otherwise leave
    // the rows present and vacuous.
    assert.ok(
      ALL_COST_OPTION_IDS.includes(SESSION_UNKNOWN_COST_BUCKET_ID),
      "Unknown must be a selectable cost state"
    );
    assert.ok(
      NUMERIC_COST_OPTION_IDS.length >= 2,
      "expected at least two numeric buckets beside Unknown"
    );
  });

  for (const scenario of COST_SELECTION_CASES) {
    test(`${scenario.name}: both copies agree`, () => {
      const sanitized = query({ costBuckets: scenario.costBuckets });
      const listAdmits = hasNoLocalFacetFilters(sanitized);
      const usageAdmits = lightweightUsageLoadFitsQuery(sanitized);

      assert.equal(
        listAdmits,
        scenario.admitted,
        "hasNoLocalFacetFilters disagreed with the expected carve-out"
      );
      assert.equal(
        usageAdmits,
        scenario.admitted,
        "lightweightUsageLoadFitsQuery disagreed with the expected carve-out"
      );
      assert.equal(
        listAdmits,
        usageAdmits,
        "the two copies of the ISS-4481 carve-out have drifted apart"
      );
    });
  }
});

/**
 * The facets each predicate owns. The two lists are deliberately NOT the same
 * set — harness/model force the list fast path back to the matcher but ride the
 * lightweight usage rows fine, and free-text search is the reverse — so the
 * asymmetry is pinned here rather than left to be "unified" by a later reader.
 */
const LIST_FALLBACK_FACETS: readonly Partial<SanitizedQuery>[] = [
  { harnesses: ["claude"] },
  { models: ["opus"] },
  { autonomyTiers: [...ONE_AUTONOMY_TIER] },
  { costBuckets: [SESSION_UNKNOWN_COST_BUCKET_ID] },
  { changePresence: [SessionChangePresenceId.HasChanges] },
  { prAssociation: [SessionPrAssociationId.HasPr] },
];

const USAGE_FALLBACK_FACETS: readonly Partial<SanitizedQuery>[] = [
  { search: "auth" },
  { autonomyTiers: [...ONE_AUTONOMY_TIER] },
  { costBuckets: [SESSION_UNKNOWN_COST_BUCKET_ID] },
  { changePresence: [SessionChangePresenceId.HasChanges] },
  { prAssociation: [SessionPrAssociationId.HasPr] },
];

describe("the facet vocabularies these tables derive from", () => {
  test("Autonomy still offers a selectable tier", () => {
    // ONE_AUTONOMY_TIER is a slice of the option list. An emptied list would
    // turn both autonomy rows into no-facet queries, which assert the OPPOSITE
    // of what their names claim rather than failing.
    assert.equal(ONE_AUTONOMY_TIER.length, 1);
  });
});

describe("hasNoLocalFacetFilters", () => {
  test("an unfiltered query has no local facet filters", () => {
    assert.equal(hasNoLocalFacetFilters(query({})), true);
  });

  for (const facet of LIST_FALLBACK_FACETS) {
    test(`${describeFacet(facet)} forces the in-memory matcher`, () => {
      assert.equal(hasNoLocalFacetFilters(query(facet)), false);
    });
  }

  test("it ignores the facets other admission predicates own", () => {
    // Free-text search, the Repository/Status selections, the date window, the
    // sort and the quality segment are each gated by `canUseListCursorPage` /
    // `canPageBeforeLoading`, not here. Absorbing one of them into this
    // predicate would silently narrow both fast paths at once.
    assert.equal(hasNoLocalFacetFilters(query({ search: "auth" })), true);
    assert.equal(
      hasNoLocalFacetFilters(query({ repositories: ["closedloop-ai/x"] })),
      true
    );
    assert.equal(hasNoLocalFacetFilters(query({ statuses: ["active"] })), true);
    assert.equal(
      hasNoLocalFacetFilters(query({ startDate: new Date("2026-01-01") })),
      true
    );
  });
});

describe("lightweightUsageLoadFitsQuery", () => {
  test("an unfiltered query fits the lightweight usage load", () => {
    assert.equal(lightweightUsageLoadFitsQuery(query({})), true);
  });

  for (const facet of USAGE_FALLBACK_FACETS) {
    test(`${describeFacet(facet)} forces the full hydrate`, () => {
      assert.equal(lightweightUsageLoadFitsQuery(query(facet)), false);
    });
  }

  test("harness, model and repository stay on the lightweight rows", () => {
    // FEA-1834 keeps harness/model here (the lightweight rows carry both
    // values); ISS-5626 removed the Repository exclusion once the load resolved
    // each row's stored-first `repositoryFullName`. All three force
    // `hasNoLocalFacetFilters`-style fallback nowhere near this predicate.
    assert.equal(
      lightweightUsageLoadFitsQuery(query({ harnesses: ["claude"] })),
      true
    );
    assert.equal(
      lightweightUsageLoadFitsQuery(query({ models: ["opus"] })),
      true
    );
    assert.equal(
      lightweightUsageLoadFitsQuery(
        query({ repositories: ["closedloop-ai/x"] })
      ),
      true
    );
  });

  test("the two predicates diverge exactly where their rows do", () => {
    // The asymmetry is the point: neither predicate is a superset of the other,
    // so a refactor that collapses them into one must fail here.
    const harnessOnly = query({ harnesses: ["claude"] });
    assert.equal(hasNoLocalFacetFilters(harnessOnly), false);
    assert.equal(lightweightUsageLoadFitsQuery(harnessOnly), true);

    const searchOnly = query({ search: "auth" });
    assert.equal(hasNoLocalFacetFilters(searchOnly), true);
    assert.equal(lightweightUsageLoadFitsQuery(searchOnly), false);
  });
});

/**
 * The predicate reads exactly one thing off the source — whether
 * `listRepositoryScopedSessionIds` is present — so these carry only the reads
 * the contract makes mandatory, each returning an empty result. Nothing here is
 * ever called: giving them real bodies would suggest the predicate consults
 * them.
 */
const REQUIRED_SOURCE_READS = {
  listAllSessionCursorRows: () => [],
  listUpdatedSessionCursorRows: () => [],
  loadSyncedSessions: () => [],
};

const REPO_SCOPED_SOURCE: AgentSessionSyncSource = {
  ...REQUIRED_SOURCE_READS,
  listRepositoryScopedSessionIds: () => [],
};

/** A fake/legacy source: `resolveRepositoryScopedSessionIds` degrades to the
 * whole cursor list for it, so it can never push a window or sort down. */
const UNSCOPED_SOURCE: AgentSessionSyncSource = {
  ...REQUIRED_SOURCE_READS,
};

type WindowAndSortCase = {
  name: string;
  source: AgentSessionSyncSource;
  overrides: Partial<SanitizedQuery>;
  expected: boolean;
};

/**
 * The three arms of `canPageWindowAndSortBeforeHydration`, named so a case
 * cannot silently move between them:
 *
 *  1. neither windowed nor sorted — admitted unconditionally, source and
 *     repository selection irrelevant, because there is nothing to push down;
 *  2. windowed or sorted with no repository-scoped resolver to carry it —
 *     refused, since the branch it gates runs no in-memory matcher;
 *  3. windowed or sorted WITH that resolver — admitted only while the sort is
 *     one the cursor SQL has a column for.
 */
const WINDOW_AND_SORT_CASES: readonly WindowAndSortCase[] = [
  {
    name: "arm 1: neither windowed nor sorted, no repo scoping available",
    source: UNSCOPED_SOURCE,
    overrides: {},
    expected: true,
  },
  {
    name: "arm 1: neither windowed nor sorted, repo selection present",
    source: REPO_SCOPED_SOURCE,
    overrides: { repositories: ["closedloop-ai/x"] },
    expected: true,
  },
  {
    name: "arm 2: a start bound with no repository selection",
    source: REPO_SCOPED_SOURCE,
    overrides: { startDate: new Date("2026-01-01") },
    expected: false,
  },
  {
    name: "arm 2: an end bound with no repository selection",
    source: REPO_SCOPED_SOURCE,
    overrides: { endDate: new Date("2026-02-01") },
    expected: false,
  },
  {
    name: "arm 2: a cursor sort with no repository selection",
    source: REPO_SCOPED_SOURCE,
    overrides: { sortBy: SessionListCursorSortKey.LastActivity },
    expected: false,
  },
  {
    name: "arm 2: a repository selection the source cannot scope",
    source: UNSCOPED_SOURCE,
    overrides: {
      repositories: ["closedloop-ai/x"],
      startDate: new Date("2026-01-01"),
    },
    expected: false,
  },
  {
    name: "arm 3: a window a repository-scoped read can push down",
    source: REPO_SCOPED_SOURCE,
    overrides: {
      repositories: ["closedloop-ai/x"],
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-02-01"),
    },
    expected: true,
  },
  {
    name: "arm 3: the real Sessions request shape (window plus lastActivity)",
    source: REPO_SCOPED_SOURCE,
    overrides: {
      repositories: ["closedloop-ai/x"],
      startDate: new Date("2026-01-01"),
      sortBy: SessionListCursorSortKey.LastActivity,
    },
    expected: true,
  },
  {
    name: "arm 3: a started sort",
    source: REPO_SCOPED_SOURCE,
    overrides: {
      repositories: ["closedloop-ai/x"],
      sortBy: SessionListCursorSortKey.Started,
    },
    expected: true,
  },
  {
    name: "arm 3: a sort the cursor SQL has no column for",
    source: REPO_SCOPED_SOURCE,
    overrides: { repositories: ["closedloop-ai/x"], sortBy: "cost" },
    expected: false,
  },
  {
    name: "arm 3: a pushable window undone by an unpushable sort",
    source: REPO_SCOPED_SOURCE,
    overrides: {
      repositories: ["closedloop-ai/x"],
      startDate: new Date("2026-01-01"),
      sortBy: "cost",
    },
    expected: false,
  },
  {
    name: "arm 3: the Updated key is not a request-selectable sort",
    // `SessionListCursorSortKey.Updated` is the natural order an UNSORTED read
    // pages by, never a value a request carries; as a `sortBy` string it is a
    // column the repository-scoped SQL cannot order by.
    source: REPO_SCOPED_SOURCE,
    overrides: {
      repositories: ["closedloop-ai/x"],
      sortBy: SessionListCursorSortKey.Updated,
    },
    expected: false,
  },
];

describe("canPageWindowAndSortBeforeHydration", () => {
  for (const scenario of WINDOW_AND_SORT_CASES) {
    test(scenario.name, () => {
      assert.equal(
        canPageWindowAndSortBeforeHydration(
          scenario.source,
          query(scenario.overrides)
        ),
        scenario.expected
      );
    });
  }
});

function describeFacet(facet: Partial<SanitizedQuery>): string {
  return Object.keys(facet).join("+");
}

function query(overrides: Partial<SanitizedQuery>): SanitizedQuery {
  return {
    startDate: null,
    endDate: null,
    dateWindowField: SESSIONS_SURFACE_DATE_WINDOW_FIELD,
    completedAfter: null,
    harness: null,
    status: null,
    statuses: [],
    userId: null,
    userIds: [],
    scopeUnsatisfiable: false,
    repositories: [],
    harnesses: [],
    models: [],
    autonomyTiers: [],
    costBuckets: [],
    changePresence: [],
    prAssociation: [],
    priorities: [],
    quality: "all",
    search: null,
    countOnly: false,
    limit: 50,
    offset: 0,
    sortBy: null,
    sortDir: "desc",
    hasUnsupportedCloudFilter: false,
    ...overrides,
  };
}
