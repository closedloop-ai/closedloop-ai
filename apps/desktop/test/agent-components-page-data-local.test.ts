/**
 * @file agent-components-page-data-local.test.ts
 * @description ISS-6822 — the desktop mirror of `GET /agent-components/page-data`,
 * read against a real seeded local store.
 *
 * The shared reduction is covered where it lives; what only this module can get
 * wrong is the ASSEMBLY: which population it reads, what it hands the reduction
 * as the facet universe, and whether it invents a prior-window baseline the
 * desktop has never had. Each case asserts a RETURNED VALUE.
 */

import assert from "node:assert/strict";
import {
  AgentComponentSortDir,
  AgentComponentSortKey,
} from "@repo/api/src/types/agent-component";
import type { AgentComponentPageDataRequest } from "@repo/api/src/utils/agent-component-page-data";
import { test } from "vitest";
import {
  AGENT_COMPONENTS_PAGE_DATA_BAD_REQUEST_CODE,
  agentComponentsPageDataLocal,
  parseAgentComponentPageDataRequest,
} from "../src/main/dashboard/agent-components-page-data-local.js";
import {
  insertComponent,
  insertUsage,
} from "./agent-components-test-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

/** Enough rows that a page-sized response is provably a SLICE of the population. */
const SEEDED_SKILLS = 7;
const PAGE_SIZE = 3;

function request(
  overrides: Partial<AgentComponentPageDataRequest> = {}
): AgentComponentPageDataRequest {
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
    pageSize: PAGE_SIZE,
    honestSource: false,
    dedupePluginRollups: false,
    // ISS-6888: the shared reader states this on every windowed read from a
    // window-capable source. Defaulted ON here so each case below opts OUT
    // deliberately rather than inheriting a closed gate it never mentions.
    unwindowedFacetUniverse: true,
    ...overrides,
  };
}

async function seedSkills(
  prisma: Parameters<typeof insertComponent>[0]
): Promise<void> {
  for (let index = 0; index < SEEDED_SKILLS; index += 1) {
    const key = `skill-${String(index).padStart(2, "0")}`;
    await insertComponent(prisma, {
      id: `c-${key}`,
      kind: "skill",
      externalId: `ext-${key}`,
      key,
      source: index % 2 === 0 ? "repo-a" : "repo-b",
    });
    await insertUsage(prisma, {
      sessionId: `s-${key}`,
      kind: "skill",
      key,
      agentComponentId: `c-${key}`,
      invocations: index + 1,
      lastInvokedAt: "2026-06-01T00:00:00.000Z",
    });
  }
}

/**
 * ISS-6888 — two components on opposite sides of one window boundary.
 *
 * `ACTIVE` was invoked after {@link CURRENT_WINDOW_START}; `IDLE` only before it.
 * A reader that APPLIES the bounds therefore sees a different single row in each
 * of the two windows, and an unwindowed read sees both — which is what lets one
 * seed prove the preceding baseline, the unwindowed facet universe, and the
 * absence of both when they are not asked for, without any of the four cases
 * being satisfiable by a reader that ignored its window.
 */
const CURRENT_WINDOW_START = "2026-05-01T00:00:00.000Z";
const PRIOR_WINDOW_START = "2026-01-01T00:00:00.000Z";
const ACTIVE_COMPONENT_NAME = "active-skill";
const ACTIVE_SOURCE = "repo-active";
const IDLE_SOURCE = "repo-idle";
const ACTIVE_INVOCATIONS = 4;
const IDLE_INVOCATIONS = 9;

async function seedSplitWindow(
  prisma: Parameters<typeof insertComponent>[0]
): Promise<void> {
  const rows = [
    {
      key: ACTIVE_COMPONENT_NAME,
      source: ACTIVE_SOURCE,
      invocations: ACTIVE_INVOCATIONS,
      lastInvokedAt: "2026-06-01T00:00:00.000Z",
    },
    {
      key: "idle-skill",
      source: IDLE_SOURCE,
      invocations: IDLE_INVOCATIONS,
      lastInvokedAt: "2026-02-01T00:00:00.000Z",
    },
  ];
  for (const row of rows) {
    await insertComponent(prisma, {
      id: `c-${row.key}`,
      kind: "skill",
      externalId: `ext-${row.key}`,
      key: row.key,
      source: row.source,
    });
    await insertUsage(prisma, {
      sessionId: `s-${row.key}`,
      kind: "skill",
      key: row.key,
      agentComponentId: `c-${row.key}`,
      invocations: row.invocations,
      lastInvokedAt: row.lastInvokedAt,
    });
  }
}

test("ISS-6822: the desktop page-data read returns ONE page while its total and facets describe the whole population", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedSkills(prisma);

    const result = await agentComponentsPageDataLocal(prisma, request());

    // Bounded at the RESPONSE, not at the population: the page is page-sized
    // while every aggregate still counts the whole inventory. A read that
    // narrowed the population to the page instead would return the same rows
    // with a total that silently agreed with them.
    assert.equal(result.items.length, PAGE_SIZE);
    assert.equal(result.filteredTotal, SEEDED_SKILLS);
    assert.equal(result.current.components, SEEDED_SKILLS);
    assert.equal(result.totalPages, Math.ceil(SEEDED_SKILLS / PAGE_SIZE));

    // The facet universe is that same population — both seeded sources are
    // offered, with counts summing to it.
    const sourceCounts = Object.fromEntries(
      result.facets.sources.map((option) => [option.id, option.count])
    );
    assert.equal(
      sourceCounts["repo-a"] + sourceCounts["repo-b"],
      SEEDED_SKILLS
    );
  } finally {
    await close();
  }
});

test("ISS-6822: a later page is the next slice of the SAME ordering, not a re-read", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedSkills(prisma);

    const first = await agentComponentsPageDataLocal(prisma, request());
    const second = await agentComponentsPageDataLocal(
      prisma,
      request({ page: 1 })
    );

    assert.equal(second.page, 1);
    const firstNames = first.items.map((row) => row.name);
    const secondNames = second.items.map((row) => row.name);
    assert.deepEqual(
      firstNames.filter((name) => secondNames.includes(name)),
      [],
      "pages must not overlap"
    );
    assert.deepEqual(
      [...firstNames, ...secondNames],
      [...firstNames, ...secondNames]
        .slice()
        .sort((a, b) => a.localeCompare(b)),
      "the two pages together must continue one ascending order"
    );
  } finally {
    await close();
  }
});

test("ISS-6888: the desktop read serves a REAL prior-window baseline when both bounds are sent", async () => {
  // BEHAVIOR CHANGED IN THIS DIFF, deliberately. This case used to assert the
  // opposite — that `previous` is always absent — and that WAS the contract while
  // the shared list refused to ask this source for a baseline. It refused because
  // its capability gate read `scope === "agent-components:http"`, a comparison
  // written by FEA-3178 when the local reader really did ignore the window and
  // never revisited after FEA-3196 taught it to apply the bounds. With the gate
  // now derived from a declared capability, this source is asked, and the honest
  // answer is the population the preceding window actually contains.
  //
  // The seed is what makes that provable: ACTIVE was invoked inside the current
  // window and IDLE only before it, so a reader that ignored the bounds would
  // return the same two rows for both windows and a delta of 0% — the fabricated
  // number the old suppression existed to prevent. Distinct counts are the proof
  // the bounds were APPLIED, not merely accepted.
  const { prisma, close } = await openTestPrisma();
  try {
    await seedSplitWindow(prisma);

    const result = await agentComponentsPageDataLocal(
      prisma,
      request({
        startDate: CURRENT_WINDOW_START,
        prevStart: PRIOR_WINDOW_START,
        prevEnd: CURRENT_WINDOW_START,
      })
    );

    assert.equal(result.current.components, 1);
    assert.notEqual(result.previous, undefined);
    assert.equal(result.previous?.components, 1);
    // Same COUNT, different POPULATION — so the assertion above cannot be
    // satisfied by handing the reduction the current window twice.
    assert.deepEqual(
      result.items.map((row) => row.name),
      [ACTIVE_COMPONENT_NAME]
    );
    assert.equal(result.previous?.invocations, IDLE_INVOCATIONS);
    assert.equal(result.current.invocations, ACTIVE_INVOCATIONS);
  } finally {
    await close();
  }
});

test("ISS-6888: no prior-window bounds still means NO baseline, never a zeroed one", async () => {
  // The sibling of the case above, and the half that must survive it: absence has
  // to keep meaning "there is no prior period", which the cards render as no
  // delta at all. A reader that answered every request with a baseline would put
  // a comparison on screen that nothing asked for.
  const { prisma, close } = await openTestPrisma();
  try {
    await seedSplitWindow(prisma);

    const result = await agentComponentsPageDataLocal(
      prisma,
      request({ startDate: CURRENT_WINDOW_START })
    );

    assert.equal("previous" in result, false);
    assert.equal(result.previous, undefined);
  } finally {
    await close();
  }
});

test("ISS-6888: the facet universe stays UNWINDOWED, so a source idle in the window keeps its option", async () => {
  // The half of ISS-6888 that a delta assertion cannot catch. Narrowing the facet
  // menu to the selected window silently REMOVES an owner or source whose
  // components were idle in it — the option disappears from the filter list, so
  // the one narrowing that would bring those rows back is the one the user can no
  // longer reach. The universe is therefore read unwindowed, and the idle source
  // stays listed at count 0.
  const { prisma, close } = await openTestPrisma();
  try {
    await seedSplitWindow(prisma);

    const result = await agentComponentsPageDataLocal(
      prisma,
      request({ startDate: CURRENT_WINDOW_START })
    );

    const sourceCounts = Object.fromEntries(
      result.facets.sources.map((option) => [option.id, option.count])
    );
    // Present as an OPTION...
    assert.ok(
      IDLE_SOURCE in sourceCounts,
      `expected "${IDLE_SOURCE}" to remain a filter option, got ${JSON.stringify(sourceCounts)}`
    );
    // ...and honestly counted at zero, not silently folded into the active one.
    assert.equal(sourceCounts[IDLE_SOURCE], 0);
    assert.equal(sourceCounts[ACTIVE_SOURCE], 1);
  } finally {
    await close();
  }
});

test("ISS-6888: a HALF-specified prior window is no baseline, exactly as an omitted one", async () => {
  // The reader gates the preceding read on `prevStart && prevEnd`, and the
  // schema's own docstring claims a half-specified pair means "no baseline".
  // Nothing exercised that: every other case sends both bounds or neither, so
  // weakening the `&&` to `||` stayed green while a lone `prevStart` would read a
  // window unbounded ABOVE — overlapping the current one — and put a fabricated
  // percentage on the summary cards as a measured comparison.
  const { prisma, close } = await openTestPrisma();
  try {
    await seedSplitWindow(prisma);

    for (const halfPair of [
      { prevStart: PRIOR_WINDOW_START },
      { prevEnd: CURRENT_WINDOW_START },
    ]) {
      const result = await agentComponentsPageDataLocal(
        prisma,
        request({ startDate: CURRENT_WINDOW_START, ...halfPair })
      );

      assert.equal(
        "previous" in result,
        false,
        `expected no baseline for ${JSON.stringify(halfPair)}`
      );
      assert.equal(result.previous, undefined);
    }
  } finally {
    await close();
  }
});

test("ISS-6888: the unwindowed universe is only read when the caller ASKS for it", async () => {
  // The rollout gate's other half. `startDate` alone must not authorize the
  // universe read: the bounded request carries it on every windowed read,
  // including from a source whose date-window capability is being withheld, so
  // inferring the ask from it leaked the zero-count facet options past the
  // closed flag. With the ask withheld the menu narrows to the window, which is
  // exactly what this reader did before ISS-6888.
  const { prisma, close } = await openTestPrisma();
  try {
    await seedSplitWindow(prisma);

    const withheld = await agentComponentsPageDataLocal(
      prisma,
      request({
        startDate: CURRENT_WINDOW_START,
        unwindowedFacetUniverse: false,
      })
    );

    const sourceCounts = Object.fromEntries(
      withheld.facets.sources.map((option) => [option.id, option.count])
    );
    assert.equal(IDLE_SOURCE in sourceCounts, false);
    assert.equal(sourceCounts[ACTIVE_SOURCE], 1);
    // The ROWS are unaffected either way — only the facet universe is withheld.
    assert.deepEqual(
      withheld.items.map((row) => row.name),
      [ACTIVE_COMPONENT_NAME]
    );
  } finally {
    await close();
  }
});

test("ISS-6888: with NO window selected the universe is the current population, not a second read", async () => {
  // The negative sibling of the case above. With no `startDate` the current
  // population already IS unwindowed, so both sources are offered at their real
  // counts — this is what distinguishes "the universe is read unwindowed" from
  // "the universe is always padded with zero-count options".
  const { prisma, close } = await openTestPrisma();
  try {
    await seedSplitWindow(prisma);

    const result = await agentComponentsPageDataLocal(prisma, request());

    const sourceCounts = Object.fromEntries(
      result.facets.sources.map((option) => [option.id, option.count])
    );
    assert.equal(sourceCounts[ACTIVE_SOURCE], 1);
    assert.equal(sourceCounts[IDLE_SOURCE], 1);
  } finally {
    await close();
  }
});

test("ISS-6822: a facet narrowing is applied to the rows AND to the totals they are counted in", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedSkills(prisma);

    const narrowed = await agentComponentsPageDataLocal(
      prisma,
      request({
        filters: {
          kinds: [],
          collaborators: [],
          sources: ["repo-a"],
          harnesses: [],
          search: "",
        },
      })
    );

    const expected = Math.ceil(SEEDED_SKILLS / 2);
    assert.equal(narrowed.filteredTotal, expected);
    assert.equal(narrowed.current.components, expected);
    // A narrowing that reached the rows but not the aggregate is the exact
    // "summary does not reconcile with its population" defect.
    assert.ok(narrowed.items.every((row) => row.source === "repo-a"));
  } finally {
    await close();
  }
});

test("#6725: an UNPARSABLE prevStart never reaches the read as a whole-history baseline", async () => {
  // whitlockk review on #6725, over the real store and through the IPC entry point
  // the handler calls — not the schema alone, because the damage was downstream
  // of it. `"not-a-date"` is a string, so a type-only schema admitted the pair;
  // `coerceIsoBound` then dropped the lower bound and the preceding read became
  // ALL history up to `prevEnd`, which here is the whole seeded inventory.
  const { prisma, close } = await openTestPrisma();
  try {
    await seedSplitWindow(prisma);

    const malformed = {
      ...request({ startDate: CURRENT_WINDOW_START }),
      prevStart: "not-a-date",
      prevEnd: CURRENT_WINDOW_START,
    };

    assert.throws(
      () => parseAgentComponentPageDataRequest(malformed),
      (error: Error) =>
        error.message.includes(AGENT_COMPONENTS_PAGE_DATA_BAD_REQUEST_CODE),
      "a half-valid prior window must be refused before any population is read"
    );

    // What the refusal is worth: the SAME request with a parsable lower bound
    // reads a baseline of exactly the idle component, so the rejection above is
    // withholding a real capability from a bad input rather than a schema that
    // has stopped accepting prior windows. Both halves in one case, because a
    // rejection test alone cannot tell those apart.
    const wellFormed = await agentComponentsPageDataLocal(
      prisma,
      parseAgentComponentPageDataRequest({
        ...malformed,
        prevStart: PRIOR_WINDOW_START,
      })
    );

    assert.equal(wellFormed.previous?.invocations, IDLE_INVOCATIONS);
    // The whole-history baseline the dropped bound produced would have counted
    // BOTH components, so this is the number that moved.
    assert.equal(wellFormed.previous?.components, 1);
    assert.equal(wellFormed.current.invocations, ACTIVE_INVOCATIONS);
  } finally {
    await close();
  }
});
