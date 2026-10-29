/**
 * @file shared-agent-components-api-coverage.test.ts
 * @description ISS-10514: pins the branches of `shared-agent-components-api.ts`
 * that the neighbouring suites never drive — untrusted IPC filter coercion, the
 * unknown-kind / unknown-resolved-state folds, null name and timestamp
 * fallbacks, the JS harness merge for Unicode-folded unresolved usage, the
 * plugin pack-candidate misses, metadata parsing, and the LOC/$ loader's
 * no-session short circuit. Every case reads through the real exported readers
 * over a migrated SQLite store.
 */

import assert from "node:assert/strict";
import {
  AGENT_COMPONENT_INVENTORY_CAP,
  AgentComponentKind,
  ComponentResolvedState,
  Harness,
} from "@repo/api/src/types/agent-component";
import { test } from "vitest";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  coerceAgentComponentFilters,
  getAgentComponentDetailLocal,
  listAgentComponentsLocal,
} from "../src/main/dashboard/shared-agent-components-api.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import {
  insertComponent,
  insertUsage,
} from "./agent-components-test-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";
import { fakeLocCostSource } from "./shared-agent-components-loc-cost-source.js";

const HASH_ORPHAN = "c".repeat(64);

async function execSql(
  prisma: DesktopPrisma,
  sql: string,
  ...params: unknown[]
): Promise<void> {
  await prisma.write((client) => client.$executeRawUnsafe(sql, ...params));
}

// ---------------------------------------------------------------------------
// coerceAgentComponentFilters
// ---------------------------------------------------------------------------

test("coerceAgentComponentFilters returns an empty filter for a non-object payload", () => {
  assert.deepEqual(coerceAgentComponentFilters(null), {});
  assert.deepEqual(coerceAgentComponentFilters(undefined), {});
  assert.deepEqual(coerceAgentComponentFilters("skill"), {});
  assert.deepEqual(coerceAgentComponentFilters(42), {});
});

test("coerceAgentComponentFilters keeps only known string kinds and a known harness", () => {
  const filters = coerceAgentComponentFilters({
    kinds: [AgentComponentKind.Skill, 7, "not-a-kind", AgentComponentKind.Mcp],
    source: "gstack",
    harness: Harness.Codex,
    search: "review",
  });
  assert.deepEqual(filters, {
    kinds: [AgentComponentKind.Skill, AgentComponentKind.Mcp],
    source: "gstack",
    harness: Harness.Codex,
    search: "review",
  });
});

test("coerceAgentComponentFilters drops an unknown or non-string harness and non-string source/search", () => {
  assert.deepEqual(
    coerceAgentComponentFilters({ harness: "cursor", source: 3, search: {} }),
    {}
  );
  assert.deepEqual(coerceAgentComponentFilters({ harness: 1 }), {});
  assert.deepEqual(coerceAgentComponentFilters({ kinds: "skill" }), {});
});

test("coerceAgentComponentFilters floors limit/offset and clamps limit to the inventory cap", () => {
  assert.deepEqual(coerceAgentComponentFilters({ limit: 12.9, offset: 3.7 }), {
    limit: 12,
    offset: 3,
  });
  assert.deepEqual(
    coerceAgentComponentFilters({ limit: AGENT_COMPONENT_INVENTORY_CAP + 50 }),
    { limit: AGENT_COMPONENT_INVENTORY_CAP }
  );
  assert.deepEqual(coerceAgentComponentFilters({ offset: 0 }), { offset: 0 });
});

test("coerceAgentComponentFilters drops a non-positive limit, a negative offset, and non-number paging", () => {
  assert.deepEqual(coerceAgentComponentFilters({ limit: 0, offset: -1 }), {});
  assert.deepEqual(coerceAgentComponentFilters({ limit: -5, offset: "2" }), {});
  assert.deepEqual(coerceAgentComponentFilters({ limit: "10" }), {});
});

// ---------------------------------------------------------------------------
// listAgentComponentsLocal
// ---------------------------------------------------------------------------

test("listAgentComponentsLocal coerces an unrecognized stored kind to config", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-mystery",
      kind: "mystery-kind",
      externalId: "ext-mystery",
      key: "thing",
    });
    const result = await listAgentComponentsLocal(prisma, {});
    assert.equal(result.total, 1);
    assert.equal(result.items[0].kind, AgentComponentKind.Config);
    assert.equal(result.items[0].id, "mystery-kind::thing");
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal names a row by component_key, then external_id, when name is NULL", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-keyed",
      kind: AgentComponentKind.Skill,
      externalId: "ext-keyed",
      key: "keyed-skill",
    });
    await insertComponent(prisma, {
      id: "c-bare",
      kind: AgentComponentKind.Skill,
      externalId: "ext-only-name",
      key: null,
    });
    await execSql(prisma, "UPDATE agent_components SET name = NULL");

    const result = await listAgentComponentsLocal(prisma, {});
    assert.deepEqual(
      result.items.map((item) => item.name),
      ["ext-only-name", "keyed-skill"]
    );
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal surfaces versioned usage with no live inventory as an unresolved name-level row", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // A live inventory row for a DIFFERENT name keeps the version-bucket
    // synthesis loop non-trivial; the orphan's hash must not borrow it.
    await insertComponent(prisma, {
      id: "c-live",
      kind: AgentComponentKind.Skill,
      externalId: "ext-live",
      key: "live-skill",
    });
    await insertUsage(prisma, {
      sessionId: "s-orphan",
      kind: AgentComponentKind.Skill,
      key: "orphan-skill",
      invocations: 4,
      versionHash: HASH_ORPHAN,
    });

    const result = await listAgentComponentsLocal(prisma, {});
    const orphan = result.items.find((item) => item.name === "orphan-skill");
    assert.ok(orphan);
    assert.equal(orphan.id, "skill::orphan-skill");
    assert.equal(orphan.invocations, 4);
    assert.equal(orphan.sessions, 1);
    assert.equal(orphan.versionId, undefined);
    assert.equal(result.total, 2);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal emits empty seen stamps and no lastInvokedAt for untimed unresolved usage", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertUsage(prisma, {
      sessionId: "s-untimed",
      kind: AgentComponentKind.Skill,
      key: "untimed",
      invocations: 1,
      lastInvokedAt: null,
      firstInvokedAt: null,
    });
    const result = await listAgentComponentsLocal(prisma, {});
    assert.equal(result.total, 1);
    const [item] = result.items;
    assert.equal(item.firstSeenAt, "");
    assert.equal(item.lastSeenAt, "");
    assert.equal("lastInvokedAt" in item, false);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal merges Unicode-folded unresolved harnesses the way the SQL CASE does, and filters by source", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // SQLite lower() is ASCII-only, so each upper/lower pair stays two SQL
    // groups and the JS fold merges them, exercising every mergeHarness arm.
    const pairs: [string, string | null, string, string | null][] = [
      ["ÀX", null, "àx", Harness.Codex],
      ["ÈY", Harness.Claude, "èy", null],
      ["ÌZ", Harness.Claude, "ìz", Harness.Claude],
      ["ÒW", Harness.Claude, "òw", Harness.Codex],
    ];
    for (const [upper, upperHarness, lower, lowerHarness] of pairs) {
      await insertUsage(prisma, {
        sessionId: `s-${lower}-1`,
        kind: AgentComponentKind.Skill,
        key: upper,
        invocations: 2,
        harness: upperHarness,
      });
      await insertUsage(prisma, {
        sessionId: `s-${lower}-2`,
        kind: AgentComponentKind.Skill,
        key: lower,
        invocations: 3,
        harness: lowerHarness,
      });
    }

    const result = await listAgentComponentsLocal(prisma, {});
    const byName = new Map(result.items.map((item) => [item.name, item]));
    assert.equal(result.total, 4);
    assert.equal(byName.get("àx")?.harness, Harness.Codex);
    assert.equal(byName.get("èy")?.harness, Harness.Claude);
    assert.equal(byName.get("ìz")?.harness, Harness.Claude);
    assert.equal(byName.get("òw")?.harness, Harness.Both);
    for (const item of result.items) {
      assert.equal(item.invocations, 5);
      assert.equal(item.sessions, 2);
    }

    const filtered = await listAgentComponentsLocal(prisma, { source: "òw" });
    assert.deepEqual(
      filtered.items.map((item) => item.name),
      ["òw"]
    );
    assert.equal(filtered.total, 1);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal rolls a plugin up over the candidate pack that has child usage when another candidate has none", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // The plugin's candidates are its own pack_id ("unused-pack") and its
    // component_key ("gstack"); only "gstack" has children with usage.
    await insertComponent(prisma, {
      id: "c-plugin",
      kind: AgentComponentKind.Plugin,
      externalId: "ext-plugin",
      key: "gstack",
      packId: "unused-pack",
    });
    await insertComponent(prisma, {
      id: "c-child",
      kind: AgentComponentKind.Skill,
      externalId: "ext-child",
      key: "child-skill",
      packId: "gstack",
    });
    await insertUsage(prisma, {
      sessionId: "s-child",
      kind: AgentComponentKind.Skill,
      key: "child-skill",
      invocations: 6,
    });

    const result = await listAgentComponentsLocal(prisma, {
      kinds: [AgentComponentKind.Plugin],
    });
    assert.equal(result.total, 1);
    const [plugin] = result.items;
    assert.equal(plugin.invocations, 6);
    assert.equal(plugin.sessions, 1);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal skips the session LOC/cost load when the page has no invoking sessions", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-config",
      kind: AgentComponentKind.Config,
      externalId: "ext-config",
      key: "settings",
    });
    const loads: string[][] = [];
    const base = fakeLocCostSource({
      "s-used": { loc: { added: 10, removed: 0 }, cost: 1 },
    });
    const source: AgentSessionSyncSource = {
      ...base,
      loadSyncedSessions(ids, cache, options) {
        loads.push([...ids]);
        return base.loadSyncedSessions(ids, cache, options);
      },
    };

    const idle = await listAgentComponentsLocal(prisma, {}, null, source);
    assert.equal(idle.items[0].locPerDollar, null);
    assert.deepEqual(loads, []);

    // Control: once the page has an invoking session, the same source IS read.
    await insertComponent(prisma, {
      id: "c-used",
      kind: AgentComponentKind.Skill,
      externalId: "ext-used",
      key: "used-skill",
    });
    await insertUsage(prisma, {
      sessionId: "s-used",
      kind: AgentComponentKind.Skill,
      key: "used-skill",
      invocations: 1,
    });
    await listAgentComponentsLocal(prisma, {}, null, source);
    assert.deepEqual(loads, [["s-used"]]);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// getAgentComponentDetailLocal
// ---------------------------------------------------------------------------

test("getAgentComponentDetailLocal reads an unrecognized resolved_state as unresolved", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-odd-state",
      kind: AgentComponentKind.Skill,
      externalId: "ext-odd-state",
      key: "odd-state",
    });
    await execSql(
      prisma,
      "UPDATE agent_components SET resolved_state = 'not-a-state'"
    );
    const detail = await getAgentComponentDetailLocal(
      prisma,
      "skill::odd-state"
    );
    assert.ok(detail);
    assert.equal(detail.resolvedState, ComponentResolvedState.Unresolved);
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal folds seen stamps across a name's rows instead of echoing the representative's", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    for (const id of ["c-stamp-rep", "c-stamp-other"]) {
      await insertComponent(prisma, {
        id,
        kind: AgentComponentKind.Skill,
        externalId: `ext-${id}`,
        key: "stamped",
        installPath: `${id}/SKILL.md`,
      });
    }
    // The detail read orders by raw `last_seen_at` bytes DESC, so the whole-
    // second `Z` stamp sorts first and becomes the representative, while the
    // `.500Z` stamp on the other row is the later instant `maxIso` keeps.
    await execSql(
      prisma,
      "UPDATE agent_components SET first_seen_at = $1, last_seen_at = $2 WHERE id = $3",
      "2026-03-01T00:00:00.000Z",
      "2026-06-01T00:00:00Z",
      "c-stamp-rep"
    );
    await execSql(
      prisma,
      "UPDATE agent_components SET first_seen_at = $1, last_seen_at = $2 WHERE id = $3",
      "2026-01-01T00:00:00.000Z",
      "2026-06-01T00:00:00.500Z",
      "c-stamp-other"
    );
    const detail = await getAgentComponentDetailLocal(prisma, "skill::stamped");
    assert.ok(detail);
    // Premise check: rows arrive representative-first.
    assert.equal(detail.provenance[0]?.installPath, "c-stamp-rep/SKILL.md");
    assert.equal(detail.firstSeenAt, "2026-01-01T00:00:00.000Z");
    assert.equal(detail.lastSeenAt, "2026-06-01T00:00:00.500Z");
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal emits empty seen stamps when the inventory row has none", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-unseen",
      kind: AgentComponentKind.Skill,
      externalId: "ext-unseen",
      key: "unseen",
    });
    await execSql(
      prisma,
      "UPDATE agent_components SET first_seen_at = NULL, last_seen_at = NULL"
    );
    const detail = await getAgentComponentDetailLocal(prisma, "skill::unseen");
    assert.ok(detail);
    assert.equal(detail.firstSeenAt, "");
    assert.equal(detail.lastSeenAt, "");
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal reads metadata only when the raw read hands back JSON text", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // `metadata` is a JSONB column, so the Prisma raw read deserializes it
    // before `parseMetadata` sees it. A JSON-encoded STRING therefore arrives as
    // the inner text and parses; a stored object arrives already parsed.
    const metadataByKey: Record<string, string | null> = {
      "meta-object": JSON.stringify({ model: "opus" }),
      "meta-text-object": JSON.stringify(JSON.stringify({ model: "sonnet" })),
      "meta-text-number": JSON.stringify("5"),
      "meta-text-null": JSON.stringify("null"),
      "meta-none": null,
    };
    for (const key of Object.keys(metadataByKey)) {
      await insertComponent(prisma, {
        id: `c-${key}`,
        kind: AgentComponentKind.Subagent,
        externalId: `ext-${key}`,
        key,
      });
      await execSql(
        prisma,
        "UPDATE agent_components SET metadata = $1 WHERE id = $2",
        metadataByKey[key],
        `c-${key}`
      );
    }

    const detailFor = async (key: string) => {
      const detail = await getAgentComponentDetailLocal(
        prisma,
        `subagent::${key}`
      );
      assert.ok(detail);
      return detail.properties;
    };
    const none = await detailFor("meta-none");
    assert.equal(none.model, undefined);
    assert.deepEqual(await detailFor("meta-text-object"), {
      ...none,
      model: "sonnet",
    });
    assert.deepEqual(await detailFor("meta-text-number"), none);
    assert.deepEqual(await detailFor("meta-text-null"), none);
    // ISS-10559: a known defect, not a contract. A plain JSON object in the
    // JSONB column is already an object when it reaches `parseMetadata`, whose
    // `JSON.parse` then throws and the catch drops it, so `model` is lost.
    // Flip this when ISS-10559 lands.
    assert.deepEqual(await detailFor("meta-object"), none);
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal carries project_path into per-row provenance", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-project",
      kind: AgentComponentKind.Skill,
      externalId: "ext-project",
      key: "project-skill",
      projectPath: "repo/app",
    });
    const detail = await getAgentComponentDetailLocal(
      prisma,
      "skill::project-skill",
      "ct-local"
    );
    assert.ok(detail);
    assert.deepEqual(detail.provenance, [
      { computeTargetId: "ct-local", projectPath: "repo/app" },
    ]);
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal never falls back to description for a hook or config prompt", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    for (const kind of [AgentComponentKind.Hook, AgentComponentKind.Config]) {
      await insertComponent(prisma, {
        id: `c-${kind}`,
        kind,
        externalId: `ext-${kind}`,
        key: "described",
        description: "a description",
      });
    }
    await insertComponent(prisma, {
      id: "c-skill-described",
      kind: AgentComponentKind.Skill,
      externalId: "ext-skill-described",
      key: "described",
      description: "a description",
    });

    const hook = await getAgentComponentDetailLocal(prisma, "hook::described");
    const config = await getAgentComponentDetailLocal(
      prisma,
      "config::described"
    );
    const skill = await getAgentComponentDetailLocal(
      prisma,
      "skill::described"
    );
    assert.equal(hook?.prompt, null);
    assert.equal(config?.prompt, null);
    assert.equal(skill?.prompt, "a description");
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal merges a plugin session's child usage across two candidate packs", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-plugin",
      kind: AgentComponentKind.Plugin,
      externalId: "ext-plugin",
      key: "gstack",
      packId: "extra-pack",
    });
    await insertComponent(prisma, {
      id: "c-child-a",
      kind: AgentComponentKind.Skill,
      externalId: "ext-child-a",
      key: "child-a",
      packId: "gstack",
    });
    await insertComponent(prisma, {
      id: "c-child-b",
      kind: AgentComponentKind.Skill,
      externalId: "ext-child-b",
      key: "child-b",
      packId: "extra-pack",
    });
    await insertUsage(prisma, {
      sessionId: "s-both",
      kind: AgentComponentKind.Skill,
      key: "child-a",
      invocations: 2,
    });
    await insertUsage(prisma, {
      sessionId: "s-both",
      kind: AgentComponentKind.Skill,
      key: "child-b",
      invocations: 3,
    });

    const detail = await getAgentComponentDetailLocal(prisma, "plugin::gstack");
    assert.ok(detail);
    assert.deepEqual(detail.usageSessions, [
      { sessionId: "s-both", invocationCount: 5, versionHash: null },
    ]);
    assert.equal(detail.invocations, 5);
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal keeps a plugin session at its first-seen position when a later pack sees it again", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Candidate packs iterate pack_id first ("extra-pack"), then the key
    // ("gstack"). extra-pack yields s-first then s-second (by recency); gstack
    // yields s-first again, which must not move it behind s-second.
    await insertComponent(prisma, {
      id: "c-plugin",
      kind: AgentComponentKind.Plugin,
      externalId: "ext-plugin",
      key: "gstack",
      packId: "extra-pack",
    });
    await insertComponent(prisma, {
      id: "c-child-extra",
      kind: AgentComponentKind.Skill,
      externalId: "ext-child-extra",
      key: "child-extra",
      packId: "extra-pack",
    });
    await insertComponent(prisma, {
      id: "c-child-gstack",
      kind: AgentComponentKind.Skill,
      externalId: "ext-child-gstack",
      key: "child-gstack",
      packId: "gstack",
    });
    await insertUsage(prisma, {
      sessionId: "s-first",
      kind: AgentComponentKind.Skill,
      key: "child-extra",
      invocations: 1,
      lastInvokedAt: "2026-06-05T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s-second",
      kind: AgentComponentKind.Skill,
      key: "child-extra",
      invocations: 1,
      lastInvokedAt: "2026-06-01T00:00:00.000Z",
    });
    await insertUsage(prisma, {
      sessionId: "s-first",
      kind: AgentComponentKind.Skill,
      key: "child-gstack",
      invocations: 4,
    });

    const detail = await getAgentComponentDetailLocal(prisma, "plugin::gstack");
    assert.ok(detail);
    assert.deepEqual(detail.usageSessions, [
      { sessionId: "s-first", invocationCount: 5, versionHash: null },
      { sessionId: "s-second", invocationCount: 1, versionHash: null },
    ]);
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal 404s a plugin slug with no inventory even when plugin-kind usage exists", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertUsage(prisma, {
      sessionId: "s-ghost",
      kind: AgentComponentKind.Plugin,
      key: "ghost",
      invocations: 2,
    });
    await insertUsage(prisma, {
      sessionId: "s-ghost",
      kind: AgentComponentKind.Skill,
      key: "ghost",
      invocations: 2,
    });
    assert.equal(
      await getAgentComponentDetailLocal(prisma, "plugin::ghost"),
      null
    );
    // Control: the same usage shape under a non-plugin kind does resolve.
    const skill = await getAgentComponentDetailLocal(prisma, "skill::ghost");
    assert.equal(skill?.invocations, 2);
    assert.equal(skill?.analyticsKey, "ghost");
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal omits analyticsKey for unresolved usage under a blank component_key", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertUsage(prisma, {
      sessionId: "s-blank",
      kind: AgentComponentKind.Skill,
      key: "",
      invocations: 1,
    });
    const detail = await getAgentComponentDetailLocal(prisma, "skill::");
    assert.ok(detail);
    assert.equal(detail.id, "skill::");
    assert.equal(detail.sessions, 1);
    assert.equal("analyticsKey" in detail, false);
  } finally {
    await close();
  }
});
