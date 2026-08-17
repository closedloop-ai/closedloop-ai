/**
 * @file agent-components-plugin-live-child-scope.test.ts
 * @description ISS-6180: the desktop plugin child-usage rollup must join only
 * LIVE inventory children — the `uninstalled_at IS NULL` scope `INVENTORY_SELECT`
 * and every sibling inventory read already apply.
 *
 * Scanners TOMBSTONE rather than delete (`mcp-discovery.ts` stamps
 * `uninstalled_at` on `mcp` rows, a plugin child kind since ISS-6094) and nothing
 * clears the child's `pack_id`, so an unscoped join kept an uninstalled child's
 * invocations rolling into its plugin's total while the SAME usage ALSO surfaced
 * as a standalone "unresolved" row — one invocation rendered twice in one
 * response, which `sumDedupedInvocations` (ISS-5534) cannot suppress because an
 * unresolved row carries no `packIds` for its exact-intersection test to match.
 *
 * Lives in its own file rather than in `shared-agent-components-api.test.ts`
 * because that file is on the shrink-only `noExcessiveLinesPerFile` grandfather
 * list.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getAgentComponentDetailLocal,
  listAgentComponentsLocal,
} from "../src/main/dashboard/shared-agent-components-api.js";
import {
  insertComponent,
  insertUsage,
} from "./agent-components-test-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const PACK_ID = "gstack";
const LIVE_INVOKED_AT = "2026-06-05T00:00:00.000Z";
const DEAD_INVOKED_AT = "2026-06-09T00:00:00.000Z";

/**
 * A plugin with one LIVE child (skill, 4 invocations in `s1`) and one TOMBSTONED
 * child (mcp, 5 invocations in `s2`), both still stamped with the plugin's
 * `pack_id`. The dead child's usage is the row that must roll up nowhere.
 */
async function seedPluginWithTombstonedChild(
  prisma: Awaited<ReturnType<typeof openTestPrisma>>["prisma"]
): Promise<void> {
  await insertComponent(prisma, {
    id: "c-plugin",
    kind: "plugin",
    externalId: "claude|/x|gstack",
    key: PACK_ID,
    name: "GStack",
    packId: PACK_ID,
  });
  await insertComponent(prisma, {
    id: "c-child-skill",
    kind: "skill",
    externalId: "gstack-skill",
    key: "gstack-nav",
    packId: PACK_ID,
  });
  await insertComponent(prisma, {
    id: "c-child-mcp",
    kind: "mcp",
    externalId: "gstack-mcp-server",
    key: "gstack-mcp",
    packId: PACK_ID,
    uninstalledAt: "2026-07-01T00:00:00.000Z",
  });
  await insertUsage(prisma, {
    sessionId: "s1",
    kind: "skill",
    key: "gstack-nav",
    invocations: 4,
    lastInvokedAt: LIVE_INVOKED_AT,
  });
  await insertUsage(prisma, {
    sessionId: "s2",
    kind: "mcp",
    key: "gstack-mcp",
    invocations: 5,
    lastInvokedAt: DEAD_INVOKED_AT,
  });
}

test("listAgentComponentsLocal excludes a tombstoned child from its plugin's rollup", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedPluginWithTombstonedChild(prisma);

    const result = await listAgentComponentsLocal(prisma, {
      kinds: ["plugin"],
    });
    assert.equal(result.total, 1);
    const [plugin] = result.items;
    assert.equal(plugin.kind, "plugin");
    // The LIVE child's 4 invocations in {s1} only — an unscoped join read 9/2.
    assert.equal(plugin.invocations, 4);
    assert.equal(plugin.sessions, 1);
    // Usage recency rolls up from the live child too, so the plugin cannot claim
    // an activity instant that only the uninstalled child produced.
    assert.equal(plugin.lastInvokedAt, LIVE_INVOKED_AT);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal renders a tombstoned child's invocations exactly once", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedPluginWithTombstonedChild(prisma);

    const result = await listAgentComponentsLocal(prisma, {});
    // The tombstoned child leaves the inventory, so its usage surfaces in the
    // unresolved lane — the one place it is now counted.
    const unresolved = result.items.filter((i) => i.id === "mcp::gstack-mcp");
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].invocations, 5);
    // That same activity is NOT also inside the plugin's rollup — the mcp row
    // and the plugin row no longer describe overlapping invocations.
    const [plugin] = result.items.filter((i) => i.kind === "plugin");
    assert.equal(plugin.invocations, 4);
    // The live skill child is still both its own row and inside the rollup —
    // the pre-existing, packIds-declared overlap `sumDedupedInvocations` owns.
    assert.deepEqual(plugin.packIds, [PACK_ID]);
    const [skill] = result.items.filter((i) => i.id === "skill::gstack-nav");
    assert.deepEqual(skill.packIds, [PACK_ID]);
    // The unresolved row has no pack parentage to intersect with, which is why
    // an unscoped rollup could never have been de-duplicated downstream.
    assert.equal(unresolved[0].packIds, undefined);
  } finally {
    await close();
  }
});

test("a stale FK to a tombstoned child does not join a live sibling of the same identity", async () => {
  // ISS-6180 (wongk review): the (kind, key) join is the FALLBACK, not the
  // authority. The dead row and a live row share `mcp::gstack-mcp`, so a
  // natural-key-only join let the dead row's usage reach the plugin through its
  // live twin and the `uninstalled_at IS NULL` scope bought nothing for it.
  //
  // The seeded FK is a persisted state production reaches, not a synthetic one:
  // `relinkInvocationRows` stamps `local_component_id` when the identity has
  // exactly ONE inventory row, and only re-runs for RE-DERIVED sessions — so a
  // child linked while it was the only install keeps that FK after being
  // tombstoned and replaced by a second install.
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-plugin",
      kind: "plugin",
      externalId: "claude|/x|gstack",
      key: PACK_ID,
      name: "GStack",
      packId: PACK_ID,
    });
    await insertComponent(prisma, {
      id: "c-mcp-live",
      kind: "mcp",
      externalId: "gstack-mcp@device-a",
      key: "gstack-mcp",
      packId: PACK_ID,
    });
    await insertComponent(prisma, {
      id: "c-mcp-dead",
      kind: "mcp",
      externalId: "gstack-mcp@device-b",
      key: "gstack-mcp",
      packId: PACK_ID,
      uninstalledAt: "2026-07-01T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s-live",
      kind: "mcp",
      key: "gstack-mcp",
      agentComponentId: "c-mcp-live",
      invocations: 3,
      lastInvokedAt: LIVE_INVOKED_AT,
    });
    await insertUsage(prisma, {
      sessionId: "s-dead",
      kind: "mcp",
      key: "gstack-mcp",
      agentComponentId: "c-mcp-dead",
      invocations: 5,
      lastInvokedAt: DEAD_INVOKED_AT,
    });

    const result = await listAgentComponentsLocal(prisma, {
      kinds: ["plugin"],
    });
    const [plugin] = result.items;
    // The LIVE install's 3 — not 8, and not the dead row's recency either.
    assert.equal(plugin.invocations, 3);
    assert.equal(plugin.lastInvokedAt, LIVE_INVOKED_AT);
  } finally {
    await close();
  }
});

test("a stale FK pins one install when a second later joins the same identity", async () => {
  // The same child installed on two compute targets is two inventory rows under
  // one (kind, key), and a natural-key join produces one joined row per install —
  // so SUM(acsu.invocations) multiplies a single usage row by the install count.
  // Honoring the FK collapses that back to the one install the writer linked.
  //
  // SCOPE: this covers the STALE-link half only, which is the half an FK can
  // decide. A session re-derived AFTER the second install carries a NULL FK
  // (`relinkInvocationRows` nulls an ambiguous match), takes the fallback arm,
  // and still multiplies — see the note in `pluginUsageSql`. Do not read this
  // test as proof that duplicate-install multiplication is fixed in general.
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-plugin",
      kind: "plugin",
      externalId: "claude|/x|gstack",
      key: PACK_ID,
      name: "GStack",
      packId: PACK_ID,
    });
    for (const id of ["c-skill-device-a", "c-skill-device-b"]) {
      await insertComponent(prisma, {
        id,
        kind: "skill",
        externalId: `gstack-nav@${id}`,
        key: "gstack-nav",
        packId: PACK_ID,
      });
    }
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "gstack-nav",
      agentComponentId: "c-skill-device-a",
      invocations: 6,
      lastInvokedAt: LIVE_INVOKED_AT,
    });

    const result = await listAgentComponentsLocal(prisma, {
      kinds: ["plugin"],
    });
    const [plugin] = result.items;
    // 6, not 12 — the FK names ONE of the two installs as the real match.
    assert.equal(plugin.invocations, 6);
    assert.equal(plugin.sessions, 1);
    // The same source both halves of the rollup must agree on: the LOC/$ session
    // set is built by a sibling query carrying the identical guard.
    assert.deepEqual(plugin.packIds, [PACK_ID]);
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal builds plugin usageSessions from live children only", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedPluginWithTombstonedChild(prisma);

    const detail = await getAgentComponentDetailLocal(prisma, "plugin::gstack");
    assert.ok(detail, "plugin detail should resolve");
    assert.equal(detail.kind, "plugin");
    assert.equal(detail.invocations, 4);
    assert.equal(detail.sessions, 1);
    // The per-session breakdown is drawn from the same children as the total, so
    // detail and list cannot contradict each other about which sessions ran.
    assert.equal(detail.usageSessions.length, 1);
    assert.equal(detail.usageSessions[0].sessionId, "s1");
    assert.equal(detail.usageSessions[0].invocationCount, 4);
  } finally {
    await close();
  }
});
