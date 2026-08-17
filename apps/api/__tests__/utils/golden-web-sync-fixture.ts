/**
 * PLN-1389 Phase 2.4 — YAML->assertion helper for the golden web-sync parity test.
 *
 * Two read-only loaders:
 *   - `loadGoldenExpectations` reads a dossier's frozen `expectations.yaml`
 *     (the oracle) from `packages/golden-sessions/` and returns the session/token/
 *     turn subset the cloud parity test asserts against. It only READS the oracle
 *     file; it never transforms a session.
 *   - `loadDerivedSyncFixture` reads the DERIVED payload frozen by
 *     `apps/desktop/scripts/regen-golden-sync-payloads.ts` (Phase 1) from
 *     `apps/api/__tests__/fixtures/golden-web-sync/`.
 *
 * Keeping the oracle read here (not baked into the derived fixture) means a change
 * to the human `expectations.yaml` is reflected directly in the assertion — the
 * derived payload never becomes a second, drifting oracle.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const UTILS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(UTILS_DIR, "../../../..");
const FIXTURES_DIR = resolve(UTILS_DIR, "../fixtures/golden-web-sync");
const GOLDEN_DIR = resolve(REPO_ROOT, "packages/golden-sessions");

// A dossier id is a bare directory/file basename; reject path-like input so it
// can never escape the golden/fixtures roots (matches the regen script guard).
function assertSafeSessionId(sessionId: string): void {
  if (
    sessionId.length === 0 ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("..")
  ) {
    throw new Error(
      `Unsafe dossier id ${JSON.stringify(sessionId)}: expected a bare basename (no path separators or "..").`
    );
  }
}

// ── Human oracle (expectations.yaml) ────────────────────────────────────────

const goldenTokenSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cache_read: z.number().int().nonnegative(),
  cache_write: z.number().int().nonnegative(),
});

// Non-strict: expectations.yaml carries more (cost, subagents, activity, …); we
// pick only the session/token/turn facts in R5's scope.
const goldenExpectationsSchema = z.object({
  session_id: z.string(),
  harness: z.string(),
  session: z.object({
    status: z.string(),
    primary_model: z.string(),
    models_used: z.array(z.string()),
  }),
  turns: z.object({
    total: z.number().int().nonnegative(),
    user: z.number().int().nonnegative(),
    assistant: z.number().int().nonnegative(),
    tool_result: z.number().int().nonnegative(),
  }),
  tokens_by_model: z.record(z.string(), goldenTokenSchema),
});

export type GoldenTokenExpectation = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type GoldenExpectations = {
  sessionId: string;
  harness: string;
  status: string;
  primaryModel: string;
  modelsUsed: string[];
  turns: { total: number; user: number; assistant: number; toolResult: number };
  tokensByModel: Record<string, GoldenTokenExpectation>;
};

/** Read + validate the golden oracle for `sessionId` (read-only). */
export function loadGoldenExpectations(sessionId: string): GoldenExpectations {
  assertSafeSessionId(sessionId);
  const raw = parseYaml(
    readFileSync(join(GOLDEN_DIR, sessionId, "expectations.yaml"), "utf8")
  );
  const parsed = goldenExpectationsSchema.parse(raw);
  return {
    sessionId: parsed.session_id,
    harness: parsed.harness,
    status: parsed.session.status,
    primaryModel: parsed.session.primary_model,
    modelsUsed: parsed.session.models_used,
    turns: {
      total: parsed.turns.total,
      user: parsed.turns.user,
      assistant: parsed.turns.assistant,
      toolResult: parsed.turns.tool_result,
    },
    tokensByModel: Object.fromEntries(
      Object.entries(parsed.tokens_by_model).map(([model, token]) => [
        model,
        {
          input: token.input,
          output: token.output,
          cacheRead: token.cache_read,
          cacheWrite: token.cache_write,
        },
      ])
    ),
  };
}

// ── Derived sync payload (frozen by the Phase 1 regen script) ────────────────

export type DerivedSyncFixture = {
  schemaVersion: number;
  sessions: SyncedAgentSession[];
};

// The sessions are validated in full by parseDesktopAgentSessionsPayload in the
// test (the production ingress contract); here we only guard the envelope shape
// and that each session carries an id, and preserve every field via passthrough.
const derivedSyncFixtureSchema = z.object({
  schemaVersion: z.number().int(),
  sessions: z
    .array(z.object({ externalSessionId: z.string().min(1) }).passthrough())
    .min(1),
});

/** Read the derived, regenerable payload for `sessionId`. */
export function loadDerivedSyncFixture(sessionId: string): DerivedSyncFixture {
  assertSafeSessionId(sessionId);
  const path = join(FIXTURES_DIR, `${sessionId}.synced-session.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Missing/invalid derived fixture for ${sessionId} at ${path}. Regenerate with \`pnpm --filter desktop run regen:golden-sync-payloads ${sessionId}\`. Cause: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const parsed = derivedSyncFixtureSchema.parse(raw);
  return {
    schemaVersion: parsed.schemaVersion,
    sessions: parsed.sessions as unknown as SyncedAgentSession[],
  };
}
