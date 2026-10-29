// @vitest-environment jsdom

import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import { ColumnFieldKind } from "@repo/design-system/lib/column-registry";
import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { columnWidthBounds } from "../artifact-list-model";
import {
  ADD_ARTIFACT,
  ADD_FIELD,
  BOARD_VIEW,
  CREATE_ARTIFACT_DIALOG,
  FIRST_ARTIFACT_TITLE,
  LAST_7_DAYS,
  LIST_VIEW,
  nthElement,
  OWNER_COLUMN_OPTIONS,
  renderShell,
  rowSlugs,
  SHELL_FLOW_TIMEOUT_MS,
} from "./support/list-shell-harness";
import { openRadixMenu } from "./support/radix-menu";

const DEFAULT_RANGE_LABEL = "Artifact updated within time period";
const ARTIFACTS_CREATED_CARD = "About Artifacts created";
const ARTIFACTS_CREATED_ITEM = /^Artifacts created/;
const STATUS_CHIP = "Status: In review";

function firstRadio(name: string): HTMLElement {
  return nthElement(screen.getAllByRole("radio", { name }), 0);
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("artifact list toolbar date range", {
  timeout: SHELL_FLOW_TIMEOUT_MS,
}, () => {
  it("narrows the rows to the chosen range and keeps it when the active range is pressed again", () => {
    renderShell();

    expect(screen.getByLabelText(DEFAULT_RANGE_LABEL)).toBeTruthy();
    expect(screen.getByText("7d")).toBeTruthy();
    expect(screen.getByText("All")).toBeTruthy();
    expect(firstRadio("Last 30 days").getAttribute("aria-checked")).toBe(
      "true"
    );
    expect(rowSlugs()).toContain("DOC-184");

    fireEvent.click(firstRadio(LAST_7_DAYS));
    expect(firstRadio(LAST_7_DAYS).getAttribute("aria-checked")).toBe("true");
    expect(rowSlugs()).not.toContain("DOC-184");

    fireEvent.click(firstRadio(LAST_7_DAYS));
    expect(firstRadio(LAST_7_DAYS).getAttribute("aria-checked")).toBe("true");
    expect(rowSlugs()).not.toContain("DOC-184");
  });

  it("names the range control with the host's label", () => {
    renderShell({ dateFilterLabel: "Session updated within period" });

    expect(screen.getByLabelText("Session updated within period")).toBeTruthy();
    expect(screen.queryByLabelText(DEFAULT_RANGE_LABEL)).toBeNull();
  });

  it("omits the range control when the host turns it off", () => {
    renderShell({ showDateRangeControl: false });

    expect(screen.getAllByRole("radio", { name: LIST_VIEW })).toHaveLength(2);
    expect(screen.queryByRole("radio", { name: LAST_7_DAYS })).toBeNull();
  });
});

describe("artifact list toolbar layout", {
  timeout: SHELL_FLOW_TIMEOUT_MS,
}, () => {
  it("switches to the board and ignores a press on the active layout", () => {
    renderShell();
    expect(screen.getByLabelText(OWNER_COLUMN_OPTIONS)).toBeTruthy();

    fireEvent.click(firstRadio(LIST_VIEW));
    expect(firstRadio(LIST_VIEW).getAttribute("aria-checked")).toBe("true");
    expect(rowSlugs()).toHaveLength(3);

    fireEvent.click(firstRadio(BOARD_VIEW));

    expect(firstRadio(BOARD_VIEW).getAttribute("aria-checked")).toBe("true");
    expect(rowSlugs()).toEqual([]);
    expect(screen.getByText(FIRST_ARTIFACT_TITLE)).toBeTruthy();
    expect(screen.queryByLabelText(OWNER_COLUMN_OPTIONS)).toBeNull();

    fireEvent.click(firstRadio(LIST_VIEW));
    expect(firstRadio(LIST_VIEW).getAttribute("aria-checked")).toBe("true");
    expect(rowSlugs()).toHaveLength(3);
  });

  it("switches layout from the compact toolbar and ignores a press on the active one", () => {
    renderShell();
    const compact = (name: string) =>
      nthElement(screen.getAllByRole("radio", { name }), 1);

    fireEvent.click(compact(LIST_VIEW));
    expect(compact(LIST_VIEW).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(compact(BOARD_VIEW));
    expect(compact(BOARD_VIEW).getAttribute("aria-checked")).toBe("true");
    expect(rowSlugs()).toEqual([]);

    fireEvent.click(compact(LIST_VIEW));
    expect(compact(LIST_VIEW).getAttribute("aria-checked")).toBe("true");
    expect(rowSlugs()).toHaveLength(3);
  });

  it("offers no layout switch on an embedded list", () => {
    renderShell({ variant: "embedded" });

    expect(screen.queryByRole("radio", { name: LIST_VIEW })).toBeNull();
    expect(rowSlugs()).toHaveLength(3);
  });
});

describe("artifact list toolbar sorting", {
  timeout: SHELL_FLOW_TIMEOUT_MS,
}, () => {
  it("sorts from the Sort menu and clears back to the stored order", async () => {
    renderShell();
    expect(rowSlugs()).toEqual(["FEA-2481", "DOC-184", "SES-7B91"]);

    openRadixMenu(screen.getByRole("button", { name: "Sort" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Owner" }));

    expect(
      screen.getByRole("button", { name: "Sorted by Owner" })
    ).toBeTruthy();
    expect(rowSlugs()).toEqual(["FEA-2481", "SES-7B91", "DOC-184"]);

    fireEvent.click(screen.getByRole("button", { name: "Clear sort" }));

    expect(screen.getByRole("button", { name: "Sort" })).toBeTruthy();
    expect(rowSlugs()).toEqual(["FEA-2481", "DOC-184", "SES-7B91"]);
  });

  it("sorts from the compact View menu, which reflects and clears the sort", async () => {
    renderShell();

    openRadixMenu(screen.getByRole("button", { name: "View" }));
    expect(
      (await screen.findByRole("menuitemradio", { name: "None" })).getAttribute(
        "aria-checked"
      )
    ).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Owner" }));

    expect(
      screen.getByRole("button", { name: "Sorted by Owner" })
    ).toBeTruthy();
    expect(rowSlugs()).toEqual(["FEA-2481", "SES-7B91", "DOC-184"]);

    openRadixMenu(screen.getByRole("button", { name: "View" }));
    expect(
      (
        await screen.findByRole("menuitemradio", { name: "Owner" })
      ).getAttribute("aria-checked")
    ).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "None" }));

    expect(screen.getByRole("button", { name: "Sort" })).toBeTruthy();
  });
});

describe("artifact list toolbar creation controls", {
  timeout: SHELL_FLOW_TIMEOUT_MS,
}, () => {
  it("opens the add-field dialog from the toolbar and from the View menu", async () => {
    renderShell();

    fireEvent.click(
      nthElement(screen.getAllByRole("button", { name: ADD_FIELD }), 0)
    );
    expect(await screen.findByRole("dialog", { name: ADD_FIELD })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: ADD_FIELD })).toBeNull();

    openRadixMenu(screen.getByRole("button", { name: "View" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: ADD_FIELD }));
    expect(await screen.findByRole("dialog", { name: ADD_FIELD })).toBeTruthy();
  });

  it("withholds every add-field entry point when the host turns it off", async () => {
    renderShell({ showAddFieldButton: false });

    expect(screen.queryByRole("button", { name: ADD_FIELD })).toBeNull();
    openRadixMenu(screen.getByRole("button", { name: "View" }));
    expect(
      await screen.findByRole("menuitemradio", { name: "None" })
    ).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: ADD_FIELD })).toBeNull();
  });

  it("opens the creation dialog from Add artifact, and hides the button when asked", async () => {
    const { unmount } = renderShell();

    fireEvent.click(screen.getByRole("button", { name: ADD_ARTIFACT }));
    expect(
      await screen.findByRole("dialog", { name: CREATE_ARTIFACT_DIALOG })
    ).toBeTruthy();
    unmount();

    renderShell({ showAddArtifactButton: false });
    expect(screen.queryByRole("button", { name: ADD_ARTIFACT })).toBeNull();
  });
});

describe("artifact list toolbar active filters", {
  timeout: SHELL_FLOW_TIMEOUT_MS,
}, () => {
  it("shows the active filter bar and clears every filter from the Filters control", () => {
    window.history.replaceState(
      {},
      "",
      `/?statuses=${ARTIFACT_STATUS_ROOT.InReview}`
    );
    renderShell();

    expect(screen.getByText(STATUS_CHIP)).toBeTruthy();
    expect(rowSlugs()).toEqual(["FEA-2481"]);

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(screen.queryByText(STATUS_CHIP)).toBeNull();
    expect(rowSlugs()).toEqual(["FEA-2481", "DOC-184", "SES-7B91"]);
  });
});

describe("artifact list toolbar range filters", {
  timeout: SHELL_FLOW_TIMEOUT_MS,
}, () => {
  it("renders a range column's min and max inputs inside the Filters menu", async () => {
    renderShell({
      additionalColumns: [
        {
          filterRange: (artifact) => artifact.aiSpend,
          filterable: true,
          id: "spend",
          kind: ColumnFieldKind.Custom,
          label: "Spend",
          renderCell: () => null,
          width: columnWidthBounds(100),
        },
      ],
    });

    openRadixMenu(screen.getByRole("button", { name: "Filters" }));
    fireEvent.keyDown(await screen.findByRole("menuitem", { name: "Spend" }), {
      key: "ArrowRight",
    });

    expect(await screen.findByPlaceholderText("Min")).toBeTruthy();
    expect(screen.getByPlaceholderText("Max")).toBeTruthy();
  });
});

describe("artifact list summary cards", {
  timeout: SHELL_FLOW_TIMEOUT_MS,
}, () => {
  it("shows each visible metric and drops one the Options menu hides", async () => {
    renderShell();

    expect(
      screen.getByRole("button", { name: ARTIFACTS_CREATED_CARD })
    ).toBeTruthy();

    openRadixMenu(screen.getByRole("button", { name: "Options" }));
    const item = await screen.findByRole("menuitem", {
      name: ARTIFACTS_CREATED_ITEM,
    });
    fireEvent.click(item);
    fireEvent.keyDown(item, { key: "Escape" });

    expect(
      screen.queryByRole("button", { name: ARTIFACTS_CREATED_CARD })
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "About Est. Total" })
    ).toBeTruthy();
  });

  it("renders no cards when the host turns them off", () => {
    renderShell({ showSummaryCards: false });

    expect(
      screen.queryByRole("button", { name: ARTIFACTS_CREATED_CARD })
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Sort" })).toBeTruthy();
  });
});
