/**
 * @file local-cloud-cost-coverage-parity.test.ts
 * @description ISS-11226 (review: whitlockk) — the Local/Cloud parity case for LOC/$
 * cost coverage.
 *
 * The two surfaces render the same card for the same session, so they must agree
 * on the question that decides whether the session is IN the LOC/$ population at
 * all: was its cost measured? They used to answer it with four separately-typed
 * expressions — the cloud row projection, the cloud fold, the desktop fold
 * (whose docstring asserted the predicate was "shared with the cloud" while
 * holding a copy), and the desktop per-session resolver. This suite pins that
 * they now answer it with one, `locPerDollarCostMeasured`.
 *
 * It drives PRODUCTION code on both sides and re-derives neither: the Local
 * verdict comes from `sessionLocCost`, the Cloud verdict from
 * `storedSessionCostCoverage`, and each case is then run through BOTH real
 * population folds so a drift shows up as a divergent population, not just a
 * divergent boolean.
 *
 * `persist-session-children.ts` is why one value can stand for both surfaces:
 * its `sessionDetail.update` is the LAST writer of `SessionDetail.estimatedCost`
 * and writes `analytics.estimatedCostUsd` — the same field the desktop resolver
 * reads — NULL-preserving.
 *
 * The two states whitlockk named are cases 4 and 5.
 */
import {
  AgentComponentKind,
  type AgentComponentKind as AgentComponentKindType,
} from "@repo/api/src/types/agent-component";
import { LOC_SOURCE_GIT } from "@repo/api/src/utils/session-loc";
import { describe, expect, it } from "vitest";
import type { SyncedAgentSession } from "../../desktop/src/main/agent-sync/agent-session-sync-contract.js";
import { foldPopulationLocPerDollar as foldLocalPopulation } from "../../desktop/src/main/dashboard/shared-agent-components-loc-per-dollar.js";
import {
  type SharedAgentSessionLocCost,
  sessionLocCost,
} from "../../desktop/src/main/session/session-loc-cost.js";
import { sumTokenUsage } from "../../desktop/src/main/session/session-usage-totals.js";
import {
  foldPopulationLocPerDollar as foldCloudPopulation,
  type SessionLocCost,
  storedSessionCostCoverage,
} from "../app/agent-components/loc-per-dollar";

const SESSION_ID = "session-parity";
const COMPONENT_SLUG = "subagent-parity";
const SESSION_LOC = 400;

type TokenRow = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number | null;
};

type ParityCase = {
  name: string;
  /**
   * The whole-session cost BOTH surfaces hold for this session: the desktop's
   * `sessionAnalytics.estimatedCostUsd` and, by the last-writer rule above, the
   * cloud's `SessionDetail.estimatedCost`. `undefined` is the session carrying
   * no analytics rollup at all, which is the only case the two differ in shape —
   * the cloud column is then whatever it last held, modelled here as `null`.
   */
  sharedCostUsd: number | null | undefined;
  tokenRows: TokenRow[];
  expectedMeasured: boolean;
  /**
   * The rate BOTH folds must publish for this session alone. `null` covers two
   * distinct situations the fold's own output cannot tell apart — the session
   * was excluded, or it was included at a $0 denominator, which is not a rate —
   * so `expectedMeasured` above is what separates them, asserted on the entry.
   * Costs are exact binary fractions so the expected ratio is a literal rather
   * than arithmetic re-derived from the input.
   */
  expectedLocPerDollar: number | null;
};

function tokenRow(estimatedCostUsd: number | null): TokenRow {
  return {
    model: "claude-opus-4",
    inputTokens: 10,
    outputTokens: 3,
    cacheReadTokens: 5,
    cacheWriteTokens: 2,
    estimatedCostUsd,
  };
}

const PARITY_CASES: ParityCase[] = [
  {
    name: "a fully priced session",
    sharedCostUsd: 0.25,
    tokenRows: [tokenRow(0.25)],
    expectedMeasured: true,
    expectedLocPerDollar: 1600,
  },
  {
    name: "a session priced at exactly $0 (measured, not absent)",
    sharedCostUsd: 0,
    tokenRows: [tokenRow(0)],
    expectedMeasured: true,
    // Included, but LOC over $0 is not a rate — both cards say unavailable.
    expectedLocPerDollar: null,
  },
  {
    name: "a session nothing could price",
    sharedCostUsd: null,
    tokenRows: [tokenRow(null)],
    expectedMeasured: false,
    expectedLocPerDollar: null,
  },
  {
    // whitlockk's second state. Web-search cost is a metadata line item that by
    // construction never appears in `tokenUsageByModel` (`webSearchCostSql`), so
    // a token-row coverage rule sees no members and calls a real figure unknown.
    // The cloud records it from metadata (`resolveTokenRollupColumns`), so an
    // all-rows rule here would drop a session the cloud card counts.
    name: "a web-search-only session, priced from metadata with no token rows",
    sharedCostUsd: 0.5,
    tokenRows: [],
    expectedMeasured: true,
    // The load-bearing number: an all-rows rule excluded this session, so Local
    // published no rate at all where Cloud published one.
    expectedLocPerDollar: 800,
  },
  {
    // whitlockk's first state. The desktop's own `sessionEstimatedCostSql` is
    // `WHEN NOT (fullyPriced) THEN NULL`, so a mixed window reaches BOTH surfaces
    // as null and both must exclude it. Parity is the assertion; the shared
    // value is what makes it one rule instead of two that happen to agree.
    name: "a partial token sum, whose authoritative whole-session cost is null",
    sharedCostUsd: null,
    tokenRows: [tokenRow(0.25), tokenRow(null)],
    expectedMeasured: false,
    expectedLocPerDollar: null,
  },
  {
    name: "a corrupt non-finite cost crossing the sync boundary",
    sharedCostUsd: Number.NaN,
    tokenRows: [tokenRow(0.25)],
    expectedMeasured: false,
    expectedLocPerDollar: null,
  },
  {
    name: "a corrupt negative cost crossing the sync boundary",
    sharedCostUsd: -1,
    tokenRows: [tokenRow(0.25)],
    expectedMeasured: false,
    expectedLocPerDollar: null,
  },
];

function localEntry(parityCase: ParityCase): SharedAgentSessionLocCost {
  const session = {
    branch: null,
    gitDiffStats: {
      linesAdded: SESSION_LOC,
      linesRemoved: 0,
      source: LOC_SOURCE_GIT,
    },
    tokenUsageByModel: parityCase.tokenRows,
    ...(parityCase.sharedCostUsd === undefined
      ? {}
      : { sessionAnalytics: { estimatedCostUsd: parityCase.sharedCostUsd } }),
  } as unknown as SyncedAgentSession;
  return sessionLocCost(session, sumTokenUsage(session));
}

function cloudEntry(parityCase: ParityCase): SessionLocCost {
  const { cost, costMeasured } = storedSessionCostCoverage(
    parityCase.sharedCostUsd ?? null
  );
  return {
    branch: null,
    cost,
    costMeasured,
    loc: SESSION_LOC,
    locSource: LOC_SOURCE_GIT,
    repositoryFullName: null,
    // Not part of this case, which reconciles the COST coverage verdict across
    // Local and Cloud. `null` rather than `0`: a zero here would claim a token
    // measurement this fixture never took.
    tokens: null,
  };
}

const COMPONENTS: readonly { slug: string; kind: AgentComponentKindType }[] = [
  { slug: COMPONENT_SLUG, kind: AgentComponentKind.Subagent },
];

function sessionIdsBySlug(): Map<string, Iterable<string>> {
  return new Map([[COMPONENT_SLUG, [SESSION_ID]]]);
}

describe("Local/Cloud LOC/$ cost-coverage parity", () => {
  it.each(PARITY_CASES)("agrees on $name", (parityCase) => {
    const local = localEntry(parityCase);
    const cloud = cloudEntry(parityCase);

    // The verdict itself, from each surface's own production derivation.
    expect(local.costMeasured).toBe(parityCase.expectedMeasured);
    expect(cloud.costMeasured).toBe(parityCase.expectedMeasured);
    expect(local.costMeasured).toBe(cloud.costMeasured);

    // And the consequence: the same session is IN, or OUT, of both real
    // population folds. A boolean that agreed while the folds disagreed would
    // still put two different numbers on the two cards.
    const localFold = foldLocalPopulation(
      COMPONENTS,
      sessionIdsBySlug(),
      new Map([[SESSION_ID, local]])
    );
    const cloudFold = foldCloudPopulation(
      COMPONENTS,
      sessionIdsBySlug(),
      new Map([[SESSION_ID, cloud]])
    );
    expect(localFold).toEqual(cloudFold);
    expect(localFold.locPerDollar).toBe(parityCase.expectedLocPerDollar);
  });

  it("counts a measured $0 session in BOTH populations, not neither", () => {
    // The null-versus-zero rule (Cosimo, 2026-09-02) stated as its own case: it is
    // the one the `?? 0` collapse this ticket removes used to make unanswerable,
    // and a fold that quietly went back to "zero means absent" would keep every
    // other case above green.
    const measuredZero: ParityCase = {
      name: "measured zero",
      sharedCostUsd: 0,
      tokenRows: [tokenRow(0)],
      expectedMeasured: true,
      expectedLocPerDollar: null,
    };
    const local = localEntry(measuredZero);
    const cloud = cloudEntry(measuredZero);

    expect(local.cost).toBe(0);
    expect(cloud.cost).toBe(0);
    expect(local.costMeasured).toBe(true);
    expect(cloud.costMeasured).toBe(true);

    // LOC over a $0 denominator is not a rate, so both folds report the session
    // as sampled and the ratio as unavailable — the same unavailable, on both.
    const localFold = foldLocalPopulation(
      COMPONENTS,
      sessionIdsBySlug(),
      new Map([[SESSION_ID, local]])
    );
    const cloudFold = foldCloudPopulation(
      COMPONENTS,
      sessionIdsBySlug(),
      new Map([[SESSION_ID, cloud]])
    );
    expect(localFold).toEqual(cloudFold);
  });
});
