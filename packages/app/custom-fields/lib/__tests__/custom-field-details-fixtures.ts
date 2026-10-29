import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import {
  CustomFieldEntityType,
  type CustomFieldEnumOption,
  type CustomFieldReferenceTarget,
  type CustomFieldType,
  type CustomFieldValueDetail,
  type CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import type { BasicUser } from "@repo/api/src/types/user";

/** ISS-12302 fixtures shared by the Details custom-field suites. */

export const ENTITY_ID = "55555555-5555-4555-8555-555555555551";

export function makeField(
  id: string,
  fieldType: CustomFieldType,
  extra: Partial<CustomFieldWithOptions> = {}
): CustomFieldWithOptions {
  return {
    createdAt: new Date("2026-10-01T00:00:00Z"),
    createdById: null,
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    description: null,
    entityTypes: [CustomFieldEntityType.Session],
    enumOptions: [],
    fieldType,
    id,
    isGlobalToOrg: true,
    isSearchable: false,
    isSortable: false,
    name: `Field ${id}`,
    numberFormat: null,
    organizationId: "org-1",
    precision: null,
    referenceTargetSources: [],
    showInTable: false,
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    ...extra,
  };
}

export function makeOption(
  customFieldId: string,
  id: string,
  name: string
): CustomFieldEnumOption {
  return {
    color: "blue",
    customFieldId,
    enabled: true,
    id,
    name,
    sortOrder: 0,
  };
}

export function makeValue(
  field: CustomFieldWithOptions,
  extra: Partial<CustomFieldValueDetail> = {}
): CustomFieldValueDetail {
  return {
    customFieldId: field.id,
    dateValue: null,
    displayValue: null,
    entityId: ENTITY_ID,
    enumValue: null,
    fieldType: field.fieldType,
    id: `value-${field.id}`,
    multiEnumValues: [],
    name: field.name,
    numberValue: null,
    peopleValues: [],
    referenceValues: [],
    showInTable: false,
    textValue: null,
    ...extra,
  };
}

export function makeUser(id: string, firstName: string): BasicUser {
  return {
    avatarUrl: null,
    email: `${id}@example.test`,
    firstName,
    id,
    lastName: null,
  };
}

/** A promise the test settles by hand, to hold a write or a read in flight. */
export function deferred<T = unknown>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

export function makeTarget(
  id: string,
  name: string
): CustomFieldReferenceTarget {
  return {
    artifactType: ArtifactType.Document,
    id,
    name,
    slug: null,
    status: "TODO",
    subtype: ArtifactSubtype.Feature,
  };
}
