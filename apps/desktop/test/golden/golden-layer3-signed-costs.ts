/**
 * ISS-10166 — the Layer 3 checks that compare a cost the suite SUMS from rows
 * (or reads raw off a query) against the 6-dp figure a human signed in
 * packages/golden-sessions/corpus-expectations.yaml.
 *
 * Until ISS-10166 every one of these went through `roundUsd` (cents) on both
 * sides, so a pricing regression that moved only the 3rd-6th decimal passed:
 * the four trailing digits in the signed file were decorative. The predicate
 * here is a TOLERANCE, `|actual - signed| < 1e-6` strictly, not a re-rounding:
 * 14 of the 64 signed leaves at the window-total and conservation sites sit on
 * an exact half-microdollar tie where any 6-dp rounding rule decides them by
 * float noise, and `<= 5e-7` fails one at 5.0000001e-7. A 1 µ$ move reddens
 * every non-tie leaf; 1.5 µ$ reddens all.
 *
 * NOT here, deliberately: `by_model_vs_signed`, `by_day_cost_vs_signed` and
 * `model_breakdown_vs_signed` compare the PRODUCTION query, which rounds to
 * cents (dashboard-queries.ts, `allocateRoundedUsdValues`) before the suite
 * sees it, so those stay at cents in golden-layer3.ts and the signed 6-dp pin
 * for the same leaves is the rows-derived twin below.
 *
 * Split out of golden-layer3.ts (grandfathered file-size ceiling) and kept
 * pure over `(signed slice, sums)` so the counterfactual test can perturb an
 * in-memory copy of a signed leaf — the yaml itself is read inside the suite's
 * fixture and is not injectable from outside.
 */
import type { CorpusYaml } from "./golden-layer3-corpus-schema.js";
import { checkFact, l3Key } from "./golden-layer3-facts.js";

export const SIGNED_USD_TOLERANCE = 1e-6;

/** Every l3Key this module has asserted in the running process. */
export const checkedSignedCostKeys = new Set<string>();

export const SIGNED_COST_KEYS = {
  WindowCost: (period: string) =>
    `agg.insights.delivery.${period}.kpis.cost_vs_signed`,
  WindowPerModelSpend: (period: string) =>
    `agg.insights.agents.${period}.charts.per_model_spend_vs_signed_usd`,
  CostConservation: "agg.cost_conservation.signed",
  ByModelCost: "agg.token_analytics.by_model_cost_vs_signed_usd",
  ByDayCost: "agg.token_analytics.by_day_cost_vs_signed_usd",
} as const;

export function withinSignedUsd(actual: number, signed: number): boolean {
  return Math.abs(actual - signed) < SIGNED_USD_TOLERANCE;
}

/**
 * `windows[period].cost_usd_store` vs the delivery `cost` KPI the query
 * returned. The query hands back the raw JS sum, so it is held to the signed
 * tolerance; a non-number here is a failure, not a skip.
 */
export function checkSignedWindowCost(
  failures: string[],
  period: string,
  costActual: unknown,
  win: Pick<CorpusYaml["windows"][string], "cost_usd_store">
): void {
  const key = SIGNED_COST_KEYS.WindowCost(period);
  checkedSignedCostKeys.add(l3Key("corpus", key));
  const isNumber = typeof costActual === "number";
  checkFact(
    failures,
    "corpus",
    key,
    isNumber && withinSignedUsd(costActual, win.cost_usd_store),
    true,
    isNumber
      ? diffDetail("cost", costActual, win.cost_usd_store)
      : `cost query=${String(costActual)} signed=${win.cost_usd_store}`
  );
}

/**
 * `windows[period].per_model_spend_usd` vs the suite's rows-derived per-model
 * spend map (`deriveSpendByModel`, the producer's own accumulation before it
 * rounds to 6 dp). The production `model_breakdown` chart is cent-allocated,
 * so this twin is the only reader of the signed digits.
 */
export function checkSignedWindowPerModelSpend(
  failures: string[],
  period: string,
  win: Pick<CorpusYaml["windows"][string], "per_model_spend_usd">,
  spend: ReadonlyMap<string, number>
): void {
  checkSignedRecord(
    failures,
    SIGNED_COST_KEYS.WindowPerModelSpend(period),
    win.per_model_spend_usd,
    spend
  );
}

/**
 * `cost_conservation_by_session[sid]` vs the per-session sums over
 * `token_usage` and `token_events` rows.
 */
export function checkSignedCostConservation(
  failures: string[],
  sessionId: string,
  sums: { usage: number; events: number },
  signed: CorpusYaml["cost_conservation_by_session"][string]
): void {
  const scope = { sessionId };
  checkedSignedCostKeys.add(l3Key(scope, SIGNED_COST_KEYS.CostConservation));
  checkFact(
    failures,
    scope,
    SIGNED_COST_KEYS.CostConservation,
    {
      usage: withinSignedUsd(sums.usage, signed.token_usage_usd),
      events: withinSignedUsd(sums.events, signed.token_events_usd),
    },
    { usage: true, events: true },
    `${diffDetail("usage", sums.usage, signed.token_usage_usd)}; ${diffDetail("events", sums.events, signed.token_events_usd)}`
  );
}

/**
 * The tz-dependent `token_analytics_30d.by_model[*].cost_usd_events` and
 * `token_events_cost_per_day_30d` leaves vs the suite's own rows-derived
 * per-model and per-day event-cost maps — the same accumulation the producer
 * runs before it rounds to 6 dp (derive-corpus-expectations.ts).
 *
 * One fact per section, keyed by model / day, so a missing or extra key is a
 * mismatch too rather than an unasserted leaf.
 */
export function checkSignedTokenAnalyticsCosts(
  failures: string[],
  signed: {
    byModel: Record<string, { cost_usd_events: number }>;
    byDay: Record<string, number>;
  },
  sums: {
    byModel: ReadonlyMap<string, { cost: number }>;
    byDay: ReadonlyMap<string, { cost: number }>;
  }
): void {
  checkSignedRecord(
    failures,
    SIGNED_COST_KEYS.ByModelCost,
    Object.fromEntries(
      Object.entries(signed.byModel).map(([m, v]) => [m, v.cost_usd_events])
    ),
    costOnly(sums.byModel)
  );
  checkSignedRecord(
    failures,
    SIGNED_COST_KEYS.ByDayCost,
    signed.byDay,
    costOnly(sums.byDay)
  );
}

/**
 * The wiring guard: every signed cost leaf the yaml carries must have been
 * asserted by one of the checks above during this run. Registered by the
 * suite after the aggregate tests, the same shape as its divergence sweep.
 */
export function assertSignedCostKeysExercised(yaml: {
  windows: Record<string, unknown>;
  cost_conservation_by_session: Record<string, unknown>;
}): void {
  const expected = [
    ...Object.keys(yaml.windows).flatMap((p) => [
      l3Key("corpus", SIGNED_COST_KEYS.WindowCost(p)),
      l3Key("corpus", SIGNED_COST_KEYS.WindowPerModelSpend(p)),
    ]),
    ...Object.keys(yaml.cost_conservation_by_session).map((sid) =>
      l3Key({ sessionId: sid }, SIGNED_COST_KEYS.CostConservation)
    ),
    l3Key("corpus", SIGNED_COST_KEYS.ByModelCost),
    l3Key("corpus", SIGNED_COST_KEYS.ByDayCost),
  ];
  const missing = expected.filter((k) => !checkedSignedCostKeys.has(k));
  if (missing.length > 0) {
    throw new Error(
      `golden layer3: ${missing.length} signed cost leaf/leaves never asserted this run — a check was unwired or its key path moved:\n  - ${missing.join("\n  - ")}`
    );
  }
}

function diffDetail(label: string, actual: number, signed: number): string {
  return `${label} actual=${actual} signed=${signed} diff=${Math.abs(actual - signed)}`;
}

function costOnly(
  sums: ReadonlyMap<string, { cost: number }>
): ReadonlyMap<string, number> {
  return new Map([...sums].map(([k, v]) => [k, v.cost]));
}

function checkSignedRecord(
  failures: string[],
  key: string,
  signed: Record<string, number>,
  sums: ReadonlyMap<string, number>
): void {
  checkedSignedCostKeys.add(l3Key("corpus", key));
  const keys = [...new Set([...Object.keys(signed), ...sums.keys()])].sort();
  const actual: Record<string, boolean> = {};
  const expected: Record<string, boolean> = {};
  const details: string[] = [];
  for (const k of keys) {
    expected[k] = true;
    const sum = sums.get(k);
    const signedValue = signed[k];
    if (sum === undefined || signedValue === undefined) {
      actual[k] = false;
      details.push(`${k} actual=${sum} signed=${signedValue}`);
      continue;
    }
    actual[k] = withinSignedUsd(sum, signedValue);
    if (!actual[k]) {
      details.push(diffDetail(k, sum, signedValue));
    }
  }
  checkFact(failures, "corpus", key, actual, expected, details.join("; "));
}
