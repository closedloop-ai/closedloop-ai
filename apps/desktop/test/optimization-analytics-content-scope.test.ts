/**
 * @file optimization-analytics-content-scope.test.ts
 * @description ISS-4403 behavioral tests for the content-scoped desktop
 * optimization-analytics reads. Two components share ONE name-level key but
 * carry DIFFERENT `agent_component_session_usage.component_version_hash` values
 * (the FEA-4335 same-name/different-content collision). The three read
 * functions must:
 *   - return DISTINCT results per content version when a `fingerprint` is
 *     supplied (the FULL content hash, i.e. `AgentComponentDetail.versionId`);
 *   - fall back to the combined name-level result when NO fingerprint is
 *     supplied (the pre-ISS-4403 / version-skewed-renderer behavior).
 *
 * These call the extracted production query functions
 * (`optimization-analytics-queries.ts`) directly — the same code path the IPC
 * handlers delegate to — against an ephemeral on-disk SQLite database created by
 * the production migration runner, so no live DB or `ipcMain` is required.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  queryComponentModelTrend,
  queryIsSkillLoaded,
  querySubagentFrequency,
} from "../src/main/dashboard/optimization-analytics-queries.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { openTestPrisma } from "./prisma-test-utils.js";

// Pin a non-UTC timezone so the localDay() day buckets are deterministic across
// machines/CI (mirrors component-model-analytics.test.ts). Restore the exact
// previous TZ so a co-located runner mode doesn't leak it.
const originalTz = process.env.TZ;
process.env.TZ = "America/Chicago";
after(() => {
  if (originalTz === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
  } else {
    process.env.TZ = originalTz;
  }
});

// Each test opens its own ephemeral store; collect the close fns and dispose
// them all in a single `after` so a per-test try/finally isn't needed.
const openStores: Array<() => Promise<void>> = [];
after(async () => {
  for (const close of openStores) {
    await close();
  }
});

async function openScopedPrisma(): Promise<DesktopPrisma> {
  const { prisma, close } = await openTestPrisma();
  openStores.push(close);
  return prisma;
}

const TREND_DAYS = 30;
// Two same-name/different-content versions of one component. Full 64-hex-shaped
// content hashes (the identity space AgentComponentDetail.versionId uses).
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
// Seed at "now" (noon UTC today) so the rows always fall inside the reads'
// trailing 30-day window (localCutoffDay derives from the real clock — no fake
// timers needed since correctness here is about the version-hash predicate, not
// the day boundary, which its own dedicated test in component-model-analytics
// covers). The Chicago TZ pinned above keeps the localDay() bucket stable.
const NOW = new Date();
const RECENT_TS = new Date(
  Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate(), 12, 0, 0)
).toISOString();
const RECENT_DAY = RECENT_TS.slice(0, 10);

async function insertSession(
  prisma: DesktopPrisma,
  id: string,
  startedAt: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, $1, 'completed', $2, $2, 'claude')`,
      id,
      startedAt
    )
  );
}

async function insertAgentComponent(
  prisma: DesktopPrisma,
  id: string,
  componentKind: string,
  componentKey: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_components
         (id, component_kind, external_id, component_key, first_seen_at, last_seen_at)
       VALUES ($1, $2, $1, $3, '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
      id,
      componentKind,
      componentKey
    )
  );
}

// Seeds a usage row carrying an explicit content_version_hash — the ISS-4403
// per-invocation content fingerprint the reads scope by.
async function insertUsageWithHash(
  prisma: DesktopPrisma,
  sessionId: string,
  componentKind: string,
  componentKey: string,
  invocations: number,
  versionHash: string,
  lastInvokedAt: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_component_session_usage
         (session_id, component_kind, component_key, invocations, error_count,
          started_day, component_version_hash, last_invoked_at)
       VALUES ($1, $2, $3, $4, 0, $5, $6, $7)`,
      sessionId,
      componentKind,
      componentKey,
      invocations,
      RECENT_DAY,
      versionHash,
      lastInvokedAt
    )
  );
}

async function insertTokenEvent(
  prisma: DesktopPrisma,
  sessionId: string,
  model: string,
  inputTokens: number,
  createdAt: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO token_events
         (session_id, model, created_at, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd_estimated)
       VALUES ($1, $2, $3, $4, 0, 0, 0, 0)`,
      sessionId,
      model,
      createdAt,
      inputTokens
    )
  );
}

// Seeds one session that invoked one content version of a name, with a token
// event carrying `inputTokens` so the model-trend read has a measurable sum.
async function seedVersionSession(
  prisma: DesktopPrisma,
  opts: {
    sessionId: string;
    kind: string;
    key: string;
    versionHash: string;
    invocations: number;
    inputTokens: number;
  }
): Promise<void> {
  await insertSession(prisma, opts.sessionId, RECENT_TS);
  await insertUsageWithHash(
    prisma,
    opts.sessionId,
    opts.kind,
    opts.key,
    opts.invocations,
    opts.versionHash,
    RECENT_TS
  );
  await insertTokenEvent(
    prisma,
    opts.sessionId,
    "claude-opus-4-5",
    opts.inputTokens,
    RECENT_TS
  );
}

test("getComponentModelTrend: fingerprint scopes token sums to one content version; no fingerprint sums both", async () => {
  const prisma = await openScopedPrisma();
  const kind = "command";
  const key = "deploy";
  // Two sessions, same name, different content versions.
  await seedVersionSession(prisma, {
    sessionId: "s-cmd-a",
    kind,
    key,
    versionHash: HASH_A,
    invocations: 1,
    inputTokens: 100,
  });
  await seedVersionSession(prisma, {
    sessionId: "s-cmd-b",
    kind,
    key,
    versionHash: HASH_B,
    invocations: 1,
    inputTokens: 900,
  });

  const scopedA = await queryComponentModelTrend(
    prisma,
    kind,
    key,
    null,
    TREND_DAYS,
    HASH_A
  );
  const scopedB = await queryComponentModelTrend(
    prisma,
    kind,
    key,
    null,
    TREND_DAYS,
    HASH_B
  );
  const nameLevel = await queryComponentModelTrend(
    prisma,
    kind,
    key,
    null,
    TREND_DAYS
  );

  const inputTokensOf = (r: { points: { inputTokens: number }[] }) =>
    r.points.reduce((sum, p) => sum + p.inputTokens, 0);

  // Content A and B render DISTINCT token sums (their own version only)...
  assert.equal(inputTokensOf(scopedA), 100);
  assert.equal(inputTokensOf(scopedB), 900);
  assert.notEqual(inputTokensOf(scopedA), inputTokensOf(scopedB));
  // ...and the name-level (no-fingerprint) read still sums BOTH versions, the
  // pre-ISS-4403 fallback behavior.
  assert.equal(inputTokensOf(nameLevel), 1000);
});

test("getSubagentFrequency: fingerprint scopes invocations to one content version; no fingerprint sums both", async () => {
  const prisma = await openScopedPrisma();
  const kind = "subagent";
  const key = "reviewer";
  await seedVersionSession(prisma, {
    sessionId: "s-sub-a",
    kind,
    key,
    versionHash: HASH_A,
    invocations: 2,
    inputTokens: 10,
  });
  await seedVersionSession(prisma, {
    sessionId: "s-sub-b",
    kind,
    key,
    versionHash: HASH_B,
    invocations: 5,
    inputTokens: 10,
  });

  const scopedA = await querySubagentFrequency(prisma, key, TREND_DAYS, HASH_A);
  const scopedB = await querySubagentFrequency(prisma, key, TREND_DAYS, HASH_B);
  const nameLevel = await querySubagentFrequency(prisma, key, TREND_DAYS);

  const invocationsOf = (r: { points: { invocations: number }[] }) =>
    r.points.reduce((sum, p) => sum + p.invocations, 0);
  const sessionsOf = (r: { points: { sessionCount: number }[] }) =>
    r.points.reduce((sum, p) => sum + p.sessionCount, 0);

  // Each content version reports ONLY its own invocations + session.
  assert.equal(invocationsOf(scopedA), 2);
  assert.equal(sessionsOf(scopedA), 1);
  assert.equal(invocationsOf(scopedB), 5);
  assert.equal(sessionsOf(scopedB), 1);
  assert.notEqual(invocationsOf(scopedA), invocationsOf(scopedB));
  // Name-level fallback aggregates both versions (2 + 5 = 7 across 2 sessions).
  assert.equal(invocationsOf(nameLevel), 7);
  assert.equal(sessionsOf(nameLevel), 2);
});

test("isSkillLoaded: fingerprint scopes total invocations to one content version; no fingerprint sums both", async () => {
  const prisma = await openScopedPrisma();
  const kind = "skill";
  const key = "lint";
  // One inventory row establishes the name exists; two usage sessions carry
  // different content versions of it.
  await insertAgentComponent(prisma, "ac-skill-lint", kind, key);
  await seedVersionSession(prisma, {
    sessionId: "s-skill-a",
    kind,
    key,
    versionHash: HASH_A,
    invocations: 3,
    inputTokens: 10,
  });
  await seedVersionSession(prisma, {
    sessionId: "s-skill-b",
    kind,
    key,
    versionHash: HASH_B,
    invocations: 4,
    inputTokens: 10,
  });

  const scopedA = await queryIsSkillLoaded(prisma, key, HASH_A);
  const scopedB = await queryIsSkillLoaded(prisma, key, HASH_B);
  const nameLevel = await queryIsSkillLoaded(prisma, key);

  // Both versions exist in inventory (name-level presence) and are loading...
  assert.equal(scopedA.existsInInventory, true);
  assert.equal(scopedB.existsInInventory, true);
  assert.equal(scopedA.hasUsage, true);
  assert.equal(scopedB.hasUsage, true);
  // ...but each reports ONLY its own version's invocation total.
  assert.equal(scopedA.totalInvocations, 3);
  assert.equal(scopedB.totalInvocations, 4);
  assert.notEqual(scopedA.totalInvocations, scopedB.totalInvocations);
  // Name-level fallback sums both versions (3 + 4 = 7).
  assert.equal(nameLevel.totalInvocations, 7);
});

test("isSkillLoaded: fingerprint matching no usage row reports zero, not the other version", async () => {
  const prisma = await openScopedPrisma();
  const kind = "skill";
  const key = "format";
  await insertAgentComponent(prisma, "ac-skill-format", kind, key);
  await seedVersionSession(prisma, {
    sessionId: "s-format-a",
    kind,
    key,
    versionHash: HASH_A,
    invocations: 6,
    inputTokens: 10,
  });

  // A fingerprint for a version with NO usage rows must not borrow HASH_A's
  // totals — it reports an honest zero-usage state (never a lying UI).
  const missing = await queryIsSkillLoaded(prisma, key, HASH_B);
  assert.equal(missing.existsInInventory, true);
  assert.equal(missing.hasUsage, false);
  assert.equal(missing.totalInvocations, 0);
  assert.equal(missing.lastUsedAt, null);
});
