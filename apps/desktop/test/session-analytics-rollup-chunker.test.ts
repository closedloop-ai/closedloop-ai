/**
 * @file session-analytics-rollup-chunker.test.ts
 * @description FEA-3132 (D6) — packIdsByMetadataBudget groups session ids into
 * rollup chunks bounded by BOTH summed metadata bytes and a max count, so the
 * per-chunk json_each scan can't balloon on a large transcript. The rollup's
 * correctness depends on every id landing in exactly one chunk (no drop, no
 * duplication — the audit's no-double-count rule), so that invariant is pinned
 * hard here alongside the budgeting behavior.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { packIdsByMetadataBudget } from "../src/main/database/write-core.js";

function flat(chunks: string[][]): string[] {
  return chunks.flat();
}

test("every id appears exactly once, order preserved (no drop, no dup)", () => {
  const idBytes = Array.from({ length: 137 }, (_, i) => ({
    id: `s${i}`,
    bytes: (i % 7) * 100_000,
  }));
  const chunks = packIdsByMetadataBudget(idBytes, 1_000_000, 25);
  const out = flat(chunks);
  assert.equal(out.length, 137);
  assert.deepEqual(
    out,
    idBytes.map((x) => x.id)
  );
  assert.equal(new Set(out).size, 137);
});

test("count cap bounds chunk length", () => {
  const idBytes = Array.from({ length: 60 }, (_, i) => ({
    id: `s${i}`,
    bytes: 1,
  }));
  const chunks = packIdsByMetadataBudget(idBytes, 10_000_000, 25);
  assert.ok(chunks.every((c) => c.length <= 25));
  assert.equal(flat(chunks).length, 60);
  // 60 tiny ids / 25 = 3 chunks (25, 25, 10)
  assert.deepEqual(
    chunks.map((c) => c.length),
    [25, 25, 10]
  );
});

test("byte budget flushes before exceeding maxBytes", () => {
  // Each 4 MiB; budget 8 MiB → 2 per chunk regardless of the count cap.
  const four = 4 * 1024 * 1024;
  const idBytes = Array.from({ length: 5 }, (_, i) => ({
    id: `s${i}`,
    bytes: four,
  }));
  const chunks = packIdsByMetadataBudget(idBytes, 8 * 1024 * 1024, 25);
  assert.deepEqual(
    chunks.map((c) => c.length),
    [2, 2, 1]
  );
});

test("a single oversized session forms its own chunk", () => {
  const idBytes = [
    { id: "small-a", bytes: 100 },
    { id: "huge", bytes: 50 * 1024 * 1024 }, // 50 MiB, over the 8 MiB budget
    { id: "small-b", bytes: 100 },
  ];
  const chunks = packIdsByMetadataBudget(idBytes, 8 * 1024 * 1024, 25);
  // small-a flushes before huge; huge is alone; small-b starts fresh after.
  assert.deepEqual(chunks, [["small-a"], ["huge"], ["small-b"]]);
});

test("empty input yields no chunks; caps floor at 1", () => {
  assert.deepEqual(packIdsByMetadataBudget([], 8 * 1024 * 1024, 25), []);
  // Degenerate caps must not drop ids or loop forever.
  const idBytes = [
    { id: "a", bytes: 5 },
    { id: "b", bytes: 5 },
  ];
  const chunks = packIdsByMetadataBudget(idBytes, 0, 0);
  assert.deepEqual(flat(chunks), ["a", "b"]);
  assert.ok(chunks.every((c) => c.length === 1));
});
