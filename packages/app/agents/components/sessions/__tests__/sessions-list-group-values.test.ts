import type {
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { GROUP_EMPTY_VALUE } from "@repo/api/src/types/custom-field-capabilities";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { UNASSIGNED_ASSIGNEE_LABEL } from "@repo/app/shared/lib/user-utils";
import {
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { describe, expect, it } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import {
  type SessionsCustomFieldsController,
  sessionsCustomFieldGroupContribution,
} from "../sessions-list-custom-fields";
import {
  SESSIONS_GROUP_FIELDS,
  sessionsGroupCanonicalValue,
} from "../sessions-list-group-values";
import { resolveCustomFieldGroups } from "../sessions-list-surface-model";
import {
  buildGroups,
  GROUPABLE_COLUMN_IDS,
} from "../sessions-list-surface-rows";
import {
  SESSIONS_CUSTOM_FIELD_COLUMN_PREFIX,
  UNASSIGNED_OWNER_ID,
} from "../sessions-list-view-state";

/**
 * ISS-8296: the value a drop would WRITE, as opposed to the label a band shows.
 *
 * Every case goes through `buildGroups` rather than calling the derivation
 * directly where it can, because the band-level rule ("one value every row
 * agreed on") is the half that is easy to implement wrongly and impossible to
 * observe from a single row.
 */

function grouping(
  primaryFieldId: string | null,
  secondaryFieldId: string | null = null
): TableGroupingState {
  return {
    primary: {
      fieldId: primaryFieldId,
      order: TableGroupOrder.Ascending,
      showEmptyGroups: false,
    },
    secondary: {
      fieldId: secondaryFieldId,
      order: TableGroupOrder.Ascending,
      showEmptyGroups: false,
    },
  };
}

function rows(...overrides: Partial<SessionTableRow>[]): SessionTableRow[] {
  return overrides.map((override, index) =>
    createSessionTableRowFixture({ id: `ses-${index}`, ...override })
  );
}

/**
 * The single band `field` produces for these rows.
 *
 * Throws rather than asserts: an `expect` in a helper is both a lint error here
 * and a worse failure message, since it reports the helper's line rather than
 * the case that called it.
 */
function onlyBand(field: string, given: SessionTableRow[]) {
  const groups = buildGroups(given, grouping(field));
  const band = groups[0];
  if (groups.length !== 1 || !band) {
    throw new Error(
      `expected exactly one band for "${field}", built ${groups.length}`
    );
  }
  return band;
}

describe("the groupable column set is DERIVED from the field table", () => {
  it("names exactly the fields that declared themselves", () => {
    // Not decoration: a hand-written set beside the table is what would let a
    // new groupable column ship without declaring whether its bands can be
    // dropped on. Written out by hand here so emptying the table fails too.
    expect([...GROUPABLE_COLUMN_IDS].sort()).toEqual([
      "harness",
      "model",
      "owner",
      "priority",
      "status",
    ]);
    expect([...GROUPABLE_COLUMN_IDS].sort()).toEqual(
      Object.keys(SESSIONS_GROUP_FIELDS).sort()
    );
  });
});

describe("status bands carry a LIFECYCLE value, never a displayed one", () => {
  it("gives a failed band the stored lifecycle status behind its label", () => {
    const band = onlyBand("status", rows({ status: SESSION_STATUS.ERROR }));

    // The label and the value are different strings, which is the point.
    expect(band.label).toBe("Failed");
    expect(band.value).toBe(SESSION_STATUS.ERROR);
    expect(band.droppable).toBe(true);
  });

  it("refuses a WAITING band, which no producer stores", () => {
    // The defect this exists to stop: `waiting` reaches a band through the
    // ordinary unrecognized-spelling path, which folds to `active` — a drop
    // meaning "make this waiting" would set the session RUNNING. The predicate
    // that used to be the tempting exclusion here (`isDisplayOnlySessionStatus`)
    // never covered `waiting` and ISS-10364 deleted it; the band must refuse the
    // value on its own.
    const band = onlyBand("status", rows({ status: "waiting" }));

    expect(band.value).toBeUndefined();
    expect(band.droppable).toBe(false);
  });

  it.each(["stale", "unknown"])("refuses a %s band", (status) => {
    const band = onlyBand("status", rows({ status }));

    expect(band.value).toBeUndefined();
    expect(band.droppable).toBe(false);
  });

  it("refuses a retired or version-skewed spelling", () => {
    // `status` is a bare `string`, so a negative check would admit this as
    // canonical and write a word nothing recognizes.
    const band = onlyBand("status", rows({ status: "abandoned" }));

    expect(band.value).toBeUndefined();
    expect(band.droppable).toBe(false);
  });

  it("refuses the whole band when a skewed row joins a real one", () => {
    // A skewed spelling never gets a band of its own — the label fold fail-opens
    // it INTO "Active" — so the mixed band is the only shape this actually
    // takes, and one unreadable row makes the band unwritable for all of them.
    const band = onlyBand(
      "status",
      rows({ status: SESSION_STATUS.ACTIVE }, { status: "abandoned" })
    );

    expect(band.items).toHaveLength(2);
    expect(band.value).toBeUndefined();
    expect(band.droppable).toBe(false);
  });
});

describe("owner bands separate an absent owner from an unidentified one", () => {
  it("gives an unowned band the settable unassigned value, PRESENT not absent", () => {
    const band = onlyBand("owner", rows({ user: null }));

    expect(band.label).toBe(UNASSIGNED_ASSIGNEE_LABEL);
    // The assertion that matters is the second one: `toBeDefined` is what tells
    // "explicitly unassigned" apart from "no canonical value", and a consumer
    // testing truthiness would collapse them.
    expect(band.value).toBeDefined();
    expect(band.value).toBe(UNASSIGNED_OWNER_ID);
    expect(band.droppable).toBe(true);
  });

  it("gives an owned band the user id, not the display name", () => {
    const band = onlyBand(
      "owner",
      rows({ user: { id: "user-abc", name: "Jane Doe" } })
    );

    expect(band.label).toBe("Jane Doe");
    expect(band.value).toBe("user-abc");
  });

  it("refuses a band whose owner has a NAME but no id", () => {
    // `user.id` is optional while `name` is required. Folding this onto the
    // unassigned sentinel — which is right for a filter facet — would make the
    // drop UNASSIGN a session that visibly has an owner.
    const band = onlyBand("owner", rows({ user: { name: "Jane Doe" } }));

    expect(band.label).toBe("Jane Doe");
    expect(band.value).toBeUndefined();
    expect(band.droppable).toBe(false);
  });

  // ISS-7505: bands key on the owner ID, so a shared display name no longer
  // merges two people into one band whose count and rows belong to both.
  it("gives two people sharing a display name two bands, each headed by the name", () => {
    const groups = buildGroups(
      rows(
        { user: { id: "user-abc", name: "Jane Doe" } },
        { user: { id: "user-xyz", name: "Jane Doe" } },
        { user: { id: "user-abc", name: "Jane Doe" } }
      ),
      grouping("owner")
    );

    expect(groups).toHaveLength(2);
    expect(groups.map((band) => band.label)).toEqual(["Jane Doe", "Jane Doe"]);
    // Never a raw id in the header.
    expect(groups.map((band) => band.label)).not.toContain("user-abc");
    const byValue = new Map(groups.map((band) => [band.value, band]));
    expect(byValue.get("user-abc")?.items.map((row) => row.id)).toEqual([
      "ses-0",
      "ses-2",
    ]);
    expect(byValue.get("user-xyz")?.items.map((row) => row.id)).toEqual([
      "ses-1",
    ]);
    // Each band now names ONE owner, so each is a drop target for that owner.
    expect(groups.every((band) => band.droppable)).toBe(true);
  });

  it("orders owner bands by the name a reader scans, not by id", () => {
    const groups = buildGroups(
      rows(
        { user: { id: "a-id", name: "Zoe" } },
        { user: { id: "z-id", name: "Anouk" } }
      ),
      grouping("owner")
    );

    expect(groups.map((band) => band.label)).toEqual(["Anouk", "Zoe"]);
  });

  it("keeps unowned rows in ONE unassigned band", () => {
    const band = onlyBand("owner", rows({ user: null }, { user: null }));

    expect(band.label).toBe(UNASSIGNED_ASSIGNEE_LABEL);
    expect(band.items).toHaveLength(2);
    expect(band.droppable).toBe(true);
  });

  it("separates an identified owner from a name-only one, refusing only the latter", () => {
    // Before ISS-7505 both rows shared one band keyed on the NAME, which had
    // to be refused whole. Keyed on id, the name-only row has no identity to
    // join, so it stands apart and is the only band a drop cannot write to.
    const groups = buildGroups(
      rows(
        { user: { id: "user-abc", name: "Jane Doe" } },
        { user: { name: "Jane Doe" } }
      ),
      grouping("owner")
    );

    expect(groups).toHaveLength(2);
    expect(groups.map((band) => band.label)).toEqual(["Jane Doe", "Jane Doe"]);
    const identified = groups.find((band) => band.value === "user-abc");
    const nameOnly = groups.find((band) => band.value === undefined);
    expect(identified?.droppable).toBe(true);
    expect(nameOnly?.droppable).toBe(false);
  });
});

describe("fields that are not settable never produce a destination", () => {
  it.each(["harness", "model"])(
    "refuses a clean single-value %s band",
    (field) => {
      // Not a data problem — a domain one. Neither is a property of a completed
      // run that a host could change, so a clean band is still not a target.
      const band = onlyBand(
        field,
        rows({ harness: "claude", model: "sonnet" })
      );

      expect(band.value).toBeUndefined();
      expect(band.droppable).toBe(false);
    }
  );

  it("refuses a harness band holding both spellings the label folds together", () => {
    // `resolveHarnessLabel` is case-insensitive by design, so these render as
    // ONE "Claude" band. Reading the raw string as canonical would have made
    // this band report two values.
    const band = onlyBand(
      "harness",
      rows({ harness: "claude" }, { harness: "Claude" })
    );

    expect(band.items).toHaveLength(2);
    expect(band.value).toBeUndefined();
  });
});

describe("a field this surface does not know fails CLOSED", () => {
  it("gives no canonical value for an unmapped field id", () => {
    // Nothing validates the grouping field id — the groupable set only decides
    // what the MENU offers, so a controlled-view host or a restored saved view
    // can name anything.
    expect(
      sessionsGroupCanonicalValue("repo", createSessionTableRowFixture({}))
    ).toBeUndefined();
  });

  it("refuses the bands an unmapped field id builds", () => {
    const band = onlyBand("repo", rows({ repo: "closedloop-ai/symphony" }));

    expect(band.value).toBeUndefined();
    expect(band.droppable).toBe(false);
  });

  it("does not answer for an inherited object key", () => {
    expect(
      sessionsGroupCanonicalValue(
        "constructor",
        createSessionTableRowFixture({})
      )
    ).toBeUndefined();
  });
});

describe("the settable-empty value is one constant, not two", () => {
  it("agrees with the owner sentinel it coincides with", () => {
    // They hold the same string today. Pinned so that changing one without the
    // other is caught here rather than by a host writing the wrong empty.
    expect(GROUP_EMPTY_VALUE).toBe(UNASSIGNED_OWNER_ID);
  });
});

describe("subgroups carry their own value, independent of the parent", () => {
  it("values a subgroup from its OWN field", () => {
    const groups = buildGroups(
      rows({
        status: SESSION_STATUS.ERROR,
        user: { id: "user-abc", name: "Jane Doe" },
      }),
      grouping("owner", "status")
    );

    const parent = groups[0];
    const child = parent?.subgroups?.[0];
    expect(parent?.value).toBe("user-abc");
    expect(child?.label).toBe("Failed");
    expect(child?.value).toBe(SESSION_STATUS.ERROR);
    // Anti-vacuity: the subgroup must NOT have inherited the owner id.
    expect(child?.value).not.toBe("user-abc");
  });

  it("refuses a subgroup on its own merits while the parent stays droppable", () => {
    const groups = buildGroups(
      rows({ status: "waiting", user: { id: "user-abc", name: "Jane Doe" } }),
      grouping("owner", "status")
    );

    expect(groups[0]?.droppable).toBe(true);
    expect(groups[0]?.subgroups?.[0]?.droppable).toBe(false);
  });
});

/**
 * ISS-8296 (whitlockk review on #6356): nothing reached the custom-field half of
 * the mapping, so a regression that put `displayValue` back in `value` — the
 * exact defect this ticket exists to remove — stayed green.
 *
 * Every case below is chosen so the canonical value and the rendered label
 * DISAGREE, which is what makes `value: displayValue` fail here rather than
 * pass by coincidence.
 */
describe("sessionsCustomFieldGroupContribution", () => {
  it("carries the enum OPTION ID, not the label the band renders", () => {
    const contribution = sessionsCustomFieldGroupContribution(
      enumController(),
      column(ENUM_FIELD.id),
      "session-1"
    );

    expect(contribution.key).toBe("In progress");
    expect(contribution.value).toBe("opt-in-progress");
    // Anti-vacuity: the label must not have been reused as the value.
    expect(contribution.value).not.toBe(contribution.key);
  });

  it("separates an absent enum value as settable-empty, not unmappable", () => {
    const contribution = sessionsCustomFieldGroupContribution(
      enumController(),
      column(ENUM_FIELD.id),
      "session-without-value"
    );

    expect(contribution.key).toBe("—");
    // Present-and-empty, NOT absent: a drop here means "clear this field", and
    // a truthiness test on the host side would discard that legal write.
    expect(contribution.value).toBe(GROUP_EMPTY_VALUE);
    expect(contribution.value).not.toBeUndefined();
  });

  it("refuses an enum band whose LABEL outlived the option it names", () => {
    // ENUM's `displayValue` is CachedOnWrite while `enumValue` resolves live,
    // and the option FK is `onDelete: SetNull`, so deleting an option leaves a
    // row still reading "In progress" with nothing behind it (marisolashgrove
    // review). Folding that to GROUP_EMPTY_VALUE made the band droppable and
    // had the drop CLEAR the field the band claims to set.
    const contribution = sessionsCustomFieldGroupContribution(
      orphanedEnumController(),
      column(ENUM_FIELD.id),
      "session-1"
    );

    expect(contribution.key).toBe("In progress");
    expect(contribution.value).toBeUndefined();
  });

  it("still admits a CLEARED enum row, which carries no label to outlive", () => {
    // The counterfactual for the case above, and what keeps its fix from being
    // "refuse whenever the option is unresolved": every write recomputes
    // `displayValue`, so a genuinely cleared row has no label and its band is
    // the same settable "—" an absent row lands in.
    const contribution = sessionsCustomFieldGroupContribution(
      clearedEnumController(),
      column(ENUM_FIELD.id),
      "session-1"
    );

    expect(contribution.key).toBe("—");
    expect(contribution.value).toBe(GROUP_EMPTY_VALUE);
    expect(contribution.value).not.toBeUndefined();
  });

  it("yields no value for a type the capability table refuses to group", () => {
    // DATE is still offered by `isSessionsCustomFieldGroupable`, so this band
    // EXISTS while the two inventories disagree. It must fail closed.
    const contribution = sessionsCustomFieldGroupContribution(
      dateController(),
      column(DATE_FIELD.id),
      "session-1"
    );

    expect(contribution.key).toBe("Feb 1, 2026");
    expect(contribution.value).toBeUndefined();
  });

  it("yields no value for a column that names no field at all", () => {
    const contribution = sessionsCustomFieldGroupContribution(
      enumController(),
      column("field-that-does-not-exist"),
      "session-1"
    );

    expect(contribution.key).toBe("—");
    expect(contribution.value).toBeUndefined();
  });

  it("carries the reference TARGET ID, not the label the band renders", () => {
    const contribution = sessionsCustomFieldGroupContribution(
      referenceController(),
      column(REF_FIELD.id),
      "session-1"
    );

    expect(contribution.key).toBe("Ship the thing");
    expect(contribution.value).toBe("art-1");
    expect(contribution.value).not.toBe(contribution.key);
  });

  it("refuses a reference value with multiple targets as corrupt", () => {
    const contribution = sessionsCustomFieldGroupContribution(
      multiReferenceController(),
      column(REF_FIELD.id),
      "session-1"
    );

    expect(contribution.value).toBeUndefined();
  });
});

/**
 * whitlockk review on #6702: every case above calls the derivation directly, so the
 * callback `resolveCustomFieldGroups` hands `buildGroups` — the only thing that
 * reaches it in production — could be dropped and they would all stay green
 * while no custom-field band carried a value at all.
 */
describe("resolveCustomFieldGroups is the production path to that derivation", () => {
  const CUSTOM_FIELD_ROW = rows({ id: "session-1" });

  it("bands a custom-field column with the canonical value, not the label", () => {
    const groups = resolveCustomFieldGroups(
      true,
      CUSTOM_FIELD_ROW,
      grouping(column(ENUM_FIELD.id)),
      enumController()
    );

    expect(groups).toHaveLength(1);
    expect(groups?.[0]?.label).toBe("In progress");
    expect(groups?.[0]?.value).toBe("opt-in-progress");
    // Anti-vacuity: the value must not be the label the band renders.
    expect(groups?.[0]?.value).not.toBe(groups?.[0]?.label);
  });

  it("leaves the band unwritable when the surface has no custom-field controller", () => {
    const groups = resolveCustomFieldGroups(
      true,
      CUSTOM_FIELD_ROW,
      grouping(column(ENUM_FIELD.id)),
      undefined
    );

    expect(groups).toHaveLength(1);
    expect(groups?.[0]?.value).toBeUndefined();
    expect(groups?.[0]?.droppable).toBe(false);
  });
});

function column(fieldId: string): string {
  return `${SESSIONS_CUSTOM_FIELD_COLUMN_PREFIX}${fieldId}`;
}

function customField(
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

function customFieldValue(
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

const ENUM_FIELD = customField("stage", CustomFieldType.Enum);
const DATE_FIELD = customField("due", CustomFieldType.Date);

function enumController(): SessionsCustomFieldsController {
  return {
    fields: [ENUM_FIELD],
    valuesBySessionId: new Map([
      [
        "session-1",
        [
          {
            ...customFieldValue(ENUM_FIELD, "session-1", "In progress"),
            enumValue: {
              color: "blue",
              customFieldId: ENUM_FIELD.id,
              enabled: true,
              id: "opt-in-progress",
              name: "In progress",
              sortOrder: 0,
            },
          },
        ],
      ],
      ["session-without-value", []],
    ]),
  };
}

/**
 * A row whose enum option was DELETED: the cached label survives the `SetNull`
 * that cleared `enumValueId`, so the band still renders "In progress".
 */
function orphanedEnumController(): SessionsCustomFieldsController {
  return {
    fields: [ENUM_FIELD],
    valuesBySessionId: new Map([
      ["session-1", [customFieldValue(ENUM_FIELD, "session-1", "In progress")]],
    ]),
  };
}

/** A row whose value was CLEARED, so the recomputed label is empty too. */
function clearedEnumController(): SessionsCustomFieldsController {
  return {
    fields: [ENUM_FIELD],
    valuesBySessionId: new Map([
      ["session-1", [customFieldValue(ENUM_FIELD, "session-1", "")]],
    ]),
  };
}

function dateController(): SessionsCustomFieldsController {
  return {
    fields: [DATE_FIELD],
    valuesBySessionId: new Map([
      [
        "session-1",
        [
          {
            ...customFieldValue(DATE_FIELD, "session-1", "Feb 1, 2026"),
            dateValue: new Date("2026-02-01T00:00:00.000Z"),
          },
        ],
      ],
    ]),
  };
}

const REF_FIELD = customField("sprint", CustomFieldType.Reference);

function referenceController(): SessionsCustomFieldsController {
  return {
    fields: [REF_FIELD],
    valuesBySessionId: new Map([
      [
        "session-1",
        [
          {
            ...customFieldValue(REF_FIELD, "session-1", "Ship the thing"),
            referenceValues: [
              {
                id: "art-1",
                name: "Ship the thing",
                slug: null,
                artifactType: "DOCUMENT" as const,
                subtype: null,
                status: "OPEN",
              },
            ],
          },
        ],
      ],
    ]),
  };
}

function multiReferenceController(): SessionsCustomFieldsController {
  return {
    fields: [REF_FIELD],
    valuesBySessionId: new Map([
      [
        "session-1",
        [
          {
            ...customFieldValue(REF_FIELD, "session-1", "Ship + Land"),
            referenceValues: [
              {
                id: "art-1",
                name: "Ship the thing",
                slug: null,
                artifactType: "DOCUMENT" as const,
                subtype: null,
                status: "OPEN",
              },
              {
                id: "art-2",
                name: "Land the thing",
                slug: null,
                artifactType: "DOCUMENT" as const,
                subtype: null,
                status: "OPEN",
              },
            ],
          },
        ],
      ],
    ]),
  };
}
