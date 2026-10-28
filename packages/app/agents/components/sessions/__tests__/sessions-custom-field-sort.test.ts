import type {
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { describe, expect, it } from "vitest";
import {
  type SessionsCustomFieldsController,
  sortSessionsByCustomField,
} from "../sessions-list-custom-fields";
import { SESSIONS_CUSTOM_FIELD_COLUMN_PREFIX } from "../sessions-list-view-state";

/**
 * ISS-7052 (whitlockk review): a DATE or NUMBER custom field must order by its
 * TYPED value, not by the text the API formatted for display. Both fixtures
 * below are chosen so the two orders DISAGREE — sorting the display text puts
 * them in the opposite order from sorting the real value, so a regression to
 * `displayValue` cannot leave these assertions green.
 */
describe("sortSessionsByCustomField", () => {
  it("orders DATE fields chronologically, not by formatted text", () => {
    const rows = sortSessionsByCustomField(
      [row("session-later"), row("session-earlier")],
      dateController(),
      column(DATE_FIELD.id),
      "asc"
    );

    // "Feb 1, 2026" sorts BEFORE "Mar 1, 2025" as text, and after it in time.
    expect(rows.map((entry) => entry.id)).toEqual([
      "session-earlier",
      "session-later",
    ]);
  });

  it("orders NUMBER fields by value, not by formatted duration text", () => {
    const rows = sortSessionsByCustomField(
      [row("session-long"), row("session-short")],
      durationController(),
      column(DURATION_FIELD.id),
      "asc"
    );

    // "1h 12m" sorts BEFORE "45m" as text, and after it as a duration.
    expect(rows.map((entry) => entry.id)).toEqual([
      "session-short",
      "session-long",
    ]);
  });
});

function column(fieldId: string) {
  return `${SESSIONS_CUSTOM_FIELD_COLUMN_PREFIX}${fieldId}` as never;
}

function row(id: string): SessionTableRow {
  return { id, name: id } as SessionTableRow;
}

function baseField(
  id: string,
  fieldType: CustomFieldWithOptions["fieldType"]
): CustomFieldWithOptions {
  return {
    createdAt: new Date("2026-08-25T12:00:00.000Z"),
    createdById: "user-1",
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    description: null,
    entityTypes: [CustomFieldEntityType.Session],
    enumOptions: [],
    fieldType,
    id,
    isGlobalToOrg: false,
    isSearchable: true,
    isSortable: true,
    name: id,
    numberFormat: NumberFormat.None,
    organizationId: "org-1",
    precision: null,
    referenceTargetSources: [],
    showInTable: true,
    updatedAt: new Date("2026-08-25T12:00:00.000Z"),
  };
}

function baseValue(
  field: CustomFieldWithOptions,
  entityId: string,
  displayValue: string
): CustomFieldValueDetail {
  return {
    customFieldId: field.id,
    dateValue: null,
    displayValue,
    entityId,
    enumValue: null,
    fieldType: field.fieldType,
    id: `${field.id}-${entityId}`,
    multiEnumValues: [],
    name: field.name,
    numberValue: null,
    peopleValues: [],
    referenceValues: [],
    showInTable: true,
    textValue: null,
  };
}

const DATE_FIELD = baseField("due", CustomFieldType.Date);
const DURATION_FIELD = baseField("spent", CustomFieldType.Number);

function dateController(): SessionsCustomFieldsController {
  return {
    fields: [DATE_FIELD],
    valuesBySessionId: new Map([
      [
        "session-later",
        [
          {
            ...baseValue(DATE_FIELD, "session-later", "Feb 1, 2026"),
            dateValue: new Date("2026-02-01T00:00:00.000Z"),
          },
        ],
      ],
      [
        "session-earlier",
        [
          {
            ...baseValue(DATE_FIELD, "session-earlier", "Mar 1, 2025"),
            dateValue: new Date("2025-03-01T00:00:00.000Z"),
          },
        ],
      ],
    ]),
  };
}

function durationController(): SessionsCustomFieldsController {
  return {
    fields: [DURATION_FIELD],
    valuesBySessionId: new Map([
      [
        "session-long",
        [
          {
            ...baseValue(DURATION_FIELD, "session-long", "1h 12m"),
            // Milliseconds, the canonical duration storage unit.
            numberValue: 4_320_000,
          },
        ],
      ],
      [
        "session-short",
        [
          {
            ...baseValue(DURATION_FIELD, "session-short", "45m"),
            numberValue: 2_700_000,
          },
        ],
      ],
    ]),
  };
}
