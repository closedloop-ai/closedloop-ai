// FEA SQLite migration — engine-agnostic GOLDEN characterization test.
//
// Pins the dialect-sensitive analytics outputs (the riskiest part of the
// SQLite → SQLite/libSQL port: percentile_cont autonomy, timezone heatmap
// bucketing, model-usage-over-time, token aggregation) against a fixed,
// deterministic seed. The golden values are captured on SQLite; after the
// engine swap, SQLite MUST reproduce the identical numbers or a test fails and
// points straight at the offending query.
//
// Uses ONLY openSqliteAgentDatabase (no direct engine import) so the same file
// runs unchanged against both engines. Run with DUMP_GOLDEN=1 to print the
// current outputs when (re)capturing the golden.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { InsightsSection } from "@closedloop-ai/loops-api/insights";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { makeSession as baseSession } from "./normalized-session-test-utils.js";

// Force a fixed timezone so the timezone-sensitive analytics (the heatmap's
// per-hour bucketing) are deterministic across machines/CI and identical between
// the SQLite session-timezone path and the SQLite strftime('localtime') port.
// Runs at module evaluation, before any test opens a DB or reads a Date.
process.env.TZ = "UTC";

const NOW = "2026-06-20T12:00:00.000Z";

type SessionOverrides = Partial<NormalizedSession> & { sessionId: string };

function makeSession(overrides: SessionOverrides): NormalizedSession {
  return baseSession({
    name: overrides.sessionId,
    cwd: "/workspace/closedloop-electron",
    model: "gpt-5",
    version: "1.0.0",
    slug: overrides.sessionId,
    gitBranch: "main",
    startedAt: "2026-06-18T10:00:00.000Z",
    endedAt: "2026-06-18T10:05:00.000Z",
    userMessages: 1,
    assistantMessages: 1,
    tokensByModel: {
      "gpt-5": { input: 100, output: 40, cacheRead: 0, cacheWrite: 0 },
    },
    messageTimestamps: ["2026-06-18T10:00:30.000Z"],
    entrypoint: "codex",
    artifacts: {
      prs: [],
      issues: [],
      repo: "closedloop-ai/closedloop-electron",
    },
    ...overrides,
  });
}

// Deterministic seed exercising heatmap (varied days/hours), autonomy/classification
// (varied user-turn counts → human vs agent), model-over-time, tokens, and delivery.
const SEED: Array<{ session: NormalizedSession; harness: string }> = [
  {
    harness: "claude",
    session: makeSession({
      sessionId: "g-claude-steered",
      model: "claude-sonnet-4-5",
      startedAt: "2026-06-16T09:00:00.000Z",
      endedAt: "2026-06-16T09:30:00.000Z",
      userMessages: 4, // steered → human interactive
      assistantMessages: 5,
      tokensByModel: {
        "claude-sonnet-4-5": {
          input: 1200,
          output: 800,
          cacheRead: 300,
          cacheWrite: 100,
        },
      },
      messageTimestamps: [
        "2026-06-16T09:01:00.000Z",
        "2026-06-16T09:10:00.000Z",
        "2026-06-16T09:20:00.000Z",
        "2026-06-16T09:25:00.000Z",
      ],
      // FEA-2641 Fix 4: the heatmap/autonomy are turn-based over metadata
      // $.messages — 4 human + 5 assistant turns matching the declared counts,
      // all inside the 09:00 UTC hour, pinning one mixed Human+Agent cell.
      messages: [
        { role: "human", timestamp: "2026-06-16T09:01:00.000Z", text: "q1" },
        {
          role: "assistant",
          timestamp: "2026-06-16T09:02:00.000Z",
          text: "a1",
        },
        { role: "human", timestamp: "2026-06-16T09:10:00.000Z", text: "q2" },
        {
          role: "assistant",
          timestamp: "2026-06-16T09:12:00.000Z",
          text: "a2",
        },
        { role: "human", timestamp: "2026-06-16T09:20:00.000Z", text: "q3" },
        {
          role: "assistant",
          timestamp: "2026-06-16T09:21:00.000Z",
          text: "a3",
        },
        { role: "human", timestamp: "2026-06-16T09:25:00.000Z", text: "q4" },
        {
          role: "assistant",
          timestamp: "2026-06-16T09:26:00.000Z",
          text: "a4",
        },
        {
          role: "assistant",
          timestamp: "2026-06-16T09:29:00.000Z",
          text: "a5",
        },
      ],
      toolUses: [
        { name: "Read", timestamp: "2026-06-16T09:02:00.000Z", input: {} },
        { name: "Edit", timestamp: "2026-06-16T09:12:00.000Z", input: {} },
      ],
    }),
  },
  {
    harness: "codex",
    session: makeSession({
      sessionId: "g-codex-headless",
      model: "gpt-5",
      startedAt: "2026-06-17T14:00:00.000Z",
      endedAt: "2026-06-17T14:08:00.000Z",
      userMessages: 1, // single prompt → agent
      assistantMessages: 3,
      tokensByModel: {
        "gpt-5": { input: 500, output: 300, cacheRead: 0, cacheWrite: 0 },
      },
      messageTimestamps: ["2026-06-17T14:00:30.000Z"],
      // 1 human + 3 assistant turns (headless kickoff) in the 14:00 UTC hour.
      messages: [
        { role: "human", timestamp: "2026-06-17T14:00:30.000Z", text: "go" },
        {
          role: "assistant",
          timestamp: "2026-06-17T14:02:00.000Z",
          text: "a1",
        },
        {
          role: "assistant",
          timestamp: "2026-06-17T14:05:00.000Z",
          text: "a2",
        },
        {
          role: "assistant",
          timestamp: "2026-06-17T14:07:00.000Z",
          text: "a3",
        },
      ],
      toolUses: [
        { name: "Bash", timestamp: "2026-06-17T14:01:00.000Z", input: {} },
      ],
      artifacts: {
        prs: [{ number: "275", repo: "closedloop-ai/closedloop-electron" }],
        issues: [],
        repo: "closedloop-ai/closedloop-electron",
      },
    }),
  },
  {
    harness: "opencode",
    session: makeSession({
      sessionId: "g-opencode-steered",
      model: "claude-sonnet-4-5",
      startedAt: "2026-06-18T22:00:00.000Z",
      endedAt: "2026-06-18T22:45:00.000Z",
      userMessages: 6, // steered → human interactive
      assistantMessages: 7,
      tokensByModel: {
        "claude-sonnet-4-5": {
          input: 2000,
          output: 1500,
          cacheRead: 800,
          cacheWrite: 200,
        },
      },
      messageTimestamps: [
        "2026-06-18T22:05:00.000Z",
        "2026-06-18T22:15:00.000Z",
        "2026-06-18T22:25:00.000Z",
      ],
      // 6 human + 7 assistant turns in the 22:00 UTC hour.
      messages: [
        { role: "human", timestamp: "2026-06-18T22:05:00.000Z", text: "q1" },
        {
          role: "assistant",
          timestamp: "2026-06-18T22:06:00.000Z",
          text: "a1",
        },
        { role: "human", timestamp: "2026-06-18T22:15:00.000Z", text: "q2" },
        {
          role: "assistant",
          timestamp: "2026-06-18T22:16:00.000Z",
          text: "a2",
        },
        { role: "human", timestamp: "2026-06-18T22:25:00.000Z", text: "q3" },
        {
          role: "assistant",
          timestamp: "2026-06-18T22:26:00.000Z",
          text: "a3",
        },
        { role: "human", timestamp: "2026-06-18T22:30:00.000Z", text: "q4" },
        {
          role: "assistant",
          timestamp: "2026-06-18T22:31:00.000Z",
          text: "a4",
        },
        { role: "human", timestamp: "2026-06-18T22:35:00.000Z", text: "q5" },
        {
          role: "assistant",
          timestamp: "2026-06-18T22:36:00.000Z",
          text: "a5",
        },
        { role: "human", timestamp: "2026-06-18T22:40:00.000Z", text: "q6" },
        {
          role: "assistant",
          timestamp: "2026-06-18T22:41:00.000Z",
          text: "a6",
        },
        {
          role: "assistant",
          timestamp: "2026-06-18T22:44:00.000Z",
          text: "a7",
        },
      ],
      toolUses: [
        { name: "Read", timestamp: "2026-06-18T22:06:00.000Z", input: {} },
      ],
    }),
  },
];

async function captureAnalytics() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sqlite-golden-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    for (const { session, harness } of SEED) {
      const result = await db.importer.importSession(session, harness);
      if (result.skipped) {
        throw new Error(
          `seed import unexpectedly skipped: ${session.sessionId}`
        );
      }
    }
    // Pin the insights clock to NOW so the date-windowed trend series are
    // deterministic (otherwise the 90-day window + trend dates drift with
    // wall-clock time and the golden fails on any day after capture).
    const insightsNow = new Date(NOW);
    const [delivery, utilization, agents, tokenAnalytics] = await Promise.all([
      db.dashboard.getInsights(InsightsSection.Delivery, "90", insightsNow),
      db.dashboard.getInsights(InsightsSection.Utilization, "90", insightsNow),
      db.dashboard.getInsights(InsightsSection.Agents, "90", insightsNow),
      db.dashboard.getTokenAnalytics(insightsNow),
    ]);
    return { delivery, utilization, agents, tokenAnalytics };
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("SQLite-conversion golden: dialect-sensitive analytics are stable", async () => {
  const out = await captureAnalytics();

  if (process.env.DUMP_GOLDEN) {
    process.stderr.write(`GOLDEN_DUMP=${JSON.stringify(out)}\n`);
  }

  // Full golden snapshot captured on SQLite (TZ=UTC). After the engine swap,
  // SQLite/libSQL must reproduce these exactly — any deepEqual failure is either
  // a real dialect-port bug (fix the SQL) or an intended difference (recapture).
  const goldenPath = fileURLToPath(
    new URL("./fixtures/sqlite-golden.json", import.meta.url)
  );
  const golden = JSON.parse(await readFile(goldenPath, "utf8"));
  assert.deepEqual(out, golden);
});
