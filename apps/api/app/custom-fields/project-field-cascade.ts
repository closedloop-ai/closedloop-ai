import type { AttachCustomFieldInput } from "@repo/api/src/types/custom-field";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { ArtifactSubtype, ArtifactType, Prisma, withDb } from "@repo/database";
import { getPrismaErrorCode } from "@/lib/db-utils";

type CascadeInput = {
  fieldId: string;
  organizationId: string;
  projectId: string;
  input: AttachCustomFieldInput;
};

/** Maximum child settings written by one project-cascade statement. */
export const CASCADE_CHILD_BATCH_SIZE = 1000;

/** Transaction budget for the serial project child-setting cascade. */
export const CASCADE_TX_TIMEOUT_MS = 30_000;

/** Total attach attempts after retryable serialization conflicts. */
export const ATTACH_TX_MAX_ATTEMPTS = 3;

const PRISMA_WRITE_CONFLICT_CODE = "P2034";

/** Owns the bounded, repeatable-read project custom-field cascade. */
export const customFieldProjectCascade = {
  async runTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    let attempt = 1;
    for (;;) {
      try {
        return await withDb.tx(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          timeout: CASCADE_TX_TIMEOUT_MS,
        });
      } catch (error) {
        const isRetryable =
          getPrismaErrorCode(error) === PRISMA_WRITE_CONFLICT_CODE;
        if (!isRetryable || attempt >= ATTACH_TX_MAX_ATTEMPTS) {
          throw error;
        }
        attempt += 1;
      }
    }
  },

  /** Cascade a project attachment to feature-typed document children only. */
  async attachToChildren(
    tx: Prisma.TransactionClient,
    { fieldId, organizationId, projectId, input }: CascadeInput
  ): Promise<void> {
    const defaults = {
      customFieldId: fieldId,
      organizationId,
      isImportant: input.isImportant ?? false,
      isRequired: input.isRequired ?? false,
      sortOrder: input.sortOrder ?? 0,
      entityType: CustomFieldEntityType.Document,
    };

    let cursorId: string | undefined;
    for (;;) {
      const childFeatureDocuments = await tx.artifact.findMany({
        where: {
          projectId,
          organizationId,
          type: ArtifactType.DOCUMENT,
          subtype: ArtifactSubtype.FEATURE,
          ...(cursorId ? { id: { gt: cursorId } } : {}),
        },
        select: { id: true },
        orderBy: { id: "asc" },
        take: CASCADE_CHILD_BATCH_SIZE,
      });

      if (childFeatureDocuments.length === 0) {
        return;
      }

      const childSettingsData: Prisma.CustomFieldSettingCreateManyInput[] =
        childFeatureDocuments.map((document) => ({
          ...defaults,
          entityId: document.id,
        }));
      await tx.customFieldSetting.createMany({
        data: childSettingsData,
        skipDuplicates: true,
      });

      if (childFeatureDocuments.length < CASCADE_CHILD_BATCH_SIZE) {
        return;
      }
      cursorId = childFeatureDocuments.at(-1)?.id;
      if (!cursorId) {
        return;
      }
    }
  },
};
