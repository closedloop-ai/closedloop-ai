import type { SqliteAgentDatabase } from "../../src/main/database/sqlite.js";
import {
  type ClaudeCodeApiRequestSignal,
  type ClaudeCodeCostUsageSignal,
  ClaudeCodeOtelSignalType,
} from "../../src/main/otel/claude-code-otel-signal-contract.js";
import { ClaudeCodeSignalDropReason } from "../../src/main/otel/claude-code-signal-drop.js";

type TokenEventRow = {
  session_id: string;
  model: string;
  created_at: string;
  input_tokens: number | bigint;
  output_tokens: number | bigint;
  cache_read_tokens: number | bigint;
  cache_write_tokens: number | bigint;
  cost_usd_estimated: number | null;
};

const PERSIST_BATCH_SIZE = 250;

/**
 * Claude Code's OTel export, replayed from the corpus's own Claude token
 * events through the production persister (`claudeCodeOtel.persistSignals`):
 * one `api_request` per priced model call and one `cost_usage` point per
 * session and model, which is what a session with OTel export on produces.
 * The golden import fills neither table because the corpus carries
 * transcripts, not OTel. Latency is not in a transcript, so it is derived
 * deterministically from the call's output size.
 */
export async function seedClaudeTelemetry(
  db: SqliteAgentDatabase
): Promise<{ apiRequests: number; costPoints: number }> {
  const events = await db.prisma.client.$queryRawUnsafe<TokenEventRow[]>(
    `SELECT te.session_id, te.model, te.created_at, te.input_tokens, te.output_tokens,
            te.cache_read_tokens, te.cache_write_tokens, te.cost_usd_estimated
       FROM token_events te JOIN sessions s ON s.id = te.session_id
      WHERE s.harness = 'claude' AND te.model <> '' AND te.model NOT LIKE '<%'
      ORDER BY te.session_id, te.created_at`
  );
  const apiRequests = apiRequestSignals(events);
  const costPoints = costUsageSignals(events);
  const signals = [...apiRequests, ...costPoints];
  for (let start = 0; start < signals.length; start += PERSIST_BATCH_SIZE) {
    const summary = await db.claudeCodeOtel.persistSignals(
      signals.slice(start, start + PERSIST_BATCH_SIZE)
    );
    if (summary.rejected > 0) {
      throw new Error(
        `claude OTel persister rejected ${summary.rejected} seeded signal(s)`
      );
    }
  }
  await db.claudeCodeOtel.recordSignalDrop({
    harness: "claude",
    reason: ClaudeCodeSignalDropReason.ReceiverBackpressure,
    count: 3,
  });
  return { apiRequests: apiRequests.length, costPoints: costPoints.length };
}

function apiRequestSignals(
  events: readonly TokenEventRow[]
): ClaudeCodeApiRequestSignal[] {
  const seen = new Set<string>();
  const signals: ClaudeCodeApiRequestSignal[] = [];
  for (const event of events) {
    const key = `${event.session_id}\u001f${event.created_at}\u001f${event.model}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const outputTokens = Number(event.output_tokens);
    signals.push({
      type: ClaudeCodeOtelSignalType.ApiRequest,
      sessionId: event.session_id,
      model: event.model,
      startedAt: event.created_at,
      durationMs: 600 + Math.min(outputTokens, 8000) * 15,
      costUsd: event.cost_usd_estimated ?? 0,
      inputTokens: Number(event.input_tokens),
      outputTokens,
      cacheReadTokens: Number(event.cache_read_tokens),
      cacheCreationTokens: Number(event.cache_write_tokens),
    });
  }
  return signals;
}

function costUsageSignals(
  events: readonly TokenEventRow[]
): ClaudeCodeCostUsageSignal[] {
  const totals = new Map<string, ClaudeCodeCostUsageSignal>();
  for (const event of events) {
    const key = `${event.session_id}\u001f${event.model}`;
    const current = totals.get(key);
    const costUsd = (current?.costUsd ?? 0) + (event.cost_usd_estimated ?? 0);
    totals.set(key, {
      type: ClaudeCodeOtelSignalType.CostUsage,
      sessionId: event.session_id,
      model: event.model,
      observedAt: event.created_at,
      costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    });
  }
  return [...totals.values()].filter((signal) => signal.costUsd > 0);
}
