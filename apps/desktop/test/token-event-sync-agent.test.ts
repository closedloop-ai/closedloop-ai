/**
 * ISS-12552 (PRD-800): a token event's agent is
 * synced as `agentExternalId` on every sync, and the main agent is stated with
 * the parent marker, so the cloud can correct an owner it stored before.
 */
import assert from "node:assert/strict";
import { PARENT_AGENT_EXTERNAL_ID } from "@repo/api/src/types/token-event-agent-owner";
import { describe, test } from "vitest";
import type { SqliteTokenEventRow } from "../src/main/database/db-row-types.js";
import { mapSyncedTokenEvent } from "../src/main/database/token-event-sync.js";

function row(extra: Partial<SqliteTokenEventRow> = {}): SqliteTokenEventRow {
  return {
    session_id: "session-1",
    transport_id: "token-event-1",
    model: "model-a",
    created_at: "2026-10-16T12:00:00.000Z",
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd_estimated: null,
    input_cost_usd_estimated: null,
    output_cost_usd_estimated: null,
    cache_read_cost_usd_estimated: null,
    cache_creation_cost_usd_estimated: null,
    ...extra,
  };
}

describe("token event agent sync (ISS-12552)", () => {
  test("sends a subagent's events with their agent", () => {
    assert.equal(
      mapSyncedTokenEvent("session-1", row({ agent_id: "agent-lane" }))
        .agentExternalId,
      "agent-lane"
    );
  });

  test("states the main agent explicitly, for a null or absent agent", () => {
    for (const event of [row({ agent_id: null }), row()]) {
      assert.equal(
        mapSyncedTokenEvent("session-1", event).agentExternalId,
        PARENT_AGENT_EXTERNAL_ID
      );
    }
  });
});
