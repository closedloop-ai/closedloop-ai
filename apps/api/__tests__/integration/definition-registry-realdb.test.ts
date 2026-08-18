/**
 * FEA-3290 (F1, Slice 3) — real-Postgres integration proof for the definition
 * registry writer and the desktop sync lane.
 *
 * Unlike the mocked-Prisma unit tests (which model the upsert contract by hand),
 * this seeds a minimal relational graph via the REAL @repo/database client and
 * exercises `registerDefinitionVersion` + `desktopComponentsSyncService.sync`
 * against a REAL Postgres, so the actual `@@unique` upsert semantics — including
 * the NULL-in-unique-key coalescing — are proven, not simulated.
 *
 * NOT in the default vitest suite (excluded via __tests__/integration/**). Run
 * with a real DATABASE_URL, e.g.:
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/app \
 *     pnpm --filter api exec vitest run \
 *     __tests__/integration/definition-registry-realdb.test.ts \
 *     --config vitest.config.mts
 *
 * All seeded rows are namespaced under two unique orgs and cleaned up in
 * afterAll (org delete cascades to compute targets / versions / occurrences).
 */
import { randomUUID } from "node:crypto";
import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import {
  SourceAccessState,
  SourceOccurrenceType,
  withDb,
} from "@repo/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureDefinitionVersion,
  recordDefinitionSourceOccurrence,
  registerDefinitionVersion,
} from "../../app/definition-registry/service";
import { desktopComponentsSyncService } from "../../app/desktop/components/sync/service";

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const USER_A = randomUUID();
// FEA-3982 edit-lineage: a second ORG_A user so a version observed by two
// distinct users records two editors (true multi-editor collaboration).
const USER_A2 = randomUUID();
const TARGET_A = randomUUID();

async function seedOrg(orgId: string, userId: string, targetId: string) {
  await withDb(async (db) => {
    await db.organization.create({
      data: {
        id: orgId,
        clerkId: `clerk_org_${orgId}`,
        name: "Registry Test Org",
        slug: `registry-test-${orgId}`,
        // FEA-4169: the desktop components sync lane is now gated server-side by
        // the org session-sync policy (`isOrgSessionSyncPolicyEnabled`), which
        // fail-closes on the NOT NULL DEFAULT false column. This org drives the
        // real-DB sync assertions below, so enable the policy to exercise the
        // write path against a genuinely allowed org (rather than injecting an
        // override) — the policy-off denial is covered in the unit suite.
        sessionSyncPolicyEnabled: true,
      },
    });
    await db.user.create({
      data: {
        id: userId,
        organizationId: orgId,
        clerkId: `clerk_user_${userId}`,
        email: `seed.${userId}@example.com`,
        firstName: "Seed",
        lastName: "User",
      },
    });
    await db.computeTarget.create({
      data: {
        id: targetId,
        organizationId: orgId,
        userId,
        machineName: "seed-machine",
        platform: "darwin",
      },
    });
  });
}

beforeAll(async () => {
  await seedOrg(ORG_A, USER_A, TARGET_A);
  // Second ORG_A user (no compute target needed) for the multi-editor lineage.
  await withDb(async (db) => {
    await db.user.create({
      data: {
        id: USER_A2,
        organizationId: ORG_A,
        clerkId: `clerk_user_${USER_A2}`,
        email: `seed.${USER_A2}@example.com`,
        firstName: "Seed2",
        lastName: "User",
      },
    });
  });
  // Org B: only the org row needed (isolation assertions read cross-org).
  await withDb(async (db) => {
    await db.organization.create({
      data: {
        id: ORG_B,
        clerkId: `clerk_org_${ORG_B}`,
        name: "Registry Test Org B",
        slug: `registry-test-${ORG_B}`,
      },
    });
  });
});

afterAll(async () => {
  await withDb(async (db) => {
    const orgIds = [ORG_A, ORG_B];
    // Delete children before the orgs. User→organization is ON DELETE NO ACTION
    // (users are never cascade-deleted with an org in prod), so a bare
    // organization.deleteMany fails the users FK. Remove rows leaf→root so
    // cleanup doesn't depend on every FK being ON DELETE CASCADE.
    await db.sourceOccurrence.deleteMany({
      where: { organizationId: { in: orgIds } },
    });
    // FEA-3982: editor lineage rows FK the version (ON DELETE CASCADE), but
    // delete them first so cleanup stays leaf→root and order-independent.
    await db.definitionVersionEditor.deleteMany({
      where: { definitionVersion: { organizationId: { in: orgIds } } },
    });
    await db.definitionVersion.deleteMany({
      where: { organizationId: { in: orgIds } },
    });
    await db.computeTarget.deleteMany({
      where: { organizationId: { in: orgIds } },
    });
    await db.user.deleteMany({ where: { organizationId: { in: orgIds } } });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
  });
});

describe("registerDefinitionVersion (real Postgres)", () => {
  it("upserts one DefinitionVersion per (org, fingerprint); a whitespace edit splits, orgs isolate", async () => {
    const content = "# Realdb Skill\nline\n";
    const edited = "# Realdb Skill\n line\n"; // whitespace-only change

    const { definitionHash } = computeDefinitionHash({
      frontmatter: "",
      body: content,
      kind: "skill",
    });

    await withDb(async (db) => {
      const id1 = await registerDefinitionVersion(db, {
        organizationId: ORG_A,
        componentKind: "skill",
        content,
        computeTargetId: TARGET_A,
        installPath: "/a/SKILL.md",
      });
      // Idempotent re-register — same row.
      const id2 = await registerDefinitionVersion(db, {
        organizationId: ORG_A,
        componentKind: "skill",
        content,
        computeTargetId: TARGET_A,
        installPath: "/a/SKILL.md",
      });
      expect(id2).toBe(id1);

      // Whitespace edit → a distinct exact version.
      const idEdited = await registerDefinitionVersion(db, {
        organizationId: ORG_A,
        componentKind: "skill",
        content: edited,
        computeTargetId: TARGET_A,
        installPath: "/a/SKILL.md",
      });
      expect(idEdited).not.toBe(id1);

      // Same content in ORG_B → a separate row (same hash, different org).
      const idB = await registerDefinitionVersion(db, {
        organizationId: ORG_B,
        componentKind: "skill",
        content,
      });
      expect(idB).not.toBe(id1);
    });

    await withDb(async (db) => {
      // ORG_A has exactly two versions for this fingerprint family (base + edit).
      const orgAForHash = await db.definitionVersion.findMany({
        where: { organizationId: ORG_A, definitionHash },
      });
      expect(orgAForHash).toHaveLength(1);
      expect(orgAForHash[0]?.normalizerContractVersion).toBe(1);

      // The idempotent double-register produced exactly ONE occurrence.
      const occs = await db.sourceOccurrence.findMany({
        where: {
          organizationId: ORG_A,
          definitionVersionId: orgAForHash[0]?.id,
        },
      });
      expect(occs).toHaveLength(1);
      expect(occs[0]?.occurrenceType).toBe("local");
      expect(occs[0]?.repoFullName).toBe("");
      expect(occs[0]?.localPath).toBe("/a/SKILL.md");

      // Cross-org: ORG_A's read never returns ORG_B's row.
      const crossOrg = await db.definitionVersion.findMany({
        where: { organizationId: ORG_A, id: undefined, definitionHash },
      });
      expect(crossOrg.every((r) => r.organizationId === ORG_A)).toBe(true);

      // Both orgs hold the same fingerprint independently.
      const bothOrgs = await db.definitionVersion.findMany({
        where: { definitionHash, organizationId: { in: [ORG_A, ORG_B] } },
      });
      expect(bothOrgs).toHaveLength(2);
    });
  });

  it("records one editor lineage row per (version, user); two users editing the same hash = two editors; idempotent re-observe bumps lastEditedAt; orgs isolate (FEA-3982)", async () => {
    const content = "# Realdb Lineage Skill\nbody\n";
    const older = new Date("2026-02-01T00:00:00.000Z");
    const newer = new Date("2026-04-01T00:00:00.000Z");
    const { definitionHash } = computeDefinitionHash({
      frontmatter: "",
      body: content,
      kind: "skill",
    });

    let versionId = "";
    await withDb(async (db) => {
      // USER_A discovers the version (earliest observation).
      versionId = await registerDefinitionVersion(db, {
        organizationId: ORG_A,
        componentKind: "skill",
        content,
        computeTargetId: TARGET_A,
        installPath: "/a/LINEAGE.md",
        editorUserId: USER_A,
        observedAt: older,
      });
      // USER_A re-observes later ⇒ same lineage row, lastEditedAt bumped.
      await registerDefinitionVersion(db, {
        organizationId: ORG_A,
        componentKind: "skill",
        content,
        computeTargetId: TARGET_A,
        installPath: "/a/LINEAGE.md",
        editorUserId: USER_A,
        observedAt: newer,
      });
      // USER_A2 authors the same bytes ⇒ a SECOND editor of that exact hash
      // (multi-editor collaboration on identical content).
      await registerDefinitionVersion(db, {
        organizationId: ORG_A,
        componentKind: "skill",
        content,
        computeTargetId: TARGET_A,
        installPath: "/a/LINEAGE.md",
        editorUserId: USER_A2,
        observedAt: newer,
      });
    });

    await withDb(async (db) => {
      const editors = await db.definitionVersionEditor.findMany({
        where: { definitionVersionId: versionId },
        orderBy: { firstEditedAt: "asc" },
      });
      // Exactly two distinct editors — the re-observe did NOT duplicate USER_A.
      expect(editors).toHaveLength(2);
      expect(editors.map((e) => e.userId)).toEqual([USER_A, USER_A2]);
      // USER_A's row kept its earliest firstEditedAt and advanced lastEditedAt.
      const userARow = editors.find((e) => e.userId === USER_A);
      expect(userARow?.firstEditedAt).toEqual(older);
      expect(userARow?.lastEditedAt).toEqual(newer);

      // Cross-org isolation: ORG_B never carries this version's editors, even
      // though ORG_B could hold the same fingerprint independently.
      const orgBEditors = await db.definitionVersionEditor.findMany({
        where: {
          definitionVersion: { organizationId: ORG_B, definitionHash },
        },
      });
      expect(orgBEditors).toHaveLength(0);
    });
  });

  it("writes no editor lineage row when the caller has no user context (FEA-3982 skew-safe)", async () => {
    const content = "# Realdb Unattributed Skill\nno editor\n";
    let versionId = "";
    await withDb(async (db) => {
      versionId = await registerDefinitionVersion(db, {
        organizationId: ORG_A,
        componentKind: "skill",
        content,
        occurrenceType: SourceOccurrenceType.pack,
        packId: randomUUID(),
        // No editorUserId — a pack import carries pre-authored bytes.
      });
    });
    await withDb(async (db) => {
      const editors = await db.definitionVersionEditor.findMany({
        where: { definitionVersionId: versionId },
      });
      expect(editors).toHaveLength(0);
    });
  });

  it("serializes concurrent null-target provenance and preserves its observation window", async () => {
    const content = "# Concurrent Repository Evidence\n";
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-03-01T00:00:00.000Z");
    const definitionVersionId = await withDb((db) =>
      ensureDefinitionVersion(db, {
        organizationId: ORG_A,
        componentKind: "skill",
        content,
        observedAt: newer,
      })
    );

    await Promise.all([
      withDb((db) =>
        recordDefinitionSourceOccurrence(db, {
          organizationId: ORG_A,
          definitionVersionId,
          occurrenceType: SourceOccurrenceType.repository,
          accessState: SourceAccessState.inaccessible,
          computeTargetId: null,
          installPath: null,
          repoFullName: "closedloop-ai/symphony-alpha",
          repoPath: ".claude/skills/example/SKILL.md",
          repoCommit: "abc123",
          observedAt: older,
        })
      ),
      withDb((db) =>
        recordDefinitionSourceOccurrence(db, {
          organizationId: ORG_A,
          definitionVersionId,
          occurrenceType: SourceOccurrenceType.repository,
          accessState: SourceAccessState.accessible,
          computeTargetId: null,
          installPath: null,
          repoFullName: "closedloop-ai/symphony-alpha",
          repoPath: ".claude/skills/example/SKILL.md",
          repoCommit: "abc123",
          observedAt: newer,
        })
      ),
    ]);

    await withDb(async (db) => {
      const occurrences = await db.sourceOccurrence.findMany({
        where: {
          organizationId: ORG_A,
          definitionVersionId,
          occurrenceType: SourceOccurrenceType.repository,
          repoFullName: "closedloop-ai/symphony-alpha",
          repoPath: ".claude/skills/example/SKILL.md",
          repoCommit: "abc123",
          computeTargetId: null,
        },
      });
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]?.firstSeenAt).toEqual(older);
      expect(occurrences[0]?.lastSeenAt).toEqual(newer);
      expect(occurrences[0]?.accessState).toBe(SourceAccessState.accessible);
    });
  });

  it("pack (null compute target) occurrence: the atomic INSERT … ON CONFLICT dedupes an idempotent re-register to ONE row and writes one occurrence per distinct pack (FEA-3909)", async () => {
    const content = "# Realdb Pack Member\n\nreusable body.\n";
    const packA = randomUUID();
    const packB = randomUUID();
    const { definitionHash } = computeDefinitionHash({
      frontmatter: "",
      body: content,
      kind: "skill",
    });

    let versionId = "";
    await withDb(async (db) => {
      versionId = await registerDefinitionVersion(db, {
        organizationId: ORG_A,
        componentKind: "skill",
        content,
        occurrenceType: SourceOccurrenceType.pack,
        packId: packA,
      });
      const again = await registerDefinitionVersion(db, {
        organizationId: ORG_A,
        componentKind: "skill",
        content,
        occurrenceType: SourceOccurrenceType.pack,
        packId: packA,
      });
      expect(again).toBe(versionId);
      await registerDefinitionVersion(db, {
        organizationId: ORG_A,
        componentKind: "skill",
        content,
        occurrenceType: SourceOccurrenceType.pack,
        packId: packB,
      });
    });

    await withDb(async (db) => {
      const version = await db.definitionVersion.findUnique({
        where: {
          organizationId_definitionHash: {
            organizationId: ORG_A,
            definitionHash,
          },
        },
      });
      expect(version?.id).toBe(versionId);

      const occs = await db.sourceOccurrence.findMany({
        where: {
          organizationId: ORG_A,
          definitionVersionId: versionId,
          occurrenceType: SourceOccurrenceType.pack,
        },
        orderBy: { packId: "asc" },
      });
      expect(occs).toHaveLength(2);
      expect(occs.map((o) => o.packId).sort()).toEqual([packA, packB].sort());
      for (const occ of occs) {
        expect(occ.computeTargetId).toBeNull();
        expect(occ.repoFullName).toBe("");
        expect(occ.repoPath).toBe("");
        expect(occ.repoCommit).toBe("");
        expect(occ.localPath).toBe("");
      }
    });
  });
});

describe("desktopComponentsSyncService.sync (real Postgres)", () => {
  it("creates a DefinitionVersion + SourceOccurrence and stamps definition_version_id on the coarse version row; re-sync is idempotent", async () => {
    const content = "# Synced Skill\nbody\n";
    const contentHash = "synced-hash-1";
    const { definitionHash } = computeDefinitionHash({
      frontmatter: "",
      body: content,
      kind: "skill",
    });

    const payload = {
      schemaVersion: 1 as const,
      batchId: randomUUID(),
      syncMode: "incremental" as const,
      componentCount: 1,
      components: [
        {
          externalId: "skill::synced",
          componentKind: "skill",
          harness: "claude",
          name: "Synced Skill",
          componentKey: "synced",
          content,
          contentHash,
          installPath: ".claude/skills/synced/SKILL.md",
          firstSeenAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-10T00:00:00.000Z",
          scannedAt: "2026-01-10T00:00:00.000Z",
        },
      ],
    };

    const input = {
      clerkUserId: null,
      computeTargetId: TARGET_A,
      organizationId: ORG_A,
      userId: USER_A,
      payload: payload as never,
    };

    const first = await desktopComponentsSyncService.sync(input);
    expect(first.ok).toBe(true);
    // Idempotent re-sync.
    const second = await desktopComponentsSyncService.sync(input);
    expect(second.ok).toBe(true);

    await withDb(async (db) => {
      const version = await db.definitionVersion.findUnique({
        where: {
          organizationId_definitionHash: {
            organizationId: ORG_A,
            definitionHash,
          },
        },
      });
      expect(version).not.toBeNull();

      // The coarse version row carries the F1 link.
      const coarse = await db.agentComponentVersion.findUnique({
        where: {
          organizationId_componentKind_componentKey_source_contentHash: {
            organizationId: ORG_A,
            componentKind: "skill",
            componentKey: "synced",
            source: "",
            contentHash,
          },
        },
      });
      expect(coarse?.definitionVersionId).toBe(version?.id);

      // Exactly one occurrence despite two syncs (idempotent rescan, AC-6).
      const occs = await db.sourceOccurrence.findMany({
        where: { definitionVersionId: version?.id, organizationId: ORG_A },
      });
      expect(occs).toHaveLength(1);
      expect(occs[0]?.computeTargetId).toBe(TARGET_A);
      expect(occs[0]?.localPath).toBe(".claude/skills/synced/SKILL.md");
    });
  });

  it("does not register a version for a content-less component (older client stays unresolved)", async () => {
    const payload = {
      schemaVersion: 1 as const,
      batchId: randomUUID(),
      syncMode: "incremental" as const,
      componentCount: 1,
      components: [
        {
          externalId: "skill::no-content",
          componentKind: "skill",
          harness: "claude",
          name: "No Content",
          componentKey: "no-content",
          content: null,
          contentHash: null,
          lastSeenAt: "2026-01-10T00:00:00.000Z",
        },
      ],
    };

    const result = await desktopComponentsSyncService.sync({
      clerkUserId: null,
      computeTargetId: TARGET_A,
      organizationId: ORG_A,
      userId: USER_A,
      payload: payload as never,
    });
    expect(result.ok).toBe(true);

    await withDb(async (db) => {
      // The inventory existence row exists...
      const comp = await db.agentComponent.findFirst({
        where: {
          organizationId: ORG_A,
          externalComponentId: "skill::no-content",
        },
      });
      expect(comp).not.toBeNull();
      // ...but no coarse version row (no contentHash) and thus no F1 link.
      const coarse = await db.agentComponentVersion.findFirst({
        where: { organizationId: ORG_A, componentKey: "no-content" },
      });
      expect(coarse).toBeNull();
    });
  });
});
