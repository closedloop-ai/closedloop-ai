"use client";

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import type {
  CreateCustomFieldInput,
  CustomFieldEnumOption,
  CustomFieldReferenceTarget,
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { formatCustomFieldDurationMs } from "@repo/api/src/types/custom-field-duration";
import type { BasicUser } from "@repo/api/src/types/user";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import type { CustomFieldTableValue } from "@repo/app/custom-fields/components/custom-field-table-cell";
import { DEFAULT_TABLE_PAGE_SIZE } from "@repo/design-system/components/ui/table-page-size-select";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { type ComponentProps, useCallback, useMemo, useState } from "react";
import { DEFAULT_DATE_RANGE } from "../../../shared/lib/format-utils";
import { DEFAULT_SESSION_FACET_FILTERS } from "../../lib/session-filter-adapter";
import {
  createFullyPopulatedSessionsUsageFixture,
  createSessionTableRowFixture,
} from "./session-list-fixtures";
import {
  hasSessionsCustomFieldSortColumn,
  type SessionsCustomFieldsController,
  sessionsCustomFieldColumnId,
  sortSessionsByCustomField,
  sortSessionsByStableId,
} from "./sessions-list-custom-fields";
import {
  defaultVisibleColumnIds,
  sortRows,
} from "./sessions-list-surface-rows";
import { SessionsListSurfaceV2 } from "./sessions-list-surface-v2";
import {
  matchesSessionsPreviewFacets,
  type SessionsPreviewFacetEvidence,
} from "./sessions-list-surface-v2-demo-facets";
import { SESSIONS_DEMO_CUSTOM_FIELD_SEEDS } from "./sessions-list-surface-v2-demo-fields";
import {
  isSessionsCustomFieldColumnId,
  resolveSessionsListSorts,
  type SessionsListViewState,
} from "./sessions-list-view-state";

export function SessionsListSurfaceV2Preview({
  facetEvidence,
  initialFavoriteIds,
  rows: seedRows,
  seedCustomFields = false,
  totalRows,
  usage,
  surfaceProps,
}: {
  /** Row evidence the Changes and Project facets read beyond the row itself. */
  facetEvidence?: SessionsPreviewFacetEvidence;
  initialFavoriteIds?: readonly string[];
  rows: readonly SessionTableRow[];
  /**
   * Starts the preview with {@link SESSIONS_DEMO_CUSTOM_FIELD_SEEDS} already
   * defined and valued on the first row, so the custom-field columns and their
   * cells are on screen without anyone opening Add field. Opt-in because the
   * `apps/prototypes` Sessions page shares this preview and documents the
   * surface WITHOUT them.
   */
  seedCustomFields?: boolean;
  totalRows: number;
  usage?: AgentSessionUsageSummary;
  surfaceProps?: Partial<ComponentProps<typeof SessionsListSurfaceV2>>;
}) {
  const { className = "h-screen", ...resolvedSurfaceProps } =
    surfaceProps ?? {};
  const allRows = useMemo(
    () => createDefaultStoryRows(seedRows, totalRows),
    [seedRows, totalRows]
  );
  const [pageSize, setPageSize] = useState(DEFAULT_TABLE_PAGE_SIZE);
  const [view, setView] = useState<SessionsListViewState>(() => ({
    dateRange: DEFAULT_DATE_RANGE,
    facets: DEFAULT_SESSION_FACET_FILTERS,
    grouping: EMPTY_TABLE_GROUPING,
    page: 0,
    scopeUserId: null,
    sortBy: null,
    sortDir: "asc",
    sorts: [],
    // A CONTROLLED view owns its own visible set, and the surface only folds in
    // custom-field columns it sees APPEAR after mount — so a seeded field has to
    // be listed here or its column never renders.
    visibleColumnIds: new Set([
      ...defaultVisibleColumnIds(new Map()),
      ...(seedCustomFields
        ? SESSIONS_DEMO_CUSTOM_FIELD_SEEDS.map((seed) =>
            sessionsCustomFieldColumnId(seed.field.id)
          )
        : []),
    ]),
  }));
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        initialFavoriteIds ??
          ([seedRows[0]?.id].filter(Boolean) as readonly string[])
      )
  );
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [fields, setFields] = useState<readonly CustomFieldWithOptions[]>(() =>
    seedCustomFields
      ? SESSIONS_DEMO_CUSTOM_FIELD_SEEDS.map((seed) => seed.field)
      : []
  );
  const [valuesBySessionId, setValuesBySessionId] = useState<
    ReadonlyMap<string, readonly CustomFieldValueDetail[]>
  >(() => (seedCustomFields ? createSeededValues(seedRows[0]?.id) : new Map()));

  const createField = useCallback(
    (input: CreateCustomFieldInput) => {
      const field = createStoryField(input, fields);
      setFields((current) => [...current, field]);
      return field;
    },
    [fields]
  );
  const updateValue = useCallback(
    (
      row: SessionTableRow,
      field: CustomFieldWithOptions,
      nextValue: CustomFieldTableValue
    ) => {
      setValuesBySessionId((current) =>
        updateStoryValue(current, row.id, field, nextValue)
      );
    },
    []
  );
  const customFields = useMemo<SessionsCustomFieldsController>(
    () => ({
      fields,
      onCreateField: createField,
      onValueChange: updateValue,
      peopleOptions: STORY_PEOPLE,
      referenceOptions: STORY_REFERENCES,
      valuesBySessionId,
    }),
    [createField, fields, updateValue, valuesBySessionId]
  );
  const favorites = useMemo(
    () => ({
      favoriteIds,
      onBulkChange: (rows: readonly SessionTableRow[], favorited: boolean) =>
        setFavoriteIds((current) =>
          setMembershipForRows(current, rows, favorited)
        ),
      onChange: (row: SessionTableRow, favorited: boolean) =>
        setFavoriteIds((current) => setMembership(current, row.id, favorited)),
    }),
    [favoriteIds]
  );
  const selection = useMemo(
    () => ({ selectedIds, onChange: setSelectedIds }),
    [selectedIds]
  );
  const matchingRows = useMemo(
    () =>
      allRows.filter((row) =>
        matchesSessionsPreviewFacets(row, view.facets, facetEvidence)
      ),
    [allRows, facetEvidence, view.facets]
  );
  // The Sessions card counts what the current filters matched, so it reads the
  // rows the facets kept rather than the fixture's fixed total.
  const matchedUsage = useMemo(
    () => usage && { ...usage, totalSessions: matchingRows.length },
    [matchingRows.length, usage]
  );
  const sortedRows = useMemo(() => {
    const sorts = resolveSessionsListSorts(view);
    const hasCustomFieldSort = sorts.some(
      (sort) =>
        isSessionsCustomFieldColumnId(sort.fieldId) &&
        hasSessionsCustomFieldSortColumn(customFields, sort.fieldId)
    );
    let next = hasCustomFieldSort
      ? sortSessionsByStableId(matchingRows)
      : [...matchingRows];
    for (let index = sorts.length - 1; index >= 0; index -= 1) {
      const sort = sorts[index];
      if (sort) {
        next = isSessionsCustomFieldColumnId(sort.fieldId)
          ? sortSessionsByCustomField(
              next,
              customFields,
              sort.fieldId,
              sort.direction,
              { preservePriorSortsOnTie: true }
            )
          : sortRows(next, sort.fieldId, sort.direction);
      }
    }
    return next;
  }, [customFields, matchingRows, view]);
  const pageRows = useMemo(() => {
    const start = view.page * pageSize;
    return sortedRows.slice(start, start + pageSize);
  }, [pageSize, sortedRows, view.page]);
  const controlledView = useMemo(
    () => ({
      onChange: setView,
      totalRows: sortedRows.length,
      value: view,
    }),
    [sortedRows.length, view]
  );

  return (
    <SessionsListSurfaceV2
      {...resolvedSurfaceProps}
      className={className}
      controlledView={controlledView}
      customFields={customFields}
      favorites={favorites}
      onPageSizeChange={setPageSize}
      pageSize={pageSize}
      rows={pageRows}
      selection={selection}
      usage={matchedUsage}
    />
  );
}

function createDefaultStoryRows(
  seedRows: readonly SessionTableRow[],
  totalRows: number
): SessionTableRow[] {
  return [
    ...seedRows,
    ...Array.from(
      { length: Math.max(0, totalRows - seedRows.length) },
      (_, index) => {
        const sessionNumber = index + seedRows.length + 1;
        return createSessionTableRowFixture({
          id: `ses-${sessionNumber}`,
          name: `session/default-page-${sessionNumber}`,
        });
      }
    ),
  ];
}

function setMembershipForRows(
  current: ReadonlySet<string>,
  rows: readonly SessionTableRow[],
  included: boolean
): ReadonlySet<string> {
  const next = new Set(current);
  for (const row of rows) {
    if (included) {
      next.add(row.id);
    } else {
      next.delete(row.id);
    }
  }
  return next;
}

function createStoryField(
  input: CreateCustomFieldInput,
  currentFields: readonly CustomFieldWithOptions[]
): CustomFieldWithOptions {
  const stem = input.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  let id = `story-${stem || "field"}`;
  let suffix = 2;
  const existingIds = new Set(currentFields.map((field) => field.id));
  while (existingIds.has(id)) {
    id = `story-${stem || "field"}-${suffix}`;
    suffix += 1;
  }
  const timestamp = new Date("2026-08-25T12:00:00.000Z");
  return {
    createdAt: timestamp,
    createdById: "story-user",
    currencyCode: input.currencyCode ?? null,
    customLabel: input.customLabel ?? null,
    customLabelPosition: input.customLabelPosition ?? null,
    description: input.description ?? null,
    entityTypes: input.entityTypes ?? [CustomFieldEntityType.Session],
    enumOptions: createEnumOptions(id, input),
    fieldType: input.fieldType,
    id,
    isGlobalToOrg: false,
    isSearchable: input.isSearchable ?? false,
    isSortable: input.isSortable ?? false,
    name: input.name,
    numberFormat: input.numberFormat ?? null,
    organizationId: "story-org",
    precision: input.precision ?? null,
    referenceTargetSources: input.referenceTargetSources ?? [],
    showInTable: input.showInTable ?? true,
    updatedAt: timestamp,
  };
}

function createEnumOptions(
  fieldId: string,
  input: CreateCustomFieldInput
): CustomFieldEnumOption[] {
  return (input.enumOptions ?? []).map((option, index) => ({
    color: option.color ?? "#64748b",
    customFieldId: fieldId,
    enabled: option.enabled ?? true,
    id: `${fieldId}-option-${index + 1}`,
    name: option.name,
    sortOrder: option.sortOrder ?? index,
  }));
}

function updateStoryValue(
  current: ReadonlyMap<string, readonly CustomFieldValueDetail[]>,
  sessionId: string,
  field: CustomFieldWithOptions,
  nextValue: CustomFieldTableValue
): ReadonlyMap<string, readonly CustomFieldValueDetail[]> {
  const next = new Map(current);
  const withoutField = (current.get(sessionId) ?? []).filter(
    (value) => value.customFieldId !== field.id
  );
  const detail = createValueDetail(sessionId, field, nextValue);
  next.set(sessionId, detail ? [...withoutField, detail] : withoutField);
  return next;
}

function createValueDetail(
  sessionId: string,
  field: CustomFieldWithOptions,
  value: CustomFieldTableValue
): CustomFieldValueDetail | null {
  if (value === null || (Array.isArray(value) && value.length === 0)) {
    return null;
  }
  const valueIds = Array.isArray(value) ? value : [String(value)];
  const enumValues = field.enumOptions.filter((option) =>
    valueIds.includes(option.id)
  );
  const peopleValues = STORY_PEOPLE.filter((person) =>
    valueIds.includes(person.id)
  );
  const referenceValues = STORY_REFERENCES.filter((target) =>
    valueIds.includes(target.id)
  );
  const numberValue = typeof value === "number" ? value : null;
  const textValue =
    field.fieldType === CustomFieldType.Text && typeof value === "string"
      ? value
      : null;
  const dateValue =
    field.fieldType === CustomFieldType.Date && typeof value === "string"
      ? new Date(`${value}T00:00:00.000Z`)
      : null;
  return {
    customFieldId: field.id,
    dateValue,
    displayValue: displayStoryValue(
      field,
      value,
      enumValues,
      peopleValues,
      referenceValues
    ),
    entityId: sessionId,
    enumValue:
      field.fieldType === CustomFieldType.Enum ? (enumValues[0] ?? null) : null,
    fieldType: field.fieldType,
    id: `${sessionId}-${field.id}`,
    multiEnumValues:
      field.fieldType === CustomFieldType.MultiEnum ? enumValues : [],
    name: field.name,
    numberValue,
    peopleValues,
    referenceValues,
    showInTable: field.showInTable,
    textValue,
  };
}

function displayStoryValue(
  field: CustomFieldWithOptions,
  value: CustomFieldTableValue,
  enumValues: readonly CustomFieldEnumOption[],
  peopleValues: readonly BasicUser[],
  referenceValues: readonly CustomFieldReferenceTarget[]
): string {
  if (
    field.fieldType === CustomFieldType.Number &&
    typeof value === "number" &&
    field.numberFormat === NumberFormat.Duration
  ) {
    return formatCustomFieldDurationMs(value);
  }
  if (field.fieldType === CustomFieldType.Number) {
    return String(value);
  }
  if (
    field.fieldType === CustomFieldType.Enum ||
    field.fieldType === CustomFieldType.MultiEnum
  ) {
    return enumValues.map((option) => option.name).join(", ");
  }
  if (field.fieldType === CustomFieldType.People) {
    return peopleValues.map(personName).join(", ");
  }
  if (
    field.fieldType === CustomFieldType.Reference ||
    field.fieldType === CustomFieldType.ReferenceMulti
  ) {
    return referenceValues
      .map((target) => target.slug ?? target.name)
      .join(", ");
  }
  return String(value);
}

function setMembership(
  current: ReadonlySet<string>,
  id: string,
  included: boolean
): ReadonlySet<string> {
  const next = new Set(current);
  if (included) {
    next.add(id);
  } else {
    next.delete(id);
  }
  return next;
}

function personName(person: BasicUser): string {
  return [person.firstName, person.lastName].filter(Boolean).join(" ");
}

const STORY_PEOPLE: readonly BasicUser[] = [
  {
    avatarUrl: null,
    email: "ottilie@closedloop.ai",
    firstName: "Ottilie",
    id: "user-ottilie",
    lastName: "Eye",
  },
  {
    avatarUrl: null,
    email: "pascoe@closedloop.ai",
    firstName: "Pascoe",
    id: "user-pascoe",
    lastName: "Birchall",
  },
];

const STORY_REFERENCES: readonly CustomFieldReferenceTarget[] = [
  {
    artifactType: ArtifactType.Document,
    id: "issue-grid",
    name: "Promote Grid Table v2",
    slug: "ISS-7052",
    status: "active",
    subtype: ArtifactSubtype.Feature,
  },
  {
    artifactType: ArtifactType.Branch,
    id: "branch-grid",
    name: "Grid Table v2 migration",
    slug: "BRN-grid-table-v2",
    status: "active",
    subtype: null,
  },
  {
    artifactType: ArtifactType.Session,
    id: "session-prototype",
    name: "Prototype generic artifact shells",
    slug: "SES-7B91",
    status: "inactive",
    subtype: null,
  },
];

export function createSessionsListSurfaceV2PreviewRow(
  overrides: Partial<SessionTableRow>
): SessionTableRow {
  return createSessionTableRowFixture(overrides);
}

function createSeededValues(
  firstSessionId: string | undefined
): ReadonlyMap<string, readonly CustomFieldValueDetail[]> {
  if (!firstSessionId) {
    return new Map();
  }
  return new Map([
    [
      firstSessionId,
      SESSIONS_DEMO_CUSTOM_FIELD_SEEDS.map((seed) =>
        createValueDetail(firstSessionId, seed.field, seed.value)
      ).filter((value): value is CustomFieldValueDetail => value !== null),
    ],
  ]);
}

export function createSessionsListSurfaceV2PreviewUsage(
  overrides: Partial<AgentSessionUsageSummary> = {}
): AgentSessionUsageSummary {
  return {
    ...createFullyPopulatedSessionsUsageFixture(),
    ...overrides,
  };
}
