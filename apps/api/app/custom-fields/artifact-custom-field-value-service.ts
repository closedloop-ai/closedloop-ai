import "server-only";

import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
  type ArtifactFieldEditReceiptContext,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import type {
  CustomFieldEntityType,
  CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import type { Result } from "@repo/api/src/types/result";
import { type TransactionClient, withDb } from "@repo/database";
import type { ActivityActor } from "@/lib/artifact-activity-capture";
import { captureArtifactFieldEditAnalytics } from "@/lib/artifact-field-edit-analytics";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import {
  type ArtifactCustomFieldValueError,
  ArtifactCustomFieldValueErrorKind,
} from "./artifact-custom-field-value-contract";
import {
  customFieldValueFingerprint,
  readCustomFieldValueFingerprint,
} from "./custom-field-value-fingerprint";
import { InvalidReferenceTargetError } from "./reference-targets";
import { customFieldValuesService } from "./values-service";

export type ArtifactCustomFieldEntityType = Exclude<
  CustomFieldEntityType,
  typeof CustomFieldEntityType.Project
>;

export type ArtifactCustomFieldWriteContext = {
  actor: ActivityActor;
  receipt?: ArtifactFieldEditReceiptContext;
  /**
   * Set when the write joins a caller's transaction: the analytics event is
   * handed here so the caller emits it only after that transaction commits.
   */
  deferEffect?: (effect: () => void) => void;
};

/** A set value, and whether its stored value moved. */
export type ArtifactCustomFieldSetOutcome = {
  value: CustomFieldValueDetail;
  changed: boolean;
};

type SetArtifactCustomFieldValueParams = {
  fieldId: string;
  entityType: ArtifactCustomFieldEntityType;
  entityId: string;
  organizationId: string;
  rawValue: string | number | string[];
  context: ArtifactCustomFieldWriteContext;
};

type ClearArtifactCustomFieldValueParams = {
  fieldId: string;
  entityType: ArtifactCustomFieldEntityType;
  entityId: string;
  organizationId: string;
  context: ArtifactCustomFieldWriteContext;
};

/** Owns atomic artifact custom-field mutations and their value-safe analytics. */
export const artifactCustomFieldValueService = {
  async set(
    params: SetArtifactCustomFieldValueParams,
    /** Runs on the value write's transaction once it stored (ISS-12552). */
    recordWrite?: RecordWriteInTransaction<{ changed: boolean }>
  ): Promise<
    Result<ArtifactCustomFieldSetOutcome, ArtifactCustomFieldValueError>
  > {
    let write: Awaited<ReturnType<typeof writeArtifactCustomFieldValue>>;
    try {
      write = await writeArtifactCustomFieldValue(params, recordWrite);
    } catch (error) {
      // The reference-row FK race is classified only after `withDb.tx` rejects,
      // so the value upsert has rolled back before the caller receives a 400.
      if (error instanceof InvalidReferenceTargetError) {
        return {
          ok: false,
          error: {
            kind: ArtifactCustomFieldValueErrorKind.InvalidValue,
            message: error.message,
          },
        };
      }
      throw error;
    }
    if (!write.ok) {
      return write;
    }
    const outcome = write.value;
    emitCustomFieldAnalytics(
      params,
      outcome.changed,
      outcome.beforePresent,
      true
    );
    return {
      ok: true,
      value: { value: outcome.value, changed: outcome.changed },
    };
  },

  /** Clear one artifact custom field and report whether a value was removed. */
  async clear(
    params: ClearArtifactCustomFieldValueParams,
    /**
     * Runs on the clear's transaction when the artifact is the caller's
     * (ISS-12552); clearing on an unknown artifact writes nothing.
     */
    recordWrite?: RecordWriteInTransaction<{ changed: boolean }>
  ): Promise<{ changed: boolean }> {
    const changed = await withDb.tx(async (tx) => {
      const found = await lockArtifact(
        tx,
        params.entityId,
        params.organizationId
      );
      const before = await readCustomFieldValueFingerprint(tx, params);
      const deletedCount =
        await customFieldValuesService.clearValueInTransaction(
          tx,
          params.fieldId,
          params.entityType,
          params.entityId,
          params.organizationId
        );
      if (found) {
        await recordWrite?.(tx, { changed: deletedCount > 0 });
      }
      return { changed: deletedCount > 0, beforePresent: before !== null };
    });
    emitCustomFieldAnalytics(
      params,
      changed.changed,
      changed.beforePresent,
      false
    );
    return { changed: changed.changed };
  },
};

function writeArtifactCustomFieldValue(
  params: SetArtifactCustomFieldValueParams,
  recordWrite: RecordWriteInTransaction<{ changed: boolean }> | undefined
) {
  return withDb.tx(async (tx) => {
    await lockArtifact(tx, params.entityId, params.organizationId);
    const before = await readCustomFieldValueFingerprint(tx, params);
    const valueResult =
      await customFieldValuesService.setValueForEntityInTransaction(
        tx,
        params.fieldId,
        params.entityType,
        params.entityId,
        params.organizationId,
        params.rawValue
      );
    if (!valueResult.ok) {
      return valueResult;
    }
    const after = await readCustomFieldValueFingerprint(tx, params);
    const changed =
      customFieldValueFingerprint(before) !==
      customFieldValueFingerprint(after);
    await recordWrite?.(tx, { changed });
    return {
      ok: true as const,
      value: {
        value: valueResult.value,
        changed,
        beforePresent: before !== null,
      },
    };
  });
}

async function lockArtifact(
  tx: TransactionClient,
  entityId: string,
  organizationId: string
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
      FROM "artifacts"
     WHERE "id" = ${entityId}::uuid
       AND "organization_id" = ${organizationId}::uuid
     FOR UPDATE`;
  return rows.length > 0;
}

function emitCustomFieldAnalytics(
  params: {
    organizationId: string;
    context: ArtifactCustomFieldWriteContext;
  },
  changed: boolean,
  beforePresent: boolean,
  afterPresent: boolean
): void {
  const emit = () =>
    captureArtifactFieldEditAnalytics({
      organizationId: params.organizationId,
      userId: params.context.actor.userId,
      field: ArtifactFieldEditField.CustomField,
      result: changed
        ? ArtifactFieldEditOutcome.Committed
        : ArtifactFieldEditOutcome.NoChange,
      artifactCount: 1,
      before: beforePresent ? "present" : null,
      after: afterPresent ? "present" : null,
      provenance: params.context.receipt?.provenance,
    });
  if (params.context.deferEffect) {
    params.context.deferEffect(emit);
    return;
  }
  emit();
}
