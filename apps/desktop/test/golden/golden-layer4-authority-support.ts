import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  UtilizationInsightsResponse,
} from "@closedloop-ai/loops-api/insights";
import {
  findLayer4Divergence,
  LAYER4_CORPUS_SENTINEL,
} from "./golden-layer4-divergences.js";

export type Layer4Snapshot = {
  generatedBy: string;
  sourceNow: string;
  sections: {
    agents: AgentsInsightsResponse;
    utilization: UtilizationInsightsResponse;
    delivery: DeliveryInsightsResponse;
  };
};

const BRANCHES_WITHOUT_PR_KEY = "render.delivery.charts.branchesWithoutPr";
const BRANCHES_WITHOUT_PR_AVAILABILITY_KEY =
  "render.delivery.tileAvailability.chart:branchesWithoutPr";
const BRANCHES_WITHOUT_PR_DONUT_AVAILABILITY_KEY =
  "render.delivery.tileAvailability.chart:branchesWithoutPr:donut";

/**
 * Pin Desktop's known fail-closed authority result before projecting the signed
 * oracle value back into the broader dialect freeze.
 */
export function reconcileAuthorityDeliveryFreeze(
  actual: DeliveryInsightsResponse,
  oracle: DeliveryInsightsResponse
): { projectedActual: DeliveryInsightsResponse; firedKeys: string[] } {
  const actualAvailability = actual.tileAvailability;
  const oracleAvailability = oracle.tileAvailability;
  const oracleChartAvailability =
    oracleAvailability?.["chart:branchesWithoutPr"];
  const oracleDonutAvailability =
    oracleAvailability?.["chart:branchesWithoutPr:donut"];
  const firedKeys = [
    assertRegisteredAuthorityDivergence(
      BRANCHES_WITHOUT_PR_KEY,
      actual.charts.branchesWithoutPr,
      oracle.charts.branchesWithoutPr
    ),
    assertRegisteredAuthorityDivergence(
      BRANCHES_WITHOUT_PR_AVAILABILITY_KEY,
      actualAvailability?.["chart:branchesWithoutPr"],
      oracleChartAvailability
    ),
    assertRegisteredAuthorityDivergence(
      BRANCHES_WITHOUT_PR_DONUT_AVAILABILITY_KEY,
      actualAvailability?.["chart:branchesWithoutPr:donut"],
      oracleDonutAvailability
    ),
  ];
  if (
    oracleChartAvailability === undefined ||
    oracleDonutAvailability === undefined
  ) {
    throw new Error(
      "signed Layer 4 oracle lacks branch authority availability"
    );
  }
  return {
    projectedActual: {
      ...actual,
      charts: {
        ...actual.charts,
        branchesWithoutPr: oracle.charts.branchesWithoutPr,
      },
      tileAvailability: {
        ...actual.tileAvailability,
        "chart:branchesWithoutPr": oracleChartAvailability,
        "chart:branchesWithoutPr:donut": oracleDonutAvailability,
      },
    },
    firedKeys,
  };
}

/** Reconcile the authority-owned delivery subset and record registry coverage. */
export function reconcileAuthoritySnapshotFreeze(
  actual: Layer4Snapshot,
  oracle: Layer4Snapshot,
  firedKeys: Set<string>
): Layer4Snapshot {
  const reconciliation = reconcileAuthorityDeliveryFreeze(
    actual.sections.delivery,
    oracle.sections.delivery
  );
  for (const key of reconciliation.firedKeys) {
    firedKeys.add(key);
  }
  return {
    ...actual,
    sections: {
      ...actual.sections,
      delivery: reconciliation.projectedActual,
    },
  };
}

/** Assert the signed render freeze after isolating registered authority drift. */
export function assertRenderAggregatesFreeze(
  snapshot: Layer4Snapshot,
  tz: string,
  fixturePath: string,
  writeSnapshots: boolean,
  failures: string[],
  firedKeys: Set<string>
): void {
  if (writeSnapshots) {
    writeRenderAggregatesFixture(snapshot, fixturePath, firedKeys);
    return;
  }
  if (tz !== "UTC") {
    return;
  }
  if (!existsSync(fixturePath)) {
    failures.push(
      `render-aggregates fixture missing: ${fixturePath} — generate via GOLDEN_L4_WRITE_SNAPSHOTS=1 (UTC suite)`
    );
    return;
  }
  const frozen: Layer4Snapshot = JSON.parse(readFileSync(fixturePath, "utf8"));
  const projected = reconcileAuthoritySnapshotFreeze(
    snapshot,
    frozen,
    firedKeys
  );
  if (!isDeepStrictEqual(projected, frozen)) {
    failures.push(
      "render-aggregates fixture drift — corpus output no longer matches the frozen fixture. " +
        "Regenerate via GOLDEN_L4_WRITE_SNAPSHOTS=1 (UTC suite), verify, then freeze."
    );
  }
}

/**
 * Freeze a regenerated snapshot WITHOUT laundering the registered authority
 * divergences (ISS-8751).
 *
 * The authority-owned keys (`charts.branchesWithoutPr` and its two tile
 * availabilities) are the one part of this fixture that is NOT Desktop's own
 * output: offline Desktop fails them closed, and the signed oracle records what
 * the semantic contract says they should be, so the ISS-5828 registry can hold
 * the two apart.
 *
 * This used to write `snapshot` verbatim, which copied Desktop's fail-closed
 * values over the oracle's. That makes `actual === oracle`, the divergence stops
 * reproducing, and the next reader deletes the registry entry as stale -- turning
 * a tracked bug into blessed behavior. Carrying the authority subtree forward
 * from the existing fixture keeps the contrast, and reusing the same reconcile
 * the read path uses means the bytes written are exactly the bytes that will be
 * compared. It also populates `firedKeys`, so a regen run proves every
 * registered divergence still reproduces instead of skipping that check.
 *
 * With no existing fixture there is nothing to carry forward, and writing raw
 * output would silently bless the bug -- so that case refuses rather than
 * guessing. Deriving the authority values for a brand-new fixture is an
 * oracle-review step, not something a regen flag may do.
 */
function writeRenderAggregatesFixture(
  snapshot: Layer4Snapshot,
  fixturePath: string,
  firedKeys: Set<string>
): void {
  if (!existsSync(fixturePath)) {
    throw new Error(
      `Refusing to generate ${fixturePath} from Desktop output alone: the ` +
        "authority-owned delivery keys would be frozen at their fail-closed " +
        "values, silently blessing the ISS-5828 divergence. Derive those values " +
        "from the semantic contract and seed the fixture before regenerating."
    );
  }
  const frozen: Layer4Snapshot = JSON.parse(readFileSync(fixturePath, "utf8"));
  const projected = reconcileAuthoritySnapshotFreeze(
    snapshot,
    frozen,
    firedKeys
  );
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, `${JSON.stringify(projected, null, 2)}\n`);
}

/** Three-way guard: current divergence, resolved divergence, or new regression. */
export function assertRegisteredAuthorityDivergence(
  key: string,
  actual: unknown,
  oracle: unknown
): string {
  const entry = findLayer4Divergence(LAYER4_CORPUS_SENTINEL, key);
  if (!entry) {
    throw new Error(`missing Layer 4 divergence registry entry for ${key}`);
  }
  if (isDeepStrictEqual(actual, oracle)) {
    throw new Error(
      `${key} stopped diverging from the signed oracle; remove the registry entry`
    );
  }
  if (!isDeepStrictEqual(actual, entry.actual)) {
    throw new Error(`${key} drifted to a third value outside ${entry.ticket}`);
  }
  return `${entry.sessionId} ${entry.key}`;
}
