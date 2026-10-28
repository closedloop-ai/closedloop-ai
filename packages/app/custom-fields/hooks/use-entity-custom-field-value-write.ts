"use client";

import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type {
  CustomFieldEntityType,
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import type { CustomFieldTableValue } from "../components/custom-field-table-cell";
import {
  applyOptimisticCustomFieldValue,
  type OptimisticCustomFieldLookups,
} from "../lib/optimistic-custom-field-value";
import {
  beginCustomFieldValueWrite,
  customFieldKeys,
  endCustomFieldValueWrite,
  putCustomFieldValue,
} from "./use-custom-fields";

export type EntityCustomFieldValueWrite = (
  field: CustomFieldWithOptions,
  next: CustomFieldTableValue,
  lookups: Omit<OptimisticCustomFieldLookups, "entityId">
) => Promise<unknown>;

type FieldWrites = {
  /** The value the newest successful write left, or the read's before any. */
  confirmed: CustomFieldValueDetail | undefined;
  confirmedWrite: number;
  latest: number;
  pending: number;
};

/**
 * The menu-based custom-field editors' write on the Details tab (ISS-12302):
 * shows the choice at once, then PUTs it.
 *
 * - Writes run in click order, one after another, because each PUT carries
 *   the whole value and two in flight would be decided by arrival order (the
 *   `valueWriteChain` of `useSessionsCustomFieldsController`).
 * - The values are read again only once no write is queued on the entity,
 *   by this hook or a typed editor's `useUpdateCustomFieldValue`: a read that
 *   lands between two queued writes would replace the later one's shown
 *   choice, and the multi-value menus build their next whole value from it.
 * - Each write goes to the entity it was made on, even if the hook has
 *   since moved to another.
 * - A refused write puts back the last value a write confirmed, and only when
 *   it is that field's newest write, so an earlier failure never undoes a
 *   later choice.
 * - The returned promise rejects with the refusal, so the cell's own commit
 *   ledger sees it. The shared QueryClient's mutation toast reports it; no
 *   second toast here.
 */
export function useEntityCustomFieldValueWrite(
  entityType: CustomFieldEntityType,
  entityId: string,
  surface?: ArtifactStatusEditSurface
): EntityCustomFieldValueWrite {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();
  const { mutateAsync } = useMutation({
    mutationFn: (write: {
      entityId: string;
      entityType: CustomFieldEntityType;
      fieldId: string;
      value: CustomFieldTableValue;
    }) =>
      putCustomFieldValue(
        apiClient,
        write.entityType,
        write.entityId,
        write.fieldId,
        write.value,
        surface
      ),
  });
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  // Entries leave when their last pending write settles, so this holds at
  // most the fields with a write in flight.
  const writes = useRef(new Map<string, FieldWrites>());

  return useCallback(
    async (field, next, lookups) => {
      const queryKey = customFieldKeys.values(entityType, entityId);
      const ledgerKey = `${entityType}:${entityId}:${field.id}`;
      const readField = () =>
        queryClient
          .getQueryData<readonly CustomFieldValueDetail[]>(queryKey)
          ?.find((value) => value.customFieldId === field.id);
      const entry = writes.current.get(ledgerKey) ?? {
        confirmed: readField(),
        confirmedWrite: 0,
        latest: 0,
        pending: 0,
      };
      writes.current.set(ledgerKey, entry);
      entry.latest += 1;
      entry.pending += 1;
      beginCustomFieldValueWrite(queryClient, entityType, entityId);
      const write = entry.latest;

      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData<readonly CustomFieldValueDetail[]>(
        queryKey,
        (current) =>
          current &&
          (applyOptimisticCustomFieldValue(current, field, next, {
            ...lookups,
            entityId,
          }) ??
            current)
      );
      const written = readField();

      const run = chain.current.then(() =>
        mutateAsync({ entityId, entityType, fieldId: field.id, value: next })
      );
      chain.current = run.catch(() => undefined);
      try {
        const result = await run;
        if (write > entry.confirmedWrite) {
          entry.confirmedWrite = write;
          entry.confirmed = written;
        }
        return result;
      } catch (error) {
        if (write === entry.latest) {
          queryClient.setQueryData<readonly CustomFieldValueDetail[]>(
            queryKey,
            (current) =>
              current && withFieldValue(current, field.id, entry.confirmed)
          );
        }
        throw error;
      } finally {
        entry.pending -= 1;
        if (entry.pending === 0) {
          writes.current.delete(ledgerKey);
        }
        endCustomFieldValueWrite(queryClient, entityType, entityId);
      }
    },
    [entityId, entityType, mutateAsync, queryClient]
  );
}

function withFieldValue(
  values: readonly CustomFieldValueDetail[],
  fieldId: string,
  value: CustomFieldValueDetail | undefined
): CustomFieldValueDetail[] {
  const others = values.filter((entry) => entry.customFieldId !== fieldId);
  return value ? [...others, value] : others;
}
