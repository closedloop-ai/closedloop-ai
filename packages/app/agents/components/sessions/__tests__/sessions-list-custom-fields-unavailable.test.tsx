import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { GROUP_EMPTY_VALUE } from "@repo/api/src/types/custom-field-capabilities";
import {
  createSessionCustomFieldFixture,
  createSessionTableRowFixture,
} from "@repo/app/agents/components/sessions/session-list-fixtures";
import {
  renderSessionsCustomFieldCell,
  type SessionsCustomFieldsController,
  sessionsCustomFieldColumnId,
  sessionsCustomFieldGroupContribution,
  sortSessionsByCustomField,
} from "@repo/app/agents/components/sessions/sessions-list-custom-fields";
import {
  TABLE_CELL_UNAVAILABLE_LABEL,
  TableCellValueState,
} from "@repo/design-system/components/ui/table-cell-primitives";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

const FIELD = createSessionCustomFieldFixture({
  fieldType: CustomFieldType.Reference,
  id: "linked",
  name: "Linked",
});

afterEach(cleanup);

describe("Sessions custom-field unavailable row projection", () => {
  it("renders the approved unavailable state instead of an ordinary empty cell", () => {
    const row = createSessionTableRowFixture({
      id: "unavailable",
      name: "Unavailable session",
    });

    render(
      renderSessionsCustomFieldCell({
        controller: controllerWith(new Map()),
        field: FIELD,
        row,
      })
    );

    const label = screen.getByText(TABLE_CELL_UNAVAILABLE_LABEL);
    expect(label.parentElement).toHaveAttribute(
      "data-cell-value-state",
      TableCellValueState.Unavailable
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("groups unavailable projection separately from present-and-empty", () => {
    const controller = controllerWith(new Map([["empty", []]]));

    expect(
      sessionsCustomFieldGroupContribution(
        controller,
        sessionsCustomFieldColumnId(FIELD.id),
        "unavailable"
      )
    ).toEqual({ key: TABLE_CELL_UNAVAILABLE_LABEL, value: undefined });
    expect(
      sessionsCustomFieldGroupContribution(
        controller,
        sessionsCustomFieldColumnId(FIELD.id),
        "empty"
      )
    ).toEqual({ key: "—", value: GROUP_EMPTY_VALUE });
  });

  it("sorts unavailable projection last in both directions", () => {
    const controller = controllerWith(
      new Map([
        ["empty", []],
        ["populated", [value("populated", "Alpha")]],
      ])
    );
    const rows = ["unavailable-z", "populated", "unavailable-a", "empty"].map(
      (id) => createSessionTableRowFixture({ id, name: id })
    );
    const columnId = sessionsCustomFieldColumnId(FIELD.id);

    expect(
      sortSessionsByCustomField(rows, controller, columnId, "asc").map(
        ({ id }) => id
      )
    ).toEqual(["empty", "populated", "unavailable-a", "unavailable-z"]);
    expect(
      sortSessionsByCustomField(rows, controller, columnId, "desc").map(
        ({ id }) => id
      )
    ).toEqual(["populated", "empty", "unavailable-a", "unavailable-z"]);
  });
});

function controllerWith(
  valuesBySessionId: ReadonlyMap<string, readonly CustomFieldValueDetail[]>
): SessionsCustomFieldsController {
  return { fields: [FIELD], valuesBySessionId };
}

function value(entityId: string, displayValue: string): CustomFieldValueDetail {
  return {
    customFieldId: FIELD.id,
    dateValue: null,
    displayValue,
    entityId,
    enumValue: null,
    fieldType: FIELD.fieldType,
    id: `${FIELD.id}-${entityId}`,
    multiEnumValues: [],
    name: FIELD.name,
    numberValue: null,
    peopleValues: [],
    referenceValues: [],
    showInTable: true,
    textValue: null,
  };
}
