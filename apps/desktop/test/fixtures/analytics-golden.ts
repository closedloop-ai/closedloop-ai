import { readFileSync } from "node:fs";

import type { TokenAnalytics } from "../../src/shared/agent-db-contract.js";

// `Required<…>` so this fixture API carries the same all-keys invariant the
// projector enforces at runtime: `estimatedCostUsd` is optional on the canonical
// type, but every covered key must be present or the projection throws. Keeping
// it optional here would make an object that omits it type-correct and then fail
// at runtime. `keyof Required<T>` === `keyof T`, so the keys-covered guard in
// type-tests/analytics-golden-keys-covered.ts is unaffected.
export type TokenAnalyticsByModelInput = Required<
  TokenAnalytics["byModel"][number]
>;

export type TokenAnalyticsByModelRow = Record<string, number | string>;

// Single source of truth for the golden `byModel` key-set. The keys-covered type
// guard that fails `tsc` when the canonical `TokenAnalytics["byModel"][number]`
// type gains a field lives in `type-tests/analytics-golden-keys-covered.ts` —
// the only actively-typechecked home for it, since `test/**` is not compiled by
// any `tsc` script (FEA-3901). The `satisfies` below is a belt-and-suspenders
// in-file check (enforced transitively via that type-test's import) and drives
// the runtime projection key list.
export const TOKEN_ANALYTICS_BY_MODEL_KEYS = {
  model: true,
  inputTokens: true,
  outputTokens: true,
  sessions: true,
  estimatedCostUsd: true,
} as const satisfies Record<keyof TokenAnalyticsByModelInput, true>;

const tokenAnalyticsByModelRowKeys = Object.freeze(
  Object.keys(TOKEN_ANALYTICS_BY_MODEL_KEYS)
);

type SqliteGoldenFixture = {
  tokenAnalytics: {
    byModel: TokenAnalyticsByModelInput[];
  };
};

const sqliteGolden = JSON.parse(
  readFileSync(new URL("./sqlite-golden.json", import.meta.url), "utf8")
) as SqliteGoldenFixture;

// key-const → JSON link (FEA-3901): once the canonical type + keys const gain a
// field, this fails the `test:node` slice until every golden `byModel` row gains
// the field too. Every row is checked, not just the first.
assertGoldenByModelRowsCoverKeys(sqliteGolden.tokenAnalytics.byModel);

export function emptyExpectedByModelRows(): TokenAnalyticsByModelRow[] {
  return projectTokenAnalyticsByModelRows([]);
}

export function projectTokenAnalyticsByModelRows<Row extends object>(
  rows: readonly Row[]
): TokenAnalyticsByModelRow[] {
  return rows.map((row) => {
    const source = row as Record<string, unknown>;
    const projected: TokenAnalyticsByModelRow = {};
    for (const key of tokenAnalyticsByModelRowKeys) {
      const value = source[key];
      if (typeof value !== "number" && typeof value !== "string") {
        throw new Error(`Missing token analytics byModel field: ${key}`);
      }
      projected[key] = value;
    }
    return projected;
  });
}

export function sortTokenAnalyticsByModelRowsByModel(
  rows: readonly TokenAnalyticsByModelRow[]
): TokenAnalyticsByModelRow[] {
  return [...rows].sort((a, b) =>
    String(a.model).localeCompare(String(b.model))
  );
}

export function tokenAnalyticsByModelRow(
  row: TokenAnalyticsByModelInput
): TokenAnalyticsByModelRow {
  const [projected] = projectTokenAnalyticsByModelRows([row]);
  if (!projected) {
    throw new Error("Expected one token analytics byModel row");
  }
  return projected;
}

function assertGoldenByModelRowsCoverKeys(
  rows: readonly TokenAnalyticsByModelInput[]
): void {
  if (rows.length === 0) {
    throw new Error("Expected sqlite-golden tokenAnalytics.byModel rows");
  }
  // Delegate the per-key validation to the canonical validator
  // (projectTokenAnalyticsByModelRows throws when a row omits a covered key) so
  // the typeof check lives in one place; add row-index context for fixture drift.
  rows.forEach((row, index) => {
    try {
      projectTokenAnalyticsByModelRows([row]);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `sqlite-golden tokenAnalytics.byModel[${index}]: ${reason}`,
        { cause }
      );
    }
  });
}
