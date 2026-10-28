// @vitest-environment jsdom

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  DetailsAvailability,
  type DetailsField,
  DetailsFieldId,
  DetailsReadOnlyKind,
  DetailsSectionId,
  type DetailsSelfSavingEdit,
  forViewer,
} from "../details-design-model";
import { isDetailsFieldDrawn } from "../details-sections";
import {
  DetailsTabArtifactType,
  forDetailsTabViewer,
} from "../details-tab-model";
import {
  configOf,
  readOnlyName,
  renderDetails,
  VIEWER_REASONS,
} from "./details-test-support";

/** ISS-12302: custom-field rows that save themselves, and their draw rule. */

const SET_ID = "cf-set";
const EMPTY_ID = "cf-empty";

function selfSaving(
  id: string,
  empty: boolean,
  edit: DetailsSelfSavingEdit = { mode: "self-saving" }
): DetailsField {
  return {
    edit,
    id,
    label: id,
    value: {
      empty,
      kind: "self-saving",
      render: (editable) => `Test: ${id} ${editable ? "editor" : "value"}`,
    },
  };
}

const twoRows = () =>
  configOf([], [selfSaving(SET_ID, false), selfSaving(EMPTY_ID, true)]);

function cellOf(id: string) {
  return document.querySelector<HTMLElement>(`[data-details-field="${id}"]`);
}

function customFieldsSection() {
  return document.querySelector(
    `[data-details-section="${DetailsSectionId.CustomFields}"]`
  );
}

describe("Self-saving Details rows", () => {
  it("draws an editable row set or not, as its own editor", () => {
    renderDetails(twoRows());

    expect(cellOf(SET_ID)).toHaveTextContent(`Test: ${SET_ID} editor`);
    expect(cellOf(EMPTY_ID)).toHaveTextContent(`Test: ${EMPTY_ID} editor`);
    expect(customFieldsSection()).not.toBeNull();
  });

  it("stretches only a row that asks to fill, editor and value alike", () => {
    const filling = (
      id: string,
      edit: DetailsSelfSavingEdit = { mode: "self-saving" }
    ): DetailsField => ({
      edit,
      id,
      label: id,
      value: {
        empty: false,
        fill: true,
        kind: "self-saving",
        render: (editable) => `Test: ${id} ${editable ? "editor" : "value"}`,
      },
    });
    renderDetails(
      configOf(
        [],
        [
          filling("cf-fill"),
          selfSaving(SET_ID, false),
          filling("cf-fill-value", { mode: "read-only" }),
        ]
      )
    );

    const wrapperOf = (id: string) => cellOf(id)?.firstElementChild;
    expect(wrapperOf("cf-fill")).toHaveClass("flex-1");
    expect(wrapperOf("cf-fill-value")).toHaveClass("flex-1");
    expect(wrapperOf(SET_ID)).not.toHaveClass("flex-1");
  });

  it.each([
    DetailsAvailability.Offline,
    DetailsAvailability.NoPermission,
  ] as const)(
    "under %s hides the empty row and locks the set one with the host's wording",
    (availability) => {
      renderDetails(twoRows(), availability);

      expect(cellOf(EMPTY_ID)).toBeNull();
      expect(screen.queryByText(`Test: ${EMPTY_ID} value`)).toBeNull();
      expect(cellOf(SET_ID)).toHaveTextContent(`Test: ${SET_ID} value`);
      expect(screen.queryByText(`Test: ${SET_ID} editor`)).toBeNull();
      expect(
        screen.getByRole("button", {
          name: readOnlyName(SET_ID, VIEWER_REASONS[availability]),
        })
      ).toBeInTheDocument();
    }
  );

  it("keeps an empty built-in row that the same viewer lock hides for a self-saving one", () => {
    renderDetails(
      configOf(
        [
          {
            edit: { mode: "editable", onSave: () => Promise.resolve() },
            id: DetailsFieldId.Project,
            label: "Project",
            value: { kind: "text", text: "" },
          },
        ],
        [selfSaving(EMPTY_ID, true)]
      ),
      DetailsAvailability.Offline
    );

    expect(cellOf(DetailsFieldId.Project)).not.toBeNull();
    expect(cellOf(EMPTY_ID)).toBeNull();
  });

  it("omits the Custom fields section when no row in it is drawn", () => {
    renderDetails(
      configOf([], [selfSaving(EMPTY_ID, true), selfSaving("cf-other", true)]),
      DetailsAvailability.Offline
    );

    expect(customFieldsSection()).toBeNull();
  });

  it.each([
    ["no reason", { mode: "read-only" }],
    [
      "a not-editable reason",
      {
        mode: "read-only",
        reason: { kind: DetailsReadOnlyKind.NotEditable },
      },
    ],
    [
      "a situational reason",
      {
        mode: "read-only",
        reason: { kind: DetailsReadOnlyKind.NoPermission, text: "Test." },
      },
    ],
  ] as const)(
    "draws a read-only row with %s only when it has a value",
    (_, edit: DetailsSelfSavingEdit) => {
      expect(isDetailsFieldDrawn(selfSaving(SET_ID, false, edit))).toBe(true);
      expect(isDetailsFieldDrawn(selfSaving(EMPTY_ID, true, edit))).toBe(false);
    }
  );

  it("forViewer and forDetailsTabViewer lock a self-saving row with the host's reason", () => {
    const base = twoRows();
    const expected = {
      mode: "read-only",
      reason: {
        kind: DetailsReadOnlyKind.DesktopOffline,
        text: VIEWER_REASONS[DetailsAvailability.Offline],
      },
    };

    const v20 = forViewer(base, DetailsAvailability.Offline);
    const v21 = forDetailsTabViewer(
      {
        base,
        customFieldsProject: null,
        type: DetailsTabArtifactType.Session,
      },
      DetailsAvailability.Offline
    );

    for (const fields of [v20.customFields, v21.base.customFields]) {
      expect(fields.map((field) => field.edit)).toEqual([expected, expected]);
      expect(fields.map(isDetailsFieldDrawn)).toEqual([true, false]);
    }
  });
});
