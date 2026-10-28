import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { test } from "vitest";
import { AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY } from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import { readLayer2Snapshot } from "./golden/golden-layer2-snapshot.js";
import type { RawCapture } from "./golden/golden-layer2-store-capture.js";

const NOW = "2026-09-18T21:45:00.000Z";
const initialTemplate = {
  source_key: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  status: OutboxStatus.Pending,
  attempt_count: 0,
  created_at: NOW,
  updated_at: NOW,
  payload: { sha256: "unchanged", chars: 250 },
};

function readFixture(row: Record<string, unknown>): RawCapture {
  const dir = mkdtempSync(join(tmpdir(), "golden-l2-snapshot-"));
  try {
    const path = join(dir, "snapshot.json");
    writeFileSync(
      path,
      JSON.stringify({
        sessions: [{ id: "session", status: "inactive" }],
        agent_component_invocation_sync_outbox: [row],
      })
    );
    return readLayer2Snapshot(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("legacy first-enqueue expectation adds only its pending timestamp", () => {
  assert.deepEqual(readFixture(initialTemplate), {
    sessions: [{ id: "session", status: "inactive" }],
    agent_component_invocation_sync_outbox: [
      { ...initialTemplate, pending_since: NOW },
    ],
  });
  assert.equal(Object.hasOwn(initialTemplate, "pending_since"), false);
});

test.each([null, "2026-01-01T00:00:00.000Z"])(
  "an explicit frozen pending_since is preserved: %s",
  (pending_since) => {
    const row = { ...initialTemplate, pending_since };
    assert.deepEqual(readFixture(row).agent_component_invocation_sync_outbox, [
      row,
    ]);
  }
);

test.each([
  { source_key: "target-specific-queue" },
  { status: OutboxStatus.DeadLettered },
  { attempt_count: 1 },
  { created_at: null },
  { created_at: "not-a-timestamp", updated_at: "not-a-timestamp" },
  { updated_at: "2026-09-19T21:45:00.000Z" },
])("unproven legacy template shape refuses projection: %j", (changes) => {
  assert.throws(() => readFixture({ ...initialTemplate, ...changes }));
});

test.each([
  {},
  { pending_since: null },
  { pending_since: "2026-01-01T00:00:00.000Z" },
])("actual missing/null/wrong pending timestamp still differs: %j", (stamp) => {
  const expected = readFixture(initialTemplate);
  const actual = {
    ...expected,
    agent_component_invocation_sync_outbox: [{ ...initialTemplate, ...stamp }],
  };
  assert.equal(isDeepStrictEqual(actual, expected), false);
});
