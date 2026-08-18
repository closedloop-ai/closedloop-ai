/**
 * Shared fixtures for the customFieldValuesService suites.
 *
 * The value lane and the settings lane are tested in separate files but drive
 * the same `withDb` double, so the row builders and the db harness live here
 * rather than being copied into both.
 */
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import type { Mock } from "vitest";
import { vi } from "vitest";

export const TEST_ORG_ID = "org-111";
export const TEST_FIELD_ID = "field-abc";
export const TEST_ENTITY_ID = "feature-xyz";
export const TEST_OPTION_ID = "opt-1";

export type DbMocks = {
  projectFindFirst: Mock;
  artifactFindFirst: Mock;
  customFieldFindFirst: Mock;
  enumOptionFindFirst: Mock;
  enumOptionFindMany: Mock;
  userFindMany: Mock;
  valueUpsert: Mock;
  valueFindMany: Mock;
  valueDeleteMany: Mock;
  settingFindMany: Mock;
  settingDeleteMany: Mock;
};

/** Builds the Prisma field record (with enumOptions relation) returned from withDb. */
export function buildFieldRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_FIELD_ID,
    organizationId: TEST_ORG_ID,
    name: "Priority",
    description: null,
    fieldType: CustomFieldType.Enum,
    createdById: "user-1",
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-02"),
    precision: null,
    numberFormat: null,
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    isGlobalToOrg: false,
    enumOptions: [],
    ...overrides,
  };
}

/** Builds a CustomFieldValue row with the enumValue + customField relations the read projection needs. */
export function buildValueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cfv-1",
    customFieldId: TEST_FIELD_ID,
    organizationId: TEST_ORG_ID,
    entityType: CustomFieldEntityType.Document,
    entityId: TEST_ENTITY_ID,
    textValue: null,
    numberValue: null,
    dateValue: null,
    enumValueId: null,
    multiEnumValueIds: [],
    peopleValueIds: [],
    displayValue: "",
    enumValue: null,
    customField: {
      id: TEST_FIELD_ID,
      name: "Priority",
      fieldType: CustomFieldType.Text,
      showInTable: true,
      enumOptions: [],
    },
    ...overrides,
  };
}

/** Builds an enum option row. */
export function buildOption(
  id: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    customFieldId: TEST_FIELD_ID,
    name: id.toUpperCase(),
    color: "none",
    enabled: true,
    sortOrder: 0,
    ...overrides,
  };
}

/**
 * Installs a `withDb` implementation backed by one mutable db double and returns
 * its delegate mocks so a test can assert on the exact query it issued.
 *
 * Every `withDb` call in the service receives the same object, so ordering is
 * expressed by which delegate a step reaches for, not by call sequence.
 */
export function installDb(
  mockWithDb: Mock,
  overrides: Partial<DbMocks> = {}
): DbMocks {
  const mocks: DbMocks = {
    projectFindFirst: vi.fn().mockResolvedValue({ id: TEST_ENTITY_ID }),
    artifactFindFirst: vi.fn().mockResolvedValue({ id: TEST_ENTITY_ID }),
    customFieldFindFirst: vi.fn().mockResolvedValue(buildFieldRow()),
    enumOptionFindFirst: vi.fn().mockResolvedValue(null),
    enumOptionFindMany: vi.fn().mockResolvedValue([]),
    userFindMany: vi.fn().mockResolvedValue([]),
    valueUpsert: vi.fn().mockResolvedValue(buildValueRow()),
    valueFindMany: vi.fn().mockResolvedValue([]),
    valueDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    settingFindMany: vi.fn().mockResolvedValue([]),
    settingDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    ...overrides,
  };

  mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({
      project: { findFirst: mocks.projectFindFirst },
      artifact: { findFirst: mocks.artifactFindFirst },
      customField: { findFirst: mocks.customFieldFindFirst },
      customFieldEnumOption: {
        findFirst: mocks.enumOptionFindFirst,
        findMany: mocks.enumOptionFindMany,
      },
      customFieldValue: {
        upsert: mocks.valueUpsert,
        findMany: mocks.valueFindMany,
        deleteMany: mocks.valueDeleteMany,
      },
      customFieldSetting: {
        findMany: mocks.settingFindMany,
        deleteMany: mocks.settingDeleteMany,
      },
      user: { findMany: mocks.userFindMany },
    })
  );

  return mocks;
}

/** Returns the `create` payload the service handed to customFieldValue.upsert. */
export function upsertCreateArg(valueUpsert: Mock): Record<string, unknown> {
  return valueUpsert.mock.calls[0][0].create;
}

/** Builds the customField relation shape a CustomFieldSetting row carries. */
export function buildSettingFieldRelation() {
  return {
    ...buildFieldRow(),
    showInTable: true,
    isSearchable: false,
    isSortable: false,
    entityTypes: [],
  };
}
