import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  detailRowsToList,
  sessionDetailsCtes,
} from "../src/main/database/session-detail-mappers.js";

describe("sessionDetailsCtes", () => {
  const sql = sessionDetailsCtes();

  test("token_totals CTE folds baseline_input into total_tokens", () => {
    assert.ok(
      sql.includes("baseline_input"),
      "token_totals CTE must include baseline_input"
    );
  });

  test("token_totals CTE folds baseline_output into total_tokens", () => {
    assert.ok(
      sql.includes("baseline_output"),
      "token_totals CTE must include baseline_output"
    );
  });

  test("token_totals CTE COALESCE-guards all four token columns", () => {
    for (const col of [
      "input_tokens",
      "baseline_input",
      "output_tokens",
      "baseline_output",
    ]) {
      assert.ok(
        sql.includes(`COALESCE(${col}, 0)`),
        `token_totals CTE must COALESCE(${col}, 0)`
      );
    }
  });
});

describe("detailRowsToList", () => {
  test("maps raw rows to SessionWithAgents with correct totalTokens", () => {
    const raw = {
      id: "sess-1",
      name: "test session",
      status: "completed",
      cwd: "/tmp",
      model: "claude-sonnet-4-20250514",
      started_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-01T01:00:00Z",
      ended_at: "2026-07-01T01:00:00Z",
      awaiting_input_since: null,
      metadata: null,
      harness: "claude-code",
      billing_mode: null,
      user_id: null,
      organization_id: null,
      agent_count: 2,
      event_count: 10,
      total_tokens: 5000,
    };
    const result = detailRowsToList([raw]);
    assert.equal(result.length, 1);
    assert.equal(result[0].totalTokens, 5000);
    assert.equal(result[0].agentCount, 2);
    assert.equal(result[0].eventCount, 10);
    assert.equal(result[0].id, "sess-1");
    assert.equal(result[0].status, "completed");
  });

  test("coerces bigint-like agent and event counts to Number", () => {
    const raw = {
      id: "sess-2",
      status: "active",
      agent_count: BigInt(3),
      event_count: BigInt(15),
      total_tokens: BigInt(12_000),
    };
    const result = detailRowsToList([raw as Record<string, unknown>]);
    assert.equal(result[0].agentCount, 3);
    assert.equal(result[0].eventCount, 15);
    assert.equal(result[0].totalTokens, 12_000);
  });

  test("defaults missing counts to zero", () => {
    const raw = {
      id: "sess-3",
      status: "active",
    };
    const result = detailRowsToList([raw as Record<string, unknown>]);
    assert.equal(result[0].agentCount, 0);
    assert.equal(result[0].eventCount, 0);
    assert.equal(result[0].totalTokens, 0);
  });
});
