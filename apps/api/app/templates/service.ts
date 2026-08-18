import {
  type Document,
  DocumentStatus,
  DocumentType,
  SnapshotSource,
} from "@repo/api/src/types/document";
import { ArtifactType, withDb } from "@repo/database";
import {
  documentIncludeWithUser,
  generateSlug,
  toDocument,
} from "@/app/documents/document-utils";
import { documentVersionService } from "@/app/documents/document-version-service";
import { PRD_TEMPLATE } from "@/app/documents/template-seeds";
import { getPrismaErrorCode } from "@/lib/db-utils";

// ISS-4532: bound the seed transaction. The advisory-lock wait — a blocked
// loser waits for the winner to COMMIT, not just to release a row lock — counts
// against Prisma's interactive-transaction timeout, so the 5s default risks a
// P2028 on a contended loser. Match the catalog pack-import / audit-append
// advisory-lock convention: 5s to acquire a pooled connection, 30s of work.
const SEED_TEMPLATE_TX_MAX_WAIT_MS = 5000;
const SEED_TEMPLATE_TX_TIMEOUT_MS = 30_000;

/**
 * Document templates service. Owns reads + lazy-creation of organization
 * templates (DOCUMENT artifacts with `subtype: TEMPLATE` + a `templateForType`
 * tag).
 *
 * Templates are org-level and carry no project (FEA-1749). They previously
 * lived on a hidden per-org "Templates" sentinel Project that existed for one
 * reason: to satisfy a DB CHECK requiring every non-SESSION artifact to have a
 * project. That constraint is gone, so the sentinel is gone with it — templates
 * are read by `document.templateForType`, never by project, so nothing looked
 * at that parent anyway.
 */

export const documentTemplatesService = {
  /**
   * Find the organization template for a specific document type. Returns
   * null if no template exists. Pure read — does NOT auto-create templates.
   */
  async findOrgTemplate(
    organizationId: string,
    templateForType: DocumentType
  ): Promise<Document | null> {
    const artifact = await withDb((db) =>
      db.artifact.findFirst({
        where: {
          type: ArtifactType.DOCUMENT,
          organizationId,
          document: { templateForType },
        },
        include: documentIncludeWithUser,
      })
    );
    if (!artifact) {
      return null;
    }
    return toDocument(artifact);
  },

  /**
   * Ensure default templates exist for an organization. Creates/upserts the
   * PRD template if missing.
   */
  async ensureDefaultTemplates(
    organizationId: string,
    userId: string
  ): Promise<void> {
    // ISS-4532 FAST PATH (steady state): a cheap pooled read that takes NO lock.
    // ensureDefaultTemplates runs on EVERY template GET; if the org's PRD
    // template AND its initial version already exist (the overwhelmingly common
    // case) we must return without opening a transaction or taking the advisory
    // lock. Serializing every reader on the xact lock would pin a pooled
    // connection per request under the lock and exhaust the pool (reviewer
    // pool-exhaustion concern). Only a request that actually needs seeding
    // falls through to the locked transaction below.
    const seeded = await withDb((db) =>
      db.documentDetail.findFirst({
        where: {
          templateForType: DocumentType.Prd,
          artifact: { organizationId, type: ArtifactType.DOCUMENT },
        },
        select: {
          artifactId: true,
          versions: { select: { id: true }, take: 1 },
        },
      })
    );
    if (seeded && seeded.versions.length > 0) {
      return;
    }

    // SEED PATH: the template or its initial version is missing. Seed inside ONE
    // transaction under a (org, templateForType) advisory lock. Lazy seeding is
    // racy — two first-access requests each ran a findFirst on a separate
    // connection, both missed, and both inserted, leaving duplicate PRD
    // templates and nondeterministic "the template for X" lookups. The
    // xact-scoped lock serializes concurrent seeders; the loser blocks until the
    // winner commits, then its in-lock re-check finds the row and skips the
    // create. Covers the template version too (getLatest→createVersion is the
    // same read-then-write shape). Nested withDb calls join this txn via
    // AsyncLocalStorage. Bounded {maxWait,timeout} so a lock-blocked loser fails
    // fast rather than tripping Prisma's 5s interactive-txn default (P2028).
    // The (org, templateForType) advisory-lock key — reused by BOTH the seed txn
    // and the P2002-recovery txn so they serialize on the same lock.
    const lockKey = `document:template-for-type:${organizationId}:${DocumentType.Prd}`;
    try {
      await withDb.tx(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))`;

          const existing = await tx.documentDetail.findFirst({
            where: {
              templateForType: DocumentType.Prd,
              artifact: { organizationId, type: ArtifactType.DOCUMENT },
            },
            select: { artifactId: true },
          });

          let templateId: string;
          if (existing) {
            templateId = existing.artifactId;
          } else {
            const created = await tx.artifact.create({
              data: {
                type: ArtifactType.DOCUMENT,
                subtype: DocumentType.Template,
                // ISS-4532: denormalize template_for_type onto the artifact so
                // the (organization_id, template_for_type) partial unique index
                // — the restored storage invariant — is populated for this row.
                templateForType: DocumentType.Prd,
                organizationId,
                // Org-level: templates have no project (FEA-1749).
                projectId: null,
                createdById: userId,
                name: "Product Requirements Document Template",
                slug: generateSlug(),
                status: DocumentStatus.Draft,
                document: {
                  create: {
                    templateForType: DocumentType.Prd,
                    latestVersion: 1,
                    // Templates aren't bound to a repo. Snapshot is required on
                    // DocumentDetail post-PLN-602.
                    repositorySnapshot: {
                      repositories: [],
                      source: SnapshotSource.None,
                    },
                  },
                },
              },
              select: { id: true },
            });
            templateId = created.id;
          }

          const existingVersion =
            await documentVersionService.getLatest(templateId);
          if (!existingVersion) {
            await documentVersionService.createVersion(
              templateId,
              organizationId,
              null,
              PRD_TEMPLATE
            );
          }
        },
        {
          maxWait: SEED_TEMPLATE_TX_MAX_WAIT_MS,
          timeout: SEED_TEMPLATE_TX_TIMEOUT_MS,
        }
      );
    } catch (error) {
      // ISS-4532: a P2002 here means a concurrent seeder that BYPASSED this
      // advisory lock — an old instance mid rolling-deploy, predating the lock —
      // won the restored (org, template_for_type) unique index. A P2002 ABORTS
      // the Postgres transaction, so recovery must NOT run on the same `tx` (it
      // would fail with 25P02, "current transaction is aborted"); the txn has
      // already rolled back by the time we're here (apps/api AGENTS.md: retry a
      // unique-race recovery after rollback in a fresh transaction, never inside
      // the failed one).
      if (getPrismaErrorCode(error) !== "P2002") {
        throw error;
      }
      // Recover in a FRESH transaction that REACQUIRES the same advisory lock,
      // so the version check/create serializes behind the winner's own seed
      // (which holds this lock while it creates the template AND its version).
      // Without the lock, this recovery could observe the winner's version as
      // absent — in the window between its artifact commit and its version
      // create — and both would call createVersion, which atomically increments
      // latestVersion, leaving two seeded versions (2 and 3).
      await withDb.tx(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))`;
          const winner = await tx.documentDetail.findFirst({
            where: {
              templateForType: DocumentType.Prd,
              artifact: { organizationId, type: ArtifactType.DOCUMENT },
            },
            select: { artifactId: true },
          });
          if (!winner) {
            // The unique-index winner must exist once its txn committed; if it
            // is somehow absent, surface the original P2002 rather than masking.
            throw error;
          }
          const existingVersion = await documentVersionService.getLatest(
            winner.artifactId
          );
          if (!existingVersion) {
            await documentVersionService.createVersion(
              winner.artifactId,
              organizationId,
              null,
              PRD_TEMPLATE
            );
          }
        },
        {
          maxWait: SEED_TEMPLATE_TX_MAX_WAIT_MS,
          timeout: SEED_TEMPLATE_TX_TIMEOUT_MS,
        }
      );
    }
  },
};
