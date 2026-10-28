import {
  CustomFieldType,
  type CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CUSTOM_FIELD_FILTER_MAX_FACETS,
  CUSTOM_FIELD_FILTER_MAX_VALUES,
  CustomFieldFilterOperator,
  type CustomFieldFilter as CustomFieldQueryFilter,
} from "@repo/api/src/types/custom-field-list-query";
import { DocumentType } from "@repo/api/src/types/document";
// The custom-field column ids are owned by the documents slice that builds them.
import { documentCustomFieldColumnId } from "@repo/app/documents/components/documents-prototype-custom-fields";
import { getDocumentTypeLabel } from "@repo/app/documents/lib/document-navigation";
import type {
  ArtifactListColumnExtension,
  CustomFieldFilter,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-model";

/** The extension-column id the Documents index renders its Type facet under. */
export const DOCUMENT_TYPE_EXTENSION_COLUMN_ID = "document-type";

/**
 * ISS-12600: the extension-column filters the Documents index applies, as a
 * server scope — or `expressible: false` when one has no server predicate that
 * matches the list's client predicate (`matchesExtensionFilters`).
 *
 * The list compares DISPLAY LABELS, so only labels with an exact operand map:
 * the Type facet's labels map back through `getDocumentTypeLabel`; TEXT labels
 * are the stored text; ENUM and MULTI_ENUM labels are option names, mapped to
 * every option id carrying that name in the field definition. PEOPLE and
 * REFERENCE labels are resolved-on-read names with no id on the definition, and
 * NUMBER and DATE filter by a range the server facet vocabulary does not have,
 * so those stay unscoped. A filter on a column the list does not render is
 * ignored, exactly as `matchesExtensionFilters` ignores it.
 */
export function artifactExtensionFilterScope(
  extensionFilters: Readonly<Record<string, CustomFieldFilter>>,
  extensionColumns: readonly ArtifactListColumnExtension[],
  customFields: readonly CustomFieldWithOptions[]
): ExtensionFilterScope {
  const scope: ExtensionFilterScope = {
    expressible: true,
    customFieldFilters: [],
  };
  for (const [columnId, filter] of Object.entries(extensionFilters)) {
    if (
      !(
        isActive(filter) &&
        extensionColumns.some((column) => column.id === columnId)
      )
    ) {
      continue;
    }
    if (columnId === DOCUMENT_TYPE_EXTENSION_COLUMN_ID) {
      scope.types = documentTypesForLabels(filter);
      scope.expressible &&= scope.types !== undefined;
      continue;
    }
    const field = customFields.find(
      (candidate) => documentCustomFieldColumnId(candidate.id) === columnId
    );
    const facet = field ? customFieldFacet(field, filter) : undefined;
    if (facet) {
      scope.customFieldFilters.push(facet);
    } else {
      scope.expressible = false;
    }
  }
  if (scope.customFieldFilters.length > CUSTOM_FIELD_FILTER_MAX_FACETS) {
    scope.expressible = false;
  }
  return scope;
}

export type ExtensionFilterScope = {
  expressible: boolean;
  /** The Type facet's selection as persisted subtypes, when it is active. */
  types?: DocumentType[];
  customFieldFilters: CustomFieldQueryFilter[];
};

function isActive(filter: CustomFieldFilter): boolean {
  return Boolean(
    filter.selectedValues?.length ||
      filter.min !== undefined ||
      filter.max !== undefined
  );
}

function hasRange(filter: CustomFieldFilter): boolean {
  return filter.min !== undefined || filter.max !== undefined;
}

function documentTypesForLabels(
  filter: CustomFieldFilter
): DocumentType[] | undefined {
  const selected = filter.selectedValues ?? [];
  if (hasRange(filter) || selected.length === 0) {
    return undefined;
  }
  return Object.values(DocumentType).filter((type) => {
    const label = getDocumentTypeLabel(type);
    return label !== null && selected.includes(label);
  });
}

function customFieldFacet(
  field: CustomFieldWithOptions,
  filter: CustomFieldFilter
): CustomFieldQueryFilter | undefined {
  const selected = filter.selectedValues ?? [];
  const served =
    field.filterOperators?.includes(CustomFieldFilterOperator.IsAnyOf) ?? true;
  if (
    !(field.isSearchable && served) ||
    hasRange(filter) ||
    selected.length === 0
  ) {
    return undefined;
  }
  const values = facetOperands(field, selected);
  if (values.length === 0 || values.length > CUSTOM_FIELD_FILTER_MAX_VALUES) {
    return undefined;
  }
  return {
    fieldId: field.id,
    operator: CustomFieldFilterOperator.IsAnyOf,
    values,
  };
}

function facetOperands(
  field: CustomFieldWithOptions,
  selected: readonly string[]
): string[] {
  if (field.fieldType === CustomFieldType.Text) {
    return [...new Set(selected)].sort();
  }
  if (
    field.fieldType === CustomFieldType.Enum ||
    field.fieldType === CustomFieldType.MultiEnum
  ) {
    return field.enumOptions
      .filter((option) => selected.includes(option.name))
      .map((option) => option.id)
      .sort();
  }
  return [];
}
