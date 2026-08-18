/**
 * @file sql-values-tuples.test.ts
 * @description Unit coverage for the SQL VALUES-tuple / param-cap chunk helpers
 * (`src/main/database/sql-values-tuples.ts`), extracted from `write-core.ts`
 * (ISS-4572). Pure functions — no DB — so pin the tuple text, the flat param
 * ordering, and the param-cap chunking arithmetic that keeps each multi-row
 * INSERT under the SQLite/libSQL bound-variable limit.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { EVENT_INSERT_PARAM_CAP } from "../src/main/database/db-constants.js";
import {
  buildValuesTuples,
  chunkRowsByParamCap,
  sqlValuesTuple,
} from "../src/main/database/sql-values-tuples.js";

test("sqlValuesTuple: numbers placeholders from base+1 for `count` params", () => {
  assert.equal(sqlValuesTuple(0, 3), "($1, $2, $3)");
  assert.equal(sqlValuesTuple(3, 2), "($4, $5)");
  assert.equal(sqlValuesTuple(0, 1), "($1)");
});

test("buildValuesTuples: emits one tuple per row and a flat param array in row order", () => {
  const { tuples, params } = buildValuesTuples([
    ["a", "b"],
    ["c", "d", "e"],
  ]);
  assert.deepEqual(tuples, ["($1, $2)", "($3, $4, $5)"]);
  assert.deepEqual(params, ["a", "b", "c", "d", "e"]);
});

test("chunkRowsByParamCap: caps rows per chunk so total params stay under the variable limit", () => {
  const columnCount = 10;
  const rowsPerChunk = Math.floor(EVENT_INSERT_PARAM_CAP / columnCount);
  // One more row than fits in a single chunk forces exactly two chunks.
  const rows = Array.from({ length: rowsPerChunk + 1 }, () =>
    Array.from({ length: columnCount }, () => 0)
  );
  const chunks = chunkRowsByParamCap(rows, columnCount);
  assert.equal(chunks.length, 2, "spills into a second chunk past the cap");
  assert.equal(
    chunks[0].length,
    rowsPerChunk,
    "first chunk is filled to the cap"
  );
  assert.equal(chunks[1].length, 1, "remainder in the second chunk");
  for (const chunk of chunks) {
    assert.ok(
      chunk.length * columnCount <= EVENT_INSERT_PARAM_CAP,
      "no chunk exceeds the bound-variable cap"
    );
  }
});

test("chunkRowsByParamCap: at least one row per chunk even when a single row exceeds the cap", () => {
  // A row wider than the cap can't be split, so the floor is 1 row/chunk.
  const chunks = chunkRowsByParamCap([[1], [2]], EVENT_INSERT_PARAM_CAP + 1);
  assert.deepEqual(chunks, [[[1]], [[2]]]);
});

test("chunkRowsByParamCap: empty input yields no chunks", () => {
  assert.deepEqual(chunkRowsByParamCap([], 5), []);
});
