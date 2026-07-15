/**
 * FEA-2923 real-Postgres integration proof for the cloud read path.
 *
 * Unlike the mocked-Prisma unit tests in
 * apps/api/app/agent-components/__tests__, this test seeds a minimal but valid
 * relational graph via the REAL @repo/database prisma client and exercises
 * agentComponentsService.listForOrg / getDetailForOrg, plus ranking + compliance,
 * against a REAL Postgres instance.
 *
 * It is intentionally NOT included by the default vitest config (which only runs
 * unit tests + compatibility). Run it explicitly with a real DATABASE_URL, e.g.:
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/app \
 *     pnpm --filter api exec vitest run \
 *     __tests__/integration/agent-components-realdb.test.ts \
 *     --config vitest.config.mts
 *
 * All seeded rows are namespaced under one unique org and cleaned up in
 * afterAll (org delete cascades to artifacts/compute targets/components).
 */
import { randomUUID } from "node:crypto";
import { withDb } from "@repo/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { complianceService } from "../../app/agent-components/compliance/service";
import { rankingService } from "../../app/agent-components/ranking/service";
import { agentComponentsService } from "../../app/agent-components/service";
import { AGENT_COMPONENT_LIST_DEFAULT_LIMIT } from "../../app/agent-components/validators";

// One unique org per run so parallel/leftover data can never collide.
const ORG_ID = randomUUID();
const USER_ID = randomUUID();
const COMPUTE_TARGET_ID = randomUUID();

// Two SESSION artifacts (each is a session the components were used in).
const SESSION_A_ID = randomUUID();
const SESSION_B_ID = randomUUID();

// Component ids
const SKILL_ID = randomUUID();
const PLUGIN_ID = randomUUID();
const PLUGIN_CHILD_ID = randomUUID();
const HOOK_ID = randomUUID();
const CONFIG_ID = randomUUID();

const SKILL_KEY = "my-skill";
const PLUGIN_KEY = "rtk";
const HOOK_KEY = "pre-commit-hook";
const CONFIG_KEY = "settings.json";

const listQuery = {
  limit: AGENT_COMPONENT_LIST_DEFAULT_LIMIT,
  offset: 0,
} as Parameters<typeof agentComponentsService.listForOrg>[1];

beforeAll(async () => {
  await withDb(async (db) => {
    await db.organization.create({
      data: {
        id: ORG_ID,
        clerkId: `clerk_org_${ORG_ID}`,
        name: "RealDB Test Org",
        slug: `realdb-test-${ORG_ID}`,
      },
    });

    await db.user.create({
      data: {
        id: USER_ID,
        organizationId: ORG_ID,
        clerkId: `clerk_user_${USER_ID}`,
        email: "seed.user@example.com",
        firstName: "Seed",
        lastName: "User",
      },
    });

    await db.computeTarget.create({
      data: {
        id: COMPUTE_TARGET_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
        machineName: "seed-machine",
        platform: "darwin",
      },
    });

    // Two SESSION artifacts + their SessionDetail rows. These are what
    // sessionsTab / usageSessions are built from.
    for (const [artifactId, extSession] of [
      [SESSION_A_ID, "ext-session-a"],
      [SESSION_B_ID, "ext-session-b"],
    ] as const) {
      await db.artifact.create({
        data: {
          id: artifactId,
          organizationId: ORG_ID,
          type: "SESSION",
          name: `Session ${extSession}`,
          slug: `session-${extSession}-${artifactId.slice(0, 8)}`,
          status: "active",
        },
      });
      await db.sessionDetail.create({
        data: {
          artifactId,
          userId: USER_ID,
          computeTargetId: COMPUTE_TARGET_ID,
          externalSessionId: extSession,
          harness: "claude",
          sessionStartedAt: new Date("2026-01-01T00:00:00Z"),
          sessionUpdatedAt: new Date("2026-01-01T01:00:00Z"),
          lastActivityAt: new Date("2026-01-01T01:00:00Z"),
        },
      });
    }

    // ---- Agent components (inventory rows) ----
    const seenAt = {
      firstSeenAt: new Date("2026-01-01T00:00:00Z"),
      lastSeenAt: new Date("2026-01-02T00:00:00Z"),
    };

    // Skill: used in both sessions.
    await db.agentComponent.create({
      data: {
        id: SKILL_ID,
        organizationId: ORG_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        componentKind: "skill",
        externalComponentId: "skill:my-skill",
        harness: "claude",
        name: "My Skill",
        componentKey: SKILL_KEY,
        ...seenAt,
      },
    });

    // Plugin (parent) + a child component the plugin ships. The plugin's own
    // usage rows carry componentKind='plugin' and roll up child invocations
    // attributed to the plugin identity.
    await db.agentComponent.create({
      data: {
        id: PLUGIN_ID,
        organizationId: ORG_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        componentKind: "plugin",
        externalComponentId: "plugin:rtk",
        harness: "claude",
        name: "RTK",
        componentKey: PLUGIN_KEY,
        ...seenAt,
      },
    });
    await db.agentComponent.create({
      data: {
        id: PLUGIN_CHILD_ID,
        organizationId: ORG_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        componentKind: "command",
        externalComponentId: "command:rtk:gain",
        harness: "claude",
        name: "rtk gain",
        componentKey: "rtk:gain",
        packId: PLUGIN_KEY,
        ...seenAt,
      },
    });

    // Hook + config: intentionally NO usage rows (thin invocation signal).
    await db.agentComponent.create({
      data: {
        id: HOOK_ID,
        organizationId: ORG_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        componentKind: "hook",
        externalComponentId: "hook:pre-commit",
        harness: "claude",
        name: "Pre Commit Hook",
        componentKey: HOOK_KEY,
        ...seenAt,
      },
    });
    await db.agentComponent.create({
      data: {
        id: CONFIG_ID,
        organizationId: ORG_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        componentKind: "config",
        externalComponentId: "config:settings",
        harness: "claude",
        name: "Settings",
        componentKey: CONFIG_KEY,
        ...seenAt,
      },
    });

    // ---- Usage rows (agent_component_session_usage) ----
    // Skill: session A (3 invocations) + session B (2 invocations) => 5 inv / 2 sessions.
    await db.agentComponentSessionUsage.create({
      data: {
        agentSessionId: SESSION_A_ID,
        componentKind: "skill",
        componentKey: SKILL_KEY,
        agentComponentId: SKILL_ID,
        harness: "claude",
        invocationCount: 3,
        errorCount: 0,
      },
    });
    await db.agentComponentSessionUsage.create({
      data: {
        agentSessionId: SESSION_B_ID,
        componentKind: "skill",
        componentKey: SKILL_KEY,
        agentComponentId: SKILL_ID,
        harness: "claude",
        invocationCount: 2,
        errorCount: 1,
      },
    });

    // Plugin rollup: the plugin identity accrues child invocations across both
    // sessions. Session A: 4 (FK-linked to the plugin inventory row).
    await db.agentComponentSessionUsage.create({
      data: {
        agentSessionId: SESSION_A_ID,
        componentKind: "plugin",
        componentKey: PLUGIN_KEY,
        agentComponentId: PLUGIN_ID,
        harness: "claude",
        invocationCount: 4,
        errorCount: 0,
      },
    });
    // Session B: 6 invocations, ORPHAN (agentComponentId NULL) — usage synced
    // before the FK was linked. Must still fold into the plugin totals.
    await db.agentComponentSessionUsage.create({
      data: {
        agentSessionId: SESSION_B_ID,
        componentKind: "plugin",
        componentKey: PLUGIN_KEY,
        agentComponentId: null,
        harness: "claude",
        invocationCount: 6,
        errorCount: 0,
      },
    });
    // => plugin: 4 + 6 = 10 invocations across 2 sessions.
  });
});

afterAll(async () => {
  await withDb(async (db) => {
    // Usage rows FK the session artifacts (cascade on session delete) but not the
    // org, so clear them first, then delete the org (cascades to artifacts,
    // compute targets, components). Belt-and-suspenders explicit cleanup.
    await db.agentComponentSessionUsage.deleteMany({
      where: { agentSessionId: { in: [SESSION_A_ID, SESSION_B_ID] } },
    });
    await db.agentComponent.deleteMany({ where: { organizationId: ORG_ID } });
    await db.sessionDetail.deleteMany({
      where: { artifactId: { in: [SESSION_A_ID, SESSION_B_ID] } },
    });
    await db.artifact.deleteMany({ where: { organizationId: ORG_ID } });
    await db.computeTarget.deleteMany({ where: { organizationId: ORG_ID } });
    await db.user.deleteMany({ where: { organizationId: ORG_ID } });
    await db.organization.deleteMany({ where: { id: ORG_ID } });
  });
});

describe("FEA-2923 cloud read path against REAL Postgres", () => {
  it("listForOrg aggregates org-wide usage, rolls up plugin (incl. orphan) child usage, and reports null usage for hook/config", async () => {
    const res = await agentComponentsService.listForOrg(ORG_ID, listQuery);

    const byKind = new Map(res.items.map((i) => [i.kind, i]));

    // All five distinct components present.
    expect(res.items).toHaveLength(5);
    expect(res.total).toBe(5);

    const skill = byKind.get("skill");
    expect(skill, "skill row present").toBeDefined();
    expect(skill?.invocations).toBe(5); // 3 + 2
    expect(skill?.sessions).toBe(2);

    const plugin = byKind.get("plugin");
    expect(plugin, "plugin row present").toBeDefined();
    // Plugin rollup: FK-linked (4) + orphan (6) = 10 invocations, 2 sessions.
    expect(plugin?.invocations).toBe(10);
    expect(plugin?.sessions).toBe(2);

    // hook + config: no usage rows => honest zero usage.
    const hook = byKind.get("hook");
    const config = byKind.get("config");
    expect(hook?.invocations).toBe(0);
    expect(hook?.sessions).toBe(0);
    expect(config?.invocations).toBe(0);
    expect(config?.sessions).toBe(0);

    // Owner attribution flows from computeTarget.user.
    expect(skill?.owner).toBe("Seed User");
  });

  it("getDetailForOrg returns a detail whose sessionsTab is NON-EMPTY (the FEA-2923 gap)", async () => {
    const detail = await agentComponentsService.getDetailForOrg(
      ORG_ID,
      `skill::${SKILL_KEY}`
    );

    expect(detail, "skill detail resolves (not 404)").not.toBeNull();
    expect(detail?.invocations).toBe(5);
    expect(detail?.sessions).toBe(2);

    // THE FIX: sessionsTab must be populated from
    // agent_component_session_usage -> session_detail, not empty.
    expect(detail?.sessionsTab.length).toBe(2);
    const tabIds = new Set(detail?.sessionsTab.map((s) => s.id));
    expect(tabIds.has(SESSION_A_ID)).toBe(true);
    expect(tabIds.has(SESSION_B_ID)).toBe(true);

    // usageSessions carries the per-session invocation counts.
    const usageById = new Map(
      detail?.usageSessions.map((u) => [u.sessionId, u.invocationCount])
    );
    expect(usageById.get(SESSION_A_ID)).toBe(3);
    expect(usageById.get(SESSION_B_ID)).toBe(2);
  });

  it("getDetailForOrg plugin detail folds orphan usage into totals + sessionsTab", async () => {
    const detail = await agentComponentsService.getDetailForOrg(
      ORG_ID,
      `plugin::${PLUGIN_KEY}`
    );

    expect(detail, "plugin detail resolves").not.toBeNull();
    expect(detail?.invocations).toBe(10); // 4 FK-linked + 6 orphan
    expect(detail?.sessions).toBe(2);
    expect(detail?.sessionsTab.length).toBe(2);

    const usageById = new Map(
      detail?.usageSessions.map((u) => [u.sessionId, u.invocationCount])
    );
    expect(usageById.get(SESSION_A_ID)).toBe(4);
    expect(usageById.get(SESSION_B_ID)).toBe(6);
  });

  it("getDetailForOrg resolves the orphan-only path (usage but no inventory row) — not 404", async () => {
    // Seed a used-only identity: usage rows exist, but NO agent_components row.
    const orphanKey = "orphan-only-skill";
    await withDb((db) =>
      db.agentComponentSessionUsage.create({
        data: {
          agentSessionId: SESSION_A_ID,
          componentKind: "skill",
          componentKey: orphanKey,
          agentComponentId: null,
          harness: "claude",
          invocationCount: 7,
          errorCount: 0,
        },
      })
    );

    try {
      const detail = await agentComponentsService.getDetailForOrg(
        ORG_ID,
        `skill::${orphanKey}`
      );

      // #2613: must NOT 404 — synthetic detail from orphan usage.
      expect(detail, "orphan-only detail resolves (not 404)").not.toBeNull();
      expect(detail?.invocations).toBe(7);
      expect(detail?.sessions).toBe(1);
      // sessionsTab still populated for the orphan-only path.
      expect(detail?.sessionsTab.length).toBe(1);
      expect(detail?.sessionsTab[0]?.id).toBe(SESSION_A_ID);
    } finally {
      await withDb((db) =>
        db.agentComponentSessionUsage.deleteMany({
          where: { agentSessionId: SESSION_A_ID, componentKey: orphanKey },
        })
      );
    }
  });

  it("getDetailForOrg 404s a genuinely unknown identity", async () => {
    const detail = await agentComponentsService.getDetailForOrg(
      ORG_ID,
      "skill::does-not-exist"
    );
    expect(detail).toBeNull();
  });

  it("rankingService stack-ranks components by org-wide invocations", async () => {
    const ranking = await rankingService.getRanking({
      organizationId: ORG_ID,
      limit: 50,
    });

    const bySlug = new Map(ranking.items.map((i) => [i.slug, i]));
    const plugin = bySlug.get(`plugin::${PLUGIN_KEY}`);
    const skill = bySlug.get(`skill::${SKILL_KEY}`);

    // ranking counts only FK-linked usage (no orphan fold): plugin = 4 (1 session).
    expect(plugin?.invocations).toBe(4);
    expect(plugin?.sessions).toBe(1);
    expect(skill?.invocations).toBe(5);
    expect(skill?.sessions).toBe(2);
    // errorRate = totalErrors / totalInvocations for skill: 1 / 5.
    expect(skill?.errorRate).toBeCloseTo(0.2, 5);

    // Rank order: skill(5) then plugin(4).
    expect(skill?.rank).toBeLessThan(plugin?.rank as number);
  });

  it("complianceService runs against the real DB and returns no gaps (no distributions seeded)", async () => {
    const compliance = await complianceService.getCompliance({
      organizationId: ORG_ID,
      limit: 50,
    });
    expect(compliance.items).toEqual([]);
    expect(compliance.total).toBe(0);
  });
});
