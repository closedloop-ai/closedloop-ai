import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient } from "@libsql/client";
import {
  applyDesktopSeedPragmas,
  branchesDbPath,
  waitForMigrationsApplied,
} from "./desktop-seed-core.js";

const SYNC_PATH = "/desktop/claude-code-telemetry/sync";
const DROP_COUNTER_ID = "claude:receiver_backpressure";
const MAX_FIXTURE_BODY_BYTES = 1024 * 1024;

export const ClaudeTelemetryUploadKind = {
  Session: "session",
  CountersOnly: "counters_only",
} as const;

export type ClaudeTelemetryUpload = {
  kind: (typeof ClaudeTelemetryUploadKind)[keyof typeof ClaudeTelemetryUploadKind];
  externalSessionId: string | null;
};

/** Answers only the bounded synthetic Claude telemetry endpoint. */
export function routeClaudeTelemetrySync(
  request: IncomingMessage,
  response: ServerResponse,
  uploads: ClaudeTelemetryUpload[]
): boolean {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (!(request.method === "POST" && pathname === SYNC_PATH)) {
    return false;
  }
  let body = "";
  request.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf8");
    if (Buffer.byteLength(body) > MAX_FIXTURE_BODY_BYTES) {
      request.destroy();
    }
  });
  request.on("end", () => {
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(body);
      if (!(value && typeof value === "object" && !Array.isArray(value))) {
        throw new Error("invalid request");
      }
      parsed = value as Record<string, unknown>;
    } catch {
      response.statusCode = 400;
      response.end();
      return;
    }
    const session = parsed.session;
    const externalSessionId =
      session && typeof session === "object" && !Array.isArray(session)
        ? Reflect.get(session, "externalSessionId")
        : null;
    const sessionId =
      typeof externalSessionId === "string" ? externalSessionId : null;
    const dropCounters = Array.isArray(parsed.dropCounters)
      ? parsed.dropCounters
      : [];
    uploads.push({
      kind: sessionId
        ? ClaudeTelemetryUploadKind.Session
        : ClaudeTelemetryUploadKind.CountersOnly,
      externalSessionId: sessionId,
    });
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        accepted: true,
        protocolVersion: 1,
        ...(sessionId ? { externalSessionId: sessionId } : {}),
        dropCountersRecorded: dropCounters.length,
      })
    );
  });
  return true;
}

/** Seeds one local session-data obligation while the disposable app is down. */
export async function seedClaudeSessionSignal(
  userDataDir: string,
  sessionId: string
): Promise<void> {
  const client = createClient({ url: `file:${branchesDbPath(userDataDir)}` });
  try {
    await applyDesktopSeedPragmas(client);
    await waitForMigrationsApplied(client, 30_000);
    await client.execute({
      sql: `INSERT INTO claude_code_cost_event
              (id, session_id, model, cost_usd, observed_at, data_revision)
            VALUES (?, ?, 'claude-sonnet-4-5', 1.25, ?, 1)`,
      args: [`cost-${sessionId}`, sessionId, new Date().toISOString()],
    });
  } finally {
    client.close();
  }
}

/** Creates an independent counters-only obligation after the session ack. */
export async function seedClaudeDropCounter(
  userDataDir: string
): Promise<void> {
  const client = createClient({ url: `file:${branchesDbPath(userDataDir)}` });
  try {
    await applyDesktopSeedPragmas(client);
    const observedAt = new Date().toISOString();
    await client.execute({
      sql: `INSERT INTO claude_code_signal_drop
              (id, harness, reason, dropped_count, synced_count,
               first_observed_at, last_observed_at)
            VALUES (?, 'claude', 'receiver_backpressure', 1, 0, ?, ?)`,
      args: [DROP_COUNTER_ID, observedAt, observedAt],
    });
  } finally {
    client.close();
  }
}

/** Reads only the cursor facts needed to prove ack-only delivery. */
export async function readClaudeTelemetryWatermarks(
  userDataDir: string,
  sessionId: string
): Promise<{
  sessionDelivered: boolean;
  droppedCount: number;
  syncedCount: number;
}> {
  const client = createClient({ url: `file:${branchesDbPath(userDataDir)}` });
  try {
    await applyDesktopSeedPragmas(client);
    const cursor = await client.execute({
      sql: "SELECT 1 FROM claude_code_telemetry_sync_cursor WHERE session_id = ? LIMIT 1",
      args: [sessionId],
    });
    const counters = await client.execute({
      sql: "SELECT dropped_count, synced_count FROM claude_code_signal_drop WHERE id = ?",
      args: [DROP_COUNTER_ID],
    });
    return {
      sessionDelivered: cursor.rows.length > 0,
      droppedCount: Number(counters.rows[0]?.dropped_count ?? 0),
      syncedCount: Number(counters.rows[0]?.synced_count ?? 0),
    };
  } finally {
    client.close();
  }
}
