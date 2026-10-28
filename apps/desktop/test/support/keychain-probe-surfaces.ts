/**
 * ISS-12120 drivers for the three Desktop main-thread surfaces that classify
 * billing mode through the Keychain probe: live-session GenAI telemetry, the
 * Sessions usage read and the Branches usage reads. Pair with
 * `fake-security-binary.ts` for a cold memo, or {@link primeKeychainMemo} for a
 * warm one.
 */
import { vi } from "vitest";
import type { AgentSessionUsageAggregate } from "../../src/main/agent-sync/agent-session-read-model.js";
import type { AgentSessionSyncSource } from "../../src/main/agent-sync/agent-session-sync-source.js";
import { applyLiveSessionSinks } from "../../src/main/collectors/engine/collector-manager-live-session-sinks.js";
import { Harness } from "../../src/main/collectors/types.js";
import {
  anthropicKeychainService,
  hasKeychainCredentialCached,
} from "../../src/main/cost/anthropic-keychain.js";
import {
  readBranchUsageEventRows,
  readBranchUsageTokenRows,
} from "../../src/main/database/branch-reads.js";
import type { DbHostPrisma } from "../../src/main/database/prisma-client.js";
import { getSharedAgentSessionUsage } from "../../src/main/session/shared-agent-sessions-api.js";
import type { DesktopGenAiRequestEventInput } from "../../src/main/telemetry/app-otel-runtime-gen-ai.js";
import { genAiRequestTelemetry } from "../../src/main/telemetry/gen-ai-request-telemetry.js";
import type { SharedAgentSessionUsageSummary } from "../../src/shared/shared-agent-sessions-contract.js";
import { makeSession, makeTempDir } from "../normalized-session-test-utils.js";

/** Every env var the Claude detector reads ahead of the Keychain. */
const CLAUDE_BILLING_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
] as const;

/**
 * Leave the Keychain as the Claude detector's only signal: no credential env,
 * and `HOME` and `CLAUDE_CONFIG_DIR` on an empty temp dir. Returns the
 * Keychain service the detector will look up. Undo with `vi.unstubAllEnvs()`.
 */
export function isolateClaudeBillingEnv(): { service: string } {
  for (const name of CLAUDE_BILLING_ENV) {
    vi.stubEnv(name, undefined);
  }
  const home = makeTempDir("keychain-home-");
  const configDir = makeTempDir("keychain-claude-config-");
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  return { service: anthropicKeychainService(configDir) };
}

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform");

/** Make the probe see `platform`; undo with {@link restorePlatform}. */
export function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

export function restorePlatform(): void {
  if (ORIGINAL_PLATFORM) {
    Object.defineProperty(process, "platform", ORIGINAL_PLATFORM);
  }
}

/** Seed the probe's memo for `service` without spawning anything. */
export function primeKeychainMemo(service: string, present: boolean): void {
  hasKeychainCredentialCached(service, Date.now(), {
    platform: "darwin",
    account: "primed-account",
    itemExists: () => present,
  });
}

const PRICED_MODEL = "claude-sonnet-4-5";

/**
 * Drive the real `genAiRequestTelemetry` singleton through the collector's
 * live-session sink with a Claude session of two requests (the second closes
 * the first, so exactly one ships), and resolve with the shipped request once
 * the sink receives it.
 */
export function observeLiveClaudeRequest(): Promise<DesktopGenAiRequestEventInput> {
  let resolveShipped: (input: DesktopGenAiRequestEventInput) => void = () =>
    undefined;
  const shipped = new Promise<DesktopGenAiRequestEventInput>((resolve) => {
    resolveShipped = resolve;
  });
  genAiRequestTelemetry.bindRuntime({
    emitGenAiRequestEvent: (input) => resolveShipped(input),
  });
  const nowMs = Date.now();
  const at = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
  const usage = { input: 10, output: 20, cacheRead: 300, cacheWrite: 40 };
  applyLiveSessionSinks({
    session: makeSession({
      sessionId: "keychain-probe-session",
      model: PRICED_MODEL,
      tokenSeries: [
        { timestamp: at(1000), model: PRICED_MODEL, ...usage },
        { timestamp: at(2000), model: PRICED_MODEL, ...usage },
      ],
    }),
    harness: Harness.Claude,
    source: "transcript.jsonl",
    viaWatcher: true,
    lowDutyImport: false,
    generationIsCurrent: true,
    changedPaths: undefined,
    captureDefinitionEvidence: () => [],
    log: () => undefined,
  });
  return shipped;
}

export function unbindTelemetry(): void {
  genAiRequestTelemetry.bindRuntime(null);
}

/** One token group's cost, so the ledger it lands in is unambiguous. */
export const GROUP_COST_USD = 1.25;

/**
 * Read the Sessions usage summary through the SQL-aggregate fast path for one
 * Claude token group stored with `storedMode`.
 */
export function readSessionsUsage(
  storedMode: string | null
): Promise<SharedAgentSessionUsageSummary> {
  const aggregate: AgentSessionUsageAggregate = {
    totalSessions: 1,
    earliestSessionAt: "2026-10-01T00:00:00.000Z",
    latestSessionAt: "2026-10-01T00:00:00.000Z",
    tokenGroups: [
      {
        billingMode: storedMode,
        harness: "claude",
        model: PRICED_MODEL,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 300,
        cacheWriteTokens: 40,
        sessionCount: 1,
        estimatedCostUsd: GROUP_COST_USD,
      },
    ],
    harnessSessionCounts: [{ harness: "claude", sessionCount: 1 }],
    userSessionCounts: [],
    repoSessionCounts: [],
  };
  const source = {
    aggregateUsage: () => Promise.resolve(aggregate),
  } as unknown as AgentSessionSyncSource;
  return getSharedAgentSessionUsage(source, {});
}

/** The two Branches reads that resolve a billing mode per row. */
export const BranchUsageRead = {
  Tokens: "tokens",
  Events: "events",
} as const;
export type BranchUsageRead =
  (typeof BranchUsageRead)[keyof typeof BranchUsageRead];

/**
 * Run one Branches usage read over a single Claude row stored with
 * `storedMode`, returning each row's resolved billing mode.
 */
export async function readBranchBillingModes(
  read: BranchUsageRead,
  storedMode: string | null
): Promise<(string | null)[]> {
  const prisma = {
    client: {
      $queryRawUnsafe: () =>
        Promise.resolve([
          {
            event_row_id: "1",
            event_fingerprint: "fp-1",
            session_id: "s-1",
            model: PRICED_MODEL,
            input_tokens: "10",
            output_tokens: "20",
            cache_read_tokens: "300",
            cache_write_tokens: "40",
            cache_write_5m_tokens: null,
            cache_write_1h_tokens: null,
            billing_mode: storedMode,
            harness: "claude",
            created_at: "2026-10-01T00:00:00.000Z",
            session_started_at: "2026-10-01T00:00:00.000Z",
            cost_usd_estimated: GROUP_COST_USD,
          },
        ]),
    },
  } as unknown as DbHostPrisma;
  const rows =
    read === BranchUsageRead.Tokens
      ? await readBranchUsageTokenRows(prisma)
      : await readBranchUsageEventRows(prisma);
  return rows.map((row) => row.billingMode);
}
