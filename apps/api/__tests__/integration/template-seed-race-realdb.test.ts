/**
 * ISS-4532 real-Postgres integration proof for the template-seed race.
 *
 * The bug: `documentTemplatesService.ensureDefaultTemplates` lazily seeds the
 * org PRD template on first template access. Two concurrent first-access
 * requests each ran a findFirst on a separate pooled connection, both missed,
 * and both inserted — leaving DUPLICATE PRD templates once the storage-enforced
 * `(organization_id, template_for_type)` unique index was dropped in
 * 20260212212450.
 *
 * This test drives the real contention: TWO concurrent, TOP-LEVEL
 * `ensureDefaultTemplates` calls against a REAL Postgres, then asserts exactly
 * ONE PRD template artifact and ONE initial version survive. It deliberately
 * does NOT run inside an auto-rollback / ALS transaction wrapper — that ambient
 * transaction would make both `withDb.tx` calls JOIN one connection, erasing
 * the very cross-connection contention this test exists to reproduce.
 *
 * Not included by the default vitest config. Run with a real DATABASE_URL:
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/app \
 *     pnpm --filter api test:integration \
 *     __tests__/integration/template-seed-race-realdb.test.ts
 *
 * All rows are namespaced under one unique org and cleaned up in afterAll (org
 * delete cascades to artifacts → document_detail → document_versions).
 */
import { randomUUID } from "node:crypto";
import { DocumentType } from "@repo/api/src/types/document";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentTemplatesService } from "../../app/templates/service";

// Skip when no DATABASE_URL is configured (mirrors the other integration suites).
const env = keys();
const hasDatabase = !!env.DATABASE_URL;

// One unique org per run so parallel/leftover data can never collide.
const ORG_ID = randomUUID();
const USER_ID = randomUUID();

describe.skipIf(!hasDatabase)(
  "ISS-4532 ensureDefaultTemplates concurrency against REAL Postgres",
  () => {
    // beforeAll/afterAll live INSIDE the gated describe so they never touch the
    // DB when the suite is skipped (no DATABASE_URL).
    beforeAll(async () => {
      await withDb(async (db) => {
        await db.organization.create({
          data: {
            id: ORG_ID,
            clerkId: `clerk_org_${ORG_ID}`,
            name: "ISS-4532 Seed Race Org",
            slug: `iss4532-seed-race-${ORG_ID}`,
          },
        });
        await db.user.create({
          data: {
            id: USER_ID,
            organizationId: ORG_ID,
            clerkId: `clerk_user_${USER_ID}`,
            email: "seed.race@example.com",
            firstName: "Seed",
            lastName: "Race",
          },
        });
      });
    });

    afterAll(async () => {
      await withDb(async (db) => {
        // Org delete cascades to artifacts → document_detail → document_versions.
        await db.artifact.deleteMany({ where: { organizationId: ORG_ID } });
        await db.user.deleteMany({ where: { organizationId: ORG_ID } });
        await db.organization.deleteMany({ where: { id: ORG_ID } });
      });
    });

    it("two concurrent top-level seeders leave exactly ONE PRD template + ONE initial version", async () => {
      // Real contention: two independent top-level calls, each opening its own
      // withDb.tx on its own pooled connection under the (org, PRD) advisory
      // lock. The winner seeds; the loser blocks until commit, then its in-lock
      // re-check reuses the row. The partial unique index is the backstop.
      const results = await Promise.allSettled([
        documentTemplatesService.ensureDefaultTemplates(ORG_ID, USER_ID),
        documentTemplatesService.ensureDefaultTemplates(ORG_ID, USER_ID),
      ]);

      // Neither call should throw — the loser serializes, it does not error.
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toEqual([]);

      // Exactly one PRD template artifact, with the denormalized column set.
      const templates = await withDb((db) =>
        db.artifact.findMany({
          where: {
            organizationId: ORG_ID,
            type: ArtifactType.DOCUMENT,
            subtype: DocumentType.Template,
            templateForType: DocumentType.Prd,
          },
          select: { id: true, templateForType: true },
        })
      );
      expect(templates).toHaveLength(1);
      expect(templates[0].templateForType).toBe(DocumentType.Prd);

      // Its document_detail also reflects exactly one PRD template.
      const details = await withDb((db) =>
        db.documentDetail.findMany({
          where: {
            templateForType: DocumentType.Prd,
            artifact: { organizationId: ORG_ID, type: ArtifactType.DOCUMENT },
          },
          select: { artifactId: true },
        })
      );
      expect(details).toHaveLength(1);
      expect(details[0].artifactId).toBe(templates[0].id);

      // Exactly ONE initial version was seeded for that template — this is the
      // ISS-4532 invariant the concurrency must preserve. The version NUMBER is
      // 2, not 1: the template is created with documentDetail.latestVersion = 1
      // (a placeholder, no version row), then createVersion increments
      // latestVersion 1→2 and inserts version 2 as the sole seeded content.
      const versions = await withDb((db) =>
        db.documentVersion.findMany({
          where: { documentId: templates[0].id },
          select: { id: true, version: true },
        })
      );
      expect(versions).toHaveLength(1);
      expect(versions[0].version).toBe(2);
    });

    it("the restored partial unique index rejects a second (org, PRD) template", async () => {
      // Direct proof of the storage invariant: a second TEMPLATE artifact with
      // template_for_type = PRD for the same org must violate
      // artifacts_org_template_for_type_key.
      await expect(
        withDb((db) =>
          db.artifact.create({
            data: {
              organizationId: ORG_ID,
              type: ArtifactType.DOCUMENT,
              subtype: DocumentType.Template,
              templateForType: DocumentType.Prd,
              projectId: null,
              createdById: USER_ID,
              name: "Duplicate PRD Template",
              slug: `dup-prd-${randomUUID()}`,
              status: "DRAFT",
            },
          })
        )
      ).rejects.toThrow();
    });
  }
);
