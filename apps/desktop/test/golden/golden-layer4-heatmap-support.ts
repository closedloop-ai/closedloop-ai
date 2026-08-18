/**
 * FEA-2650 Layer 4 — activity-heatmap derivation and assertion helpers.
 *
 * Extracted from `golden-layer4.ts` so the suite file carries the tests and the
 * per-suite wiring while this module owns one responsibility: turning
 * `session_turn_bucket` rows into the `(day|hour) -> {human, agent}` cell map the
 * heatmap query is supposed to produce, and asserting a rendered heatmap against
 * it (JS/SQL lockstep, `cells[].day ⊆ days[]`, and cell ordering).
 *
 * Nothing here touches a database or the corpus — every helper is a pure
 * function over rows/cells plus a `failures` accumulator, which is why it can
 * live outside the suite at all.
 */
import { isDeepStrictEqual } from "node:util";
import { formatLocalDayKey } from "../../src/main/database/db-helpers.js";

export type HeatmapExpectation = {
  day: string;
  hour: number;
  agent: number;
  human: number;
};

export type HeatmapData = {
  cells: Array<{ day: string; hour: number; human: number; agent: number }>;
  days: string[];
};

export function assertHeatmapCells(
  label: string,
  cells: Array<{ day: string; hour: number; agent: number; human: number }>,
  expectations: HeatmapExpectation[],
  failures: string[]
): void {
  for (const expected of expectations) {
    const cell = cells.find(
      (c) => c.day === expected.day && c.hour === expected.hour
    );
    if (!cell) {
      failures.push(
        `${label}: expected heatmap cell at (${expected.day}, ${expected.hour}) not found`
      );
      continue;
    }
    if (cell.agent !== expected.agent) {
      failures.push(
        `${label}: cell (${expected.day},${expected.hour}) agent=${cell.agent}, expected ${expected.agent}`
      );
    }
    if (cell.human !== expected.human) {
      failures.push(
        `${label}: cell (${expected.day},${expected.hour}) human=${cell.human}, expected ${expected.human}`
      );
    }
  }
}

export function assertCompleteSyntheticCellMap(
  label: string,
  cells: Array<{ day: string; hour: number; agent: number; human: number }>,
  expectedCells: HeatmapExpectation[],
  failures: string[]
): void {
  const expectedMap = new Map<string, HeatmapExpectation>();
  for (const e of expectedCells) {
    expectedMap.set(`${e.day}|${e.hour}`, e);
  }

  const actualNonzero = new Map<
    string,
    { day: string; hour: number; agent: number; human: number }
  >();
  for (const c of cells) {
    if (c.agent > 0 || c.human > 0) {
      actualNonzero.set(`${c.day}|${c.hour}`, c);
    }
  }

  const mismatches: string[] = [];
  for (const [key, expected] of expectedMap) {
    const actual = actualNonzero.get(key);
    if (!actual) {
      mismatches.push(
        `missing expected cell ${key} (a:${expected.agent},h:${expected.human})`
      );
    } else if (
      actual.agent !== expected.agent ||
      actual.human !== expected.human
    ) {
      mismatches.push(
        `cell ${key}: got (a:${actual.agent},h:${actual.human}), expected (a:${expected.agent},h:${expected.human})`
      );
    }
  }
  for (const [key, actual] of actualNonzero) {
    if (!expectedMap.has(key)) {
      mismatches.push(
        `unexpected nonzero cell ${key} (a:${actual.agent},h:${actual.human})`
      );
    }
  }

  if (mismatches.length > 0) {
    failures.push(
      `${label} complete cell map:\n    ${mismatches.join("\n    ")}`
    );
  }
}

export function compareDayHour(
  a: { day: string; hour: number },
  b: { day: string; hour: number }
): number {
  if (a.day < b.day) {
    return -1;
  }
  if (a.day > b.day) {
    return 1;
  }
  return a.hour - b.hour;
}

export function buildExpectedCellMap(
  turnBuckets: Array<{
    ts: string;
    turn_kind: string;
    turn_count: number | bigint;
  }>
): Map<string, { human: number; agent: number }> {
  const map = new Map<string, { human: number; agent: number }>();
  for (const row of turnBuckets) {
    const d = new Date(row.ts);
    const day = formatLocalDayKey(d);
    const hour = d.getHours();
    const key = `${day}|${hour}`;
    const cell = map.get(key) ?? { human: 0, agent: 0 };
    const count = Number(row.turn_count);
    if (row.turn_kind === "human") {
      cell.human += count;
    } else {
      cell.agent += count;
    }
    map.set(key, cell);
  }
  return map;
}

export function assertHeatmapCellMapLockstep(
  actualCellMap: Map<string, { human: number; agent: number }>,
  expectedCellMap: Map<string, { human: number; agent: number }>,
  failures: string[]
): void {
  if (isDeepStrictEqual(actualCellMap, expectedCellMap)) {
    return;
  }

  const onlyInExpected: string[] = [];
  const onlyInActual: string[] = [];
  const valueMismatch: string[] = [];
  for (const [key, exp] of expectedCellMap) {
    const act = actualCellMap.get(key);
    if (!act) {
      onlyInExpected.push(key);
    } else if (!isDeepStrictEqual(act, exp)) {
      valueMismatch.push(
        `${key}: SQL={h:${act.human},a:${act.agent}} JS={h:${exp.human},a:${exp.agent}}`
      );
    }
  }
  for (const key of actualCellMap.keys()) {
    if (!expectedCellMap.has(key)) {
      onlyInActual.push(key);
    }
  }
  failures.push(
    "TZ lockstep heatmap: SQL cells != JS-derived cells " +
      `(only-SQL: [${onlyInActual.join(",")}], only-JS: [${onlyInExpected.join(",")}], ` +
      `value-mismatch: [${valueMismatch.join("; ")}])`
  );
}

export function assertHeatmapDaysSubset(
  cells: Array<{ day: string; hour: number }>,
  days: string[],
  failures: string[]
): void {
  const axisDaySet = new Set(days);
  for (const cell of cells) {
    if (!axisDaySet.has(cell.day)) {
      failures.push(
        `TZ lockstep: heatmap cell day "${cell.day}" not in axis days`
      );
    }
  }
}

export function assertHeatmapCellsSorted(
  cells: Array<{ day: string; hour: number }>,
  failures: string[]
): void {
  for (let i = 1; i < cells.length; i++) {
    const prev = cells[i - 1];
    const curr = cells[i];
    if (compareDayHour(prev, curr) > 0) {
      failures.push(
        `heatmap cells not sorted at index ${i}: (${prev.day},${prev.hour}) > (${curr.day},${curr.hour})`
      );
      break;
    }
  }
}

export function assertTzLockstepHeatmap(
  heatmap: HeatmapData | undefined,
  expectedCellMap: Map<string, { human: number; agent: number }>,
  failures: string[]
): void {
  if (!heatmap) {
    return;
  }
  const actualCellMap = new Map<string, { human: number; agent: number }>();
  for (const cell of heatmap.cells) {
    actualCellMap.set(`${cell.day}|${cell.hour}`, {
      human: cell.human,
      agent: cell.agent,
    });
  }
  assertHeatmapCellMapLockstep(actualCellMap, expectedCellMap, failures);
  assertHeatmapDaysSubset(heatmap.cells, heatmap.days, failures);
  assertHeatmapCellsSorted(heatmap.cells, failures);
}
