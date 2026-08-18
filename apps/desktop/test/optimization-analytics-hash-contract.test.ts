/**
 * @file optimization-analytics-hash-contract.test.ts
 * @description ISS-4403 (wongk) regression: the DETAIL RESOLVER's content-scope
 * must key off the SAME hash contract usage rows carry.
 *
 * `agent_components.content_hash` is `sha256Hex(def.content)` (raw content), and
 * the routable content-hash slug + `versionId` derive from it. But
 * `agent_component_session_usage.component_version_hash` is stamped from
 * `computeDefinitionHash({ frontmatter: "", body: content, kind })` — a
 * DOMAIN-tagged, kind-scoped digest that DIFFERS from the raw-content hash for
 * the same file. If `getAgentComponentDetailLocal` scoped usage by the raw
 * `content_hash` (or emitted it as `analyticsFingerprint`), every content-scoped
 * read would match no usage row and come back empty.
 *
 * This test seeds the TWO REAL PRODUCERS (raw hash on inventory, definition hash
 * on usage) — deliberately NOT the same fake hash on both fields — so the
 * producer mismatch cannot be masked. It resolves the detail by its real
 * content-hash slug and asserts the version-scoped usage is the correct non-zero
 * count and that `analyticsFingerprint` is the definition-hash (usage) value.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  computeDefinitionHash,
  sha256Hex,
} from "@repo/api/src/definition-fingerprint";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { getAgentComponentDetailLocal } from "../src/main/dashboard/shared-agent-components-api.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { openTestPrisma } from "./prisma-test-utils.js";

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

// One skill invoked in two sessions with DIFFERENT captured content (two real
// versions of the same name). Each version's inventory content_hash is the raw
// sha256, and each usage row carries the domain-tagged computeDefinitionHash —
// the exact two producers the live app uses.
const KIND = AgentComponentKind.Skill;
const KEY = "deep-research";
const CONTENT_A = "# Deep Research\nversion A body\n";
const CONTENT_B = "# Deep Research\nversion B body — different bytes\n";

function rawHash(content: string): string {
  return sha256Hex(content);
}

function usageHash(content: string): string {
  return computeDefinitionHash({ frontmatter: "", body: content, kind: KIND })
    .definitionHash;
}

async function insertComponentWithContent(
  prisma: DesktopPrisma,
  id: string,
  content: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_components
         (id, component_kind, external_id, component_key, name, harness, source,
          content, content_hash, resolved_state, first_seen_at, last_seen_at)
       VALUES ($1, $2, $1, $3, $3, 'claude', NULL, $4, $5, 'resolved',
               '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
      id,
      KIND,
      KEY,
      content,
      rawHash(content)
    )
  );
}

async function insertSessionAndUsage(
  prisma: DesktopPrisma,
  sessionId: string,
  content: string,
  invocations: number
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, $1, 'completed', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', 'claude')`,
      sessionId
    )
  );
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_component_session_usage
         (session_id, component_kind, component_key, invocations, error_count,
          harness, component_version_hash, first_invoked_at, last_invoked_at, started_day)
       VALUES ($1, $2, $3, $4, 0, 'claude', $5,
               '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01')`,
      sessionId,
      KIND,
      KEY,
      invocations,
      usageHash(content)
    )
  );
}

test("getAgentComponentDetailLocal content-scopes usage by the DEFINITION hash usage rows carry, not the raw content_hash slug fingerprint", async () => {
  const prisma = await openScopedPrisma();
  await insertComponentWithContent(prisma, "ac-a", CONTENT_A);
  await insertComponentWithContent(prisma, "ac-b", CONTENT_B);
  await insertSessionAndUsage(prisma, "s-a", CONTENT_A, 3);
  await insertSessionAndUsage(prisma, "s-b", CONTENT_B, 5);

  // The routable content-hash slug is `${kind}::${content_hash}` (the RAW hash),
  // which is deliberately NOT the usage `component_version_hash`.
  const slugA = `${KIND}::${rawHash(CONTENT_A)}`;
  const detailA = await getAgentComponentDetailLocal(prisma, slugA);

  assert.ok(detailA, "version A detail resolves by its content-hash slug");
  // The bug: scoping by the raw slug hash matched no usage row → 0. The fix
  // scopes by computeDefinitionHash(content) → version A's own 3 invocations.
  assert.equal(detailA.invocations, 3);
  assert.equal(detailA.sessions, 1);
  // analyticsFingerprint is the DEFINITION hash (what the panel must scope by),
  // NOT the raw content_hash slug fingerprint.
  assert.equal(detailA.analyticsFingerprint, usageHash(CONTENT_A));
  assert.notEqual(detailA.analyticsFingerprint, rawHash(CONTENT_A));

  const slugB = `${KIND}::${rawHash(CONTENT_B)}`;
  const detailB = await getAgentComponentDetailLocal(prisma, slugB);
  assert.ok(detailB, "version B detail resolves");
  assert.equal(detailB.invocations, 5);
  assert.equal(detailB.analyticsFingerprint, usageHash(CONTENT_B));
  // Distinct versions render distinct scoped counts.
  assert.notEqual(detailA.invocations, detailB.invocations);
});

test("a legacy name-level slug aggregates both versions and emits no analyticsFingerprint", async () => {
  const prisma = await openScopedPrisma();
  await insertComponentWithContent(prisma, "acn-a", CONTENT_A);
  await insertComponentWithContent(prisma, "acn-b", CONTENT_B);
  await insertSessionAndUsage(prisma, "sn-a", CONTENT_A, 3);
  await insertSessionAndUsage(prisma, "sn-b", CONTENT_B, 5);

  // Name-level slug (`${kind}::${key}`) — the pre-FEA-4335 route.
  const detail = await getAgentComponentDetailLocal(prisma, `${KIND}::${KEY}`);
  assert.ok(detail);
  // Aggregates BOTH versions (3 + 5), and stays name-level (no content scope).
  assert.equal(detail.invocations, 8);
  assert.equal(detail.sessions, 2);
  assert.equal(detail.analyticsFingerprint, undefined);
});
