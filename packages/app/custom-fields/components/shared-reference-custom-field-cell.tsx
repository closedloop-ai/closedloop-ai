"use client";

import type {
  CustomFieldReferenceSearchResponse,
  CustomFieldReferenceTarget,
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { InlineReferenceCell } from "@repo/design-system/components/ui/inline-reference-cell";
import { TableReferenceListCell } from "@repo/design-system/components/ui/table-cell-list-primitives";
import { useRef, useState } from "react";
import {
  ReferenceSearchMoreHint,
  ReferenceSearchStatus,
  useCustomFieldReferenceSearch,
} from "./custom-field-reference-search";
import type { CustomFieldTableValue } from "./custom-field-table-cell";

/**
 * PRD-722 (ISS-9349, ISS-12642): the REFERENCE and REFERENCE_MULTI
 * custom-field grid cells, rendered by the reference champion instead of the
 * hand-rolled popover in `custom-field-reference-table-cell.tsx`.
 *
 * Reached only through `CustomFieldTableCell`'s `gridview-adoption` gate. The
 * search (load on open, debounce, failure and retry, which targets the field
 * may hold, never the owning row) is the one `useCustomFieldReferenceSearch`
 * the legacy editor also reads. What changes is the commit: `onValueChange`
 * returns the host's mutation promise, and a refusal puts the confirmed
 * targets back on screen through the champion's ledger instead of being
 * swallowed while the picked target stays.
 *
 * A single reference commits its one id, or `null` for the clear (a
 * `deleteMany`, never an empty set); a multi reference commits the whole set.
 */
export function SharedReferenceCustomFieldCell({
  field,
  itemLabel,
  loadOptions,
  onValueChange,
  options = [],
  ownerEntityId,
  value,
}: {
  field: CustomFieldWithOptions;
  itemLabel: string;
  loadOptions?: (query: string) => Promise<CustomFieldReferenceSearchResponse>;
  onValueChange: (value: CustomFieldTableValue) => unknown;
  options?: readonly CustomFieldReferenceTarget[];
  ownerEntityId: string;
  value?: CustomFieldValueDetail;
}) {
  const [open, setOpen] = useState(false);
  const clearEnabled = useFeatureFlagEnabledOptional(
    CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY
  );
  const search = useCustomFieldReferenceSearch({
    field,
    loadOptions,
    open,
    options,
    ownerEntityId,
    value,
  });
  // Every target the list has offered while this cell lived, so an optimistic
  // pick (one still queued behind an earlier write, too) is named by what the
  // user saw before the host's refetch carries it, whatever the list shows now.
  const offeredRef = useRef<Map<string, CustomFieldReferenceTarget>>(new Map());
  rememberOffered(offeredRef.current, search.matchingOptions);
  const multiple = field.fieldType === CustomFieldType.ReferenceMulti;
  const stored = value?.referenceValues ?? [];
  const lookup = (id: string) =>
    stored.find((target) => target.id === id) ?? offeredRef.current.get(id);
  const nameOf = (id: string) => {
    const target = lookup(id);
    return target ? (target.slug ?? target.name) : id;
  };
  const showStatus =
    search.loadError ||
    search.isSearching ||
    search.matchingOptions.length === 0;

  return (
    <InlineReferenceCell
      clearLabel={clearEnabled && !multiple ? `Clear ${field.name}` : undefined}
      done={
        multiple
          ? { label: "Done", summary: (count) => `${count} selected` }
          : undefined
      }
      label={`${field.name} for ${itemLabel}`}
      listFooter={<ReferenceSearchMoreHint hasMore={search.hasMore} />}
      listStatus={
        showStatus ? (
          <ReferenceSearchStatus
            error={search.loadError}
            isLoading={search.isSearching}
            onRetry={search.retry}
            optionCount={search.matchingOptions.length}
            query={search.query}
          />
        ) : undefined
      }
      multiple={multiple}
      onCommit={(next) =>
        Promise.resolve(onValueChange(multiple ? [...next] : (next[0] ?? null)))
      }
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          search.reset();
        }
      }}
      onQueryChange={search.setQuery}
      options={search.matchingOptions.map((target) => ({
        value: target.id,
        label: target.slug ?? target.id,
        description: target.name,
      }))}
      primaryEditor
      query={search.query}
      renderValues={(shown) => (
        <TableReferenceListCell
          references={shown.map((id) => ({
            id,
            label: nameOf(id),
            tooltip: lookup(id)?.name ?? id,
          }))}
        />
      )}
      search={{
        label: `Search ${field.name} references`,
        placeholder: "Search references…",
      }}
      valueLabel={nameOf}
      values={stored.map((target) => target.id)}
    />
  );
}

/** Offered targets kept per cell; the oldest go first past this many. */
const OFFERED_TARGET_LIMIT = 500;

function rememberOffered(
  offered: Map<string, CustomFieldReferenceTarget>,
  targets: readonly CustomFieldReferenceTarget[]
): void {
  for (const target of targets) {
    offered.delete(target.id);
    offered.set(target.id, target);
  }
  for (const id of offered.keys()) {
    if (offered.size <= OFFERED_TARGET_LIMIT) {
      break;
    }
    offered.delete(id);
  }
}
