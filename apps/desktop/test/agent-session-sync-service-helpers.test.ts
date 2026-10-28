import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { MAX_OBSERVED_TOP_IDS } from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import {
  capPersistedTopIds,
  collectIdsAtTimestamp,
  formatBytes,
  isLocalSerializationError,
} from "../src/main/agent-sync/agent-session-sync-service-helpers.js";

const OVERFLOW_SIZE_PATTERN = /5001 exceeds 5000/;
const RESCAN_FALLBACK_PATTERN = /re-scan-from-timestamp/;

describe("agent session sync service helpers", () => {
  test("collects only the leading tied timestamp and deduplicates ids", () => {
    assert.deepEqual(
      [
        ...collectIdsAtTimestamp(
          [
            { id: "b", updated_at: "2026-08-20T02:00:00.000Z" },
            { id: "a", updated_at: "2026-08-20T02:00:00.000Z" },
            { id: "b", updated_at: "2026-08-20T02:00:00.000Z" },
            { id: "ignored", updated_at: "2026-08-20T01:00:00.000Z" },
            { id: "also-ignored", updated_at: "2026-08-20T02:00:00.000Z" },
          ],
          "2026-08-20T02:00:00.000Z"
        ),
      ],
      ["b", "a"]
    );
    assert.deepEqual([...collectIdsAtTimestamp([], "timestamp")], []);
  });

  test("persists tied ids through the exact cap without reporting overflow", () => {
    const ids = new Set(
      Array.from({ length: MAX_OBSERVED_TOP_IDS }, (_, index) => `id-${index}`)
    );
    const messages: string[] = [];

    assert.deepEqual(
      capPersistedTopIds(ids, (message) => messages.push(message)),
      [...ids]
    );
    assert.deepEqual(messages, []);
  });

  test("drops the persisted set above the cap and reports the fallback", () => {
    const ids = new Set(
      Array.from(
        { length: MAX_OBSERVED_TOP_IDS + 1 },
        (_, index) => `id-${index}`
      )
    );
    const messages: string[] = [];

    assert.deepEqual(
      capPersistedTopIds(ids, (message) => messages.push(message)),
      []
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? "", OVERFLOW_SIZE_PATTERN);
    assert.match(messages[0] ?? "", RESCAN_FALLBACK_PATTERN);
  });

  test("formats byte boundaries with the current binary units", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(1023), "1023 B");
    assert.equal(formatBytes(1024), "1.0 KiB");
    assert.equal(formatBytes(1024 * 1024 - 1), "1024.0 KiB");
    assert.equal(formatBytes(1024 * 1024), "1.0 MiB");
  });

  test("classifies only TypeError encoder signatures as local serialization failures", () => {
    for (const message of [
      "Converting circular structure to JSON",
      "Unable to SERIALIZE value",
      "Do not know how to serialize a BigInt",
    ]) {
      assert.equal(isLocalSerializationError(new TypeError(message)), true);
    }
    assert.equal(
      isLocalSerializationError(new TypeError("socket closed")),
      false
    );
    assert.equal(isLocalSerializationError(new Error("circular")), false);
    assert.equal(isLocalSerializationError("serialize"), false);
  });
});
