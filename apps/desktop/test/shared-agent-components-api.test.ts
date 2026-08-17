/**
 * @file shared-agent-components-api.test.ts
 * @description Unit tests for the desktop-local agent-components read handlers
 * (FEA-2923 / T-16.3): `listAgentComponentsLocal` and
 * `getAgentComponentDetailLocal`. Seeds an ephemeral libSQL store (schema via
 * the production migration runner) with `agent_components` +
 * `agent_component_session_usage` rows and asserts the readers project REAL
 * inventory into the shared `AgentComponent` shapes — including the plugin
 * child-usage rollup, the identity-slug contract, filtering, and 404 semantics.
 *
 * These tests fail if the read wiring reverts to the previous phantom/stub
 * (an undefined preload method or an empty response), because they assert real
 * rows, real usage totals, and real detail resolution/rejection.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import { rawKeyInClause } from "../src/main/dashboard/hash-scope-predicates.js";
import {
  coerceAgentComponentFilters,
  getAgentComponentDetailLocal,
  listAgentComponentsLocal,
  matchingUsageRawKeys,
} from "../src/main/dashboard/shared-agent-components-api.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
// Seed helpers shared with `agent-components-honest-source.test.ts`.
import {
  type InvocationSeed,
  insertComponent,
  insertInvocations,
  insertUsage,
} from "./agent-components-test-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";
import { fakeLocCostSource } from "./shared-agent-components-loc-cost-source.js";

// ---------------------------------------------------------------------------
// listAgentComponentsLocal
// ---------------------------------------------------------------------------

test("listAgentComponentsLocal returns real rows with usage totals", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-skill",
      kind: "skill",
      externalId: "ext-skill",
      key: "deep-research",
    });
    // Two sessions invoke the skill: 3 + 2 invocations across 2 sessions.
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "deep-research",
      invocations: 3,
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "skill",
      key: "deep-research",
      invocations: 2,
    });

    const result = await listAgentComponentsLocal(prisma, {});
    assert.equal(result.total, 1);
    assert.equal(result.items.length, 1);
    const item = result.items[0];
    // Identity slug contract: id === `${kind}::${lowercased key}`.
    assert.equal(item.id, "skill::deep-research");
    assert.equal(item.name, "deep-research");
    assert.equal(item.kind, "skill");
    assert.equal(item.invocations, 5);
    assert.equal(item.sessions, 2);
  } finally {
    await close();
  }
});

const HASH_A = `${"a".repeat(64)}`;
const HASH_B = `${"b".repeat(64)}`;

test("listAgentComponentsLocal collapses same-named components with distinct content hashes into ONE canonical family row (FEA-4267)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Same kind + key (so same name-only slug), different content_hash. The
    // per-version merge still fingerprints each hash internally, but FEA-4267
    // collapses that family into ONE canonical list row (mirroring the cloud
    // list): the offline catalog no longer shows a duplicate row per version.
    await insertComponent(prisma, {
      id: "c-a",
      kind: "skill",
      externalId: "ext-a",
      key: "code-review",
      contentHash: HASH_A,
    });
    await insertComponent(prisma, {
      id: "c-b",
      kind: "skill",
      externalId: "ext-b",
      key: "code-review",
      contentHash: HASH_B,
    });

    const result = await listAgentComponentsLocal(prisma, {});
    assert.equal(result.total, 1);
    assert.equal(result.items.length, 1);
    const [item] = result.items;
    // FEA-4335: the canonical family row's detail key is the CONTENT-HASH
    // routable key (`${kind}::${contentHash}`) of its chosen representative
    // version — the freshest of the two content hashes (HASH_A/HASH_B share equal
    // seen/invoked dates here, so the `id` tiebreak picks the row whose built id
    // sorts first: `skill::${HASH_A}` < `skill::${HASH_B}`). Two same-named,
    // different-bytes components therefore no longer collide onto one name-level
    // detail URI. The family still collapses to ONE list row and reports its
    // version count instead of a single-version badge.
    assert.equal(item.id, `skill::${HASH_A}`);
    assert.equal(item.slug, `skill::${HASH_A}`);
    assert.equal(item.versionCount, 2);
    assert.equal(item.versionId, undefined);
    assert.equal(item.fingerprint, undefined);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal attributes versioned usage to the MATCHING version bucket BEFORE collapse, so the family total is not doubled (FEA-3982 wongk / FEA-4267)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // A name owns two fingerprinted inventory rows (HASH_A, HASH_B). Usage that
    // carried HASH_A must land ONLY on the HASH_A version bucket — not be applied
    // to both — and only THEN collapse into the one canonical family row. If the
    // 4 invocations had leaked onto both versions, the collapsed SUM would be 8.
    await insertComponent(prisma, {
      id: "c-a",
      kind: "skill",
      externalId: "ext-a",
      key: "code-review",
      contentHash: HASH_A,
    });
    await insertComponent(prisma, {
      id: "c-b",
      kind: "skill",
      externalId: "ext-b",
      key: "code-review",
      contentHash: HASH_B,
    });
    await insertUsage(prisma, {
      sessionId: "s-a",
      kind: "skill",
      key: "code-review",
      invocations: 4,
      versionHash: HASH_A,
    });

    const result = await listAgentComponentsLocal(prisma, {});
    assert.equal(result.total, 1);
    const [item] = result.items;
    assert.equal(item.versionCount, 2);
    // Exactly the HASH_A usage (4 / 1 session) survives collapse — not doubled.
    assert.equal(item.invocations, 4);
    assert.equal(item.sessions, 1);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal surfaces usage whose carried hash predates the current inventory hash (FEA-3982 wongk — hash-at-invocation != current)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // The SINGLE inventory row is now on HASH_B (the component was updated), but a
    // historical session carried HASH_A. That A usage must still surface — on its
    // own A version bucket — rather than vanish or be mis-attributed to B.
    await insertComponent(prisma, {
      id: "c-b",
      kind: "skill",
      externalId: "ext-b",
      key: "code-review",
      contentHash: HASH_B,
    });
    await insertUsage(prisma, {
      sessionId: "s-old",
      kind: "skill",
      key: "code-review",
      invocations: 7,
      versionHash: HASH_A,
    });
    await insertUsage(prisma, {
      sessionId: "s-new",
      kind: "skill",
      key: "code-review",
      invocations: 2,
      versionHash: HASH_B,
    });

    const result = await listAgentComponentsLocal(prisma, {});
    // Two version buckets are built internally (the seeded B inventory row + the
    // synthesized A bucket for the historical usage), then FEA-4267 collapses
    // them into one canonical family row. The A usage must NOT vanish: its 7
    // invocations survive into the collapsed SUM (7 + 2 = 9), sessions UNION
    // {s-old, s-new} = 2.
    assert.equal(result.total, 1);
    const [item] = result.items;
    assert.equal(item.versionCount, 2);
    assert.equal(item.invocations, 9);
    assert.equal(item.sessions, 2);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal keeps hash-less usage OFF the versioned sibling before collapse, so the family total is not doubled (FEA-3982 skew-safe / FEA-4267)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // One versioned inventory row (HASH_A) and one hash-less legacy inventory row
    // for the same name. Hash-less usage stays on the name-level bucket; it must
    // not leak onto the HASH_A version. FEA-4267 then collapses the family into
    // ONE canonical row — the 5 hash-less invocations survive exactly once (not
    // doubled onto the versioned sibling), sessions = 1.
    await insertComponent(prisma, {
      id: "c-a",
      kind: "skill",
      externalId: "ext-a",
      key: "code-review",
      contentHash: HASH_A,
    });
    await insertComponent(prisma, {
      id: "c-legacy",
      kind: "skill",
      externalId: "ext-legacy",
      key: "code-review",
      contentHash: null,
    });
    await insertUsage(prisma, {
      sessionId: "s-legacy",
      kind: "skill",
      key: "code-review",
      invocations: 5,
      versionHash: null,
    });

    const result = await listAgentComponentsLocal(prisma, {});
    assert.equal(result.total, 1);
    const [item] = result.items;
    assert.equal(item.versionCount, 2);
    assert.equal(item.invocations, 5);
    assert.equal(item.sessions, 1);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal keeps a hash-less legacy row as a single unversioned row (FEA-3982 skew-safe)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Two devices observe the SAME hash-less legacy row — it must still render
    // exactly once under the name-only identity, with no version badge.
    await insertComponent(prisma, {
      id: "c-legacy-1",
      kind: "skill",
      externalId: "ext-1",
      key: "legacy-skill",
      contentHash: null,
    });
    await insertComponent(prisma, {
      id: "c-legacy-2",
      kind: "skill",
      externalId: "ext-2",
      key: "legacy-skill",
      contentHash: null,
    });

    const result = await listAgentComponentsLocal(prisma, {});
    assert.equal(result.total, 1);
    const item = result.items[0];
    assert.equal(item.id, "skill::legacy-skill");
    // Absent (never null) so the wire shape stays skew-safe "unversioned".
    assert.equal(item.versionId, undefined);
    assert.equal(item.fingerprint, undefined);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal populates lastInvokedAt from max usage recency, distinct from lastSeenAt (FEA-3310)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Inventory `last_seen_at` is the sync-refreshed observation time
    // ('2026-06-01' from insertComponent) — NOT a usage signal.
    await insertComponent(prisma, {
      id: "c-skill",
      kind: "skill",
      externalId: "ext-skill",
      key: "deep-research",
    });
    // Two invocations at distinct times; the later one governs lastInvokedAt.
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "deep-research",
      invocations: 3,
      lastInvokedAt: "2026-06-04T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "skill",
      key: "deep-research",
      invocations: 2,
      lastInvokedAt: "2026-06-09T00:00:00.000Z",
    });

    const result = await listAgentComponentsLocal(prisma, {});
    const item = result.items[0];
    // Real usage-recency: the MAX across usage rows, its OWN field — the
    // "recently active" indicator keys off this (FEA-3179), not lastSeenAt.
    assert.equal(item.lastInvokedAt, "2026-06-09T00:00:00.000Z");
    // ...and it is genuinely distinct from the inventory-observation lastSeenAt.
    assert.equal(item.lastSeenAt, "2026-06-01T00:00:00.000Z");
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal omits lastInvokedAt for a component with no usage rows (FEA-3310)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // A configured-only skill that was observed as inventory but never invoked.
    await insertComponent(prisma, {
      id: "c-skill",
      kind: "skill",
      externalId: "ext-skill",
      key: "never-run",
    });

    const result = await listAgentComponentsLocal(prisma, {});
    const item = result.items[0];
    // No usage rows ⇒ the field is absent (undefined), matching the cloud
    // contract — "recently active" is simply false, never a bogus timestamp.
    assert.equal(item.lastInvokedAt, undefined);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal sums usage across slug-colliding key variants (FEA-2998)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // One component, but usage rows stored under un-normalized key variants
    // (casing/whitespace) that all collapse to the same identity slug once
    // `encodeComponentSlug` lowercases/trims. `USAGE_AGGREGATE_SQL` groups by
    // the NORMALIZED key, so the three variants fold into one row whose totals
    // already span every variant — desktop must read the same count as web for
    // the same component (pre-fix, raw-key grouping discarded all but the last
    // variant's totals).
    await insertComponent(prisma, {
      id: "c-sub",
      kind: "subagent",
      externalId: "ext-sub",
      key: "Reviewer",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "subagent",
      key: "Reviewer",
      invocations: 3,
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "subagent",
      key: "reviewer",
      invocations: 2,
    });
    await insertUsage(prisma, {
      sessionId: "s3",
      kind: "subagent",
      key: " reviewer ",
      invocations: 4,
    });

    const result = await listAgentComponentsLocal(prisma, {});
    assert.equal(result.total, 1);
    const item = result.items[0];
    assert.equal(item.id, "subagent::reviewer");
    // 3 + 2 + 4 invocations across sessions {s1, s2, s3}; pre-fix this returned
    // only the last colliding group's totals (4 invocations / 1 session).
    assert.equal(item.invocations, 9);
    assert.equal(item.sessions, 3);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal unions sessions shared across colliding key variants (FEA-2998)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // A SINGLE session (s1) logs usage under two colliding raw-key variants in
    // the same run. Because `component_key` is part of the usage table's
    // per-session key, that one session yields a distinct row per variant. If
    // the reader summed per-variant `COUNT(DISTINCT session_id)` values, s1
    // would be counted once per variant and the session total would overstate
    // real usage. Grouping by the normalized key in SQL makes the count a true
    // distinct-session union, so s1 counts once.
    await insertComponent(prisma, {
      id: "c-sub",
      kind: "subagent",
      externalId: "ext-sub",
      key: "Reviewer",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "subagent",
      key: "Reviewer",
      invocations: 3,
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "subagent",
      key: "reviewer",
      invocations: 2,
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "subagent",
      key: "reviewer",
      invocations: 4,
    });

    const result = await listAgentComponentsLocal(prisma, {});
    assert.equal(result.total, 1);
    const item = result.items[0];
    assert.equal(item.id, "subagent::reviewer");
    // Invocations still sum across every variant/session: 3 + 2 + 4 = 9.
    assert.equal(item.invocations, 9);
    // Distinct sessions {s1, s2} = 2 — s1 is NOT double-counted despite logging
    // under two variants (a naive per-variant session sum would yield 3).
    assert.equal(item.sessions, 2);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal excludes uninstalled (tombstoned) rows", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-live",
      kind: "command",
      externalId: "ext-live",
      key: "review",
    });
    await insertComponent(prisma, {
      id: "c-dead",
      kind: "command",
      externalId: "ext-dead",
      key: "old-cmd",
      uninstalledAt: "2026-05-01T00:00:00.000Z",
    });

    const result = await listAgentComponentsLocal(prisma, {});
    assert.equal(result.total, 1);
    assert.equal(result.items[0].id, "command::review");
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal filters by kind and search", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-skill",
      kind: "skill",
      externalId: "ext-skill",
      key: "deep-research",
    });
    await insertComponent(prisma, {
      id: "c-cmd",
      kind: "command",
      externalId: "ext-cmd",
      key: "review",
    });

    const onlySkills = await listAgentComponentsLocal(prisma, {
      kinds: ["skill"],
    });
    assert.equal(onlySkills.total, 1);
    assert.equal(onlySkills.items[0].kind, "skill");

    const searched = await listAgentComponentsLocal(prisma, {
      search: "review",
    });
    assert.equal(searched.total, 1);
    assert.equal(searched.items[0].id, "command::review");
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal rolls up plugin usage from child components", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // A plugin whose own pack_id == its component_key == "gstack".
    await insertComponent(prisma, {
      id: "c-plugin",
      kind: "plugin",
      externalId: "claude|/x|gstack",
      key: "gstack",
      name: "GStack",
      packId: "gstack",
    });
    // Two child components that ship inside the plugin (pack_id = "gstack").
    await insertComponent(prisma, {
      id: "c-child-skill",
      kind: "skill",
      externalId: "gstack-skill",
      key: "gstack-nav",
      packId: "gstack",
    });
    await insertComponent(prisma, {
      id: "c-child-cmd",
      kind: "command",
      externalId: "gstack-cmd",
      key: "gstack-shot",
      packId: "gstack",
    });
    // Child usage: skill 4 invocations in s1, command 1 in s1, 2 in s2.
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "gstack-nav",
      invocations: 4,
      lastInvokedAt: "2026-06-05T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "command",
      key: "gstack-shot",
      invocations: 1,
      lastInvokedAt: "2026-06-07T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "command",
      key: "gstack-shot",
      invocations: 2,
      lastInvokedAt: "2026-06-06T00:00:00.000Z",
    });

    const result = await listAgentComponentsLocal(prisma, {
      kinds: ["plugin"],
    });
    assert.equal(result.total, 1);
    const plugin = result.items[0];
    assert.equal(plugin.kind, "plugin");
    // Rollup: invocations 4+1+2 = 7 across distinct sessions {s1, s2} = 2.
    assert.equal(plugin.invocations, 7);
    assert.equal(plugin.sessions, 2);
    // Usage-recency rolls up too: the MAX child last_invoked_at (FEA-3310).
    assert.equal(plugin.lastInvokedAt, "2026-06-07T00:00:00.000Z");
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal does not double-count a plugin's pack total across its version buckets (FEA-3982 wongk)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // The SAME plugin observed at two content versions (plugin.json updated A->B)
    // splits into two version buckets. The child pack rollup is version-agnostic,
    // so the full pack total must land on ONE bucket, not be duplicated on both.
    await insertComponent(prisma, {
      id: "c-plugin-a",
      kind: "plugin",
      externalId: "claude|/x|gstack",
      key: "gstack",
      name: "GStack",
      packId: "gstack",
      contentHash: HASH_A,
    });
    await insertComponent(prisma, {
      id: "c-plugin-b",
      kind: "plugin",
      externalId: "claude|/y|gstack",
      key: "gstack",
      name: "GStack",
      packId: "gstack",
      contentHash: HASH_B,
    });
    await insertComponent(prisma, {
      id: "c-child",
      kind: "skill",
      externalId: "gstack-skill",
      key: "gstack-nav",
      packId: "gstack",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "gstack-nav",
      invocations: 6,
    });

    const result = await listAgentComponentsLocal(prisma, {
      kinds: ["plugin"],
    });
    // Two plugin version buckets carry the pack total on exactly ONE (not both);
    // FEA-4267 then collapses them into a single canonical family row. The pack
    // total (6/1) must survive the collapse exactly once — never doubled to 12.
    assert.equal(result.total, 1);
    const [plugin] = result.items;
    assert.equal(plugin.versionCount, 2);
    assert.equal(plugin.invocations, 6);
    assert.equal(plugin.sessions, 1);
  } finally {
    await close();
  }
});

// FEA-3239: the plugin child-usage join must normalize `component_key` the same
// way every sibling usage lane does (`lower(trim(COALESCE(...,'')))`). A raw,
// case/whitespace-sensitive join silently drops a child whose usage-row key
// differs only in case/whitespace from its pack-manifest inventory key,
// undercounting the plugin's invocations/sessions below the cloud reader (which
// rolls up via the true FK). This asserts the rollup counts those variant rows.
test("listAgentComponentsLocal rolls up plugin child usage across case/whitespace-variant keys", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // A plugin whose own pack_id == its component_key == "gstack".
    await insertComponent(prisma, {
      id: "c-plugin",
      kind: "plugin",
      externalId: "claude|/x|gstack",
      key: "gstack",
      name: "GStack",
      packId: "gstack",
    });
    // Child skill inventory key is stored canonically as "gstack-nav".
    await insertComponent(prisma, {
      id: "c-child-skill",
      kind: "skill",
      externalId: "gstack-skill",
      key: "gstack-nav",
      packId: "gstack",
    });
    // Child command inventory key stored as "gstack-shot".
    await insertComponent(prisma, {
      id: "c-child-cmd",
      kind: "command",
      externalId: "gstack-cmd",
      key: "gstack-shot",
      packId: "gstack",
    });
    // Usage rows log the SAME children but with case/whitespace-variant keys
    // (`GStack-Nav`, ` gstack-shot `). The raw join would miss all of these,
    // reading the plugin as 0 usage; the normalized join counts them.
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "GStack-Nav",
      invocations: 4,
      lastInvokedAt: "2026-06-05T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "command",
      key: " gstack-shot ",
      invocations: 1,
      lastInvokedAt: "2026-06-07T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "command",
      key: "GSTACK-SHOT",
      invocations: 2,
      lastInvokedAt: "2026-06-06T00:00:00.000Z",
    });

    // A LOC/cost source exercises the LOC/$ lane (`pluginUsageSessionIdsSql`),
    // whose child-usage join is normalized by the same fix. Without
    // normalization it resolves no child sessions and locPerDollar is null.
    const source = fakeLocCostSource({
      s1: { loc: { added: 2000, removed: 0 }, cost: 0.5 },
      s2: { loc: { added: 0, removed: 0 }, cost: 0.5 },
    });
    const result = await listAgentComponentsLocal(
      prisma,
      { kinds: ["plugin"] },
      null,
      source
    );
    assert.equal(result.total, 1);
    const plugin = result.items[0];
    assert.equal(plugin.kind, "plugin");
    // Rollup spans every case/whitespace variant: 4+1+2 = 7 invocations across
    // distinct sessions {s1, s2} = 2 — identical to the canonical-key rollup.
    // These prove the child-usage key normalization resolved the sessions (a raw
    // join would resolve none → invocations 0 / sessions 0).
    assert.equal(plugin.invocations, 7);
    assert.equal(plugin.sessions, 2);
    assert.equal(plugin.lastInvokedAt, "2026-06-07T00:00:00.000Z");
    // FEA-4052: LOC/$ is HIDDEN for a plugin (non-verifiable kind — its number
    // is a version-agnostic child rollup, not one component's efficiency), so it
    // is null even though the child sessions carry real LOC/cost. The
    // normalization is proven by invocations/sessions above, not by LOC/$.
    assert.equal(plugin.locPerDollar, null);
  } finally {
    await close();
  }
});

// FEA-3239: the DETAIL per-session breakdown (`PLUGIN_USAGE_SESSIONS_SQL`) uses
// the same child-usage join and must normalize the key too, or a plugin's
// usageSessions read empty/undercounted for case/whitespace-variant child keys
// even though the list rollup surfaced real usage.
test("getAgentComponentDetailLocal rolls up plugin usageSessions across case/whitespace-variant keys", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-plugin",
      kind: "plugin",
      externalId: "claude|/x|gstack",
      key: "gstack",
      name: "GStack",
      packId: "gstack",
    });
    await insertComponent(prisma, {
      id: "c-child-skill",
      kind: "skill",
      externalId: "gstack-skill",
      key: "gstack-nav",
      packId: "gstack",
    });
    await insertComponent(prisma, {
      id: "c-child-cmd",
      kind: "command",
      externalId: "gstack-cmd",
      key: "gstack-shot",
      packId: "gstack",
    });
    // Same variant-key usage as the list test: s1 = skill 4 + command 1 = 5;
    // s2 = command 2. Keys differ from inventory only in case/whitespace.
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "GStack-Nav",
      invocations: 4,
      lastInvokedAt: "2026-06-02T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "command",
      key: " gstack-shot ",
      invocations: 1,
      lastInvokedAt: "2026-06-02T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "command",
      key: "GSTACK-SHOT",
      invocations: 2,
      lastInvokedAt: "2026-06-01T00:00:00.000Z",
    });

    const detail = await getAgentComponentDetailLocal(prisma, "plugin::gstack");
    assert.ok(detail, "plugin detail should resolve");
    assert.equal(detail.kind, "plugin");
    assert.equal(detail.invocations, 7);
    assert.equal(detail.sessions, 2);
    // Per-session breakdown counts every variant row, s1 first (most recent).
    assert.equal(detail.usageSessions.length, 2);
    assert.equal(detail.usageSessions[0].sessionId, "s1");
    assert.equal(detail.usageSessions[0].invocationCount, 5);
    assert.equal(detail.usageSessions[1].sessionId, "s2");
    assert.equal(detail.usageSessions[1].invocationCount, 2);
  } finally {
    await close();
  }
});

// FEA-3239: the normalized join keeps the `ac.component_key IS NOT NULL` guard so
// the `COALESCE(NULL,'')` fold does NOT over-match a null-key inventory child to
// an empty/whitespace usage key — a join the raw `NULL = key` predicate never
// made. A legitimate child's usage is still counted; the empty-key usage is not.
test("listAgentComponentsLocal does not fold empty-key usage into a null-key plugin child", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-plugin",
      kind: "plugin",
      externalId: "claude|/x|gstack",
      key: "gstack",
      name: "GStack",
      packId: "gstack",
    });
    // A legitimate child with a real key — its usage must count.
    await insertComponent(prisma, {
      id: "c-child-skill",
      kind: "skill",
      externalId: "gstack-skill",
      key: "gstack-nav",
      packId: "gstack",
    });
    // A null-key child of the same pack. Under the raw join it joined nothing
    // (NULL = key is never true); the fold must not resurrect it via `''`.
    await insertComponent(prisma, {
      id: "c-child-null",
      kind: "command",
      externalId: "gstack-nullkey",
      key: null,
      name: "gstack-orphan",
      packId: "gstack",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "gstack-nav",
      invocations: 3,
      lastInvokedAt: "2026-06-05T00:00:00.000Z",
    });
    // An empty-key usage row (malformed capture). It must NOT be attributed to
    // the null-key child via the `COALESCE(...,'')` fold.
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "command",
      key: "",
      invocations: 5,
      lastInvokedAt: "2026-06-06T00:00:00.000Z",
    });

    const result = await listAgentComponentsLocal(prisma, {
      kinds: ["plugin"],
    });
    assert.equal(result.total, 1);
    const plugin = result.items[0];
    // Only the legitimate child's usage counts: 3 invocations in {s1} = 1
    // session. The empty-key usage (5) is not folded into the null-key child.
    assert.equal(plugin.invocations, 3);
    assert.equal(plugin.sessions, 1);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal reports honest-zero usage for hook/config kinds", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-hook",
      kind: "hook",
      externalId: "ext-hook",
      key: "pre-commit",
    });
    const result = await listAgentComponentsLocal(prisma, { kinds: ["hook"] });
    assert.equal(result.total, 1);
    // hook/config kinds have no usage rows, so they reconcile to an honest 0 —
    // matching the cloud service (apps/api/app/agent-components/service.ts),
    // which emits a numeric 0 for the identical case (not null). Divergent
    // null-vs-0 would surface the same component differently across surfaces.
    assert.equal(result.items[0].invocations, 0);
    assert.equal(result.items[0].sessions, 0);
  } finally {
    await close();
  }
});

// FEA-3048: a `tool` inventory/usage row must surface as kind='tool' (its own
// observable-only kind), NOT be coerced to 'config' by toKind(). Before adding
// 'tool' to KNOWN_KINDS, toKind() collapsed it into "config".
test("listAgentComponentsLocal surfaces a tool row as kind='tool', not coerced to config", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-tool",
      kind: "tool",
      externalId: "ext-tool",
      key: "Read",
    });
    await insertUsage(prisma, {
      sessionId: "s-tool",
      kind: "tool",
      key: "Read",
      invocations: 5,
    });

    const result = await listAgentComponentsLocal(prisma, { kinds: ["tool"] });
    assert.equal(result.total, 1, "the tool row is returned");
    assert.equal(
      result.items[0].kind,
      "tool",
      "kind stays 'tool' (not coerced to 'config')"
    );
    assert.equal(result.items[0].name, "Read");
    assert.equal(result.items[0].invocations, 5, "tool usage total surfaced");

    // A `config` filter must NOT capture the tool row (proves no coercion).
    const asConfig = await listAgentComponentsLocal(prisma, {
      kinds: ["config"],
    });
    assert.equal(
      asConfig.total,
      0,
      "the tool row is not misclassified into the config bucket"
    );
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal paginates with limit/offset", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    for (let i = 0; i < 3; i++) {
      await insertComponent(prisma, {
        id: `c-${i}`,
        kind: "skill",
        externalId: `ext-${i}`,
        // names sort a, b, c
        key: `${String.fromCharCode(97 + i)}-skill`,
      });
    }
    const page = await listAgentComponentsLocal(prisma, {
      limit: 2,
      offset: 0,
    });
    assert.equal(page.total, 3);
    assert.equal(page.items.length, 2);
    assert.equal(page.hasMore, true);

    const page2 = await listAgentComponentsLocal(prisma, {
      limit: 2,
      offset: 2,
    });
    assert.equal(page2.items.length, 1);
    assert.equal(page2.hasMore, false);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// getAgentComponentDetailLocal
// ---------------------------------------------------------------------------

test("getAgentComponentDetailLocal attributes usageSessions to the version hash (FEA-2923)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-ver",
      kind: "skill",
      externalId: "ext-ver",
      key: "deep-research",
    });
    await insertUsage(prisma, {
      sessionId: "sv1",
      kind: "skill",
      key: "deep-research",
      invocations: 4,
      versionHash: "hash-v2",
    });
    await insertUsage(prisma, {
      sessionId: "sv2",
      kind: "skill",
      key: "deep-research",
      invocations: 1,
      // No version hash recorded → attribution is null (honest).
    });

    const detail = await getAgentComponentDetailLocal(
      prisma,
      "skill::deep-research"
    );
    assert.ok(detail);
    const withHash = detail.usageSessions.find((u) => u.sessionId === "sv1");
    const withoutHash = detail.usageSessions.find((u) => u.sessionId === "sv2");
    assert.equal(withHash?.versionHash, "hash-v2");
    assert.equal(withoutHash?.versionHash, null);
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal resolves a full detail by slug", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-skill",
      kind: "skill",
      externalId: "ext-skill",
      key: "deep-research",
      installPath: "/home/u/.claude/skills/deep-research.md",
      description: "Deep research skill",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "deep-research",
      invocations: 3,
      lastInvokedAt: "2026-06-02T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "skill",
      key: "deep-research",
      invocations: 2,
      lastInvokedAt: "2026-06-01T00:00:00.000Z",
    });

    const detail = await getAgentComponentDetailLocal(
      prisma,
      "skill::deep-research"
    );
    assert.ok(detail, "detail should resolve");
    assert.equal(detail.id, "skill::deep-research");
    assert.equal(detail.invocations, 5);
    assert.equal(detail.sessions, 2);
    // Detail carries the same distinct usage-recency field as the list (FEA-3310):
    // the MAX usage last_invoked_at, not the inventory-observation lastSeenAt.
    assert.equal(detail.lastInvokedAt, "2026-06-02T00:00:00.000Z");
    assert.equal(detail.properties.format, "md");
    assert.equal(detail.prompt, "Deep research skill");
    // A legacy aggregate-only detail omits the optional page so consumers keep
    // using the existing usage/session/branch projections.
    assert.equal("invocationRows" in detail, false);
    // usageSessions: one entry per session, ordered by most-recent first.
    assert.equal(detail.usageSessions.length, 2);
    assert.equal(detail.usageSessions[0].sessionId, "s1");
    assert.equal(detail.usageSessions[0].invocationCount, 3);
    // provenance: one entry per inventory row.
    assert.equal(detail.provenance.length, 1);
    assert.equal(
      detail.provenance[0].installPath,
      "/home/u/.claude/skills/deep-research.md"
    );
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal returns a bounded deterministic exact invocation page", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-read-page",
      kind: AgentComponentInvocationKind.Skill,
      externalId: "skill:read-page",
      key: "deep-research",
    });
    await insertComponent(prisma, {
      id: "c-other",
      kind: AgentComponentInvocationKind.Skill,
      externalId: "skill:other",
      key: "other",
    });
    await insertUsage(prisma, {
      sessionId: "s-read-page",
      kind: AgentComponentInvocationKind.Skill,
      key: "deep-research",
      invocations: 502,
    });
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO agent_component_versions
           (id, component_kind, component_key, source, content_hash, content,
            format, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        "v-exact",
        AgentComponentInvocationKind.Skill,
        "deep-research",
        "/repo/.claude/skills/deep-research.md",
        "hash-exact",
        "Exact definition",
        "md",
        "2026-07-22T08:00:00.000Z"
      )
    );

    const invocationRows: InvocationSeed[] = [
      {
        id: "inv-event",
        sessionId: "s-read-page",
        componentKind: AgentComponentInvocationKind.Skill,
        // A linked row remains part of this component even if its historical
        // raw key differs from today's normalized inventory key.
        componentKey: "legacy-deep-research",
        rawName: "Deep Research",
        normalizedName: "deep-research",
        relationship: AgentComponentInvocationRelationship.ChildSession,
        childSessionId: "child-session",
        invokedAt: "2026-07-22T12:00:00.000Z",
        sequence: 0,
        anchorKind: AgentComponentInvocationAnchorKind.Event,
        anchorValue: "event-stable-id",
        providerToolUseId: "tool-use-1",
        status: AgentComponentInvocationAttributionStatus.Matched,
        evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
        evidencePointer: {
          externalAgentId: "external-agent-1",
          parentExternalInvocationId: "parent-invocation-1",
          sourcePath: "/repo/.claude/skills/deep-research.md",
          sourceModifiedAt: "2026-07-22T11:59:00.000Z",
          capturedAt: "2026-07-22T12:00:01.000Z",
        },
        definitionHash: "hash-exact",
        normalizerContractVersion: 1,
        localComponentId: "c-read-page",
        localComponentVersionId: "v-exact",
        gitBranch: "feat/read-page",
        repositoryFullName: "closedloop-ai/symphony-alpha",
      },
      {
        id: "inv-agent",
        sessionId: "s-read-page",
        componentKind: AgentComponentInvocationKind.Skill,
        componentKey: " Deep-Research ",
        invokedAt: "2026-07-22T11:00:00.000Z",
        sequence: 1,
        anchorKind: AgentComponentInvocationAnchorKind.Agent,
        anchorValue: "local-agent-1",
        evidencePointer: {
          externalAgentId: "external-agent-2",
          transcriptFileId: "agent-transcript-2",
        },
        status: AgentComponentInvocationAttributionStatus.Unmatched,
      },
      {
        id: "inv-user-turn",
        sessionId: "s-read-page",
        componentKind: AgentComponentInvocationKind.Skill,
        componentKey: "deep-research",
        invokedAt: "2026-07-22T10:00:00.000Z",
        sequence: 2,
        anchorKind: AgentComponentInvocationAnchorKind.UserTurn,
        anchorValue: "user-turn-1",
      },
      {
        id: "inv-timestamp",
        sessionId: "s-read-page",
        componentKind: AgentComponentInvocationKind.Skill,
        componentKey: "deep-research",
        invokedAt: "2026-07-22T09:00:00.000Z",
        sequence: 3,
        anchorKind: AgentComponentInvocationAnchorKind.Timestamp,
        anchorValue: JSON.stringify({
          timestamp: "2026-07-22T09:00:00.000Z",
          ordinal: 4,
        }),
      },
      {
        id: "inv-session",
        sessionId: "s-read-page",
        componentKind: AgentComponentInvocationKind.Skill,
        componentKey: "deep-research",
        invokedAt: "2026-07-22T08:00:00.000Z",
        sequence: 4,
        anchorKind: AgentComponentInvocationAnchorKind.Session,
        anchorValue: "s-read-page",
        status: AgentComponentInvocationAttributionStatus.Ambiguous,
      },
      ...Array.from({ length: 497 }, (_, index) => ({
        id: `inv-bulk-${String(index).padStart(3, "0")}`,
        sessionId: "s-read-page",
        componentKind: AgentComponentInvocationKind.Skill,
        componentKey: "deep-research",
        invokedAt: "2026-07-22T07:00:00.000Z",
        sequence: index + 5,
        anchorKind: AgentComponentInvocationAnchorKind.Session,
        anchorValue: "s-read-page",
      })),
      // Same key but explicitly linked to another inventory identity: the link
      // wins, so it must not leak into this detail's fallback lane.
      {
        id: "inv-linked-other",
        sessionId: "s-read-page",
        componentKind: AgentComponentInvocationKind.Skill,
        componentKey: "deep-research",
        invokedAt: "2026-07-23T00:00:00.000Z",
        sequence: 1000,
        anchorKind: AgentComponentInvocationAnchorKind.Session,
        anchorValue: "s-read-page",
        localComponentId: "c-other",
      },
      {
        id: "inv-unlinked-other-key",
        sessionId: "s-read-page",
        componentKind: AgentComponentInvocationKind.Skill,
        componentKey: "other",
        invokedAt: "2026-07-23T00:00:00.000Z",
        sequence: 1001,
        anchorKind: AgentComponentInvocationAnchorKind.Session,
        anchorValue: "s-read-page",
      },
    ];
    await insertInvocations(prisma, invocationRows);

    const detail = await getAgentComponentDetailLocal(
      prisma,
      "skill::deep-research"
    );
    assert.ok(detail?.invocationRows);
    const page = detail.invocationRows;
    assert.equal(page.total, 502);
    assert.equal(page.items.length, 500);
    assert.equal(page.hasMore, true);
    assert.equal(page.unmatchedCount, 1);
    assert.equal(page.ambiguousCount, 1);
    assert.deepEqual(
      page.items.slice(0, 5).map((row) => row.id),
      [
        "inv-event",
        "inv-agent",
        "inv-user-turn",
        "inv-timestamp",
        "inv-session",
      ]
    );
    assert.ok(!page.items.some((row) => row.id === "inv-linked-other"));
    assert.ok(!page.items.some((row) => row.id === "inv-unlinked-other-key"));

    assert.deepEqual(page.items[0], {
      id: "inv-event",
      externalInvocationId: "inv-event",
      sessionId: "s-read-page",
      externalSessionId: "s-read-page",
      sourceSessionId: "s-read-page",
      childSessionId: "child-session",
      parentExternalInvocationId: "parent-invocation-1",
      externalAgentId: "external-agent-1",
      kind: AgentComponentInvocationKind.Skill,
      componentKey: "legacy-deep-research",
      rawName: "Deep Research",
      normalizedName: "deep-research",
      relationship: AgentComponentInvocationRelationship.ChildSession,
      invokedAt: "2026-07-22T12:00:00.000Z",
      sequence: 0,
      anchor: {
        kind: AgentComponentInvocationAnchorKind.Event,
        eventId: "event-stable-id",
        providerToolUseId: "tool-use-1",
      },
      providerInvocationId: "tool-use-1",
      status: AgentComponentInvocationAttributionStatus.Matched,
      evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
      definitionHash: "hash-exact",
      normalizerContractVersion: 1,
      definitionVersionId: "v-exact",
      sourcePath: "/repo/.claude/skills/deep-research.md",
      sourceModifiedAt: "2026-07-22T11:59:00.000Z",
      capturedAt: "2026-07-22T12:00:01.000Z",
      repositoryFullName: "closedloop-ai/symphony-alpha",
      branchName: "feat/read-page",
    });
    assert.deepEqual(page.items[1].anchor, {
      kind: AgentComponentInvocationAnchorKind.Agent,
      agentId: "local-agent-1",
      externalAgentId: "external-agent-2",
      transcriptFileId: "agent-transcript-2",
    });
    assert.deepEqual(page.items[2].anchor, {
      kind: AgentComponentInvocationAnchorKind.UserTurn,
      userTurnId: "user-turn-1",
    });
    assert.deepEqual(page.items[3].anchor, {
      kind: AgentComponentInvocationAnchorKind.Timestamp,
      timestamp: "2026-07-22T09:00:00.000Z",
      ordinal: 4,
    });
    assert.deepEqual(page.items[4].anchor, {
      kind: AgentComponentInvocationAnchorKind.Session,
    });
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal adds invocation rows to unresolved usage detail", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertUsage(prisma, {
      sessionId: "s-unresolved-invocation",
      kind: AgentComponentInvocationKind.Skill,
      key: "ghost",
      invocations: 1,
    });
    await insertInvocations(prisma, [
      {
        id: "inv-unresolved",
        sessionId: "s-unresolved-invocation",
        componentKind: AgentComponentInvocationKind.Skill,
        componentKey: " GHOST ",
        anchorKind: AgentComponentInvocationAnchorKind.Session,
        anchorValue: "s-unresolved-invocation",
        status: AgentComponentInvocationAttributionStatus.Unresolved,
      },
    ]);

    const detail = await getAgentComponentDetailLocal(prisma, "skill::ghost");
    assert.ok(detail?.invocationRows);
    assert.equal(detail.invocationRows.total, 1);
    assert.equal(detail.invocationRows.items[0].id, "inv-unresolved");
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal unions usage across colliding key variants like the list path (FEA-2998)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Detail must read the same identity as the list endpoint: usage rows under
    // colliding raw-key variants (casing/whitespace) fold into one identity, and
    // a session shared across variants counts once. Pre-fix the detail query
    // filtered on the raw `component_key`, so it saw only one variant's rows and
    // disagreed with the list count for the same slug.
    await insertComponent(prisma, {
      id: "c-sub",
      kind: "subagent",
      externalId: "ext-sub",
      key: "Reviewer",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "subagent",
      key: "Reviewer",
      invocations: 3,
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "subagent",
      key: "reviewer",
      invocations: 2,
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "subagent",
      key: " reviewer ",
      invocations: 4,
    });

    const detail = await getAgentComponentDetailLocal(
      prisma,
      "subagent::reviewer"
    );
    assert.ok(detail, "detail should resolve");
    assert.equal(detail.id, "subagent::reviewer");
    // Invocations sum across every variant: 3 + 2 + 4 = 9.
    assert.equal(detail.invocations, 9);
    // Distinct sessions {s1, s2} = 2 — s1 counted once despite two variants.
    assert.equal(detail.sessions, 2);
    // Per-session breakdown spans variants and merges s1's rows: {s1: 5, s2: 4}.
    assert.equal(detail.usageSessions.length, 2);
    const bySession = new Map(
      detail.usageSessions.map((s) => [s.sessionId, s.invocationCount])
    );
    assert.equal(bySession.get("s1"), 5);
    assert.equal(bySession.get("s2"), 4);
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal hydrates sessionsTab from the invoking session ids via the sync source", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-skill",
      kind: "skill",
      externalId: "ext-skill",
      key: "deep-research",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "deep-research",
      invocations: 3,
      lastInvokedAt: "2026-06-02T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "skill",
      key: "deep-research",
      invocations: 2,
      lastInvokedAt: "2026-06-01T00:00:00.000Z",
    });

    // Minimal fake source: records the ids it was asked to load. Returns no
    // hydrated sessions (projection is unit-tested separately), so sessionsTab
    // resolves empty — but the WIRING (usage session ids → source) is proven.
    const loadedIds: string[][] = [];
    const fakeSource = {
      loadSyncedSessions(ids: readonly string[]) {
        loadedIds.push([...ids]);
        return [];
      },
    } as unknown as AgentSessionSyncSource;

    const detail = await getAgentComponentDetailLocal(
      prisma,
      "skill::deep-research",
      "ct-local-1",
      fakeSource
    );
    assert.ok(detail, "detail should resolve");
    // The reader fanned exactly the component's usage session ids (order:
    // most-recent-first, matching usageSessions) into the sessions source.
    assert.equal(loadedIds.length, 1);
    assert.deepEqual(loadedIds[0], ["s1", "s2"]);
    // No hydrated sessions returned ⇒ sessionsTab is empty (not undefined).
    assert.deepEqual(detail.sessionsTab, []);

    // Without a source the tab stays [] and the source is never consulted.
    const noSource = await getAgentComponentDetailLocal(
      prisma,
      "skill::deep-research",
      "ct-local-1"
    );
    assert.ok(noSource);
    assert.deepEqual(noSource.sessionsTab, []);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal surfaces the local compute-target id", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-skill",
      kind: "skill",
      externalId: "ext-skill",
      key: "deep-research",
    });
    // Passing a compute-target id populates computeTargetIds so the local
    // device shows up as an observing target (parity with the cloud list).
    const withTarget = await listAgentComponentsLocal(prisma, {}, "ct-local-1");
    assert.deepEqual(withTarget.items[0].computeTargetIds, ["ct-local-1"]);
    // FEA-4098 (Slice 3): the single git-attributed `owner` was replaced by the
    // `collaborators` authors people-set. Desktop-local reads have no org-wide
    // DefinitionVersion lineage to attribute authors from, so `collaborators` is
    // intentionally empty and the deprecated `owner` alias is omitted entirely
    // (never serialized as null) so absence stays skew-safe on the wire.
    assert.deepEqual(withTarget.items[0].collaborators, []);
    assert.equal(withTarget.items[0].owner, undefined);
    // Absent a compute-target id it degrades to an empty array (not undefined).
    const noTarget = await listAgentComponentsLocal(prisma, {});
    assert.deepEqual(noTarget.items[0].computeTargetIds, []);
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal uses the compute-target id for provenance", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-skill",
      kind: "skill",
      externalId: "ext-skill",
      key: "deep-research",
      installPath: "/home/u/.claude/skills/deep-research.md",
    });
    const detail = await getAgentComponentDetailLocal(
      prisma,
      "skill::deep-research",
      "ct-local-1"
    );
    assert.ok(detail, "detail should resolve");
    // provenance.computeTargetId is the local compute-target id, NOT the
    // inventory row's own primary key ("c-skill").
    assert.equal(detail.provenance[0].computeTargetId, "ct-local-1");
    assert.notEqual(detail.provenance[0].computeTargetId, "c-skill");
    assert.deepEqual(detail.computeTargetIds, ["ct-local-1"]);

    // Without a resolved local compute-target id, computeTargetId is an honest
    // empty string — NEVER the inventory row's content-hash id ("c-skill") —
    // while the install-path provenance is still surfaced.
    const fallback = await getAgentComponentDetailLocal(
      prisma,
      "skill::deep-research"
    );
    assert.ok(fallback);
    assert.equal(fallback.provenance[0].computeTargetId, "");
    assert.notEqual(fallback.provenance[0].computeTargetId, "c-skill");
    assert.equal(
      fallback.provenance[0].installPath,
      "/home/u/.claude/skills/deep-research.md"
    );
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal builds plugin usageSessions from child usage", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-plugin",
      kind: "plugin",
      externalId: "claude|/x|gstack",
      key: "gstack",
      name: "GStack",
      packId: "gstack",
    });
    await insertComponent(prisma, {
      id: "c-child-skill",
      kind: "skill",
      externalId: "gstack-skill",
      key: "gstack-nav",
      packId: "gstack",
    });
    await insertComponent(prisma, {
      id: "c-child-cmd",
      kind: "command",
      externalId: "gstack-cmd",
      key: "gstack-shot",
      packId: "gstack",
    });
    // s1: skill 4 + command 1 = 5 invocations; s2: command 2 invocations.
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "gstack-nav",
      invocations: 4,
      lastInvokedAt: "2026-06-02T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "command",
      key: "gstack-shot",
      invocations: 1,
      lastInvokedAt: "2026-06-02T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "command",
      key: "gstack-shot",
      invocations: 2,
      lastInvokedAt: "2026-06-01T00:00:00.000Z",
    });

    const detail = await getAgentComponentDetailLocal(prisma, "plugin::gstack");
    assert.ok(detail, "plugin detail should resolve");
    assert.equal(detail.kind, "plugin");
    // Rolled-up totals: 4+1+2 = 7 invocations across {s1, s2} = 2 sessions.
    assert.equal(detail.invocations, 7);
    assert.equal(detail.sessions, 2);
    // usageSessions must match that rollup (not be empty): the per-session
    // breakdown sums the child usage, s1 first (most recent).
    assert.equal(detail.usageSessions.length, 2);
    assert.equal(detail.usageSessions[0].sessionId, "s1");
    assert.equal(detail.usageSessions[0].invocationCount, 5);
    assert.equal(detail.usageSessions[1].sessionId, "s2");
    assert.equal(detail.usageSessions[1].invocationCount, 2);
  } finally {
    await close();
  }
});

// A fragment of `PLUGIN_USAGE_SQL` (the full-table child-usage rollup) unique to
// that query — the per-session variant selects `acsu.session_id`, not this alias.
const PLUGIN_USAGE_SQL_SIGNATURE = "ac.pack_id AS pack_id";

// Wrap a real test prisma so every `$queryRawUnsafe` still hits the ephemeral
// store but its SQL is recorded, letting a test assert which queries ran.
function withQuerySpy(prisma: DesktopPrisma): {
  spy: DesktopPrisma;
  queries: string[];
} {
  const queries: string[] = [];
  const real = prisma.client.$queryRawUnsafe.bind(prisma.client);
  const spy = {
    client: {
      $queryRawUnsafe: (query: string, ...params: unknown[]) => {
        queries.push(query);
        return real(query, ...params);
      },
    },
  } as unknown as DesktopPrisma;
  return { spy, queries };
}

test("getAgentComponentDetailLocal skips the full-table plugin-usage aggregate for a non-plugin (FEA-3123)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-skill",
      kind: "skill",
      externalId: "ext-skill",
      key: "deep-research",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "deep-research",
      invocations: 3,
    });

    const { spy, queries } = withQuerySpy(prisma);
    const detail = await getAgentComponentDetailLocal(
      spy,
      "skill::deep-research"
    );

    // Behavior is preserved: the skill still resolves with its usage totals.
    assert.ok(detail, "non-plugin detail should still resolve");
    assert.equal(detail.kind, "skill");
    assert.equal(detail.invocations, 3);
    assert.equal(detail.sessions, 1);
    // ...but the whole-table plugin-usage aggregate is never issued.
    assert.ok(
      queries.every((q) => !q.includes(PLUGIN_USAGE_SQL_SIGNATURE)),
      "PLUGIN_USAGE_SQL must not run for a non-plugin detail read"
    );
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal still issues the plugin-usage aggregate for a plugin (FEA-3123)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-plugin",
      kind: "plugin",
      externalId: "claude|/x|gstack",
      key: "gstack",
      name: "GStack",
      packId: "gstack",
    });
    await insertComponent(prisma, {
      id: "c-child-skill",
      kind: "skill",
      externalId: "gstack-skill",
      key: "gstack-nav",
      packId: "gstack",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "gstack-nav",
      invocations: 4,
    });

    const { spy, queries } = withQuerySpy(prisma);
    const detail = await getAgentComponentDetailLocal(spy, "plugin::gstack");

    // A plugin still rolls up its child usage, so the aggregate must run.
    assert.ok(detail, "plugin detail should resolve");
    assert.equal(detail.kind, "plugin");
    assert.equal(detail.invocations, 4);
    assert.ok(
      queries.some((q) => q.includes(PLUGIN_USAGE_SQL_SIGNATURE)),
      "PLUGIN_USAGE_SQL must still run for a plugin detail read"
    );
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal returns null for an unknown slug", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-skill",
      kind: "skill",
      externalId: "ext-skill",
      key: "deep-research",
    });
    const missing = await getAgentComponentDetailLocal(
      prisma,
      "skill::does-not-exist"
    );
    assert.equal(missing, null);
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal returns null for a malformed slug", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const bad = await getAgentComponentDetailLocal(prisma, "no-separator");
    assert.equal(bad, null);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// FEA-3121: invocations whose source never resolved to a live inventory row
// must still be counted (not silently dropped) and surfaced as unresolved.
// ---------------------------------------------------------------------------

test("listAgentComponentsLocal surfaces usage with no inventory row (unresolved source)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Two sessions invoked a local/discovered skill the collector never
    // recorded as installed inventory — the classic source-resolution failure.
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "local-only-skill",
      invocations: 3,
      harness: "claude",
      firstInvokedAt: "2026-06-01T00:00:00.000Z",
      lastInvokedAt: "2026-06-03T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "skill",
      key: "local-only-skill",
      invocations: 2,
      harness: "claude",
      lastInvokedAt: "2026-06-02T00:00:00.000Z",
    });

    const result = await listAgentComponentsLocal(prisma, {});
    // Previously this dropped to total=0 (only inventory rows were surfaced);
    // the invocation now appears, tagged unresolved.
    assert.equal(result.total, 1);
    const item = result.items[0];
    assert.equal(item.id, "skill::local-only-skill");
    assert.equal(item.name, "local-only-skill");
    assert.equal(item.kind, "skill");
    // Counts are preserved: 3 + 2 = 5 invocations across {s1, s2} = 2 sessions.
    assert.equal(item.invocations, 5);
    assert.equal(item.sessions, 2);
    // Tagged as unresolved-source: "local" (no resolvable pack/repo/server).
    assert.equal(item.sourceType, "local");
    assert.equal(item.source, "local-only-skill");
    assert.equal(item.harness, "claude");
    // Timestamps carry through from the usage rows.
    assert.equal(item.firstSeenAt, "2026-06-01T00:00:00.000Z");
    assert.equal(item.lastSeenAt, "2026-06-03T00:00:00.000Z");
    // An unresolved identity has no inventory observation, so lastInvokedAt
    // equals its usage-derived lastSeenAt — the max last_invoked_at (FEA-3310).
    assert.equal(item.lastInvokedAt, "2026-06-03T00:00:00.000Z");
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal does not double-count usage that HAS an inventory row", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-skill",
      kind: "skill",
      externalId: "ext-skill",
      key: "deep-research",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "deep-research",
      invocations: 4,
    });
    // A separate usage identity with no inventory row (unresolved).
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "command",
      key: "orphan-cmd",
      invocations: 2,
    });

    const result = await listAgentComponentsLocal(prisma, {});
    // Exactly two entries: the inventory-backed skill and the unresolved
    // command — the resolved skill is NOT also emitted as an unresolved row.
    assert.equal(result.total, 2);
    const bySlug = new Map(result.items.map((i) => [i.id, i]));
    const resolved = bySlug.get("skill::deep-research");
    assert.ok(resolved);
    assert.equal(resolved.invocations, 4);
    // Resolved rows keep their inventory-derived sourceType (default "local"
    // here since no pack/repo/scope), not the synthetic unresolved path.
    const unresolved = bySlug.get("command::orphan-cmd");
    assert.ok(unresolved);
    assert.equal(unresolved.invocations, 2);
    assert.equal(unresolved.sourceType, "local");
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal surfaces usage whose only inventory row is tombstoned", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Inventory row exists but is uninstalled — the reader filters it out, so
    // its usage would be dropped without the unresolved-source fold.
    await insertComponent(prisma, {
      id: "c-skill",
      kind: "skill",
      externalId: "ext-skill",
      key: "removed-skill",
      uninstalledAt: "2026-06-05T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "removed-skill",
      invocations: 6,
    });

    const result = await listAgentComponentsLocal(prisma, {});
    assert.equal(result.total, 1);
    assert.equal(result.items[0].id, "skill::removed-skill");
    assert.equal(result.items[0].invocations, 6);
    assert.equal(result.items[0].sourceType, "local");
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal resolves detail for unresolved-source usage", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "local-only-skill",
      invocations: 3,
      lastInvokedAt: "2026-06-03T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "skill",
      key: "local-only-skill",
      invocations: 2,
      lastInvokedAt: "2026-06-02T00:00:00.000Z",
    });

    // No inventory row for this identity — previously a phantom 404. Now the
    // detail is built from the usage rows, tagged unresolved.
    const detail = await getAgentComponentDetailLocal(
      prisma,
      "skill::local-only-skill"
    );
    assert.ok(detail, "unresolved-source detail should resolve, not 404");
    assert.equal(detail.id, "skill::local-only-skill");
    assert.equal(detail.sourceType, "local");
    assert.equal(detail.invocations, 5);
    assert.equal(detail.sessions, 2);
    assert.equal(detail.prompt, null);
    assert.deepEqual(detail.provenance, []);
    // usageSessions carry the per-session breakdown, most-recent first.
    assert.equal(detail.usageSessions.length, 2);
    assert.equal(detail.usageSessions[0].sessionId, "s1");
    assert.equal(detail.usageSessions[0].invocationCount, 3);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal collapses a mixed-harness unresolved identity to 'both'", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Same unresolved identity invoked under both harnesses. `MAX(harness)`
    // would return 'codex' (lexicographically greater) and hide the claude
    // usage from a harness filter; the derivation must collapse to 'both'.
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "mixed-skill",
      invocations: 2,
      harness: "claude",
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "skill",
      key: "mixed-skill",
      invocations: 3,
      harness: "codex",
    });

    const result = await listAgentComponentsLocal(prisma, {});
    assert.equal(result.total, 1);
    assert.equal(result.items[0].id, "skill::mixed-skill");
    assert.equal(result.items[0].harness, "both");
    // The 'both' identity is not hidden by either single-harness filter.
    const claudeFiltered = await listAgentComponentsLocal(prisma, {
      harness: "claude",
    });
    assert.equal(claudeFiltered.total, 0);
    const bothFiltered = await listAgentComponentsLocal(prisma, {
      harness: "both",
    });
    assert.equal(bothFiltered.total, 1);
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal collapses a mixed-harness unresolved identity to 'both'", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "mixed-skill",
      invocations: 2,
      harness: "claude",
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "skill",
      key: "mixed-skill",
      invocations: 3,
      harness: "codex",
    });

    const detail = await getAgentComponentDetailLocal(
      prisma,
      "skill::mixed-skill"
    );
    assert.ok(detail, "unresolved-source detail should resolve, not 404");
    // The fallback detail aggregate must agree with the list on 'both'.
    assert.equal(detail.harness, "both");
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal tags an unresolved mcp component sourceType 'server'", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // An mcp identity with usage but no inventory row. The resolved path maps
    // mcp → "server" (see toSourceType); the unresolved synthesis must agree
    // rather than falling through to the "local" default.
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "mcp",
      key: "orphan-mcp-server",
      invocations: 4,
    });

    const result = await listAgentComponentsLocal(prisma, {});
    assert.equal(result.total, 1);
    assert.equal(result.items[0].id, "mcp::orphan-mcp-server");
    assert.equal(result.items[0].kind, "mcp");
    assert.equal(result.items[0].sourceType, "server");
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal builds an unresolved mcp detail with server source and json format", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "mcp",
      key: "orphan-mcp-server",
      invocations: 4,
    });

    const detail = await getAgentComponentDetailLocal(
      prisma,
      "mcp::orphan-mcp-server"
    );
    assert.ok(detail, "unresolved mcp detail should resolve, not 404");
    assert.equal(detail.sourceType, "server");
    // mcp definitions are JSON (mirrors inferFormat), not the "md" default.
    assert.equal(detail.properties.format, "json");
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal still 404s a slug with no inventory AND no usage", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "real-usage",
      invocations: 1,
    });
    // A different identity that has neither inventory nor usage → genuine 404.
    const missing = await getAgentComponentDetailLocal(
      prisma,
      "skill::never-seen"
    );
    assert.equal(missing, null);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// FEA-3205: a non-ASCII component key must NOT double-count. The resolved fold
// normalizes in JS (`encodeComponentSlug` → full-Unicode `.toLowerCase()`)
// while the unresolved anti-join previously used SQLite `lower()` (ASCII-only,
// no ICU collation). For an accented/Turkish key the two disagreed, so the same
// identity attached to inventory as RESOLVED *and* survived the SQL `NOT EXISTS`
// as UNRESOLVED — counted twice in list + total; and inversely its detail 404'd.
// The fix moves the anti-join + key match into JS so one Unicode fold governs
// resolved fold, unresolved anti-join, and detail.
// ---------------------------------------------------------------------------

test("listAgentComponentsLocal does not double-count a non-ASCII key that resolves to inventory (FEA-3205)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Inventory row stored with an UPPERCASE accented key. JS folds `CAFÉ`→`café`
    // so usage attaches to it as RESOLVED. SQLite `lower("CAFÉ")` leaves `É`
    // uppercase, so a SQL `NOT EXISTS` anti-join would ALSO surface `café` as an
    // unresolved synthetic row — the same identity counted twice.
    await insertComponent(prisma, {
      id: "c-cafe",
      kind: "skill",
      externalId: "ext-cafe",
      key: "CAFÉ",
    });
    // Usage logged under the lowercased accented variant.
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "café",
      invocations: 4,
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "skill",
      key: "café",
      invocations: 3,
    });

    const result = await listAgentComponentsLocal(prisma, {});
    // EXACTLY ONE row for the identity — not one RESOLVED + one UNRESOLVED.
    assert.equal(
      result.total,
      1,
      "the non-ASCII identity surfaces exactly once"
    );
    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.equal(item.id, "skill::café");
    // It is the RESOLVED inventory row (usage attached), not a synthetic
    // unresolved one, and its counts are the real 4 + 3 across {s1, s2}.
    assert.equal(item.invocations, 7);
    assert.equal(item.sessions, 2);

    // And the detail resolves for the same identity (no 404, real counts).
    const detail = await getAgentComponentDetailLocal(prisma, "skill::café");
    assert.ok(detail, "detail should resolve for the non-ASCII identity");
    assert.equal(detail.id, "skill::café");
    assert.equal(detail.invocations, 7);
    assert.equal(detail.sessions, 2);
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal resolves a non-ASCII unresolved-source identity that appears in the list (FEA-3205)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Usage under a non-ASCII key with NO inventory row → unresolved. The list
    // surfaces it via the JS-normalized fold; the detail must resolve on the same
    // JS-normalized slug (the SQL `lower()` filter would have missed `İ`/`é`).
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "RÉSUMÉ",
      invocations: 5,
      lastInvokedAt: "2026-06-03T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "skill",
      key: "résumé",
      invocations: 2,
      lastInvokedAt: "2026-06-02T00:00:00.000Z",
    });

    const result = await listAgentComponentsLocal(prisma, {});
    // The two case-variants fold to ONE identity via the JS Unicode fold.
    assert.equal(
      result.total,
      1,
      "the non-ASCII identity surfaces exactly once"
    );
    const item = result.items[0];
    assert.equal(item.id, "skill::résumé");
    assert.equal(item.sourceType, "local");
    // Counts sum across variants: 5 + 2 across {s1, s2}.
    assert.equal(item.invocations, 7);
    assert.equal(item.sessions, 2);

    // Detail must resolve on the same slug the list emitted (no 404).
    const detail = await getAgentComponentDetailLocal(prisma, "skill::résumé");
    assert.ok(detail, "unresolved non-ASCII detail should resolve, not 404");
    assert.equal(detail.id, "skill::résumé");
    assert.equal(detail.invocations, 7);
    assert.equal(detail.sessions, 2);
    assert.equal(detail.usageSessions.length, 2);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// LOC/$ column (FEA-3090)
// ---------------------------------------------------------------------------

test("listAgentComponentsLocal computes LOC/$ = summed lines / summed cost across the component's deduped sessions", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-subagent",
      kind: "subagent",
      externalId: "ext-subagent",
      key: "deep-research",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "subagent",
      key: "deep-research",
      invocations: 3,
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "subagent",
      key: "deep-research",
      invocations: 2,
    });

    const source = fakeLocCostSource({
      s1: { loc: { added: 600, removed: 400 }, cost: 0.5 },
      s2: { loc: { added: 200, removed: 300 }, cost: 0.5 },
    });
    const result = await listAgentComponentsLocal(prisma, {}, null, source);
    const subagent = result.items.find(
      (i) => i.id === "subagent::deep-research"
    );
    assert.ok(subagent, "subagent row should be present");
    // ISS-4667: (1000 + 500) LINES ÷ (0.5 + 0.5) = 1500 LOC/$ (no /1000).
    assert.ok(
      subagent.locPerDollar !== null &&
        Math.abs(subagent.locPerDollar - 1500) < 1e-9,
      `expected 1500, got ${subagent.locPerDollar}`
    );
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal dedups branch-fallback LOC per branch across sessions (FEA-3633)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-subagent",
      kind: "subagent",
      externalId: "ext-subagent",
      key: "deep-research",
    });
    // Three authoring sessions share ONE branch; each carries the branch's
    // whole 1000-line fallback total (loc_source = "branch_fallback").
    for (const sessionId of ["s1", "s2", "s3"]) {
      await insertUsage(prisma, {
        sessionId,
        kind: "subagent",
        key: "deep-research",
        invocations: 1,
      });
    }
    const source = fakeLocCostSource({
      s1: {
        loc: { added: 600, removed: 400 },
        cost: 0.5,
        locSource: "branch_fallback",
        repositoryFullName: "org/repo",
        branch: "feat/shared",
      },
      s2: {
        loc: { added: 600, removed: 400 },
        cost: 0.5,
        locSource: "branch_fallback",
        repositoryFullName: "org/repo",
        branch: "feat/shared",
      },
      s3: {
        loc: { added: 600, removed: 400 },
        cost: 0.5,
        locSource: "branch_fallback",
        repositoryFullName: "org/repo",
        branch: "feat/shared",
      },
    });
    const result = await listAgentComponentsLocal(prisma, {}, null, source);
    const subagent = result.items.find(
      (i) => i.id === "subagent::deep-research"
    );
    assert.ok(subagent, "subagent row should be present");
    // ISS-4667: branch total 1000 LINES counted ONCE ÷ (0.5×3) = 666.67 LOC/$.
    // Without the dedup it would be 3×1000 lines ÷ $1.5 = 2000 (the bug).
    assert.ok(
      subagent.locPerDollar !== null &&
        Math.abs(subagent.locPerDollar - 1000 / 1.5) < 1e-9,
      `expected ${1000 / 1.5}, got ${subagent.locPerDollar}`
    );
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal reports LOC/$ = null when summed cost is 0 (no divide-by-zero)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-subagent",
      kind: "subagent",
      externalId: "ext-subagent",
      key: "deep-research",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "subagent",
      key: "deep-research",
      invocations: 1,
    });
    const source = fakeLocCostSource({
      s1: { loc: { added: 100, removed: 0 }, cost: 0 },
    });
    const result = await listAgentComponentsLocal(prisma, {}, null, source);
    const subagent = result.items.find(
      (i) => i.id === "subagent::deep-research"
    );
    assert.ok(subagent);
    assert.equal(subagent.locPerDollar, null);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal reports LOC/$ = null when the sessions produced no measurable lines", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-subagent",
      kind: "subagent",
      externalId: "ext-subagent",
      key: "deep-research",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "subagent",
      key: "deep-research",
      invocations: 1,
    });
    // Cost present, but no gitDiffStats/LOC → totalLoc 0 → null (not 0).
    const source = fakeLocCostSource({ s1: { cost: 0.5 } });
    const result = await listAgentComponentsLocal(prisma, {}, null, source);
    const subagent = result.items.find(
      (i) => i.id === "subagent::deep-research"
    );
    assert.ok(subagent);
    assert.equal(subagent.locPerDollar, null);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal leaves LOC/$ null when no sessions source is wired", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-subagent",
      kind: "subagent",
      externalId: "ext-subagent",
      key: "deep-research",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "subagent",
      key: "deep-research",
      invocations: 1,
    });
    const result = await listAgentComponentsLocal(prisma, {});
    const subagent = result.items.find(
      (i) => i.id === "subagent::deep-research"
    );
    assert.ok(subagent);
    assert.equal(subagent.locPerDollar, null);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal hides a plugin's LOC/$ (non-verifiable kind, FEA-4052)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-plugin",
      kind: "plugin",
      externalId: "claude|/x|gstack",
      key: "gstack",
      name: "GStack",
      packId: "gstack",
    });
    await insertComponent(prisma, {
      id: "c-child-skill",
      kind: "skill",
      externalId: "gstack-skill",
      key: "gstack-nav",
      packId: "gstack",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "gstack-nav",
      invocations: 4,
    });

    const source = fakeLocCostSource({
      s1: { loc: { added: 2000, removed: 0 }, cost: 0.5 },
    });
    const result = await listAgentComponentsLocal(prisma, {}, null, source);
    const plugin = result.items.find((i) => i.id === "plugin::gstack");
    assert.ok(plugin, "plugin row should be present");
    // FEA-4052: a plugin is NOT a verifiable LOC/$ kind — its number would be a
    // version-agnostic child rollup, not one component's efficiency — so it is
    // HIDDEN (null) even though its child session carries real LOC/cost (which,
    // for a verifiable kind, would compute 2000/1000 ÷ 0.5 = 4.0). The child
    // rollup still runs, proven by the plugin's non-zero invocations.
    assert.equal(plugin.invocations, 4);
    assert.equal(plugin.locPerDollar, null);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal hides a command's LOC/$ (non-verifiable kind, wongk PR #3720)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-command",
      kind: "command",
      externalId: "ext-command",
      key: "ship-it",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "command",
      key: "ship-it",
      invocations: 2,
    });

    const source = fakeLocCostSource({
      // 2000 lines ÷ $0.5 = 4000 LOC/$ — what a verifiable kind would show.
      s1: { loc: { added: 1500, removed: 500 }, cost: 0.5 },
    });
    const result = await listAgentComponentsLocal(prisma, {}, null, source);
    const command = result.items.find((i) => i.id === "command::ship-it");
    assert.ok(command, "command row should be present");
    // FEA-4052 (wongk, PR #3720): a command is NOT a verifiable LOC/$ kind. A
    // session gives every co-invoked component (a command AND a skill can both
    // fire in one session) the session's FULL LOC/cost, so a per-command number
    // would be session-level, not component-level. It stays HIDDEN (null) even
    // though its session carries real LOC/cost. The usage still folds, proven by
    // the command's non-zero invocations.
    assert.equal(command.invocations, 2);
    assert.equal(command.locPerDollar, null);
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal computes LOC/$ from the invoking sessions", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-subagent",
      kind: "subagent",
      externalId: "ext-subagent",
      key: "deep-research",
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "subagent",
      key: "deep-research",
      invocations: 3,
      lastInvokedAt: "2026-06-02T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "subagent",
      key: "deep-research",
      invocations: 2,
      lastInvokedAt: "2026-06-01T00:00:00.000Z",
    });

    const source = fakeLocCostSource({
      s1: { loc: { added: 600, removed: 400 }, cost: 0.5 },
      s2: { loc: { added: 200, removed: 300 }, cost: 0.5 },
    });
    const detail = await getAgentComponentDetailLocal(
      prisma,
      "subagent::deep-research",
      null,
      source
    );
    assert.ok(detail, "detail should resolve");
    // ISS-4667: 1500 LINES ÷ $1.00 = 1500 LOC/$.
    assert.ok(
      detail.locPerDollar !== null &&
        Math.abs(detail.locPerDollar - 1500) < 1e-9,
      `expected 1500, got ${detail.locPerDollar}`
    );
    // The single load also hydrated the sessionsTab from the same sessions.
    assert.equal(detail.sessionsTab.length, 2);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// FEA-3196: USAGE time-window (startDate/endDate) — the Agents workspace's
// All/30/60/90-day control. Before this, `coerceAgentComponentFilters` dropped
// both bounds and no lane applied a `last_invoked_at` predicate, so every
// window returned the identical all-time inventory (the control was inert).
// These tests fail if either half regresses: the coercion, or any lane's bound.
// ---------------------------------------------------------------------------

test("coerceAgentComponentFilters parses startDate/endDate to canonical ISO", () => {
  const filters = coerceAgentComponentFilters({
    startDate: "2026-06-10T00:00:00.000Z",
    endDate: "2026-06-20",
  });
  assert.equal(filters.startDate, "2026-06-10T00:00:00.000Z");
  // A bare date is accepted (the date control can emit it) and canonicalized to
  // midnight UTC — the same instant the cloud's `new Date(value)` yields.
  assert.equal(filters.endDate, "2026-06-20T00:00:00.000Z");
});

test("coerceAgentComponentFilters drops unparseable/non-string window bounds", () => {
  // An untrusted IPC payload must not be able to fail the read — a bad bound
  // degrades to the all-time view rather than throwing.
  const filters = coerceAgentComponentFilters({
    startDate: "not-a-date",
    endDate: 1234,
  });
  assert.equal(filters.startDate, undefined);
  assert.equal(filters.endDate, undefined);
});

test("listAgentComponentsLocal windows usage by last_invoked_at >= startDate", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-windowed",
      kind: "skill",
      externalId: "skill:windowed",
      key: "windowed",
    });
    // Two invocations before the window, three inside it.
    await insertUsage(prisma, {
      sessionId: "s-old",
      kind: "skill",
      key: "windowed",
      invocations: 2,
      lastInvokedAt: "2026-06-01T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s-new",
      kind: "skill",
      key: "windowed",
      invocations: 3,
      lastInvokedAt: "2026-06-20T00:00:00.000Z",
    });

    const allTime = await listAgentComponentsLocal(prisma, {});
    const allTimeRow = allTime.items.find((i) => i.id === "skill::windowed");
    assert.equal(allTimeRow?.invocations, 5);
    assert.equal(allTimeRow?.sessions, 2);

    // The window must actually change the answer — this is the exact assertion
    // the pre-fix code failed (windowed === all-time).
    const windowed = await listAgentComponentsLocal(prisma, {
      startDate: "2026-06-10T00:00:00.000Z",
    });
    const windowedRow = windowed.items.find((i) => i.id === "skill::windowed");
    assert.equal(windowedRow?.invocations, 3);
    assert.equal(windowedRow?.sessions, 1);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal bounds usage above by endDate", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-bounded",
      kind: "skill",
      externalId: "skill:bounded",
      key: "bounded",
    });
    await insertUsage(prisma, {
      sessionId: "s-in",
      kind: "skill",
      key: "bounded",
      invocations: 4,
      lastInvokedAt: "2026-06-05T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s-after",
      kind: "skill",
      key: "bounded",
      invocations: 9,
      lastInvokedAt: "2026-06-25T00:00:00.000Z",
    });

    // The preceding-window query the shared AgentsGroupedList issues for the
    // period-over-period delta sends BOTH bounds; without an endDate predicate
    // it would read all-time and the delta would be meaningless.
    const list = await listAgentComponentsLocal(prisma, {
      startDate: "2026-06-01T00:00:00.000Z",
      endDate: "2026-06-10T00:00:00.000Z",
    });
    const row = list.items.find((i) => i.id === "skill::bounded");
    assert.equal(row?.invocations, 4);
    assert.equal(row?.sessions, 1);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal drops usage-tracked components with zero in-window usage", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-idle",
      kind: "skill",
      externalId: "skill:idle",
      key: "idle",
    });
    await insertComponent(prisma, {
      id: "c-active",
      kind: "skill",
      externalId: "skill:active",
      key: "active",
    });
    await insertUsage(prisma, {
      sessionId: "s-idle",
      kind: "skill",
      key: "idle",
      invocations: 5,
      lastInvokedAt: "2026-06-01T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s-active",
      kind: "skill",
      key: "active",
      invocations: 5,
      lastInvokedAt: "2026-06-20T00:00:00.000Z",
    });

    // All-time keeps both (unchanged behavior).
    const allTime = await listAgentComponentsLocal(prisma, {});
    assert.ok(allTime.items.some((i) => i.id === "skill::idle"));

    const windowed = await listAgentComponentsLocal(prisma, {
      startDate: "2026-06-10T00:00:00.000Z",
    });
    assert.ok(
      !windowed.items.some((i) => i.id === "skill::idle"),
      "a skill with no in-window usage is not part of the window"
    );
    assert.ok(windowed.items.some((i) => i.id === "skill::active"));
    // `total` drives the summary cards + pagination, so the drop must be
    // reflected there too, not just in the returned page.
    assert.equal(windowed.total, 1);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal keeps hook/config kinds under a window", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // hook/config are observed as inventory but never invoked, so they always
    // aggregate to zero usage. Dropping them on a zero window would erase the
    // entire kind under EVERY window rather than hiding an inactive component.
    await insertComponent(prisma, {
      id: "c-hook",
      kind: "hook",
      externalId: "hook:pre-commit",
      key: "pre-commit",
    });
    await insertComponent(prisma, {
      id: "c-config",
      kind: "config",
      externalId: "config:settings",
      key: "settings",
    });

    const windowed = await listAgentComponentsLocal(prisma, {
      startDate: "2026-06-10T00:00:00.000Z",
    });
    assert.ok(windowed.items.some((i) => i.id === "hook::pre-commit"));
    assert.ok(windowed.items.some((i) => i.id === "config::settings"));
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal windows the plugin child-usage rollup", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-plugin",
      kind: "plugin",
      externalId: "plugin:pack-a",
      key: "pack-a",
      packId: "pack-a",
    });
    await insertComponent(prisma, {
      id: "c-child",
      kind: "skill",
      externalId: "skill:child",
      key: "child",
      packId: "pack-a",
    });
    await insertUsage(prisma, {
      sessionId: "s-old",
      kind: "skill",
      key: "child",
      invocations: 6,
      lastInvokedAt: "2026-06-01T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s-new",
      kind: "skill",
      key: "child",
      invocations: 4,
      lastInvokedAt: "2026-06-20T00:00:00.000Z",
    });

    const allTime = await listAgentComponentsLocal(prisma, {});
    assert.equal(
      allTime.items.find((i) => i.id === "plugin::pack-a")?.invocations,
      10
    );

    // A plugin's totals are a rollup over its children's usage, so that lane
    // needs the same bound — otherwise the plugin row reports all-time
    // invocations next to windowed skill rows in the same response.
    const windowed = await listAgentComponentsLocal(prisma, {
      startDate: "2026-06-10T00:00:00.000Z",
    });
    assert.equal(
      windowed.items.find((i) => i.id === "plugin::pack-a")?.invocations,
      4
    );
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal windows unresolved-source usage", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Usage with no live inventory row (FEA-3121 orphan lane).
    await insertUsage(prisma, {
      sessionId: "s-orphan-old",
      kind: "skill",
      key: "ghost",
      invocations: 3,
      lastInvokedAt: "2026-06-01T00:00:00.000Z",
    });

    const allTime = await listAgentComponentsLocal(prisma, {});
    assert.ok(allTime.items.some((i) => i.id === "skill::ghost"));

    // Its only usage is outside the window, so the identity has no in-window
    // existence at all.
    const windowed = await listAgentComponentsLocal(prisma, {
      startDate: "2026-06-10T00:00:00.000Z",
    });
    assert.ok(!windowed.items.some((i) => i.id === "skill::ghost"));
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal excludes usage with no comparable last_invoked_at from any window", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-untimed",
      kind: "skill",
      externalId: "skill:untimed",
      key: "untimed",
    });
    // `last_invoked_at` is nullable (it is written as MAX(events.created_at)),
    // so a usage row can carry no invocation instant at all.
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO agent_component_session_usage
           (session_id, component_kind, component_key, invocations, error_count,
            harness, component_version_hash, first_invoked_at, last_invoked_at, started_day)
         VALUES ('s-untimed', 'skill', 'untimed', 7, 0, NULL, NULL, NULL, NULL, '2026-06-01')`
      )
    );

    // All-time still counts it — no window, no timestamp requirement.
    const allTime = await listAgentComponentsLocal(prisma, {});
    assert.equal(
      allTime.items.find((i) => i.id === "skill::untimed")?.invocations,
      7
    );

    // A row with no comparable instant belongs to NO window — including an
    // upper-bounded one. Guards against an epoch sentinel, which would be
    // `<= endDate` and so would wrongly survive here (the cloud's Prisma
    // `lastInvokedAt: { lte }` drops NULL).
    const upperBounded = await listAgentComponentsLocal(prisma, {
      endDate: "2026-06-30T00:00:00.000Z",
    });
    assert.ok(!upperBounded.items.some((i) => i.id === "skill::untimed"));

    const lowerBounded = await listAgentComponentsLocal(prisma, {
      startDate: "2026-01-01T00:00:00.000Z",
    });
    assert.ok(!lowerBounded.items.some((i) => i.id === "skill::untimed"));
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// matchingUsageRawKeys / rawKeyInClause (FEA-3205, exported for FEA-3264)
// ---------------------------------------------------------------------------
//
// These back the Optimization-analytics IPC handlers, which are handed the
// already-normalized slug key (`encodeComponentSlug` lowercases + trims) but
// must match the RAW stored `component_key`. A case-sensitive `component_key = ?`
// silently missed every mixed-case variant — which is every built-in Claude tool
// (`Bash`, `Read`, `Edit`, `Task`) — so the panel read 0 while the detail page
// above it showed real invocations (FEA-3264).

test("matchingUsageRawKeys resolves mixed-case and padded raw keys for a normalized slug key (FEA-3264)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // The three raw spellings that all fold to the `bash` identity...
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "tool",
      key: "Bash",
      invocations: 1,
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "tool",
      key: "  bash  ",
      invocations: 1,
    });
    await insertUsage(prisma, {
      sessionId: "s3",
      kind: "tool",
      key: "bash",
      invocations: 1,
    });
    // ...plus one that must NOT match, and a same-key row under another kind.
    await insertUsage(prisma, {
      sessionId: "s4",
      kind: "tool",
      key: "Read",
      invocations: 1,
    });
    await insertUsage(prisma, {
      sessionId: "s5",
      kind: "skill",
      key: "Bash",
      invocations: 1,
    });

    const matched = await matchingUsageRawKeys(prisma, "tool", "bash");
    assert.deepEqual(matched.slice().sort(), ["  bash  ", "Bash", "bash"]);

    // A key with no folding variant resolves to nothing, not to every row.
    assert.deepEqual(await matchingUsageRawKeys(prisma, "tool", "nope"), []);
  } finally {
    await close();
  }
});

test("matchingUsageRawKeys folds a non-ASCII key that SQL lower() would miss (FEA-3205)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // SQLite's lower() is ASCII-only, so `lower('CAFÉ')` leaves `É` intact and a
    // SQL-side predicate never matches the JS-normalized `café`. This is why the
    // key MATCH must stay in application code.
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "CAFÉ",
      invocations: 1,
    });

    assert.deepEqual(await matchingUsageRawKeys(prisma, "skill", "café"), [
      "CAFÉ",
    ]);
  } finally {
    await close();
  }
});

test("rawKeyInClause binds trimmed keys and matches nothing when empty (FEA-3264)", () => {
  const single = rawKeyInClause(["Bash"]);
  assert.equal(single.clause, "trim(COALESCE(component_key, '')) IN (?)");
  assert.deepEqual(single.params, ["Bash"]);

  // Params are trimmed to match the trimmed column, and the caller-supplied
  // column literal qualifies the alias used by the joined analytics queries.
  const qualified = rawKeyInClause(["  bash  ", "Bash"], "acsu.component_key");
  assert.equal(
    qualified.clause,
    "trim(COALESCE(acsu.component_key, '')) IN (?, ?)"
  );
  assert.deepEqual(qualified.params, ["bash", "Bash"]);

  // An empty IN-list is invalid SQL, so an unmatched identity must degrade to a
  // false predicate — never to an unfiltered scan of every component's usage.
  const empty = rawKeyInClause([]);
  assert.equal(empty.clause, "1 = 0");
  assert.deepEqual(empty.params, []);
});

// ---------------------------------------------------------------------------
// FEA-3704: resolution state read from agent_components.resolved_state, folded
// across devices — no longer hardcoded to `unresolved`.
// ---------------------------------------------------------------------------

/**
 * Insert an inventory row that sets `resolved_state` explicitly (the shared
 * `insertComponent` helper leaves it at the schema default). Used to prove the
 * detail read now surfaces the real, per-device resolution and folds it with the
 * cloud precedence (resolved > inaccessible > unresolved > missing).
 */
async function insertComponentWithResolvedState(
  prisma: DesktopPrisma,
  row: {
    id: string;
    kind: string;
    externalId: string;
    key: string;
    resolvedState: string;
    installPath?: string | null;
  }
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_components
         (id, component_kind, external_id, component_key, name, harness,
          source, install_path, resolved_state,
          first_seen_at, last_seen_at, uninstalled_at)
       VALUES ($1, $2, $3, $4, $4, 'claude', NULL, $5, $6,
               '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', NULL)`,
      row.id,
      row.kind,
      row.externalId,
      row.key,
      row.installPath ?? "/home/u/.claude/skills/x.md",
      row.resolvedState
    )
  );
}

test("getAgentComponentDetailLocal surfaces the real resolved_state (not hardcoded unresolved) — FEA-3704", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponentWithResolvedState(prisma, {
      id: "c-resolved",
      kind: "skill",
      externalId: "ext-resolved",
      key: "resolved-skill",
      resolvedState: "resolved",
    });
    const detail = await getAgentComponentDetailLocal(
      prisma,
      "skill::resolved-skill"
    );
    assert.ok(detail);
    assert.equal(detail.resolvedState, "resolved");
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal folds resolved_state across devices with cloud precedence (resolved wins) — FEA-3704", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Same identity across two devices: one resolved, one missing. `resolved`
    // must win, and `missing` must NOT collapse the identity to "gone".
    await insertComponentWithResolvedState(prisma, {
      id: "c-dev-a",
      kind: "skill",
      externalId: "ext-a",
      key: "multi-device",
      resolvedState: "resolved",
    });
    await insertComponentWithResolvedState(prisma, {
      id: "c-dev-b",
      kind: "skill",
      externalId: "ext-b",
      key: "multi-device",
      resolvedState: "missing",
    });
    const detail = await getAgentComponentDetailLocal(
      prisma,
      "skill::multi-device"
    );
    assert.ok(detail);
    assert.equal(detail.resolvedState, "resolved");
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal defaults a row with no explicit resolved_state (legacy) to unresolved — FEA-3704", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // The shared insertComponent helper omits the resolved_state column, so the
    // NOT NULL DEFAULT 'unresolved' applies — the legacy/label-minted row case.
    await insertComponent(prisma, {
      id: "c-legacy",
      kind: "skill",
      externalId: "ext-legacy",
      key: "legacy-skill",
      installPath: "/home/u/.claude/skills/legacy.md",
    });
    const detail = await getAgentComponentDetailLocal(
      prisma,
      "skill::legacy-skill"
    );
    assert.ok(detail);
    assert.equal(detail.resolvedState, "unresolved");
  } finally {
    await close();
  }
});
