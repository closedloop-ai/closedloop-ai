import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidTokenCountError } from "@repo/lib/harness/token-counts";
import type { SqliteTokenEventRow } from "../src/main/database/db-row-types.js";
import {
  mapTraceTokenEvents,
  normalizeTraceTokenEvent,
} from "../src/main/database/trace-token-event-mapper.js";

const CREATED_AT = "2026-08-05T09:00:00.000Z";
// 2^53 — one past Number.MAX_SAFE_INTEGER, the shape a version-skewed writer
// widens a stored BIGINT counter to.
const UNSAFE_INTEGER_TOKEN = "9007199254740992";

// The session-trace suites build `SessionTraceSyncInput["tokenEvents"]` from a
// hand-written fixture, which bypasses this mapper entirely — so the one
// non-trivial thing it does (FEA-3419: a NULL TTL column stays `null` while a
// real `0` stays `0`) had no coverage. Collapsing the optional branch to a plain
// `tokenCountValue` would silently report "never reported" as "reported zero" in
// the 1h-correct fallback pricing that reads these fields.

function tokenEventRow(
  overrides: Partial<SqliteTokenEventRow> = {}
): SqliteTokenEventRow {
  return {
    session_id: "session-1",
    transport_id: null,
    model: "claude-opus-5",
    created_at: CREATED_AT,
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 30,
    cache_write_tokens: 40,
    cost_usd_estimated: null,
    input_cost_usd_estimated: null,
    output_cost_usd_estimated: null,
    cache_read_cost_usd_estimated: null,
    cache_creation_cost_usd_estimated: null,
    source_identity: null,
    cost_summary: null,
    ...overrides,
  };
}

test("an unpopulated cache-write TTL column stays null, never coerced to 0", () => {
  const absent = normalizeTraceTokenEvent(tokenEventRow());
  assert.equal(absent.cache_write_5m_tokens, null);
  assert.equal(absent.cache_write_1h_tokens, null);

  const explicitNull = normalizeTraceTokenEvent(
    tokenEventRow({ cache_write_5m_tokens: null, cache_write_1h_tokens: null })
  );
  assert.equal(explicitNull.cache_write_5m_tokens, null);
  assert.equal(explicitNull.cache_write_1h_tokens, null);
});

test("a reported zero TTL subdivision stays 0, distinguishable from unknown", () => {
  const mapped = normalizeTraceTokenEvent(
    tokenEventRow({ cache_write_5m_tokens: 0, cache_write_1h_tokens: 0 })
  );
  assert.equal(mapped.cache_write_5m_tokens, 0);
  assert.equal(mapped.cache_write_1h_tokens, 0);
});

test("storage forms (bigint, numeric string) coerce to JS numbers", () => {
  const mapped = normalizeTraceTokenEvent(
    tokenEventRow({
      input_tokens: 11n,
      output_tokens: "22",
      cache_write_1h_tokens: 33n,
    })
  );
  assert.equal(mapped.input_tokens, 11);
  assert.equal(mapped.output_tokens, 22);
  assert.equal(mapped.cache_write_1h_tokens, 33);
});

test("a corrupt count is rejected at the boundary instead of reaching the trace", () => {
  assert.throws(
    () => normalizeTraceTokenEvent(tokenEventRow({ input_tokens: -1 })),
    InvalidTokenCountError
  );
  assert.throws(
    () =>
      normalizeTraceTokenEvent(tokenEventRow({ cache_write_5m_tokens: -1 })),
    InvalidTokenCountError
  );
});

test("cost columns pass through verbatim — pricing is resolved elsewhere", () => {
  const mapped = normalizeTraceTokenEvent(
    tokenEventRow({
      cost_usd_estimated: 0.5,
      input_cost_usd_estimated: 0.1,
      output_cost_usd_estimated: 0.2,
      cache_read_cost_usd_estimated: 0.15,
      cache_creation_cost_usd_estimated: 0.05,
    })
  );
  assert.equal(mapped.cost_usd_estimated, 0.5);
  assert.equal(mapped.input_cost_usd_estimated, 0.1);
  assert.equal(mapped.output_cost_usd_estimated, 0.2);
  assert.equal(mapped.cache_read_cost_usd_estimated, 0.15);
  assert.equal(mapped.cache_creation_cost_usd_estimated, 0.05);
  assert.equal(mapped.model, "claude-opus-5");
  assert.equal(mapped.created_at, CREATED_AT);
});

// ISS-5311: the hydration call site maps a whole batch of sessions, so the
// strict parser above needs per-row isolation around it. `mapTraceTokenEvents`
// keeps the parser strict and degrades ONLY the two optional TTL subdivisions —
// to `null` ("never reported"), never to a fabricated `0`.

test("ISS-5311: a corrupt TTL subdivision degrades to null, and its valid siblings on the same row survive", () => {
  const [mapped] = mapTraceTokenEvents("session-1", [
    tokenEventRow({ cache_write_5m_tokens: -1, cache_write_1h_tokens: 7 }),
  ]);
  assert.ok(mapped);
  assert.equal(
    mapped.cache_write_5m_tokens,
    null,
    "the corrupt subdivision reads as unknown, not as a reported 0"
  );
  assert.equal(
    mapped.cache_write_1h_tokens,
    7,
    "the valid sibling subdivision on the same row is untouched"
  );
  assert.equal(mapped.input_tokens, 10);
  assert.equal(mapped.output_tokens, 20);
  assert.equal(mapped.cache_read_tokens, 30);
  assert.equal(mapped.cache_write_tokens, 40);
});

test("ISS-5311: one corrupt row does not drop or corrupt the other rows in the batch", () => {
  const mapped = mapTraceTokenEvents("session-1", [
    tokenEventRow({ cache_write_5m_tokens: UNSAFE_INTEGER_TOKEN }),
    tokenEventRow({ cache_write_5m_tokens: 5, cache_write_1h_tokens: 9 }),
  ]);
  assert.equal(mapped.length, 2, "no row is dropped");
  assert.equal(mapped[0]?.cache_write_5m_tokens, null);
  assert.equal(mapped[1]?.cache_write_5m_tokens, 5);
  assert.equal(mapped[1]?.cache_write_1h_tokens, 9);
});

test("ISS-5311: a fully valid batch is identical to the strict mapper's output", () => {
  const row = tokenEventRow({
    cache_write_5m_tokens: 5,
    cache_write_1h_tokens: 9,
  });
  assert.deepEqual(mapTraceTokenEvents("session-1", [row]), [
    normalizeTraceTokenEvent(row),
  ]);
});
