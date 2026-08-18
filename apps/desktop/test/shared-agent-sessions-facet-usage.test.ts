/**
 * ISS-5283 (desktop half) — a filtered facet's option counts exclude their own
 * dimension.
 *
 * Both directions are covered, for the same reason the cloud twin's test covers
 * both: the reported defect is the facet counts staying GLOBAL under an active
 * selection, but the obvious over-correction — scoping every facet by the full
 * filter set — collapses a facet to the value already chosen and makes it a
 * one-way door. A test proving only the first would pass on the worse bug.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFacetScopedCounts,
  isFacetDimensionFiltered,
  omitFacetDimension,
  SessionFacetDimension,
} from "../src/main/session/shared-agent-sessions-facet-usage.js";
import type {
  SharedAgentSessionsListRequest,
  SharedAgentSessionUsageSummary,
} from "../src/shared/shared-agent-sessions-contract.js";
import { emptySharedAgentSessionsUsageSummary } from "../src/shared/shared-agent-sessions-contract.js";

const OWNER_ID = "user_owner";
const HARNESS = "codex";

/**
 * A stand-in usage reader that answers from the request it is handed, so a test
 * asserts on what the relaxed READ asked for rather than on a canned reply that
 * would be identical however the request was built.
 */
function readerReturningHarnesses(seen: SharedAgentSessionsListRequest[]) {
  return (request: SharedAgentSessionsListRequest) => {
    seen.push(request);
    const harnesses =
      request.harnesses === undefined
        ? ["codex", "claude"]
        : [...request.harnesses];
    const summary: SharedAgentSessionUsageSummary = {
      ...emptySharedAgentSessionsUsageSummary(),
      byHarness: harnesses.map((harness) => ({
        harness,
        sessionCount: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
      })),
    };
    return Promise.resolve(summary);
  };
}

test("a filtered Harness facet lists the harnesses the user could switch to (ISS-5283)", async () => {
  const seen: SharedAgentSessionsListRequest[] = [];
  const fullyFiltered: SharedAgentSessionUsageSummary = {
    ...emptySharedAgentSessionsUsageSummary(),
    totalSessions: 7,
    byHarness: [
      {
        harness: HARNESS,
        sessionCount: 7,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
      },
    ],
  };
  const request: SharedAgentSessionsListRequest = {
    startDate: "2026-01-01T00:00:00.000Z",
    harnesses: [HARNESS],
  };

  const scoped = await applyFacetScopedCounts(
    fullyFiltered,
    request,
    readerReturningHarnesses(seen)
  );

  // The WIDENING direction: the Harness facet no longer collapses to the one
  // value already selected.
  assert.deepEqual(
    scoped.byHarness.map((entry) => entry.harness),
    ["codex", "claude"]
  );
  // The relaxed read dropped ONLY the harness selection — the date window (and
  // every other AND constraint) survived, or the facet would be counting a
  // population the table never describes.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].harnesses, undefined);
  assert.equal(seen[0].startDate, "2026-01-01T00:00:00.000Z");
  // The TOTALS still describe the current view.
  assert.equal(scoped.totalSessions, 7);
});

test("an unfiltered dimension issues no extra read and reuses the summary (ISS-5283)", async () => {
  const seen: SharedAgentSessionsListRequest[] = [];
  const summary = emptySharedAgentSessionsUsageSummary();

  const scoped = await applyFacetScopedCounts(
    summary,
    { startDate: "2026-01-01T00:00:00.000Z" },
    readerReturningHarnesses(seen)
  );

  // Reference equality is the assertion that matters: it proves the common,
  // unfiltered Sessions read performs exactly the reads it did before.
  assert.equal(scoped, summary);
  assert.equal(seen.length, 0);
});

test("only the filtered dimensions are re-read (ISS-5283)", async () => {
  const seen: SharedAgentSessionsListRequest[] = [];

  await applyFacetScopedCounts(
    emptySharedAgentSessionsUsageSummary(),
    { harnesses: [HARNESS], userIds: [OWNER_ID] },
    readerReturningHarnesses(seen)
  );

  // Two facets operated ⇒ two relaxed reads, not four.
  assert.equal(seen.length, 2);
});

test("the legacy single-value harness field also counts as a filtered facet (ISS-5283)", () => {
  // The local query builder still honors `harness`; excluding only the plural
  // form would leave a live harness predicate inside the Harness facet's own
  // count for a version-skewed client.
  assert.equal(
    isFacetDimensionFiltered(
      { harness: HARNESS },
      SessionFacetDimension.Harness
    ),
    true
  );
  const relaxed = omitFacetDimension(
    { harness: HARNESS, harnesses: [HARNESS] },
    SessionFacetDimension.Harness
  );
  assert.equal(relaxed.harness, undefined);
  assert.equal(relaxed.harnesses, undefined);
});

test("the Owner facet lifts `userIds` but never the pinned `userId` scope (ISS-5283)", () => {
  // FEA-4304: `userId` is an AND constraint the Owner facet is not permitted to
  // widen — dropping it would reintroduce the cross-user leak that closed.
  const relaxed = omitFacetDimension(
    { userId: "scoped_user", userIds: [OWNER_ID] },
    SessionFacetDimension.Owner
  );
  assert.equal(relaxed.userIds, undefined);
  assert.equal(relaxed.userId, "scoped_user");
});
