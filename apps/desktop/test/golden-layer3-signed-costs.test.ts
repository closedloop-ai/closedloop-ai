/**
 * ISS-10166: counterfactuals for the Layer 3 signed-cost checks
 * (test/golden/golden-layer3-signed-costs.ts).
 *
 * The L3 suite reads corpus-expectations.yaml inside its own fixture, so a
 * perturbed signed leaf cannot be injected there. These cases feed the pure
 * checks an in-memory signed slice cloned from a real-shaped fixture and bump
 * ONE leaf: by 2e-6 (red — a 1e-6 bump on a half-microdollar tie leaf can land
 * at exactly 5e-7 and stay green, so 1e-6 would not prove the predicate) and
 * by 4e-7 (green — inside the tolerance, where 14 of the 64 real leaves sit).
 *
 * Everything here is synthetic — no corpus files, no SQLite.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { l3Key } from "./golden/golden-layer3-facts.js";
import {
  assertSignedCostKeysExercised,
  checkedSignedCostKeys,
  checkSignedCostConservation,
  checkSignedTokenAnalyticsCosts,
  checkSignedWindowCost,
  checkSignedWindowPerModelSpend,
  SIGNED_COST_KEYS,
  SIGNED_USD_TOLERANCE,
  withinSignedUsd,
} from "./golden/golden-layer3-signed-costs.js";

const RED_BUMP = 2e-6;
const GREEN_BUMP = 4e-7;

// A real tie leaf: the store sums to 136.6680035 and the human signed .003.
const TIE_SUM = 136.668_003_5;
const TIE_SIGNED = 136.668_003;
const SESSION_ID = "be42c362-31ba-4ac1-b4a5-65f447c2989d";

const signedFixture: {
  windows: Record<
    string,
    { cost_usd_store: number; per_model_spend_usd: Record<string, number> }
  >;
  cost_conservation_by_session: Record<
    string,
    { token_usage_usd: number; token_events_usd: number }
  >;
  byModel: Record<string, { cost_usd_events: number }>;
  byDay: Record<string, number>;
} = {
  windows: {
    "7": {
      cost_usd_store: 12.523_119,
      per_model_spend_usd: {
        "claude-opus-5": 11.908_916,
        "gpt-5.5": 0.410_157,
      },
    },
  },
  cost_conservation_by_session: {
    [SESSION_ID]: {
      token_usage_usd: TIE_SIGNED,
      token_events_usd: 136.668_004,
    },
  },
  byModel: { "claude-opus-4-8": { cost_usd_events: TIE_SIGNED } },
  byDay: { "2026-08-31": 12.523_12 },
};

const sums = {
  windowCost: 12.523_119_5,
  perModelSpend: new Map([
    ["claude-opus-5", 11.908_916_499_999_9],
    ["gpt-5.5", 0.410_157],
  ]),
  conservation: { usage: TIE_SUM, events: 136.668_003_500_000_08 },
  byModel: new Map([["claude-opus-4-8", { cost: TIE_SUM }]]),
  byDay: new Map([["2026-08-31", { cost: 12.523_119_500_000_002 }]]),
};

const WINDOW_7_KEY = /agg\.insights\.delivery\.7\.kpis\.cost_vs_signed/;
const PER_MODEL_7_KEY =
  /agg\.insights\.agents\.7\.charts\.per_model_spend_vs_signed_usd/;
const PER_MODEL_DETAIL = /claude-opus-5 actual=/;
const MISSING_MODEL_FALSE = /"big-pickle":false/;
const MISSING_MODEL_DETAIL = /big-pickle actual=undefined signed=0\.204046/;
const QUERY_NULL = /query=null/;
const USAGE_FALSE_EVENTS_TRUE = /got \{"usage":false,"events":true\}/;
const BY_MODEL_KEY = /by_model_cost_vs_signed_usd/;
const BY_MODEL_DETAIL = /claude-opus-4-8 actual=/;
const BY_DAY_KEY = /by_day_cost_vs_signed_usd/;
const MISSING_DAY_FALSE = /"2026-09-01":false/;
const MISSING_DAY_DETAIL = /2026-09-01 actual=undefined signed=0\.5/;
const THREE_UNASSERTED = /3 signed cost leaf\/leaves never asserted/;
const WINDOW_30_KEY = /agg\.insights\.delivery\.30\.kpis\.cost_vs_signed/;
const PER_MODEL_30_KEY =
  /agg\.insights\.agents\.30\.charts\.per_model_spend_vs_signed_usd/;
const ZERO_SESSION_KEY =
  /00000000-0000-0000-0000-000000000000 agg\.cost_conservation\.signed/;
const TIE_SESSION_PREFIX = new RegExp(`^${SESSION_ID} `);

function cloneSigned(): typeof signedFixture {
  return structuredClone(signedFixture);
}

test("withinSignedUsd: strictly less than 1e-6, a tie leaf at 5e-7 is inside", () => {
  assert.equal(SIGNED_USD_TOLERANCE, 1e-6);
  assert.equal(withinSignedUsd(TIE_SUM, TIE_SIGNED), true);
  // Exactly 1e-6 apart, both directions: strictly less means OUT.
  assert.equal(withinSignedUsd(0, SIGNED_USD_TOLERANCE), false);
  assert.equal(withinSignedUsd(SIGNED_USD_TOLERANCE, 0), false);
  assert.equal(withinSignedUsd(0, GREEN_BUMP), true);
});

test("signed fixture: every check is green on the unperturbed slice", () => {
  const failures: string[] = [];
  const signed = cloneSigned();
  checkSignedWindowCost(failures, "7", sums.windowCost, signed.windows["7"]);
  checkSignedWindowPerModelSpend(
    failures,
    "7",
    signed.windows["7"],
    sums.perModelSpend
  );
  checkSignedCostConservation(
    failures,
    SESSION_ID,
    sums.conservation,
    signed.cost_conservation_by_session[SESSION_ID]
  );
  checkSignedTokenAnalyticsCosts(
    failures,
    { byModel: signed.byModel, byDay: signed.byDay },
    { byModel: sums.byModel, byDay: sums.byDay }
  );
  assert.deepEqual(failures, []);
});

test("window cost: a 2e-6 move on the signed leaf is red, 4e-7 is green", () => {
  const red = cloneSigned();
  red.windows["7"].cost_usd_store += RED_BUMP;
  const redFailures: string[] = [];
  checkSignedWindowCost(redFailures, "7", sums.windowCost, red.windows["7"]);
  assert.equal(redFailures.length, 1);
  assert.match(redFailures[0], WINDOW_7_KEY);

  const green = cloneSigned();
  green.windows["7"].cost_usd_store += GREEN_BUMP;
  const greenFailures: string[] = [];
  checkSignedWindowCost(
    greenFailures,
    "7",
    sums.windowCost,
    green.windows["7"]
  );
  assert.deepEqual(greenFailures, []);
});

test("window cost: a non-number query value is a failure, not a skip", () => {
  const failures: string[] = [];
  checkSignedWindowCost(failures, "7", null, cloneSigned().windows["7"]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], QUERY_NULL);
});

test("per-model window spend: a 2e-6 move on a signed model is red, 4e-7 is green", () => {
  const red = cloneSigned();
  red.windows["7"].per_model_spend_usd["claude-opus-5"] += RED_BUMP;
  const redFailures: string[] = [];
  checkSignedWindowPerModelSpend(
    redFailures,
    "7",
    red.windows["7"],
    sums.perModelSpend
  );
  assert.equal(redFailures.length, 1);
  assert.match(redFailures[0], PER_MODEL_7_KEY);
  assert.match(redFailures[0], PER_MODEL_DETAIL);

  const green = cloneSigned();
  green.windows["7"].per_model_spend_usd["claude-opus-5"] += GREEN_BUMP;
  const greenFailures: string[] = [];
  checkSignedWindowPerModelSpend(
    greenFailures,
    "7",
    green.windows["7"],
    sums.perModelSpend
  );
  assert.deepEqual(greenFailures, []);
});

test("per-model window spend: a signed model the rows never priced is red, not skipped", () => {
  const signed = cloneSigned();
  signed.windows["7"].per_model_spend_usd["big-pickle"] = 0.204_046;
  const failures: string[] = [];
  checkSignedWindowPerModelSpend(
    failures,
    "7",
    signed.windows["7"],
    sums.perModelSpend
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], MISSING_MODEL_FALSE);
  assert.match(failures[0], MISSING_MODEL_DETAIL);
});

test("cost conservation: a 2e-6 move on a tie leaf is red, 4e-7 is green", () => {
  const red = cloneSigned();
  red.cost_conservation_by_session[SESSION_ID].token_usage_usd += RED_BUMP;
  const redFailures: string[] = [];
  checkSignedCostConservation(
    redFailures,
    SESSION_ID,
    sums.conservation,
    red.cost_conservation_by_session[SESSION_ID]
  );
  assert.equal(redFailures.length, 1);
  // The events leaf was not moved, so only the usage half reads false.
  assert.match(redFailures[0], USAGE_FALSE_EVENTS_TRUE);
  assert.match(redFailures[0], TIE_SESSION_PREFIX);

  const green = cloneSigned();
  green.cost_conservation_by_session[SESSION_ID].token_usage_usd += GREEN_BUMP;
  const greenFailures: string[] = [];
  checkSignedCostConservation(
    greenFailures,
    SESSION_ID,
    sums.conservation,
    green.cost_conservation_by_session[SESSION_ID]
  );
  assert.deepEqual(greenFailures, []);
});

test("by-model cost: a 2e-6 move on the signed leaf is red, 4e-7 is green", () => {
  const red = cloneSigned();
  red.byModel["claude-opus-4-8"].cost_usd_events -= RED_BUMP;
  const redFailures: string[] = [];
  checkSignedTokenAnalyticsCosts(
    redFailures,
    { byModel: red.byModel, byDay: red.byDay },
    { byModel: sums.byModel, byDay: sums.byDay }
  );
  assert.equal(redFailures.length, 1);
  assert.match(redFailures[0], BY_MODEL_KEY);
  assert.match(redFailures[0], BY_MODEL_DETAIL);

  const green = cloneSigned();
  green.byModel["claude-opus-4-8"].cost_usd_events -= GREEN_BUMP;
  const greenFailures: string[] = [];
  checkSignedTokenAnalyticsCosts(
    greenFailures,
    { byModel: green.byModel, byDay: green.byDay },
    { byModel: sums.byModel, byDay: sums.byDay }
  );
  assert.deepEqual(greenFailures, []);
});

test("by-day cost: a 2e-6 move on the signed leaf is red, 4e-7 is green", () => {
  const red = cloneSigned();
  red.byDay["2026-08-31"] += RED_BUMP;
  const redFailures: string[] = [];
  checkSignedTokenAnalyticsCosts(
    redFailures,
    { byModel: red.byModel, byDay: red.byDay },
    { byModel: sums.byModel, byDay: sums.byDay }
  );
  assert.equal(redFailures.length, 1);
  assert.match(redFailures[0], BY_DAY_KEY);

  const green = cloneSigned();
  green.byDay["2026-08-31"] += GREEN_BUMP;
  const greenFailures: string[] = [];
  checkSignedTokenAnalyticsCosts(
    greenFailures,
    { byModel: green.byModel, byDay: green.byDay },
    { byModel: sums.byModel, byDay: sums.byDay }
  );
  assert.deepEqual(greenFailures, []);
});

test("by-day cost: a signed day the rows never produced is red, not skipped", () => {
  const signed = cloneSigned();
  signed.byDay["2026-09-01"] = 0.5;
  const failures: string[] = [];
  checkSignedTokenAnalyticsCosts(
    failures,
    { byModel: signed.byModel, byDay: signed.byDay },
    { byModel: sums.byModel, byDay: sums.byDay }
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], MISSING_DAY_FALSE);
  assert.match(failures[0], MISSING_DAY_DETAIL);
});

test("wiring guard: names the signed leaves no check asserted this run", () => {
  // Prime the latch here rather than lean on the cases above having run: this
  // case owns both the exercised and the unexercised path.
  const signed = cloneSigned();
  const primed: string[] = [];
  checkSignedWindowCost(primed, "7", sums.windowCost, signed.windows["7"]);
  checkSignedWindowPerModelSpend(
    primed,
    "7",
    signed.windows["7"],
    sums.perModelSpend
  );
  checkSignedCostConservation(
    primed,
    SESSION_ID,
    sums.conservation,
    signed.cost_conservation_by_session[SESSION_ID]
  );
  checkSignedTokenAnalyticsCosts(
    primed,
    { byModel: signed.byModel, byDay: signed.byDay },
    { byModel: sums.byModel, byDay: sums.byDay }
  );
  assert.deepEqual(primed, []);
  // A slice carrying a window and a session nothing checked is what the guard
  // must name, and only those: both of the window's signed leaves, one session.
  const unexercised = {
    windows: { "7": { cost_usd_store: 0 }, "30": { cost_usd_store: 0 } },
    cost_conservation_by_session: {
      [SESSION_ID]: { token_usage_usd: 0, token_events_usd: 0 },
      "00000000-0000-0000-0000-000000000000": {
        token_usage_usd: 0,
        token_events_usd: 0,
      },
    },
  };
  assert.throws(assertSignedCostKeysExercised.bind(null, unexercised), (e) => {
    assert.ok(e instanceof Error);
    assert.match(e.message, THREE_UNASSERTED);
    assert.match(e.message, WINDOW_30_KEY);
    assert.match(e.message, PER_MODEL_30_KEY);
    assert.match(e.message, ZERO_SESSION_KEY);
    return true;
  });
  // And the exercised slice passes, because the latch holds what ran above.
  assert.ok(
    checkedSignedCostKeys.has(l3Key("corpus", SIGNED_COST_KEYS.WindowCost("7")))
  );
  assertSignedCostKeysExercised({
    windows: { "7": { cost_usd_store: 0 } },
    cost_conservation_by_session: {
      [SESSION_ID]: { token_usage_usd: 0, token_events_usd: 0 },
    },
  });
});
