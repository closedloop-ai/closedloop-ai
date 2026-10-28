import assert from "node:assert/strict";
import type { NormalizedTokenRecord } from "@repo/lib/harness/types";
import { describe, test } from "vitest";
import {
  buildLegacyTokenEventIdentityCounts,
  buildReusableTokenEventTransportIds,
  consumeLegacyTokenEventIdentity,
  consumeReusableTokenEventTransportId,
  legacyTokenEventExternalId,
  normalizeTokenEventRecord,
  nullableTokenCount,
  type StoredTokenEventIdentityRow,
} from "../src/main/database/token-event-identity.js";

describe("token-event persistence identity", () => {
  test("normalizes canonical counters and optional TTL subdivisions", () => {
    assert.deepEqual(normalizeTokenEventRecord(record(), "test"), {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
    });
    assert.deepEqual(
      normalizeTokenEventRecord(
        record({ cacheWriteTtl: { fiveM: 5, oneH: 6 } }),
        "test"
      ),
      {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        cacheWriteTtl: { fiveM: 5, oneH: 6 },
      }
    );
    assert.throws(() =>
      normalizeTokenEventRecord(record({ input: -1 }), "test")
    );
  });

  test("keeps legacy content hashes stable and content-sensitive", () => {
    const identity = {
      model: "model-a",
      createdAt: "2026-08-20T10:00:00.000Z",
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    };
    assert.equal(
      legacyTokenEventExternalId("session-1", identity),
      "63e536f17ea8db358d7665858ceaef622a18393be8cc86308c03d34e438e9694"
    );
    assert.notEqual(
      legacyTokenEventExternalId("session-1", identity),
      legacyTokenEventExternalId("session-2", identity)
    );
    assert.notEqual(
      legacyTokenEventExternalId("session-1", identity),
      legacyTokenEventExternalId("session-1", {
        ...identity,
        outputTokens: 3,
      })
    );
  });

  test("builds sorted reusable ids and falls back to legacy ids", () => {
    const legacyRow = row({ transport_id: null });
    const reusable = buildReusableTokenEventTransportIds("session-1", [
      row({ transport_id: "transport-a" }),
      row({ transport_id: "transport-z" }),
      legacyRow,
    ]);
    const ids = [...reusable.idsByIdentity.values()][0];

    assert.ok(ids);
    assert.deepEqual(ids, [...ids].sort().reverse());
    assert.equal(reusable.identityByTransportId.has("transport-a"), true);
    assert.equal(
      reusable.identityByTransportId.has(
        legacyTokenEventExternalId("session-1", {
          model: legacyRow.model,
          createdAt: legacyRow.created_at,
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
        })
      ),
      true
    );
  });

  test("consumes explicit reusable ids before deterministic fallback ids", () => {
    const reusable = buildReusableTokenEventTransportIds("session-1", [
      row({ transport_id: "transport-a" }),
      row({ transport_id: "transport-b" }),
    ]);

    assert.equal(
      consumeReusableTokenEventTransportId(reusable, record(), "transport-a"),
      "transport-a"
    );
    assert.equal(
      consumeReusableTokenEventTransportId(reusable, record(), undefined),
      "transport-b"
    );
    assert.equal(
      consumeReusableTokenEventTransportId(reusable, record(), undefined),
      undefined
    );
  });

  test("rejects explicit transport ids reused for different content", () => {
    const reusable = buildReusableTokenEventTransportIds("session-1", [
      row({ transport_id: "transport-a" }),
    ]);

    assert.throws(() =>
      consumeReusableTokenEventTransportId(
        reusable,
        record({ output: 99 }),
        "transport-a"
      )
    );
    assert.equal(
      consumeReusableTokenEventTransportId(
        reusable,
        record({ output: 99 }),
        undefined
      ),
      undefined
    );
  });

  test("counts and consumes duplicate legacy identities one occurrence at a time", () => {
    const counts = buildLegacyTokenEventIdentityCounts("session-1", [
      row(),
      row(),
    ]);

    assert.equal(
      consumeLegacyTokenEventIdentity(counts, "session-1", record()),
      true
    );
    assert.equal(
      consumeLegacyTokenEventIdentity(counts, "session-1", record()),
      true
    );
    assert.equal(
      consumeLegacyTokenEventIdentity(counts, "session-1", record()),
      false
    );
    assert.equal(counts.size, 0);
  });

  test("normalizes nullable persisted counters at the replay boundary", () => {
    assert.equal(nullableTokenCount(null), null);
    assert.equal(nullableTokenCount(undefined), null);
    assert.equal(nullableTokenCount(0), 0);
    assert.equal(nullableTokenCount("7"), 7);
    assert.throws(() => nullableTokenCount(-1));
  });
});

function record(
  overrides: Partial<NormalizedTokenRecord> = {}
): NormalizedTokenRecord {
  return {
    timestamp: "2026-08-20T10:00:00.000Z",
    model: "model-a",
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    ...overrides,
  };
}

function row(
  overrides: Partial<StoredTokenEventIdentityRow> = {}
): StoredTokenEventIdentityRow {
  return {
    transport_id: null,
    model: "model-a",
    created_at: "2026-08-20T10:00:00.000Z",
    input_tokens: 1,
    output_tokens: 2,
    cache_read_tokens: 3,
    cache_write_tokens: 4,
    cache_write_5m_tokens: null,
    cache_write_1h_tokens: null,
    ...overrides,
  };
}
