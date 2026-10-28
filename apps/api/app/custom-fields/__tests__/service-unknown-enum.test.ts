import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { CustomFieldQueryRejection } from "@repo/api/src/types/custom-field-list-query";
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { customFieldsService } from "../service";
import {
  CUSTOM_FIELD_UNREADABLE_OMITTED_EVENT,
  customFieldUnreadableThrottle,
} from "../unreadable-field-telemetry";

/**
 * ISS-11071: `GET /custom-fields` degrades when one row holds an enum value this
 * build's client cannot map, and ONLY for that P2023. The real-runtime half is
 * `find-by-org-unknown-enum.integration.test.ts`.
 */

vi.mock("@repo/database", () => ({ withDb: vi.fn() }));

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock("@repo/observability/log", () => ({
  log: { error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const ORG_ID = "org-11071";
const READABLE_ID = "field-readable";
const UNREADABLE_ID = "field-unreadable";

/** Prisma 7's data-mapper code and message shape, as the realdb suite observed it. */
function unknownEnumError(): Error {
  return Object.assign(
    new Error(
      "\nInvalid `db.customField.findFirst()` invocation in\n/app/service.ts:1:1\n\nValue 'FORMULA' not found in enum 'CustomFieldType'"
    ),
    { code: "P2023" }
  );
}

function malformedUuidError(): Error {
  return Object.assign(new Error("Inconsistent column data: Malformed UUID"), {
    code: "P2023",
  });
}

function fieldRow(id: string) {
  return {
    id,
    organizationId: ORG_ID,
    name: id,
    description: null,
    fieldType: CustomFieldType.Text,
    createdById: null,
    createdAt: new Date("2026-09-01"),
    updatedAt: new Date("2026-09-01"),
    precision: null,
    numberFormat: null,
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    isGlobalToOrg: true,
    entityTypes: [],
    referenceTargetSources: [],
    showInTable: false,
    isSearchable: false,
    isSortable: false,
    enumOptions: [],
  };
}

/**
 * Installs a db double: the list read fails with `listError`, the id read
 * returns both rows, and each per-row read answers from `perRow`.
 */
function installDb(
  listError: Error,
  perRow: Record<string, () => Promise<unknown>>
) {
  const findMany = vi.fn(({ select }: { select?: unknown }) =>
    select
      ? Promise.resolve([{ id: READABLE_ID }, { id: UNREADABLE_ID }])
      : Promise.reject(listError)
  );
  const findFirst = vi.fn(({ where }: { where: { id: string } }) =>
    perRow[where.id]()
  );
  (withDb as unknown as Mock).mockImplementation(
    (callback: (db: unknown) => unknown) =>
      callback({ customField: { findMany, findFirst } })
  );
  return { findMany, findFirst };
}

describe("customFieldsService.findByOrg with an unreadable enum value", () => {
  beforeEach(() => {
    customFieldUnreadableThrottle.clear();
  });

  it("returns the readable fields and omits the unreadable one, reported as custom_field_type_unsupported", async () => {
    const { findFirst } = installDb(unknownEnumError(), {
      [READABLE_ID]: () => Promise.resolve(fieldRow(READABLE_ID)),
      [UNREADABLE_ID]: () => Promise.reject(unknownEnumError()),
    });

    const fields = await customFieldsService.findByOrg(ORG_ID);

    expect(fields.map((field) => field.id)).toEqual([READABLE_ID]);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: UNREADABLE_ID, organizationId: ORG_ID },
      })
    );
    expect(logError).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith(
      CUSTOM_FIELD_UNREADABLE_OMITTED_EVENT,
      expect.objectContaining({
        organizationId: ORG_ID,
        customFieldId: UNREADABLE_ID,
        reason: CustomFieldQueryRejection.UnsupportedFieldType,
        enumReadError: "Value 'FORMULA' not found in enum 'CustomFieldType'",
      })
    );
  });

  it("rethrows a list-read P2023 that is not an unknown enum value, without degrading", async () => {
    const malformed = malformedUuidError();
    // Every row readable, so absorbing this error would visibly succeed.
    const { findFirst } = installDb(malformed, {
      [READABLE_ID]: () => Promise.resolve(fieldRow(READABLE_ID)),
      [UNREADABLE_ID]: () => Promise.resolve(fieldRow(UNREADABLE_ID)),
    });

    await expect(customFieldsService.findByOrg(ORG_ID)).rejects.toBe(malformed);
    expect(findFirst).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it("rethrows a per-row P2023 that is not an unknown enum value", async () => {
    const malformed = malformedUuidError();
    installDb(unknownEnumError(), {
      [READABLE_ID]: () => Promise.resolve(fieldRow(READABLE_ID)),
      [UNREADABLE_ID]: () => Promise.reject(malformed),
    });

    await expect(customFieldsService.findByOrg(ORG_ID)).rejects.toBe(malformed);
    expect(logError).not.toHaveBeenCalled();
  });
});
