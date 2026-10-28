/**
 * @file agent-component-detail-hash-route.test.ts
 * @description How `getAgentComponentDetailLocal` resolves a CONTENT-HASH
 * routable slug (`${kind}::${contentHash}`), against a real libSQL store
 * (ISS-8563).
 *
 * Its own file because `shared-agent-components-api.test.ts` is on the Biome
 * per-file grandfather list and is shrink-only.
 *
 * The contract under test is one branch of `resolveDetailInventoryScope`: the
 * slug resolves as a hash route only when the kind's live inventory carries
 * rows with that `content_hash`, and a slug that matches none falls through to
 * the name-level read with no fingerprint to scope by. Both sides are driven
 * here, because between them they are the whole domain of that test — which is
 * what makes the used-only read's fingerprint argument dead.
 *
 * Seeds the TWO REAL PRODUCERS on the same rule
 * `optimization-analytics-hash-contract.test.ts` states — the raw `sha256Hex`
 * on inventory's `content_hash`, the domain-tagged `computeDefinitionHash` on
 * usage's `component_version_hash`, never one fake hash on both. The same
 * value on both columns is a state production cannot reach, and it is exactly
 * the mismatch this file's subject turns on.
 */

import assert from "node:assert/strict";
import {
  computeDefinitionHash,
  sha256Hex,
} from "@repo/api/src/definition-fingerprint";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { test } from "vitest";
import { getAgentComponentDetailLocal } from "../src/main/dashboard/shared-agent-components-api.js";
import {
  insertComponent,
  insertUsage,
} from "./agent-components-test-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const KIND = AgentComponentKind.Skill;

const LIVE_CONTENT = "# Hashed Skill\nbytes a live inventory row captured\n";
const ABSENT_CONTENT = "# Hashed Skill\nbytes no live inventory row captured\n";

/** What `agent_components.content_hash` stores, and the routable slug carries. */
const LIVE_CONTENT_HASH = sha256Hex(LIVE_CONTENT);
const ABSENT_CONTENT_HASH = sha256Hex(ABSENT_CONTENT);

/** What `agent_component_session_usage.component_version_hash` is stamped with. */
function usageHash(content: string): string {
  return computeDefinitionHash({ body: content, frontmatter: "", kind: KIND })
    .definitionHash;
}

test("a content-hash slug resolves ONLY when a live inventory row carries that hash", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      contentHash: LIVE_CONTENT_HASH,
      externalId: "ext-hashed",
      id: "c-hashed",
      key: "hashed-skill",
      kind: KIND,
    });
    await insertUsage(prisma, {
      invocations: 4,
      key: "hashed-skill",
      kind: KIND,
      sessionId: "s1",
      versionHash: usageHash(LIVE_CONTENT),
    });

    const matched = await getAgentComponentDetailLocal(
      prisma,
      `${KIND}::${LIVE_CONTENT_HASH}`
    );
    assert.ok(matched, "a content-hash slug with a live row must resolve");
    assert.equal(matched.id, `${KIND}::${LIVE_CONTENT_HASH}`);

    // A well-formed content hash no live row carries. The slug carries no name
    // to fall back on, so this is a genuine not-found — NOT a detail assembled
    // out of some other version's usage.
    const unmatched = await getAgentComponentDetailLocal(
      prisma,
      `${KIND}::${ABSENT_CONTENT_HASH}`
    );
    assert.equal(unmatched, null);
  } finally {
    await close();
  }
});

test("a content-hash slug for a used-only identity 404s, and its name-level slug still resolves", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // The used-only ("orphan") identity: usage rows carrying a
    // `component_version_hash`, and NO live inventory row at all.
    await insertUsage(prisma, {
      invocations: 7,
      key: "used-only-skill",
      kind: KIND,
      sessionId: "s1",
      versionHash: usageHash(LIVE_CONTENT),
    });

    // 404, and that is the honest answer rather than a gap the version hash
    // could close. The route's fingerprint is an inventory row's raw
    // `content_hash`, and the used-only read has no inventory row at all — so
    // there is neither a row to match nor captured content to recompute the
    // usage digest from.
    const byRouteHash = await getAgentComponentDetailLocal(
      prisma,
      `${KIND}::${LIVE_CONTENT_HASH}`
    );
    assert.equal(byRouteHash, null);

    // And the deleted predicate's own target value does not resolve either: the
    // exact `component_version_hash` the seeded usage row carries still 404s,
    // because the used-only read is never reached by a hash route.
    const byUsageHash = await getAgentComponentDetailLocal(
      prisma,
      `${KIND}::${usageHash(LIVE_CONTENT)}`
    );
    assert.equal(byUsageHash, null);

    // The same usage is still reachable name-level, so the 404s above are a miss
    // on an unresolvable key rather than lost data.
    const byName = await getAgentComponentDetailLocal(
      prisma,
      `${KIND}::used-only-skill`
    );
    assert.ok(byName, "the name-level route must still resolve the identity");
    assert.equal(byName.invocations, 7);
    assert.equal(byName.sourceType, "local");
  } finally {
    await close();
  }
});
