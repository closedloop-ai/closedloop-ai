import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { MAX_EVENT_DATA_BYTES } from "../src/main/database/db-constants.js";
import { sidecarToolEventData } from "../src/main/database/live-hook-sidecar-events.js";

/**
 * ISS-6480: the sidecar lane serialized its row with bare `importEventData`,
 * whose over-cap path replaces the WHOLE blob with `{"truncated":true}`. That
 * branch was unreachable only while the scanner bounded each input to 1000
 * characters. Carrying the raw input makes it ordinary — one delegated `Write`
 * of a file over 64 KB crosses it — so the lane now serializes the same way the
 * boot importer does, keeping the analytics keys and dropping only the heavy
 * detail.
 */
const OVERSIZED_INPUT = {
  file_path: "src/big.ts",
  content: "z".repeat(MAX_EVENT_DATA_BYTES + 10_000),
};

function toolUse(input: unknown) {
  return {
    toolName: "Write",
    toolUseId: "toolu_cap",
    input,
    output: null,
    resultTimestamp: null,
    isError: null,
  };
}

describe("sidecarToolEventData over MAX_EVENT_DATA_BYTES", () => {
  test("keeps the identity keys instead of nuking the whole row", () => {
    const serialized = sidecarToolEventData(toolUse(OVERSIZED_INPUT));

    assert.ok(serialized !== null);
    const data = JSON.parse(serialized) as Record<string, unknown>;
    // `tool_use_id` is what the conflict cleanup in live-hook-sidecar-events
    // matches contradictory stored rows on. A nuked row has none, so the
    // quarantine could never find the row it needs to delete.
    assert.equal(data.tool_use_id, "toolu_cap");
    assert.equal(data.tool_name, "Write");
    assert.equal(data.truncated, undefined);
  });

  test("drops only the heavy detail, and stays within the cap", () => {
    const serialized = sidecarToolEventData(toolUse(OVERSIZED_INPUT));

    assert.ok(serialized !== null);
    assert.ok(serialized.length <= MAX_EVENT_DATA_BYTES);
    assert.equal(
      (JSON.parse(serialized) as Record<string, unknown>).tool_input,
      undefined
    );
  });

  test("keeps the input when the row fits", () => {
    const small = { file_path: "src/small.ts", content: "ok" };
    const serialized = sidecarToolEventData(toolUse(small));

    assert.ok(serialized !== null);
    assert.deepEqual(
      (JSON.parse(serialized) as Record<string, unknown>).tool_input,
      small
    );
  });
});
