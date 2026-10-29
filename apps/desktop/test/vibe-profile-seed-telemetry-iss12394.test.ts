import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedClaudeTelemetry } from "../scripts/vibe-profile/seed-telemetry";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { ClaudeCodeSignalDropReason } from "../src/main/otel/claude-code-signal-drop.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const T0 = "2026-10-01T10:00:00.000Z";
const T1 = "2026-10-01T10:05:00.000Z";
const T2 = "2026-10-01T10:10:00.000Z";
const MODEL = "claude-sonnet-4-5";
const REJECTED = /claude OTel persister rejected 2 seeded signal\(s\)/;

let dir: string;
let db: SqliteDb;

async function insertSession(id: string, harness: string): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode)
     VALUES ($1, 'inactive', $2, $2, $3, 'api')`,
    id,
    T0,
    harness
  );
}

async function insertTokenEvent(
  sessionId: string,
  model: string,
  createdAt: string,
  outputTokens: number,
  costUsd: number | null
): Promise<void> {
  await db.run(
    `INSERT INTO token_events
       (session_id, model, created_at, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_usd_estimated)
     VALUES ($1, $2, $3, 100, $4, 7, 3, $5)`,
    sessionId,
    model,
    createdAt,
    outputTokens,
    costUsd
  );
}

async function seedCorpus(): Promise<void> {
  await insertSession("claude-a", "claude");
  await insertSession("claude-free", "claude");
  await insertSession("codex-a", "codex");
  await insertTokenEvent("claude-a", MODEL, T0, 200, 0.25);
  // same session/created_at/model: one api_request, but both costs summed
  await insertTokenEvent("claude-a", MODEL, T0, 300, 0.5);
  await insertTokenEvent("claude-a", MODEL, T1, 10_000, null);
  await insertTokenEvent("claude-a", "", T2, 50, 9);
  await insertTokenEvent("claude-a", "<synthetic>", T2, 50, 9);
  await insertTokenEvent("claude-free", MODEL, T0, 40, null);
  await insertTokenEvent("codex-a", MODEL, T0, 40, 1);
}

describe("seedClaudeTelemetry", () => {
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "vibe-seed-telemetry-"));
    db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "api",
      now: () => T2,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("replays priced Claude token events as deduped api requests and non-zero cost points", async () => {
    await seedCorpus();

    const result = await seedClaudeTelemetry(db);

    expect(result).toEqual({ apiRequests: 3, costPoints: 1 });
    const requests = await db.prisma.client.$queryRawUnsafe<
      {
        session_id: string;
        started_at: string;
        duration_ms: number | bigint;
        cost_usd: number;
        tokens_output: number | bigint;
      }[]
    >(
      `SELECT session_id, started_at, duration_ms, cost_usd, tokens_output
         FROM claude_code_api_request ORDER BY session_id, started_at`
    );
    expect(
      requests.map((row) => ({
        sessionId: row.session_id,
        startedAt: row.started_at,
        durationMs: Number(row.duration_ms),
        costUsd: Number(row.cost_usd),
        outputTokens: Number(row.tokens_output),
      }))
    ).toEqual([
      {
        sessionId: "claude-a",
        startedAt: T0,
        durationMs: 3600,
        costUsd: 0.25,
        outputTokens: 200,
      },
      {
        sessionId: "claude-a",
        startedAt: T1,
        durationMs: 120_600,
        costUsd: 0,
        outputTokens: 10_000,
      },
      {
        sessionId: "claude-free",
        startedAt: T0,
        durationMs: 1200,
        costUsd: 0,
        outputTokens: 40,
      },
    ]);

    const costs = await db.prisma.client.$queryRawUnsafe<
      { session_id: string; cost_usd: number; observed_at: string }[]
    >("SELECT session_id, cost_usd, observed_at FROM claude_code_cost_event");
    expect(
      costs.map((row) => ({
        sessionId: row.session_id,
        costUsd: Number(row.cost_usd),
        observedAt: row.observed_at,
      }))
    ).toEqual([{ sessionId: "claude-a", costUsd: 0.75, observedAt: T1 }]);

    const drops = await db.prisma.client.$queryRawUnsafe<
      { harness: string; reason: string; dropped_count: number | bigint }[]
    >("SELECT harness, reason, dropped_count FROM claude_code_signal_drop");
    expect(
      drops.map((row) => ({ ...row, dropped_count: Number(row.dropped_count) }))
    ).toEqual([
      {
        harness: "claude",
        reason: ClaudeCodeSignalDropReason.ReceiverBackpressure,
        dropped_count: 3,
      },
    ]);
  });

  it("throws when the persister rejects a seeded signal", async () => {
    await seedCorpus();
    const persist = vi
      .spyOn(db.claudeCodeOtel, "persistSignals")
      .mockResolvedValue({ accepted: 0, rejected: 2 });

    await expect(seedClaudeTelemetry(db)).rejects.toThrow(REJECTED);
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
