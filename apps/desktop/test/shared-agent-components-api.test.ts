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
import type { AgentSessionSyncSource } from "../src/main/agent-session-sync-service.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import {
  getAgentComponentDetailLocal,
  listAgentComponentsLocal,
} from "../src/main/shared-agent-components-api.js";
import { openTestPrisma } from "./prisma-test-utils.js";

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function insertComponent(
  prisma: DesktopPrisma,
  row: {
    id: string;
    kind: string;
    externalId: string;
    key: string | null;
    name?: string | null;
    harness?: string | null;
    packId?: string | null;
    scope?: string | null;
    projectPath?: string | null;
    installPath?: string | null;
    description?: string | null;
    uninstalledAt?: string | null;
  }
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_components
         (id, component_kind, external_id, component_key, name, harness,
          source, description, install_path, pack_id, scope, project_path,
          first_seen_at, last_seen_at, uninstalled_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, $11,
               '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', $12)`,
      row.id,
      row.kind,
      row.externalId,
      row.key,
      row.name ?? row.key,
      row.harness ?? "claude",
      row.description ?? null,
      row.installPath ?? null,
      row.packId ?? null,
      row.scope ?? null,
      row.projectPath ?? null,
      row.uninstalledAt ?? null
    )
  );
}

async function insertUsage(
  prisma: DesktopPrisma,
  row: {
    sessionId: string;
    kind: string;
    key: string;
    invocations: number;
    lastInvokedAt?: string;
    firstInvokedAt?: string;
    harness?: string | null;
  }
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_component_session_usage
         (session_id, component_kind, component_key, invocations, error_count,
          harness, first_invoked_at, last_invoked_at, started_day)
       VALUES ($1, $2, $3, $4, 0, $5, $6, $7, '2026-06-01')`,
      row.sessionId,
      row.kind,
      row.key,
      row.invocations,
      row.harness ?? null,
      row.firstInvokedAt ?? row.lastInvokedAt ?? "2026-06-01T00:00:00.000Z",
      row.lastInvokedAt ?? "2026-06-01T00:00:00.000Z"
    )
  );
}

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
    });
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "command",
      key: "gstack-shot",
      invocations: 1,
    });
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "command",
      key: "gstack-shot",
      invocations: 2,
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
    assert.equal(detail.properties.format, "md");
    assert.equal(detail.prompt, "Deep research skill");
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
    // owner stays intentionally null (no org-wide user directory locally).
    assert.equal(withTarget.items[0].owner, null);
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
// KLOC/$ column (FEA-3090)
// ---------------------------------------------------------------------------

type FakeSessionLoc = { added: number; removed: number };

/**
 * A minimal fake `AgentSessionSyncSource` whose `loadSyncedSessions` returns
 * synthetic sessions carrying the `gitDiffStats` (authored LOC) and per-model
 * estimated cost the KLOC/$ reader consumes (plus the fields `mapListItem`
 * touches, so the detail `sessionsTab` projection is exercised too). Ids with no
 * entry resolve to nothing (dropped), mirroring the real loader.
 */
function fakeLocCostSource(
  sessions: Record<string, { loc?: FakeSessionLoc; cost?: number }>
): AgentSessionSyncSource {
  return {
    loadSyncedSessions(ids: readonly string[]) {
      return ids.flatMap((id) => {
        const spec = sessions[id];
        if (!spec) {
          return [];
        }
        return [
          {
            externalSessionId: id,
            name: id,
            status: "completed",
            harness: "claude",
            cwd: null,
            model: "claude",
            startedAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z",
            endedAt: null,
            awaitingInputSince: null,
            lastActivityAt: "2026-06-01T00:00:00.000Z",
            attribution: null,
            prs: [],
            events: [],
            agents: [],
            markers: [],
            tokenUsageByModel:
              spec.cost === undefined
                ? []
                : [
                    {
                      model: "claude",
                      inputTokens: 0,
                      outputTokens: 0,
                      cacheReadTokens: 0,
                      cacheWriteTokens: 0,
                      estimatedCostUsd: spec.cost,
                    },
                  ],
            ...(spec.loc
              ? {
                  gitDiffStats: {
                    linesAdded: spec.loc.added,
                    linesRemoved: spec.loc.removed,
                    filesChanged: 0,
                    source: "git",
                  },
                }
              : {}),
          },
        ];
      });
    },
  } as unknown as AgentSessionSyncSource;
}

test("listAgentComponentsLocal computes KLOC/$ = summed lines/1000 / summed cost across the component's deduped sessions", async () => {
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
    await insertUsage(prisma, {
      sessionId: "s2",
      kind: "skill",
      key: "deep-research",
      invocations: 2,
    });

    const source = fakeLocCostSource({
      s1: { loc: { added: 600, removed: 400 }, cost: 0.5 },
      s2: { loc: { added: 200, removed: 300 }, cost: 0.5 },
    });
    const result = await listAgentComponentsLocal(prisma, {}, null, source);
    const skill = result.items.find((i) => i.id === "skill::deep-research");
    assert.ok(skill, "skill row should be present");
    // (1000 + 500) lines / 1000 = 1.5 KLOC ÷ (0.5 + 0.5) = 1.5 KLOC/$.
    assert.ok(
      skill.klocPerDollar !== null &&
        Math.abs(skill.klocPerDollar - 1.5) < 1e-9,
      `expected 1.5, got ${skill.klocPerDollar}`
    );
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal reports KLOC/$ = null when summed cost is 0 (no divide-by-zero)", async () => {
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
      invocations: 1,
    });
    const source = fakeLocCostSource({
      s1: { loc: { added: 100, removed: 0 }, cost: 0 },
    });
    const result = await listAgentComponentsLocal(prisma, {}, null, source);
    const skill = result.items.find((i) => i.id === "skill::deep-research");
    assert.ok(skill);
    assert.equal(skill.klocPerDollar, null);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal reports KLOC/$ = null when the sessions produced no measurable lines", async () => {
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
      invocations: 1,
    });
    // Cost present, but no gitDiffStats/LOC → totalLoc 0 → null (not 0).
    const source = fakeLocCostSource({ s1: { cost: 0.5 } });
    const result = await listAgentComponentsLocal(prisma, {}, null, source);
    const skill = result.items.find((i) => i.id === "skill::deep-research");
    assert.ok(skill);
    assert.equal(skill.klocPerDollar, null);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal leaves KLOC/$ null when no sessions source is wired", async () => {
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
      invocations: 1,
    });
    const result = await listAgentComponentsLocal(prisma, {});
    const skill = result.items.find((i) => i.id === "skill::deep-research");
    assert.ok(skill);
    assert.equal(skill.klocPerDollar, null);
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal computes a plugin's KLOC/$ from its child-usage sessions", async () => {
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
    // 2000 lines / 1000 = 2 KLOC ÷ 0.5 = 4.0 KLOC/$ (rolled up from the child).
    assert.ok(
      plugin.klocPerDollar !== null &&
        Math.abs(plugin.klocPerDollar - 4.0) < 1e-9,
      `expected 4.0, got ${plugin.klocPerDollar}`
    );
  } finally {
    await close();
  }
});

test("getAgentComponentDetailLocal computes KLOC/$ from the invoking sessions", async () => {
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

    const source = fakeLocCostSource({
      s1: { loc: { added: 600, removed: 400 }, cost: 0.5 },
      s2: { loc: { added: 200, removed: 300 }, cost: 0.5 },
    });
    const detail = await getAgentComponentDetailLocal(
      prisma,
      "skill::deep-research",
      null,
      source
    );
    assert.ok(detail, "detail should resolve");
    assert.ok(
      detail.klocPerDollar !== null &&
        Math.abs(detail.klocPerDollar - 1.5) < 1e-9,
      `expected 1.5, got ${detail.klocPerDollar}`
    );
    // The single load also hydrated the sessionsTab from the same sessions.
    assert.equal(detail.sessionsTab.length, 2);
  } finally {
    await close();
  }
});
