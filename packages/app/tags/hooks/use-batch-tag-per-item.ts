"use client";

import {
  BATCH_ITEM_APPLIED_STATUS,
  BATCH_ITEM_FAILURE_MESSAGE,
  BatchItemFailureCode,
  batchItemApplied,
  batchMutationResponseSchema,
} from "@repo/api/src/types/batch-mutation-result";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { Status } from "@repo/api/src/types/result";
import type { BatchApplyTagInput } from "@repo/api/src/types/tag";
import {
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { z } from "zod";
import { invalidateTagWriteViewFamilies } from "../../documents/hooks/bulk-artifact-invalidation";
import { ApiError } from "../../shared/api/api-error";
import type { ApiClient } from "../../shared/api/create-api-client";
import { useApiClientOptional } from "../../shared/api/use-api-client-optional";
import { watchSignedInIdentity } from "../../shared/auth/signed-in-identity";
import {
  type MutationToastOptions,
  mutationToastMeta,
} from "../../shared/query/query-client";
import {
  BulkTagMutation,
  type BulkTagMutation as BulkTagMutationValue,
} from "../lib/bulk-tag-mutation";
import { toBatchMutationResponse } from "../lib/bulk-tag-outcome";

/** Shared per-item transport and invalidation for tag apply and removal. */
export function useBatchTagPerItem(
  operation: BulkTagMutationValue,
  additionalQueryClient?: QueryClient,
  options?: Readonly<MutationToastOptions>
) {
  const apiClient = useApiClientOptional();
  const queryClient = useQueryClient();
  const submissions = useRef(
    new WeakMap<BatchApplyTagInput, TagSubmissionIdentity>()
  ).current;
  const mutation = useMutation({
    meta: mutationToastMeta(options),
    mutationFn: (input: BatchApplyTagInput) =>
      mutateTagBatch(
        apiClient,
        input,
        operation,
        submissions.get(input)?.isCurrent
      ),
    onMutate: (input) => ({
      queryClient,
      additionalQueryClient,
      identity: submissions.get(input),
    }),
    onSuccess: (response, _input, context) => {
      const hasConfirmedItem = response.results.some(
        (result) => result.status === BATCH_ITEM_APPLIED_STATUS
      );
      if (!(context?.identity?.isCurrent() && hasConfirmedItem)) {
        return;
      }
      invalidateTagWriteViewFamilies(context.queryClient);
      if (
        context.additionalQueryClient &&
        context.additionalQueryClient !== context.queryClient
      ) {
        invalidateTagWriteViewFamilies(context.additionalQueryClient);
      }
    },
    onSettled: (_response, _error, _input, context) => {
      context?.identity?.dispose();
    },
  });
  const mutate: typeof mutation.mutate = useCallback(
    (input, mutationOptions) =>
      mutation.mutate(
        captureTagSubmission(input, submissions),
        mutationOptions
      ),
    [mutation.mutate, submissions]
  );
  const mutateAsync: typeof mutation.mutateAsync = useCallback(
    (input, mutationOptions) =>
      mutation.mutateAsync(
        captureTagSubmission(input, submissions),
        mutationOptions
      ),
    [mutation.mutateAsync, submissions]
  );
  return { ...mutation, mutate, mutateAsync };
}

async function mutateTagBatch(
  apiClient: ApiClient | null,
  input: BatchApplyTagInput,
  operation: BulkTagMutationValue,
  isCurrent: (() => boolean) | undefined
) {
  if (!(apiClient && isCurrent?.())) {
    throw unknownTagOutcome();
  }
  if (operation === BulkTagMutation.Remove) {
    return parseBatchResponse(
      await apiClient.post<unknown>(
        `${BatchMutationRoute.EntityTagsRemove}/v2`,
        input
      )
    );
  }
  try {
    return parseBatchResponse(
      await apiClient.post<unknown>(
        `${BatchMutationRoute.EntityTags}/v2`,
        input
      )
    );
  } catch (error) {
    if (!(error instanceof ApiError && error.isNotFound())) {
      throw error;
    }
    if (!isCurrent()) {
      throw unknownTagOutcome();
    }
    const legacy = await apiClient.post<unknown>(
      BatchMutationRoute.EntityTags,
      input
    );
    const parsed = legacyTagReceiptSchema.safeParse(legacy);
    if (
      !parsed.success ||
      parsed.data.appliedCount > new Set(input.entityIds).size
    ) {
      throw unknownTagOutcome();
    }
    return { results: [...new Set(input.entityIds)].map(batchItemApplied) };
  }
}

function parseBatchResponse(wire: unknown) {
  const parsed = batchMutationResponseSchema.safeParse(wire);
  if (!parsed.success) {
    throw unknownTagOutcome();
  }
  return toBatchMutationResponse(parsed.data);
}

function unknownTagOutcome(): ApiError {
  return new ApiError(
    BATCH_ITEM_FAILURE_MESSAGE[BatchItemFailureCode.OutcomeUnknown],
    Status.Error
  );
}

function captureTagSubmission(
  input: BatchApplyTagInput,
  submissions: WeakMap<BatchApplyTagInput, TagSubmissionIdentity>
): BatchApplyTagInput {
  const submitted = { ...input, entityIds: [...input.entityIds] };
  submissions.set(submitted, watchSignedInIdentity());
  return submitted;
}

const legacyTagReceiptSchema = z.object({
  appliedCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

type TagSubmissionIdentity = ReturnType<typeof watchSignedInIdentity>;
