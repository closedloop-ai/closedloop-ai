import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, test } from "vitest";
import {
  detailRowsToList,
  sessionDetailsCtes,
} from "../src/main/database/session-detail-mappers.js";

describe("sessionDetailsCtes", () => {
  test("folds current and baseline tokens while flooring nullable terms", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "session-details-cte-"));
    const client = createClient({
      url: `file:${path.join(dir, "session-details.sqlite")}`,
      intMode: "number",
    });
    try {
      // A nullable minimal schema keeps each defensive COALESCE observable.
      await client.executeMultiple(`
        CREATE TABLE agents (session_id TEXT);
        CREATE TABLE events (session_id TEXT);
        CREATE TABLE token_usage (
          session_id TEXT NOT NULL,
          input_tokens INTEGER,
          baseline_input INTEGER,
          output_tokens INTEGER,
          baseline_output INTEGER
        );
        INSERT INTO token_usage VALUES
          ('populated-terms', 100, 50, 200, 25),
          ('nullable-terms', NULL, 50, 200, 25),
          ('nullable-terms', 100, NULL, 200, 25),
          ('nullable-terms', 100, 50, NULL, 25),
          ('nullable-terms', 100, 50, 200, NULL);
      `);
      const result = await client.execute({
        sql: `${sessionDetailsCtes()}
          SELECT session_id AS id, $1 AS status, total_tokens
          FROM token_totals
          ORDER BY session_id`,
        args: [SESSION_STATUS.ACTIVE],
      });
      const details = detailRowsToList(
        result.rows as unknown as Record<string, unknown>[]
      );

      assert.deepEqual(
        details.map(({ id, totalTokens }) => ({ id, totalTokens })),
        [
          { id: "nullable-terms", totalTokens: 1125 },
          { id: "populated-terms", totalTokens: 375 },
        ]
      );
    } finally {
      client.close();
      await rm(dir, { recursive: true, force: true });
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
