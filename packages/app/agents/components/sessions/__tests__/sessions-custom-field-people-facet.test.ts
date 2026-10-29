import type {
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import type { BasicUser } from "@repo/api/src/types/user";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { describe, expect, it } from "vitest";
import {
  buildSessionsCustomFieldFacetGroups,
  filterSessionsByCustomFields,
  type SessionsCustomFieldFilters,
  type SessionsCustomFieldsController,
} from "../sessions-list-custom-fields";
import { SESSIONS_CUSTOM_FIELD_COLUMN_PREFIX } from "../sessions-list-view-state";

/**
 * ISS-7052 (tamsinb review): a People facet is keyed by USER ID, so the fixture
 * below gives two DIFFERENT users the same rendered name — under the previous
 * name-keyed options they collapsed into one entry that then matched both rows.
 * The third user has no name parts at all, which used to render a blank option.
 */
describe("People custom-field facets", () => {
  it("keeps two same-named people apart and labels a nameless one by email", () => {
    const [group] = buildSessionsCustomFieldFacetGroups(
      controller(),
      new Map(),
      () => undefined,
      () => undefined
    );

    expect(group?.kind).toBe("options");
    if (group?.kind !== "options") {
      throw new Error("expected an options facet group");
    }
    expect(group.options).toEqual([
      { id: "user-kim-a", label: "Alex Kim" },
      { id: "user-kim-b", label: "Alex Kim" },
      { id: "user-nameless", label: "nameless@closedloop.ai" },
    ]);
  });

  it("filters to the selected person only, not to their namesake", () => {
    const filters: SessionsCustomFieldFilters = new Map([
      [COLUMN_ID, { kind: "options" as const, selectedValues: ["user-kim-a"] }],
    ]);

    const rows = filterSessionsByCustomFields(
      [row("session-a"), row("session-b"), row("session-c")],
      controller(),
      filters
    );

    expect(rows.map((entry) => entry.id)).toEqual(["session-a"]);
  });
});

const REVIEWER_FIELD = peopleField("reviewer");
const COLUMN_ID = `${SESSIONS_CUSTOM_FIELD_COLUMN_PREFIX}${REVIEWER_FIELD.id}`;

const ALEX_KIM_A: BasicUser = {
  avatarUrl: null,
  email: "alex.kim@closedloop.ai",
  firstName: "Alex",
  id: "user-kim-a",
  lastName: "Kim",
};
const ALEX_KIM_B: BasicUser = {
  avatarUrl: null,
  email: "a.kim@closedloop.ai",
  firstName: "Alex",
  id: "user-kim-b",
  lastName: "Kim",
};
const NAMELESS: BasicUser = {
  avatarUrl: null,
  email: "nameless@closedloop.ai",
  firstName: null,
  id: "user-nameless",
  lastName: null,
};

function row(id: string): SessionTableRow {
  return { id, name: id } as SessionTableRow;
}

function peopleField(id: string): CustomFieldWithOptions {
  return {
    createdAt: new Date("2026-08-25T12:00:00.000Z"),
    createdById: "user-1",
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    description: null,
    entityTypes: [CustomFieldEntityType.Session],
    enumOptions: [],
    fieldType: CustomFieldType.People,
    id,
    isGlobalToOrg: false,
    isSearchable: true,
    isSortable: true,
    name: "Reviewer",
    numberFormat: NumberFormat.None,
    organizationId: "org-1",
    precision: null,
    referenceTargetSources: [],
    showInTable: true,
    updatedAt: new Date("2026-08-25T12:00:00.000Z"),
  };
}

function peopleValue(
  entityId: string,
  people: readonly BasicUser[]
): CustomFieldValueDetail {
  return {
    customFieldId: REVIEWER_FIELD.id,
    dateValue: null,
    displayValue: people
      .map((person) => [person.firstName, person.lastName].join(" "))
      .join(", "),
    entityId,
    enumValue: null,
    fieldType: CustomFieldType.People,
    id: `${REVIEWER_FIELD.id}-${entityId}`,
    multiEnumValues: [],
    name: REVIEWER_FIELD.name,
    numberValue: null,
    peopleValues: [...people],
    referenceValues: [],
    showInTable: true,
    textValue: null,
  };
}

function controller(): SessionsCustomFieldsController {
  return {
    fields: [REVIEWER_FIELD],
    valuesBySessionId: new Map([
      ["session-a", [peopleValue("session-a", [ALEX_KIM_A])]],
      ["session-b", [peopleValue("session-b", [ALEX_KIM_B])]],
      ["session-c", [peopleValue("session-c", [NAMELESS])]],
    ]),
  };
}
