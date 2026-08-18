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
// FEA-4098 (Slice 3): a second author of the skill's version, so the
// collaborators people-set is [discoverer, editor] rather than a lone owner.
const EDITOR_USER_ID = randomUUID();
const COMPUTE_TARGET_ID = randomUUID();

// FEA-4098 (Slice 3): the skill's coarse content hash and the provenance-free
// DefinitionVersion fingerprint (64 lowercase hex) it links to. The list/detail
// authors set keys off the fingerprint via AgentComponentVersion → DefinitionVersion.
const SKILL_CONTENT_HASH = "a".repeat(64);
const SKILL_DEFINITION_HASH = "b".repeat(64);

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

// ISS-4635 (wongk): a DURABLE orphan-only identity — usage rows exist with a
// NULL `agentComponentId` FK (usage synced before any inventory row, or never
// linked) and NO agent_components row is ever seeded for it. Kept through the
// whole suite (unlike the transient orphan the detail test creates+deletes) so
// BOTH the listForOrg and ranking real-DB reads reconcile the orphan lane: the
// fake-Prisma parity suite proves the fold in `ranking-list-parity.test.ts`, and
// this proves it against real SQL predicates.
const ORPHAN_SKILL_KEY = "orphan-usage-skill";

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

    // Skill: used in both sessions. Carries a content hash linked to a
    // DefinitionVersion whose lineage names the authors (FEA-4098 Slice 3).
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
        contentHash: SKILL_CONTENT_HASH,
        ...seenAt,
      },
    });

    // FEA-4098 (Slice 3): the skill's exact-version fingerprint + its multi-editor
    // lineage. The list/detail authors people-set is derived from these rows
    // (discoverer first, then editors), NOT from the inventory compute-target
    // user. The coarse `AgentComponentVersion` links the skill's contentHash to
    // the provenance-free `DefinitionVersion`, which the two editors authored.
    const skillDefinitionVersion = await db.definitionVersion.create({
      data: {
        organizationId: ORG_ID,
        componentKind: "skill",
        definitionHash: SKILL_DEFINITION_HASH,
        normalizerContractVersion: 1,
        content: "# My Skill",
      },
    });
    await db.agentComponentVersion.create({
      data: {
        organizationId: ORG_ID,
        componentKind: "skill",
        componentKey: SKILL_KEY,
        contentHash: SKILL_CONTENT_HASH,
        content: "# My Skill",
        definitionVersionId: skillDefinitionVersion.id,
      },
    });
    // A second user (the editor) so authors = [discoverer, editor] — proving the
    // people-set is more than the single owner it replaced.
    await db.user.create({
      data: {
        id: EDITOR_USER_ID,
        organizationId: ORG_ID,
        clerkId: `clerk_user_${EDITOR_USER_ID}`,
        email: "editor.user@example.com",
        firstName: "Edith",
        lastName: "Editor",
      },
    });
    // Seed User discovered the hash first (earlier firstEditedAt); Edith edited
    // it later. Discoverer-first ordering is derived from `firstEditedAt`.
    await db.definitionVersionEditor.create({
      data: {
        definitionVersionId: skillDefinitionVersion.id,
        userId: USER_ID,
        firstEditedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await db.definitionVersionEditor.create({
      data: {
        definitionVersionId: skillDefinitionVersion.id,
        userId: EDITOR_USER_ID,
        firstEditedAt: new Date("2026-01-03T00:00:00Z"),
      },
    });

    // Plugin (parent) + a child command it ships. The plugin carries no own
    // usage rows; its totals are rolled up from its children, matched by
    // `packId` (applyPluginChildUsageRollup — same in listForOrg and ranking).
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
    // FEA-3982 (wongk) / FEA-4098: the usage rows carry the SAME version identity
    // the inventory row resolves to (`componentVersionHash` = the coarse
    // contentHash, `definitionVersionId` = the linked DefinitionVersion). Version
    // attribution folds usage into the bucket matching its OWN carried hash, so a
    // versioned inventory row whose usage carried no hash would split into a
    // second name-level bucket (double-listing the skill). Stamping the usage
    // rows keeps the seed coherent — one versioned skill row — which is how real
    // usage stamped by the desktop sync arrives once versions are recorded.
    await db.agentComponentSessionUsage.create({
      data: {
        agentSessionId: SESSION_A_ID,
        componentKind: "skill",
        componentKey: SKILL_KEY,
        agentComponentId: SKILL_ID,
        componentVersionHash: SKILL_CONTENT_HASH,
        definitionVersionId: skillDefinitionVersion.id,
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
        componentVersionHash: SKILL_CONTENT_HASH,
        definitionVersionId: skillDefinitionVersion.id,
        harness: "claude",
        invocationCount: 2,
        errorCount: 1,
      },
    });

    // Plugin usage: a plugin carries NO own usage rows — its invocations are
    // rolled up from its CHILD components' usage, joined by `pack_id`. Both cloud
    // read paths agree on this: listForOrg/getDetailForOrg via
    // applyPluginChildUsageRollup (FEA-2923) and rankingService via the same
    // shared pack-id rollup (FEA-3387). So the plugin's usage lives on the child
    // command `rtk:gain` (packId = PLUGIN_KEY), FK-linked to the child inventory
    // row. Session A: 4, session B: 6.
    await db.agentComponentSessionUsage.create({
      data: {
        agentSessionId: SESSION_A_ID,
        componentKind: "command",
        componentKey: "rtk:gain",
        agentComponentId: PLUGIN_CHILD_ID,
        harness: "claude",
        invocationCount: 4,
        errorCount: 0,
      },
    });
    await db.agentComponentSessionUsage.create({
      data: {
        agentSessionId: SESSION_B_ID,
        componentKind: "command",
        componentKey: "rtk:gain",
        agentComponentId: PLUGIN_CHILD_ID,
        harness: "claude",
        invocationCount: 6,
        errorCount: 0,
      },
    });
    // => plugin: 4 + 6 = 10 child invocations rolled up across 2 sessions.

    // ISS-4635 (wongk): DURABLE orphan-only usage — a skill USED but never
    // inventory-linked (`agentComponentId` NULL), across two distinct sessions
    // (6 + 3 = 9 invocations, 2 errors). No agent_components row exists for it, so
    // it only surfaces if the orphan lane is folded in — the exact defect this PR
    // fixes for ranking. Kept for the whole suite so listForOrg AND ranking both
    // reconcile it against real Postgres.
    await db.agentComponentSessionUsage.create({
      data: {
        agentSessionId: SESSION_A_ID,
        componentKind: "skill",
        componentKey: ORPHAN_SKILL_KEY,
        agentComponentId: null,
        harness: "claude",
        invocationCount: 6,
        errorCount: 1,
      },
    });
    await db.agentComponentSessionUsage.create({
      data: {
        agentSessionId: SESSION_B_ID,
        componentKind: "skill",
        componentKey: ORPHAN_SKILL_KEY,
        agentComponentId: null,
        harness: "claude",
        invocationCount: 3,
        errorCount: 1,
      },
    });
    // => orphan skill: 6 + 3 = 9 invocations / 2 errors across 2 distinct sessions.
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
  it("listForOrg aggregates org-wide usage, rolls up plugin child usage, and reports null usage for hook/config", async () => {
    const res = await agentComponentsService.listForOrg(ORG_ID, listQuery);

    // Two skills share the `skill` kind (the inventory-backed one and the durable
    // ISS-4635 orphan-only one). The inventory skill surfaces under its VERSIONED
    // slug (`skill::<definitionHash>`), the orphan under its name-level identity
    // (`skill::<key>`), so look each up by slug — a kind-keyed map would collide.
    const bySlug = new Map(res.items.map((i) => [i.slug, i]));
    const byKind = new Map(res.items.map((i) => [i.kind, i]));

    // Five inventory-backed components + the durable orphan-only skill (usage but
    // no agent_components row) = six.
    expect(res.items).toHaveLength(6);
    expect(res.total).toBe(6);

    // The versioned inventory skill keys on its DefinitionVersion fingerprint.
    const skill = bySlug.get(`skill::${SKILL_DEFINITION_HASH}`);
    expect(skill, "skill row present").toBeDefined();
    expect(skill?.invocations).toBe(5); // 3 + 2
    expect(skill?.sessions).toBe(2);

    // ISS-4635 (wongk): the orphan-only skill (NULL FK usage, no inventory row)
    // surfaces on the list with its real totals — reconciling the same orphan lane
    // ranking now folds in. 6 + 3 = 9 invocations across 2 sessions.
    const orphanSkill = bySlug.get(`skill::${ORPHAN_SKILL_KEY}`);
    expect(orphanSkill, "orphan-only skill present on the list").toBeDefined();
    expect(orphanSkill?.invocations).toBe(9);
    expect(orphanSkill?.sessions).toBe(2);

    const plugin = byKind.get("plugin");
    expect(plugin, "plugin row present").toBeDefined();
    // Plugin rollup: child usage (4 + 6) rolled up by pack_id = 10 invocations,
    // 2 sessions. The plugin has no own usage rows.
    expect(plugin?.invocations).toBe(10);
    expect(plugin?.sessions).toBe(2);

    // hook + config: no usage rows => honest zero usage.
    const hook = byKind.get("hook");
    const config = byKind.get("config");
    expect(hook?.invocations).toBe(0);
    expect(hook?.sessions).toBe(0);
    expect(config?.invocations).toBe(0);
    expect(config?.sessions).toBe(0);

    // FEA-4098 (Slice 3): the authors people-set is the DefinitionVersionEditor
    // lineage of the skill's version — discoverer first (earlier firstEditedAt),
    // then the later editor — NOT the single compute-target owner it replaced.
    expect(skill?.collaborators).toEqual(["Seed User", "Edith Editor"]);
    // codex P1: additive skew-compat `owner` alias = the discoverer.
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

  it("getDetailForOrg plugin detail rolls up child usage into totals + sessionsTab", async () => {
    const detail = await agentComponentsService.getDetailForOrg(
      ORG_ID,
      `plugin::${PLUGIN_KEY}`
    );

    expect(detail, "plugin detail resolves").not.toBeNull();
    expect(detail?.invocations).toBe(10); // 4 + 6 child invocations
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

  it("wongk (contentHash collision, real DB): a skill and a command with identical bytes keep DISTINCT authors", async () => {
    // Byte-identical content ⇒ ONE shared contentHash, but definitionHash folds
    // in the kind, so each kind links its own DefinitionVersion with its own
    // lineage. A contentHash-only resolution would mis-assign both to whichever
    // row sorted first; keying on (kind, key, contentHash) keeps them distinct.
    //
    // Fully isolated in its OWN org (org delete cascades) so it can never affect
    // the org-wide count/aggregate assertions the sibling tests make on ORG_ID.
    const collideOrgId = randomUUID();
    const collideTargetId = randomUUID();
    const collideUserId = randomUUID();
    const sharedContentHash = "c".repeat(64);
    const skillFp = "d".repeat(64);
    const commandFp = "e".repeat(64);
    const collideKey = "collide-me";
    const skillAuthorId = randomUUID();
    const commandAuthorId = randomUUID();

    await withDb(async (db) => {
      await db.organization.create({
        data: {
          id: collideOrgId,
          clerkId: `clerk_org_${collideOrgId}`,
          name: "Collision Test Org",
          slug: `collide-${collideOrgId}`,
        },
      });
      await db.user.createMany({
        data: [
          {
            id: collideUserId,
            organizationId: collideOrgId,
            clerkId: `clerk_user_${collideUserId}`,
            email: "collide.seed@example.com",
            firstName: "Collide",
            lastName: "Seed",
          },
          {
            id: skillAuthorId,
            organizationId: collideOrgId,
            clerkId: `clerk_user_${skillAuthorId}`,
            email: "skill.author@example.com",
            firstName: "Skill",
            lastName: "Author",
          },
          {
            id: commandAuthorId,
            organizationId: collideOrgId,
            clerkId: `clerk_user_${commandAuthorId}`,
            email: "command.author@example.com",
            firstName: "Command",
            lastName: "Author",
          },
        ],
      });
      await db.computeTarget.create({
        data: {
          id: collideTargetId,
          organizationId: collideOrgId,
          userId: collideUserId,
          machineName: "collide-machine",
          platform: "darwin",
        },
      });
      for (const [kind, fp, authorId] of [
        ["skill", skillFp, skillAuthorId],
        ["command", commandFp, commandAuthorId],
      ] as const) {
        await db.agentComponent.create({
          data: {
            organizationId: collideOrgId,
            computeTargetId: collideTargetId,
            componentKind: kind,
            externalComponentId: `${kind}:${collideKey}`,
            harness: "claude",
            name: `${kind} collide`,
            componentKey: collideKey,
            contentHash: sharedContentHash,
            firstSeenAt: new Date("2026-01-01T00:00:00Z"),
            lastSeenAt: new Date("2026-01-02T00:00:00Z"),
          },
        });
        const dv = await db.definitionVersion.create({
          data: {
            organizationId: collideOrgId,
            componentKind: kind,
            definitionHash: fp,
            normalizerContractVersion: 1,
            content: "# same bytes",
          },
        });
        await db.agentComponentVersion.create({
          data: {
            organizationId: collideOrgId,
            componentKind: kind,
            componentKey: collideKey,
            contentHash: sharedContentHash,
            content: "# same bytes",
            definitionVersionId: dv.id,
          },
        });
        await db.definitionVersionEditor.create({
          data: {
            definitionVersionId: dv.id,
            userId: authorId,
            firstEditedAt: new Date("2026-01-01T00:00:00Z"),
          },
        });
      }
    });

    try {
      const res = await agentComponentsService.listForOrg(
        collideOrgId,
        listQuery
      );
      const byKind = new Map(res.items.map((i) => [i.kind, i]));
      // Exactly the two seeded identities — no collision collapse.
      expect(res.items).toHaveLength(2);
      // Each identity keeps its OWN author — NOT a collided single author.
      expect(byKind.get("skill")?.collaborators).toEqual(["Skill Author"]);
      expect(byKind.get("command")?.collaborators).toEqual(["Command Author"]);
    } finally {
      // Ordered teardown: `compute_targets → org`, `compute_targets → user`, and
      // `users → org` are RESTRICT (not cascade), so a bare `organization.delete`
      // throws a FK violation while the seeded users/targets still reference the
      // org. Delete the RESTRICT-linked rows first (components + versions + editor
      // lineage cascade from the org delete), then the org. Mirrors the ORG_ID
      // afterAll teardown.
      await withDb(async (db) => {
        await db.agentComponent.deleteMany({
          where: { organizationId: collideOrgId },
        });
        await db.computeTarget.deleteMany({
          where: { organizationId: collideOrgId },
        });
        await db.user.deleteMany({ where: { organizationId: collideOrgId } });
        await db.organization.delete({ where: { id: collideOrgId } });
      });
    }
  });

  it("rankingService stack-ranks components by org-wide invocations", async () => {
    const ranking = await rankingService.getRanking({
      organizationId: ORG_ID,
      limit: 50,
    });

    const bySlug = new Map(ranking.items.map((i) => [i.slug, i]));
    const plugin = bySlug.get(`plugin::${PLUGIN_KEY}`);
    const skill = bySlug.get(`skill::${SKILL_KEY}`);

    // Ranking rolls up plugin child usage by pack_id (FEA-3387), mirroring
    // listForOrg: plugin = 4 + 6 = 10 across 2 sessions (no own usage rows).
    expect(plugin?.invocations).toBe(10);
    expect(plugin?.sessions).toBe(2);
    expect(skill?.invocations).toBe(5);
    expect(skill?.sessions).toBe(2);
    // errorRate = totalErrors / totalInvocations for skill: 1 / 5.
    expect(skill?.errorRate).toBeCloseTo(0.2, 5);

    // ISS-4635 (wongk): the durable orphan-only skill (NULL FK usage, no inventory
    // row) is folded into the ranking too — reconciling the SAME orphan lane and
    // the SAME real totals the listForOrg test asserts (9 invocations / 2 sessions
    // / 2 errors), not the pre-fix `invocations: 0`.
    const orphanSkill = bySlug.get(`skill::${ORPHAN_SKILL_KEY}`);
    expect(orphanSkill, "orphan-only skill ranked").toBeDefined();
    expect(orphanSkill?.invocations).toBe(9);
    expect(orphanSkill?.sessions).toBe(2);
    expect(orphanSkill?.errorRate).toBeCloseTo(2 / 9, 5);

    // Rank order by invocations: plugin(10) > orphan skill(9) > skill(5).
    expect(plugin?.rank).toBeLessThan(orphanSkill?.rank as number);
    expect(orphanSkill?.rank).toBeLessThan(skill?.rank as number);
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
