/**
 * @file agent-components-page-data-request.test.ts
 * @description ISS-6822 — what the desktop main process does with a page-data
 * request it cannot trust.
 *
 * The renderer and the main process ship in one binary, but a structured-clone
 * payload still carries whatever the sender put in it. A cast here would not
 * throw on a bad request — it would quietly reduce a differently-narrowed
 * population and hand back numbers the Agents list presents as measured, with
 * the type tab and filter chips on screen still claiming the narrowing the
 * numbers no longer describe.
 *
 * The contract these cases pin has two halves, and only testing one of them
 * would let the other regress:
 *  - an ABSENT optional field defaults (so a renderer that predates a field
 *    still parses), and
 *  - a PRESENT, unusable field FAILS (so no request is silently answered as a
 *    different one).
 */

import assert from "node:assert/strict";
import {
  AGENT_COMPONENT_INVENTORY_CAP,
  AgentComponentKind,
  AgentComponentSortDir,
  AgentComponentSortKey,
  Harness,
} from "@repo/api/src/types/agent-component";
import {
  AGENT_COMPONENT_PAGE_DATA_MAX_FACET_VALUES,
  AGENT_COMPONENT_PAGE_SIZE,
} from "@repo/api/src/utils/agent-component-page-data";
import { test } from "vitest";
import {
  AGENT_COMPONENTS_PAGE_DATA_BAD_REQUEST_CODE,
  parseAgentComponentPageDataRequest,
} from "../src/main/dashboard/agent-components-page-data-local.js";

const WELL_FORMED = {
  filters: {
    kinds: [AgentComponentKind.Skill],
    collaborators: ["Ada"],
    sources: ["repo-a"],
    harnesses: [Harness.Codex],
    search: "orchestrator",
  },
  sortBy: AgentComponentSortKey.Invocations,
  sortDir: AgentComponentSortDir.Desc,
  page: 3,
  pageSize: 25,
  honestSource: true,
  dedupePluginRollups: true,
  startDate: "2026-06-01T00:00:00.000Z",
};

test("ISS-6822: a well-formed request survives parsing unchanged", () => {
  const request = parseAgentComponentPageDataRequest(WELL_FORMED);

  assert.deepEqual(request.filters.kinds, [AgentComponentKind.Skill]);
  assert.deepEqual(request.filters.collaborators, ["Ada"]);
  assert.deepEqual(request.filters.harnesses, [Harness.Codex]);
  assert.equal(request.filters.search, "orchestrator");
  assert.equal(request.sortBy, AgentComponentSortKey.Invocations);
  assert.equal(request.sortDir, AgentComponentSortDir.Desc);
  assert.equal(request.page, 3);
  assert.equal(request.pageSize, 25);
  assert.equal(request.honestSource, true);
  assert.equal(request.dedupePluginRollups, true);
  assert.equal(request.startDate, "2026-06-01T00:00:00.000Z");
});

test("ISS-6822: a renderer that predates a field still parses — absence defaults, closed", () => {
  // The compatibility half. An older renderer sends neither gate and no window;
  // both must land on their closed/all-time meaning rather than failing the read.
  const request = parseAgentComponentPageDataRequest({
    filters: { kinds: [], collaborators: [], sources: [], harnesses: [] },
    page: 0,
  });

  assert.equal(request.honestSource, false);
  assert.equal(request.dedupePluginRollups, false);
  assert.equal(request.startDate, undefined);
  assert.equal(request.sortBy, AgentComponentSortKey.Name);
  assert.equal(request.pageSize, AGENT_COMPONENT_PAGE_SIZE);
  assert.equal(request.filters.search, "");
});

test("ISS-6822: a narrowing this build cannot apply FAILS rather than being answered unnarrowed", () => {
  // A kind from a newer release. Defaulting `kinds` to `[]` here would return
  // the WHOLE inventory — page, facet counts and summary totals — to a caller
  // whose UI still shows a single type tab selected.
  assert.throws(
    () =>
      parseAgentComponentPageDataRequest({
        ...WELL_FORMED,
        filters: { ...WELL_FORMED.filters, kinds: ["quantum-agent"] },
      }),
    (error: Error) =>
      error.message.includes(AGENT_COMPONENTS_PAGE_DATA_BAD_REQUEST_CODE)
  );
});

test("ISS-6822: a present-but-unusable ordering, page, or gate FAILS rather than defaulting", () => {
  for (const bad of [
    { ...WELL_FORMED, sortBy: "entropy" },
    { ...WELL_FORMED, page: "second" },
    { ...WELL_FORMED, honestSource: "yes" },
    // Above the inventory cap: honoring it would make the bounded read
    // unbounded, and silently shrinking it would answer a different question.
    { ...WELL_FORMED, pageSize: AGENT_COMPONENT_INVENTORY_CAP + 1 },
  ]) {
    assert.throws(
      () => parseAgentComponentPageDataRequest(bad),
      (error: Error) =>
        error.message.includes(AGENT_COMPONENTS_PAGE_DATA_BAD_REQUEST_CODE),
      `expected a rejection for ${JSON.stringify(bad).slice(0, 80)}`
    );
  }
});

test("ISS-6888: a prior-window bound is CARRIED to the reader, not rejected and not stripped", () => {
  // BEHAVIOR CHANGED IN THIS DIFF, deliberately: this schema used to REJECT
  // `prevStart`/`prevEnd`, because `agentComponentsPageDataLocal` could not read
  // a preceding window and a silent strip would have let the summary cards
  // present "no prior period" for a comparison the renderer had asked for. That
  // reader now reads the preceding window (ISS-6888), so the honest answer to
  // both bounds is the baseline — and rejecting would break the very request the
  // shared list now issues on this source. What has NOT changed is the rule the
  // old rejection served: the bounds must still reach the reader intact rather
  // than being dropped on the floor, which is what these assertions pin.
  const parsed = parseAgentComponentPageDataRequest({
    ...WELL_FORMED,
    prevStart: "2026-04-01T00:00:00.000Z",
    prevEnd: "2026-06-01T00:00:00.000Z",
  });
  assert.equal(parsed.prevStart, "2026-04-01T00:00:00.000Z");
  assert.equal(parsed.prevEnd, "2026-06-01T00:00:00.000Z");
});

test("ISS-6888: a prior-window bound of the wrong TYPE still FAILS", () => {
  // The sibling that stops the case above from being satisfiable by `z.any()` or
  // by dropping the keys back out of the schema. A non-string bound is the shape
  // a structured clone can deliver from a skewed renderer, and it has no honest
  // coercion — a `Date`, a number of ms, and a `null` would each silently mean a
  // different window than the caller asked for.
  for (const badBound of [
    { prevStart: 1_776_000_000_000 },
    { prevEnd: null },
    { prevStart: new Date("2026-04-01T00:00:00.000Z") },
  ]) {
    assert.throws(
      () => parseAgentComponentPageDataRequest({ ...WELL_FORMED, ...badBound }),
      (error: Error) =>
        error.message.includes(AGENT_COMPONENTS_PAGE_DATA_BAD_REQUEST_CODE),
      `expected a rejection for ${JSON.stringify(badBound)}`
    );
  }
});

test("#6725: an UNPARSABLE window bound FAILS instead of being dropped downstream", () => {
  // whitlockk review on #6725. The type check above is not the whole rule: a bound
  // of `"not-a-date"` IS a string, so a type-only schema passed it through and
  // `coerceIsoBound` dropped it one layer down — leaving `prevEnd` to bound a
  // baseline that reached back over ALL history, and the summary cards to render
  // a delta against it with no error anywhere. Every bound is checked, because a
  // dropped `startDate` widens the CURRENT population the same way.
  for (const badBound of [
    { prevStart: "not-a-date" },
    { prevEnd: "not-a-date" },
    { startDate: "not-a-date" },
    // A shape that looks like a date and parses to NaN — the near-miss a
    // format check by eye would wave through.
    { startDate: "2026-13-45T99:99:99.000Z" },
  ]) {
    assert.throws(
      () => parseAgentComponentPageDataRequest({ ...WELL_FORMED, ...badBound }),
      (error: Error) =>
        error.message.includes(AGENT_COMPONENTS_PAGE_DATA_BAD_REQUEST_CODE),
      `expected a rejection for ${JSON.stringify(badBound)}`
    );
  }
});

test("#6725: a HALF-specified prior window FAILS, the same way the HTTP validator rejects it", () => {
  // The other half of the same defect. One bound alone is not "no baseline": a
  // lone `prevEnd` leaves the baseline unbounded below (every component ever
  // seen), and a lone `prevStart` overlaps the current window. Both report a
  // population difference as a usage change. `agentComponentsPageDataLocal`
  // guards on `prevStart && prevEnd`, which turns either into a silently missing
  // comparison rather than a stated one — so the rejection belongs here, at the
  // boundary, exactly as `agentComponentPageDataQuerySchema` does it for HTTP.
  for (const halfPair of [
    { prevStart: "2026-04-01T00:00:00.000Z" },
    { prevEnd: "2026-06-01T00:00:00.000Z" },
  ]) {
    assert.throws(
      () => parseAgentComponentPageDataRequest({ ...WELL_FORMED, ...halfPair }),
      (error: Error) =>
        error.message.includes(AGENT_COMPONENTS_PAGE_DATA_BAD_REQUEST_CODE),
      `expected a rejection for ${JSON.stringify(halfPair)}`
    );
  }

  // The paired case still parses, so neither assertion above is satisfiable by a
  // schema that has simply stopped accepting a prior window.
  const paired = parseAgentComponentPageDataRequest({
    ...WELL_FORMED,
    prevStart: "2026-04-01T00:00:00.000Z",
    prevEnd: "2026-06-01T00:00:00.000Z",
  });
  assert.equal(paired.prevStart, "2026-04-01T00:00:00.000Z");
  assert.equal(paired.prevEnd, "2026-06-01T00:00:00.000Z");
});

test("#6725: a bare calendar date is still ACCEPTED, matching the HTTP validator's permissiveness", () => {
  // The bound the range control can emit. Tightening to a full ISO timestamp
  // would be a different regression — a 400-equivalent on a request the surface
  // legitimately makes — so the shared predicate is `Date.parse`, not a format.
  const bareDates = parseAgentComponentPageDataRequest({
    ...WELL_FORMED,
    startDate: "2026-07-14",
    prevStart: "2026-05-14",
    prevEnd: "2026-06-14",
  });

  assert.equal(bareDates.startDate, "2026-07-14");
  assert.equal(bareDates.prevStart, "2026-05-14");
  assert.equal(bareDates.prevEnd, "2026-06-14");
});

test("ISS-6888: the unwindowed-universe ask defaults CLOSED for a renderer that predates it", () => {
  // Absence here means "an older renderer", and this reader never read an
  // unwindowed universe before ISS-6888. Defaulting it OPEN would hand such a
  // renderer a facet menu it has never shown, which is the same silent surface
  // change the rollout flag exists to withhold — so omission keeps the prior
  // behavior and only an explicit ask opens it.
  const omitted = parseAgentComponentPageDataRequest(WELL_FORMED);
  assert.equal(omitted.unwindowedFacetUniverse, false);

  const asked = parseAgentComponentPageDataRequest({
    ...WELL_FORMED,
    unwindowedFacetUniverse: true,
  });
  assert.equal(asked.unwindowedFacetUniverse, true);
});

test("ISS-6822: omitting the prior window — the no-baseline case — still parses", () => {
  // The other half, so the rejection above cannot be satisfied by a schema that
  // simply refuses every request. Absence is the normal desktop case and an
  // explicit `undefined` is what a structured clone of an omitted optional can
  // arrive as; both mean "no baseline asked for" and must survive.
  const omitted = parseAgentComponentPageDataRequest(WELL_FORMED);
  assert.equal(omitted.prevStart, undefined);
  assert.equal(omitted.prevEnd, undefined);

  const explicitlyUndefined = parseAgentComponentPageDataRequest({
    ...WELL_FORMED,
    prevStart: undefined,
    prevEnd: undefined,
  });
  assert.equal(explicitlyUndefined.prevStart, undefined);
  assert.equal(explicitlyUndefined.prevEnd, undefined);
  // The rest of the request is untouched by the two added keys.
  assert.equal(explicitlyUndefined.startDate, WELL_FORMED.startDate);
  assert.equal(explicitlyUndefined.filters.search, WELL_FORMED.filters.search);
});

test("ISS-6822: a missing or non-object request FAILS", () => {
  for (const value of [undefined, null, "not-a-request", 42]) {
    assert.throws(
      () => parseAgentComponentPageDataRequest(value),
      (error: Error) =>
        error.message.includes(AGENT_COMPONENTS_PAGE_DATA_BAD_REQUEST_CODE)
    );
  }
});

test("ISS-9073: a facet is de-duplicated and then capped at the SHARED cloud bound", () => {
  // `packages/app/agents/data-source` drives this reader and the cloud route
  // from one filter selection, so the two have to answer the same selection the
  // same way. The cap is read from the shared constant rather than written out,
  // which is what stops the local mirror drifting past the HTTP validator again.
  const repeated = parseAgentComponentPageDataRequest({
    ...WELL_FORMED,
    filters: {
      ...WELL_FORMED.filters,
      collaborators: Array.from(
        { length: AGENT_COMPONENT_PAGE_DATA_MAX_FACET_VALUES + 50 },
        () => "Ada"
      ),
    },
  });
  // One repeated value is one narrowing, not N of them: it collapses and parses.
  assert.deepEqual(repeated.filters.collaborators, ["Ada"]);

  const atCap = parseAgentComponentPageDataRequest({
    ...WELL_FORMED,
    filters: {
      ...WELL_FORMED.filters,
      sources: Array.from(
        { length: AGENT_COMPONENT_PAGE_DATA_MAX_FACET_VALUES },
        (_unused, index) => `repo-${index}`
      ),
    },
  });
  assert.equal(
    atCap.filters.sources.length,
    AGENT_COMPONENT_PAGE_DATA_MAX_FACET_VALUES
  );

  // One DISTINCT value past the cap fails whole. Truncating would answer a
  // narrower question than the chips on screen claim.
  assert.throws(
    () =>
      parseAgentComponentPageDataRequest({
        ...WELL_FORMED,
        filters: {
          ...WELL_FORMED.filters,
          sources: Array.from(
            { length: AGENT_COMPONENT_PAGE_DATA_MAX_FACET_VALUES + 1 },
            (_unused, index) => `repo-${index}`
          ),
        },
      }),
    (error: Error) =>
      error.message.includes(AGENT_COMPONENTS_PAGE_DATA_BAD_REQUEST_CODE)
  );
});
