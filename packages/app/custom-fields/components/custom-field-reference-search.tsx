"use client";

import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import type {
  CustomFieldReferenceSearchResponse,
  CustomFieldReferenceTarget,
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import { ReferenceTargetSource } from "@repo/api/src/types/custom-field";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useDebouncedValue } from "@repo/app/shared/hooks/use-debounced-value";
import { CUSTOM_FIELD_EDITOR_CONTRACTS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { Button } from "@repo/design-system/components/ui/button";
import { useEffect, useMemo, useState } from "react";

/**
 * The search half of a REFERENCE custom-field cell: the debounced query, the
 * load on open, the failure and retry, and which targets the field can hold.
 *
 * Shared by the legacy reference editor and the champion adapter
 * (`shared-reference-custom-field-cell.tsx`), so the two cannot disagree about
 * which targets a row is offered or what a failed load says.
 */
export function useCustomFieldReferenceSearch({
  field,
  loadOptions,
  open,
  options,
  ownerEntityId,
  value,
}: {
  field: CustomFieldWithOptions;
  loadOptions?: (query: string) => Promise<CustomFieldReferenceSearchResponse>;
  open: boolean;
  options: readonly CustomFieldReferenceTarget[];
  ownerEntityId: string;
  value?: CustomFieldValueDetail;
}) {
  const excludeOwner = useFeatureFlagEnabledOptional(
    CUSTOM_FIELD_EDITOR_CONTRACTS_FEATURE_FLAG_KEY
  );
  const [query, setQuery] = useState("");
  const [loadedOptions, setLoadedOptions] = useState<
    readonly CustomFieldReferenceTarget[]
  >([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const debouncedQuery = useDebouncedValue(query, 200);
  const searchRequest = useMemo(
    () => ({ query: debouncedQuery.trim(), retryToken }),
    [debouncedQuery, retryToken]
  );
  const normalizedQuery = query.trim().toLowerCase();
  const selectedOptions = (value?.referenceValues ?? []).filter((target) =>
    referenceTargetMatchesQuery(target, normalizedQuery)
  );
  const availableOptions = loadOptions
    ? mergeReferenceTargets(loadedOptions, selectedOptions)
    : options;
  const matchingOptions = availableOptions
    // ISS-8214: `resolveAndValidateReferenceTargets` rejects a target equal to
    // the owning entity, so listing this row could only ever produce a save the
    // API refuses.
    .filter((target) => !(excludeOwner && target.id === ownerEntityId))
    .filter((target) => referenceTargetMatchesField(field, target))
    .filter((target) => referenceTargetMatchesQuery(target, normalizedQuery));
  const isSearching =
    isLoading || (loadOptions !== undefined && query !== debouncedQuery);

  useEffect(() => {
    if (!(open && loadOptions)) {
      return;
    }
    let active = true;
    setIsLoading(true);
    setLoadError(false);
    setLoadedOptions([]);
    loadOptions(searchRequest.query)
      .then((result) => {
        if (!active) {
          return;
        }
        setLoadedOptions(result.targets);
        setHasMore(result.hasMore);
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setLoadError(true);
        setHasMore(false);
      })
      .finally(() => {
        if (active) {
          setIsLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [loadOptions, open, searchRequest]);

  return {
    hasMore,
    isSearching,
    loadError,
    matchingOptions,
    query,
    setQuery,
    /** What closing the editor forgets: the query and a failed load. */
    reset: () => {
      setQuery("");
      setLoadError(false);
    },
    retry: () => setRetryToken((current) => current + 1),
  };
}

/**
 * What the list says instead of offering targets: a failed load with its
 * retry, a load in flight, or nothing to offer. `null` when there are targets
 * to list.
 */
export function ReferenceSearchStatus({
  error,
  isLoading,
  onRetry,
  optionCount,
  query,
}: {
  error: boolean;
  isLoading: boolean;
  onRetry: () => void;
  optionCount: number;
  query: string;
}) {
  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
        <p className="text-destructive text-sm" role="alert">
          Couldn't load references.
        </p>
        <Button onClick={onRetry} size="sm" type="button" variant="outline">
          Retry
        </Button>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div
        className="px-3 py-8 text-center text-muted-foreground text-sm"
        role="status"
      >
        Loading references…
      </div>
    );
  }
  if (optionCount === 0) {
    return (
      <div
        className="px-3 py-8 text-center text-muted-foreground text-sm"
        role="status"
      >
        {query.trim() ? "No matching references" : "No references available"}
      </div>
    );
  }
  return null;
}

/** Said under a list the server cut short. */
export function ReferenceSearchMoreHint({ hasMore }: { hasMore: boolean }) {
  if (!hasMore) {
    return null;
  }
  return (
    <p className="px-2 py-2 text-muted-foreground text-xs" role="status">
      Keep typing to narrow results.
    </p>
  );
}

function referenceTargetMatchesField(
  field: CustomFieldWithOptions,
  target: CustomFieldReferenceTarget
): boolean {
  if (field.referenceTargetSources.includes(ReferenceTargetSource.Artifact)) {
    return true;
  }
  if (
    field.referenceTargetSources.includes(ReferenceTargetSource.Session) &&
    target.artifactType === ArtifactType.Session
  ) {
    return true;
  }
  if (
    field.referenceTargetSources.includes(ReferenceTargetSource.Branch) &&
    target.artifactType === ArtifactType.Branch
  ) {
    return true;
  }
  return (
    field.referenceTargetSources.includes(ReferenceTargetSource.Issue) &&
    target.artifactType === ArtifactType.Document &&
    target.subtype === ArtifactSubtype.Feature
  );
}

function referenceTargetMatchesQuery(
  target: CustomFieldReferenceTarget,
  normalizedQuery: string
): boolean {
  return `${target.slug ?? ""} ${target.name}`
    .toLowerCase()
    .includes(normalizedQuery);
}

function mergeReferenceTargets(
  options: readonly CustomFieldReferenceTarget[],
  selectedOptions: readonly CustomFieldReferenceTarget[]
): CustomFieldReferenceTarget[] {
  const merged = new Map(options.map((option) => [option.id, option]));
  for (const selectedOption of selectedOptions) {
    if (!merged.has(selectedOption.id)) {
      merged.set(selectedOption.id, selectedOption);
    }
  }
  return [...merged.values()];
}
