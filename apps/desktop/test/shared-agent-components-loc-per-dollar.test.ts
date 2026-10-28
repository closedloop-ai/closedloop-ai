/**
 * @file shared-agent-components-loc-per-dollar.test.ts
 * @description ISS-6409 (#6417 review): the desktop LOC/$ fold had no unit test.
 *
 * Its cloud twin (`apps/api/app/agent-components/loc-per-dollar.ts`) gained one
 * in the same change, leaving the desktop copy covered only by a Playwright
 * spec — the slowest lane in the repo, and one that cannot say WHICH of the
 * two surfaces drifted. The two folds render the same `LOC / $` label on two
 * surfaces, so a guard fix landing in one copy and not the other is exactly
 * the cross-surface disagreement ISS-6409 exists to close.
 *
 * These cases mirror the cloud suite deliberately: the same corpus, the same
 * five candidate answers, so a divergence shows up as one suite red and the
 * other green rather than as a rendering difference nobody traced.
 */

import assert from "node:assert/strict";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { LOC_SOURCE_GIT } from "@repo/api/src/utils/session-loc";
import { test } from "vitest";
import { foldPopulationLocPerDollar } from "../src/main/dashboard/shared-agent-components-loc-per-dollar.js";
import type { SharedAgentSessionLocCost } from "../src/main/session/session-loc-cost.js";

const SHARED = "session-shared";
const ALPHA_SOLO = "session-alpha-solo";
const BRAVO_SOLO = "session-bravo-solo";

function locCost(loc: number, cost: number): SharedAgentSessionLocCost {
  return {
    branch: null,
    cost,
    // Always true on this surface — see SharedAgentSessionLocCost. The fixture
    // mirrors production rather than exercising a state desktop cannot reach.
    costMeasured: true,
    loc,
    locSource: LOC_SOURCE_GIT,
    repositoryFullName: null,
  };
}

function corpus() {
  return {
    components: [
      { kind: AgentComponentKind.Subagent, slug: "alpha" },
      { kind: AgentComponentKind.Subagent, slug: "bravo" },
    ],
    locCostBySession: new Map<string, SharedAgentSessionLocCost>([
      [SHARED, locCost(1000, 100)],
      [ALPHA_SOLO, locCost(100, 100)],
      [BRAVO_SOLO, locCost(200, 50)],
    ]),
    sessionIdsBySlug: new Map<string, Iterable<string>>([
      ["alpha", [SHARED, ALPHA_SOLO]],
      ["bravo", [SHARED, BRAVO_SOLO]],
    ]),
  };
}

test("desktop fold reads the union rate, matching the cloud twin", () => {
  const { components, sessionIdsBySlug, locCostBySession } = corpus();

  const result = foldPopulationLocPerDollar(
    components,
    sessionIdsBySlug,
    locCostBySession
  );

  // 1300 / 250. The wrong answers: 5.5 (alpha only), 6.571… (per-component
  // sum), 6.75 (unweighted mean of ratios).
  assert.equal(result.locPerDollar, 5.2);
  assert.equal(result.sampleSize, 2);
});

test("desktop fold skips a non-finite or negative session", () => {
  const { components, sessionIdsBySlug, locCostBySession } = corpus();
  sessionIdsBySlug.set("alpha", [
    SHARED,
    ALPHA_SOLO,
    "bad-nan",
    "bad-negative",
  ]);
  locCostBySession.set("bad-nan", locCost(50, Number.NaN));
  locCostBySession.set("bad-negative", locCost(-5, -5));

  const result = foldPopulationLocPerDollar(
    components,
    sessionIdsBySlug,
    locCostBySession
  );

  assert.equal(result.locPerDollar, 5.2);
  assert.equal(result.sampleSize, 2);
});

test("desktop fold excludes a non-verifiable kind", () => {
  const { components, sessionIdsBySlug, locCostBySession } = corpus();
  sessionIdsBySlug.set("grep", ["session-tool"]);
  locCostBySession.set("session-tool", locCost(9000, 1));

  const result = foldPopulationLocPerDollar(
    [...components, { kind: AgentComponentKind.Tool, slug: "grep" }],
    sessionIdsBySlug,
    locCostBySession
  );

  assert.equal(result.locPerDollar, 5.2);
  assert.equal(result.sampleSize, 2);
});

test("desktop fold zeroes the sample when the union cannot be measured", () => {
  const result = foldPopulationLocPerDollar(
    [
      { kind: AgentComponentKind.Subagent, slug: "alpha" },
      { kind: AgentComponentKind.Subagent, slug: "bravo" },
    ],
    new Map<string, Iterable<string>>([
      ["alpha", ["a"]],
      ["bravo", ["b"]],
    ]),
    new Map<string, SharedAgentSessionLocCost>([
      ["a", locCost(400, 0)],
      ["b", locCost(600, 0)],
    ])
  );

  assert.equal(result.locPerDollar, null);
  assert.equal(result.sampleSize, 0);
});

test("desktop fold counts a measured zero cost, matching the cloud twin", () => {
  const { components, sessionIdsBySlug, locCostBySession } = corpus();
  sessionIdsBySlug.set("bravo", [SHARED, BRAVO_SOLO, "free"]);
  locCostBySession.set("free", locCost(50, 0));

  const result = foldPopulationLocPerDollar(
    components,
    sessionIdsBySlug,
    locCostBySession
  );

  // 1350 / 250. A measured $0 is a real figure, so its lines count toward what
  // the spend bought (Cosimo, 2026-09-02). The cloud twin has the same case.
  assert.equal(result.locPerDollar, 5.4);
  assert.equal(result.sampleSize, 2);
});

test("desktop fold drops a session whose cost was not measured", () => {
  // ISS-11226: reachable in production now. `sumTokenUsage` carries cost-coverage
  // counters, so a session with no token rows — or with rows nobody priced —
  // arrives here with `costMeasured: false` instead of a hardcoded true.
  const { components, sessionIdsBySlug, locCostBySession } = corpus();
  sessionIdsBySlug.set("bravo", [SHARED, BRAVO_SOLO, "unmeasured"]);
  locCostBySession.set("unmeasured", {
    ...locCost(50, 0),
    costMeasured: false,
  });

  const result = foldPopulationLocPerDollar(
    components,
    sessionIdsBySlug,
    locCostBySession
  );

  assert.equal(result.locPerDollar, 5.2);
  assert.equal(result.sampleSize, 2);
});
