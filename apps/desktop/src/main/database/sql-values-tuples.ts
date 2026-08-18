/**
 * @file sql-values-tuples.ts
 * @description Pure helpers for building multi-row `INSERT ... VALUES (...), (...)`
 * parameter tuples for the desktop SQLite write path, extracted from `write-core.ts`
 * (ISS-4572 — keeping that grandfathered over-ceiling file shrinking, not growing,
 * per the root AGENTS.md shrink-only guardrail). These are the shared chunk-by-
 * param-cap primitives the event-insert path AND the artifact-link upsert path both
 * use to keep each statement's bound-parameter count under the SQLite/libSQL
 * variable limit. No DB access, no `write-core.ts` dependency — a leaf module.
 */
import { EVENT_INSERT_PARAM_CAP } from "./db-constants.js";

/**
 * Build a `($n, $n+1, …)` VALUES tuple for `count` params starting after the
 * `base` params already accumulated.
 */
export function sqlValuesTuple(base: number, count: number): string {
  const cells: string[] = [];
  for (let i = 1; i <= count; i++) {
    cells.push(`$${base + i}`);
  }
  return `(${cells.join(", ")})`;
}

/**
 * Split rows into chunks whose total bound-parameter count stays under the
 * per-statement variable cap ({@link EVENT_INSERT_PARAM_CAP}).
 */
export function chunkRowsByParamCap(
  rows: unknown[][],
  columnCount: number
): unknown[][][] {
  const rowsPerChunk = Math.max(
    1,
    Math.floor(EVENT_INSERT_PARAM_CAP / columnCount)
  );
  const chunks: unknown[][][] = [];
  for (let i = 0; i < rows.length; i += rowsPerChunk) {
    chunks.push(rows.slice(i, i + rowsPerChunk));
  }
  return chunks;
}

/** Build the `VALUES (...), (...)` tuple list and flat param array for one chunk. */
export function buildValuesTuples(rows: unknown[][]): {
  tuples: string[];
  params: unknown[];
} {
  const tuples: string[] = [];
  const params: unknown[] = [];
  for (const row of rows) {
    tuples.push(sqlValuesTuple(params.length, row.length));
    params.push(...row);
  }
  return { tuples, params };
}
