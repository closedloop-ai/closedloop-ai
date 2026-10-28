/**
 * @file local-version-usage-read.test.ts
 * @description ISS-10467 — the DESKTOP half of the per-content-version usage
 * drill-down, read against a real seeded local store.
 *
 * WHAT ONLY THIS SUITE CAN CATCH. The one step between real per-version numbers
 * and zeros that merely LOOK measured is the digest translation: the selector
 * offers `agent_component_versions.content_hash` (a raw `sha256Hex(content)`)
 * while `agent_component_session_usage.component_version_hash` is stamped with
 * `computeDefinitionHash({ frontmatter: "", body: content, kind })`. A fixture
 * that seeds the SAME string in both columns passes whichever of the two the
 * read happens to use, so every case here seeds them DIFFERENT (tamsinb
 * review) — the usage rows carry only the definition digest, never the raw
 * content hash.
 */

import assert from "node:assert/strict";
import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { test } from "vitest";
import {
  localVersionSpend,
  readAgentComponentVersionUsageLocal,
} from "../src/main/dashboard/local-version-usage-read.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import {
  insertComponent,
  insertUsage,
} from "./agent-components-test-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const KIND = AgentComponentKind.Skill;
const KEY = "frankenstein";
const SLUG = encodeComponentSlug(KIND, KEY);
const BODY = "# Frankenstein\n\nRun the ticket.\n";
/**
 * Deliberately NOT `sha256Hex(BODY)`. The read must never match a usage row on
 * this value, and spelling it as an obviously-synthetic literal keeps the two
 * digest spaces visibly distinct in the fixture.
 */
const RAW_CONTENT_HASH = "rawcontenthash-frankenstein-v1";
const EMPTY_BODY_CONTENT_HASH = "rawcontenthash-frankenstein-empty";

/**
 * The digest a usage row actually carries for a body.
 *
 * Derived from `computeDefinitionHash` DIRECTLY rather than through the read's
 * own `usageScopeHashForContent`, so the fixture is independent of the helper
 * under test. Routing it through that helper would make a regression there move
 * BOTH sides of the comparison — the seeded hash and the scope predicate — and
 * the suite would stay green on the exact defect it exists to catch.
 */
function usageDigestFor(content: string): string {
  return computeDefinitionHash({ body: content, frontmatter: "", kind: KIND })
    .definitionHash;
}

async function insertVersion(
  prisma: DesktopPrisma,
  row: { contentHash: string; content: string }
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_component_versions
         (id, component_kind, component_key, source, content_hash, content,
          format, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, '', $4, $5, 'md',
               '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
      `v-${row.contentHash}`,
      KIND,
      KEY,
      row.contentHash,
      row.content
    )
  );
}

async function seedFamily(prisma: DesktopPrisma): Promise<void> {
  await insertComponent(prisma, {
    id: "c-frankenstein",
    kind: KIND,
    externalId: "ext-frankenstein",
    key: KEY,
    contentHash: RAW_CONTENT_HASH,
    content: BODY,
  });
}

test("a revision's usage is found through the definition digest, not the content hash", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedFamily(prisma);
    await insertVersion(prisma, {
      contentHash: RAW_CONTENT_HASH,
      content: BODY,
    });
    // The usage rows carry ONLY the definition digest — exactly what the
    // collector stamps. If the read scoped by `content_hash` these rows would
    // be invisible and the entry would publish a fabricated measured zero.
    await insertUsage(prisma, {
      sessionId: "s-1",
      kind: KIND,
      key: KEY,
      invocations: 5,
      versionHash: usageDigestFor(BODY),
      lastInvokedAt: "2026-06-01T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s-2",
      kind: KIND,
      key: KEY,
      invocations: 2,
      versionHash: usageDigestFor(BODY),
      lastInvokedAt: "2026-06-02T00:00:00.000Z",
    });

    const result = await readAgentComponentVersionUsageLocal({
      prisma,
      slug: SLUG,
      versionHashes: [RAW_CONTENT_HASH],
    });

    assert.ok(result);
    const [entry] = result.entries;
    assert.equal(entry.hash, RAW_CONTENT_HASH);
    assert.equal(entry.invocations, 7);
    assert.equal(entry.sessions, 2);
    // And the family partition agrees that those rows DID name a version, so a
    // reader is not told the same invocations are unattributable.
    assert.equal(result.attribution.versioned.invocations, 7);
    assert.equal(result.attribution.unversioned.invocations, 0);
  } finally {
    await close();
  }
});

test("a revision whose usage rows carry only the raw content hash reads as a measured zero", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedFamily(prisma);
    await insertVersion(prisma, {
      contentHash: RAW_CONTENT_HASH,
      content: BODY,
    });
    // The counterfactual of the case above: rows stamped with the SELECTOR's
    // hash are not this revision's usage, so the entry must not claim them.
    // A read that matched on `content_hash` would return 4 here and 0 above.
    await insertUsage(prisma, {
      sessionId: "s-3",
      kind: KIND,
      key: KEY,
      invocations: 4,
      versionHash: RAW_CONTENT_HASH,
      lastInvokedAt: "2026-06-03T00:00:00.000Z",
    });

    const result = await readAgentComponentVersionUsageLocal({
      prisma,
      slug: SLUG,
      versionHashes: [RAW_CONTENT_HASH],
    });

    assert.ok(result);
    // A MEASURED zero (the read ran), not `null` (nothing was computed) — the
    // ISS-5363 contract the panel renders differently.
    assert.equal(result.entries[0].invocations, 0);
    assert.equal(result.entries[0].sessions, 0);
  } finally {
    await close();
  }
});

test("an empty definition body is a hashable revision, not an uncapturable one", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedFamily(prisma);
    await insertVersion(prisma, {
      contentHash: EMPTY_BODY_CONTENT_HASH,
      content: "",
    });
    await insertUsage(prisma, {
      sessionId: "s-4",
      kind: KIND,
      key: KEY,
      invocations: 3,
      versionHash: usageDigestFor(""),
      lastInvokedAt: "2026-06-04T00:00:00.000Z",
    });

    const result = await readAgentComponentVersionUsageLocal({
      prisma,
      slug: SLUG,
      versionHashes: [EMPTY_BODY_CONTENT_HASH],
    });

    assert.ok(result);
    // Before the `content == null` fix this took the falsy-body branch and
    // published `null` — a not-computed dash on Electron for the very revision
    // the cloud reported measured usage for (whitlockk review).
    assert.equal(result.entries[0].invocations, 3);
    assert.equal(result.entries[0].sessions, 1);
  } finally {
    await close();
  }
});

test("a revision the local history does not carry is not computed, never a zero", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedFamily(prisma);
    await insertVersion(prisma, {
      contentHash: RAW_CONTENT_HASH,
      content: BODY,
    });

    const result = await readAgentComponentVersionUsageLocal({
      prisma,
      slug: SLUG,
      versionHashes: ["a-hash-this-machine-never-saw"],
    });

    assert.ok(result);
    assert.equal(result.entries[0].invocations, null);
    assert.equal(result.entries[0].sessions, null);
  } finally {
    await close();
  }
});

/**
 * ISS-10467 (operator ruling, marisolashgrove 2026-09-26) — the DESKTOP token/cost
 * adapter.
 *
 * The fold itself is pinned in `packages/api/src/utils/version-spend.test.ts`;
 * what only this surface can get wrong is the MAPPING — which desktop field
 * answers each term, and what an absent record means. A desktop that answered
 * differently from the cloud for one input is the Local/Cloud divergence the
 * shared fold exists to prevent.
 */
function listItem(
  externalSessionId: string,
  counters: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }
): AgentSessionListItem {
  return {
    externalSessionId,
    inputTokens: counters.input,
    outputTokens: counters.output,
    cacheReadTokens: counters.cacheRead,
    cacheWriteTokens: counters.cacheWrite,
  } as unknown as AgentSessionListItem;
}

test("desktop spend sums all four token counters and only the priced costs", () => {
  const spend = localVersionSpend(
    ["s-1", "s-2"],
    [
      listItem("s-1", {
        input: 300,
        output: 200,
        cacheRead: 400,
        cacheWrite: 100,
      }),
      listItem("s-2", {
        input: 100,
        output: 100,
        cacheRead: 100,
        cacheWrite: 100,
      }),
    ],
    new Map([
      ["s-1", { cost: 7, costMeasured: true }],
      ["s-2", { cost: 5, costMeasured: true }],
    ])
  );

  // 1,000 + 400: a mapping that dropped cache reads would report 600 + 300.
  assert.equal(spend.totalTokens, 1400);
  assert.equal(spend.estimatedCostUsd, 12);
  assert.equal(spend.totalTokensPartial, false);
  assert.equal(spend.estimatedCostPartial, false);
});

test("desktop spend treats an UNPRICED session as a coverage hole, not as $0", () => {
  const spend = localVersionSpend(
    ["s-1", "s-2"],
    [
      listItem("s-1", {
        input: 300,
        output: 200,
        cacheRead: 400,
        cacheWrite: 100,
      }),
      listItem("s-2", {
        input: 100,
        output: 100,
        cacheRead: 100,
        cacheWrite: 100,
      }),
    ],
    new Map([
      ["s-1", { cost: 7, costMeasured: true }],
      // `costMeasured: false` is the desktop's own verdict from
      // `resolveSessionCost`; its `cost` is the 0 that stands in for an absent
      // price, and folding that would report the revision as costing $7 total.
      ["s-2", { cost: 0, costMeasured: false }],
    ])
  );

  assert.equal(spend.estimatedCostUsd, 7);
  assert.equal(spend.estimatedCostPartial, true);
  // The token sum spans both sessions and stays exact — one absent operand must
  // not take the other with it.
  assert.equal(spend.totalTokens, 1400);
  assert.equal(spend.totalTokensPartial, false);
});

test("desktop spend reports a session it holds NO record for as unmeasured", () => {
  const spend = localVersionSpend(
    ["s-1", "s-missing"],
    [
      listItem("s-1", {
        input: 300,
        output: 200,
        cacheRead: 400,
        cacheWrite: 100,
      }),
    ],
    new Map([["s-1", { cost: 7, costMeasured: true }]])
  );

  // Published as a FLOOR rather than discarded: a real partial sum is usable and
  // a blank is not, but bare it would claim a total over a session nothing read.
  assert.equal(spend.totalTokens, 1000);
  assert.equal(spend.totalTokensPartial, true);
  assert.equal(spend.estimatedCostUsd, 7);
  assert.equal(spend.estimatedCostPartial, true);
});

test("desktop spend publishes nothing-measured rather than a zero total", () => {
  const spend = localVersionSpend(["s-1"], [], new Map());

  assert.equal(spend.totalTokens, null);
  assert.equal(spend.estimatedCostUsd, null);
  assert.equal(spend.totalTokensPartial, false);
  assert.equal(spend.estimatedCostPartial, false);
});

test("the version entry CARRIES the spend fields, honestly unmeasured with no sync source", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedFamily(prisma);
    await insertVersion(prisma, {
      contentHash: RAW_CONTENT_HASH,
      content: BODY,
    });
    await insertUsage(prisma, {
      sessionId: "s-1",
      kind: KIND,
      key: KEY,
      invocations: 5,
      versionHash: usageDigestFor(BODY),
      lastInvokedAt: "2026-06-01T00:00:00.000Z",
    });

    // No `sessionSource`, so nothing can price or count tokens for s-1. The
    // WIRING assertion: an entry built without the spread would carry `undefined`
    // here, and a fold over the found rows alone would carry a confident `0`.
    const result = await readAgentComponentVersionUsageLocal({
      prisma,
      slug: SLUG,
      versionHashes: [RAW_CONTENT_HASH],
    });

    assert.ok(result);
    assert.equal(result.entries[0].totalTokens, null);
    assert.equal(result.entries[0].estimatedCostUsd, null);
    assert.equal(result.entries[0].totalTokensPartial, false);
    assert.equal(result.entries[0].estimatedCostPartial, false);
    // And the counts ARE measured, so this cannot pass on a read that failed.
    assert.equal(result.entries[0].invocations, 5);
  } finally {
    await close();
  }
});
