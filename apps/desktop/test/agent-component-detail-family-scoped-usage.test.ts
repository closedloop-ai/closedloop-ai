/**
 * @file agent-component-detail-family-scoped-usage.test.ts
 * @description ISS-10341, desktop half. `getAgentComponentDetailLocal` sums the
 * component FAMILY on a content-hash route — the same population the local list
 * row linking to that route reports — rather than the one byte-version the slug
 * names.
 *
 * Why this file exists (whitlockk, PR #7443): the cloud fix alone left LocalElectron
 * publishing the identical false zero. `collapseLocalFamilies` sums the family
 * and links it at the canonical version's routable key, and
 * `synthesizeUsageVersionBuckets` deliberately folds HASH-LESS usage into the
 * name-level bucket ("Hash-less usage folds into the name-level bucket"), while
 * the detail read narrowed every usage lane with
 * `AND component_version_hash = ?` — an arm no NULL row can satisfy. A component
 * whose usage predates the hash stamp therefore reported a measured `0` under a
 * list row reporting its real total.
 *
 * Its own file because `shared-agent-components-api.test.ts` is on the Biome
 * per-file grandfather list and is shrink-only, and because its sibling
 * `agent-component-detail-hash-route.test.ts` pins RESOLUTION (which slug finds
 * which row) where this pins POPULATION (which rows the totals sum).
 *
 * Seeds the TWO REAL PRODUCERS on the same rule the sibling states — the raw
 * `sha256Hex` on inventory's `content_hash`, the domain-tagged
 * `computeDefinitionHash` on usage's `component_version_hash`, never one fake
 * hash on both. `content` is seeded on the inventory row ON PURPOSE: the scope
 * digest is recomputed from it, so a null `content` returns a null scope and
 * disables the very predicate these cases exist to prove is gone.
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
const KEY = "frankenstein";

/** The live inventory row's captured definition text, and the route's hash. */
const LIVE_CONTENT = "# Frankenstein\nthe bytes the live inventory row holds\n";
const LIVE_CONTENT_HASH = sha256Hex(LIVE_CONTENT);

/** A superseded revision of the same component — same name, other bytes. */
const PRIOR_CONTENT = "# Frankenstein\nthe bytes an earlier revision held\n";

const HASH_SLUG = `${KIND}::${LIVE_CONTENT_HASH}`;
const NAME_SLUG = `${KIND}::${KEY}`;

/** What `agent_component_session_usage.component_version_hash` is stamped with. */
function usageHash(content: string): string {
  return computeDefinitionHash({ body: content, frontmatter: "", kind: KIND })
    .definitionHash;
}

/**
 * The measured production shape: one live inventory row on the current bytes,
 * and usage split three ways across the family — the current version, a
 * superseded one, and rows carrying NO version at all (32 of `frankenstein`'s
 * 36 real rows). Every row belongs to the same component; none of them is
 * another component's.
 */
async function seedFamily(
  prisma: Parameters<typeof insertComponent>[0]
): Promise<void> {
  await insertComponent(prisma, {
    content: LIVE_CONTENT,
    contentHash: LIVE_CONTENT_HASH,
    externalId: "ext-frankenstein",
    id: "c-frankenstein",
    key: KEY,
    kind: KIND,
  });
  await insertUsage(prisma, {
    invocations: 4,
    key: KEY,
    kind: KIND,
    sessionId: "sess-current",
    versionHash: usageHash(LIVE_CONTENT),
  });
  await insertUsage(prisma, {
    invocations: 10,
    key: KEY,
    kind: KIND,
    sessionId: "sess-prior",
    versionHash: usageHash(PRIOR_CONTENT),
  });
  await insertUsage(prisma, {
    invocations: 60,
    key: KEY,
    kind: KIND,
    sessionId: "sess-unstamped",
    versionHash: null,
  });
}

test("a content-hash route sums the FAMILY, including version-less and sibling-version usage", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedFamily(prisma);

    const detail = await getAgentComponentDetailLocal(prisma, HASH_SLUG);
    assert.ok(detail, "the content-hash slug must resolve its live row");

    // 4 + 10 + 60. Narrowed to the route's own version this was 4 — and with a
    // real corpus, where the version-less rows are the bulk, a measured 0.
    assert.equal(detail.invocations, 74);
    assert.equal(detail.sessions, 3);
  } finally {
    await close();
  }
});

test("the content-hash route and the name-level route report the SAME population", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedFamily(prisma);

    const byHash = await getAgentComponentDetailLocal(prisma, HASH_SLUG);
    const byName = await getAgentComponentDetailLocal(prisma, NAME_SLUG);
    assert.ok(byHash && byName);

    // Non-vacuity first: `invocations`/`sessions` are `number | null`, and two
    // nulls would satisfy the equality below while proving nothing. Pin that
    // both routes produced a real measured count before comparing them.
    assert.equal(typeof byHash.invocations, "number");
    assert.ok((byHash.invocations ?? 0) > 0);
    assert.equal(typeof byName.invocations, "number");

    // Asserted against each other, not against two pinned constants that can
    // drift apart in lockstep with the bug. One seeded row set, two routes to
    // it, one answer — which is the whole claim ISS-10341 makes.
    assert.deepEqual(
      { invocations: byHash.invocations, sessions: byHash.sessions },
      { invocations: byName.invocations, sessions: byName.sessions }
    );
  } finally {
    await close();
  }
});

test("the per-session breakdown spans the family too, not just the routed version", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedFamily(prisma);

    const detail = await getAgentComponentDetailLocal(prisma, HASH_SLUG);
    assert.ok(detail);

    // This is the second narrowed lane, and the one that mattered most: this
    // session-id set is the spine `locPerDollar` and the sessions tab both hang
    // off, so narrowing it did not understate those panels — it emptied them.
    assert.deepEqual(detail.usageSessions?.map((s) => s.sessionId).sort(), [
      "sess-current",
      "sess-prior",
      "sess-unstamped",
    ]);
    // Attribution is still per-row: widening the POPULATION must not flatten
    // which version each session actually ran at.
    assert.equal(
      detail.usageSessions?.find((s) => s.sessionId === "sess-unstamped")
        ?.versionHash,
      null
    );
    assert.equal(
      detail.usageSessions?.find((s) => s.sessionId === "sess-current")
        ?.versionHash,
      usageHash(LIVE_CONTENT)
    );
  } finally {
    await close();
  }
});

test("widening stops at the identity: another component's usage is never summed in", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedFamily(prisma);
    // A DIFFERENT component, same kind, whose usage also carries no version
    // hash. Dropping the version predicate must not become "sum every
    // version-less row of this kind".
    await insertUsage(prisma, {
      invocations: 500,
      key: "some-other-skill",
      kind: KIND,
      sessionId: "sess-other",
      versionHash: null,
    });

    const detail = await getAgentComponentDetailLocal(prisma, HASH_SLUG);
    assert.ok(detail);
    assert.equal(detail.invocations, 74);
    assert.equal(detail.sessions, 3);
  } finally {
    await close();
  }
});

test("the optimization panel's disclosed version scope is still published", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedFamily(prisma);

    const detail = await getAgentComponentDetailLocal(prisma, HASH_SLUG);
    assert.ok(detail);

    // ISS-4403's `analyticsFingerprint` SURVIVES this change. The page's totals
    // widened; the optimization panel keeps its version scope because it labels
    // it (`This version · #<short>`), so it is a disclosed narrower view rather
    // than a silent replacement of the family's numbers. ISS-10488 owns whether
    // it should widen too — until then, deleting it here would drop a shipped
    // capability, so this pins that it is still emitted and still the digest
    // usage rows actually carry.
    assert.equal(detail.analyticsFingerprint, usageHash(LIVE_CONTENT));
    assert.equal(detail.analyticsKey, KEY);
  } finally {
    await close();
  }
});
