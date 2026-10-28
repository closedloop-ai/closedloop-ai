import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { composeStory } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { describe, expect, it } from "vitest";
import { SessionStatus } from "../stories/grid-table-toolbar-demo/fixtures";
import { ListSurfaceDemo } from "../stories/grid-table-toolbar-demo/list-surface-demo";

const OTTILIE_EASTWICK_PATTERN = /^Ottilie Eastwick/;
const PASCOE_BIRCHALL_PATTERN = /^Pascoe Birchall/;
const MARISOL_ASHGROVE_PATTERN = /^Marisol Ashgrove/;
const FAILED_PATTERN = /^Failed/;
const BLOCKED_PATTERN = /^Blocked/;
const PAGINATION_NAV_NAME = "pagination";

async function renderDemo(
  props: {
    initialGrouping?: TableGroupingState;
    initialStatuses?: readonly string[];
  } = {}
) {
  const Story = composeStory(
    { render: () => <ListSurfaceDemo {...props} /> },
    { title: "Test/ListSurfaceDemo", component: ListSurfaceDemo }
  );
  await Story.run();
  return within(document.body);
}

function rowFor(sessionId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `[data-grid-row-id="${sessionId}"]`
  );
  if (!row) {
    throw new Error(`Missing rendered row for ${sessionId}`);
  }
  return row;
}

function metricValueText(label: string): string | null {
  const descriptions = Array.from(
    document.querySelectorAll('[data-slot="card-description"]')
  );
  const description = descriptions.find((el) => el.textContent === label);
  if (!description) {
    return null;
  }
  const card = description.closest('[data-slot="card"]');
  return card?.querySelector('[data-slot="card-title"]')?.textContent ?? null;
}

function precedes(a: Element, b: Element): boolean {
  return Boolean(
    // biome-ignore lint/suspicious/noBitwiseOperators: DOM compareDocumentPosition requires bitwise AND
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
  );
}

describe("ListSurfaceDemo", () => {
  describe("default render", () => {
    it("shows the first page of rows and the sessions/spend metric cards", async () => {
      const screen = await renderDemo();
      expect(screen.getByText("agent/refactor-auth-guard")).toBeTruthy();
      expect(screen.getByText("fix/token-rounding")).toBeTruthy();
      expect(screen.getByText("agent/seed-generator")).toBeTruthy();
      expect(screen.getByText("feat/grid-table-toolbar")).toBeTruthy();
      expect(screen.queryByText("chore/upgrade-prisma")).toBeNull();
      expect(screen.queryByText("agent/backfill-telemetry")).toBeNull();
      expect(
        screen.getByRole("navigation", { name: PAGINATION_NAV_NAME })
      ).toBeTruthy();
      expect(metricValueText("Sessions")).toBe("6");
      expect(metricValueText("Token spend")).toBe("$18.37");
    });

    it("does not render the hidden Active now and Failures metrics by default", async () => {
      await renderDemo();
      expect(metricValueText("Active now")).toBeNull();
      expect(metricValueText("Failures")).toBeNull();
    });
  });

  describe("filtering by initialStatuses", () => {
    it("narrows the rendered rows and the metric cards to the selected statuses", async () => {
      const screen = await renderDemo({
        initialStatuses: [SessionStatus.Active],
      });
      expect(screen.getByText("agent/refactor-auth-guard")).toBeTruthy();
      expect(screen.getByText("feat/grid-table-toolbar")).toBeTruthy();
      expect(screen.queryByText("fix/token-rounding")).toBeNull();
      expect(screen.queryByText("agent/seed-generator")).toBeNull();
      expect(screen.queryByText("chore/upgrade-prisma")).toBeNull();
      expect(screen.queryByText("agent/backfill-telemetry")).toBeNull();
      expect(metricValueText("Sessions")).toBe("2");
      expect(metricValueText("Token spend")).toBe("$13.99");
    });

    it("filters by Failed status", async () => {
      const screen = await renderDemo({
        initialStatuses: [SessionStatus.Failed],
      });
      expect(screen.getByText("fix/token-rounding")).toBeTruthy();
      expect(screen.queryByText("agent/refactor-auth-guard")).toBeNull();
      expect(metricValueText("Sessions")).toBe("1");
      expect(metricValueText("Token spend")).toBe("$0.24");
    });

    it("filters by Done status showing two rows", async () => {
      const screen = await renderDemo({
        initialStatuses: [SessionStatus.Done],
      });
      expect(screen.getByText("agent/seed-generator")).toBeTruthy();
      expect(screen.getByText("agent/backfill-telemetry")).toBeTruthy();
      expect(screen.queryByText("agent/refactor-auth-guard")).toBeNull();
      expect(metricValueText("Sessions")).toBe("2");
    });

    it("filters by multiple statuses", async () => {
      const screen = await renderDemo({
        initialStatuses: [SessionStatus.Active, SessionStatus.Failed],
      });
      expect(screen.getByText("agent/refactor-auth-guard")).toBeTruthy();
      expect(screen.getByText("fix/token-rounding")).toBeTruthy();
      expect(screen.getByText("feat/grid-table-toolbar")).toBeTruthy();
      expect(screen.queryByText("agent/seed-generator")).toBeNull();
    });
  });

  describe("grouping", () => {
    it("hides pagination and renders every row when grouped", async () => {
      const grouping: TableGroupingState = {
        primary: {
          fieldId: "status",
          order: TableGroupOrder.Custom,
          showEmptyGroups: false,
        },
        secondary: EMPTY_TABLE_GROUPING.secondary,
      };
      const screen = await renderDemo({ initialGrouping: grouping });
      expect(
        screen.queryByRole("navigation", { name: PAGINATION_NAV_NAME })
      ).toBeNull();
      for (const name of [
        "agent/refactor-auth-guard",
        "fix/token-rounding",
        "agent/seed-generator",
        "feat/grid-table-toolbar",
        "chore/upgrade-prisma",
        "agent/backfill-telemetry",
      ]) {
        expect(screen.getByText(name)).toBeTruthy();
      }
    });

    it("orders primary groups by Custom (insertion) order", async () => {
      const grouping: TableGroupingState = {
        primary: {
          fieldId: "owner",
          order: TableGroupOrder.Custom,
          showEmptyGroups: false,
        },
        secondary: EMPTY_TABLE_GROUPING.secondary,
      };
      const screen = await renderDemo({ initialGrouping: grouping });
      const ottilie = screen.getByRole("button", {
        name: OTTILIE_EASTWICK_PATTERN,
      });
      const pascoe = screen.getByRole("button", {
        name: PASCOE_BIRCHALL_PATTERN,
      });
      const marisol = screen.getByRole("button", {
        name: MARISOL_ASHGROVE_PATTERN,
      });
      expect(precedes(ottilie, pascoe)).toBe(true);
      expect(precedes(pascoe, marisol)).toBe(true);
    });

    it("orders primary groups Ascending alphabetically", async () => {
      const grouping: TableGroupingState = {
        primary: {
          fieldId: "owner",
          order: TableGroupOrder.Ascending,
          showEmptyGroups: false,
        },
        secondary: EMPTY_TABLE_GROUPING.secondary,
      };
      const screen = await renderDemo({ initialGrouping: grouping });
      const ottilie = screen.getByRole("button", {
        name: OTTILIE_EASTWICK_PATTERN,
      });
      const pascoe = screen.getByRole("button", {
        name: PASCOE_BIRCHALL_PATTERN,
      });
      const marisol = screen.getByRole("button", {
        name: MARISOL_ASHGROVE_PATTERN,
      });
      expect(precedes(ottilie, marisol)).toBe(true);
      expect(precedes(marisol, pascoe)).toBe(true);
    });

    it("orders primary groups Descending alphabetically", async () => {
      const grouping: TableGroupingState = {
        primary: {
          fieldId: "owner",
          order: TableGroupOrder.Descending,
          showEmptyGroups: false,
        },
        secondary: EMPTY_TABLE_GROUPING.secondary,
      };
      const screen = await renderDemo({ initialGrouping: grouping });
      const ottilie = screen.getByRole("button", {
        name: OTTILIE_EASTWICK_PATTERN,
      });
      const pascoe = screen.getByRole("button", {
        name: PASCOE_BIRCHALL_PATTERN,
      });
      const marisol = screen.getByRole("button", {
        name: MARISOL_ASHGROVE_PATTERN,
      });
      expect(precedes(pascoe, marisol)).toBe(true);
      expect(precedes(marisol, ottilie)).toBe(true);
    });

    it("orders a two-level grouping's secondary level in Custom order", async () => {
      const grouping: TableGroupingState = {
        primary: {
          fieldId: "owner",
          order: TableGroupOrder.Custom,
          showEmptyGroups: false,
        },
        secondary: {
          fieldId: "status",
          order: TableGroupOrder.Custom,
          showEmptyGroups: false,
        },
      };
      const screen = await renderDemo({ initialGrouping: grouping });
      const failed = screen.getByRole("button", { name: FAILED_PATTERN });
      const blocked = screen.getByRole("button", { name: BLOCKED_PATTERN });
      expect(precedes(failed, blocked)).toBe(true);
    });

    it("orders a two-level grouping's secondary level Ascending", async () => {
      const grouping: TableGroupingState = {
        primary: {
          fieldId: "owner",
          order: TableGroupOrder.Custom,
          showEmptyGroups: false,
        },
        secondary: {
          fieldId: "status",
          order: TableGroupOrder.Ascending,
          showEmptyGroups: false,
        },
      };
      const screen = await renderDemo({ initialGrouping: grouping });
      const blocked = screen.getByRole("button", { name: BLOCKED_PATTERN });
      const failed = screen.getByRole("button", { name: FAILED_PATTERN });
      expect(precedes(blocked, failed)).toBe(true);
    });

    it("groups by repository to exercise a non-person non-status field", async () => {
      const grouping: TableGroupingState = {
        primary: {
          fieldId: "repository",
          order: TableGroupOrder.Ascending,
          showEmptyGroups: false,
        },
        secondary: EMPTY_TABLE_GROUPING.secondary,
      };
      const screen = await renderDemo({ initialGrouping: grouping });
      const groups = screen
        .getAllByRole("button")
        .filter((btn) => btn.textContent?.includes("closedloop-ai/"));
      expect(groups.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("renderSessionCell", () => {
    it("formats the cost column as currency and renders other columns as strings", async () => {
      await renderDemo();
      const withinRow = within(rowFor("ses_7b91"));
      expect(withinRow.getByText("$4.12")).toBeTruthy();
      expect(withinRow.getByText("18m")).toBeTruthy();
      expect(withinRow.getByText("Ottilie Eastwick")).toBeTruthy();
      expect(withinRow.getByText("2 hours ago")).toBeTruthy();
    });

    it("renders non-cost columns via the string fallback", async () => {
      await renderDemo();
      const withinRow = within(rowFor("ses_7b74"));
      expect(withinRow.getByText("$0.24")).toBeTruthy();
      expect(withinRow.getByText("Pascoe Birchall")).toBeTruthy();
      expect(withinRow.getByText("41m")).toBeTruthy();
    });
  });

  describe("metricValue", () => {
    it("computes the sessions metric via the default row-count branch", async () => {
      await renderDemo({
        initialStatuses: [SessionStatus.Blocked],
      });
      expect(metricValueText("Sessions")).toBe("1");
      expect(metricValueText("Token spend")).toBe("$0.61");
    });

    it("computes the sessions count for the full population", async () => {
      await renderDemo();
      expect(metricValueText("Sessions")).toBe("6");
    });
  });

  describe("sortRows", () => {
    it("sorts by cost using numeric comparison in ascending order", async () => {
      const screen = await renderDemo();

      await userEvent.click(screen.getByRole("button", { name: "Cost" }));
      await userEvent.click(screen.getByRole("button", { name: "Cost" }));

      expect(renderedRowIds()).toEqual([
        "ses_7b74",
        "ses_7b12",
        "ses_7b58",
        "ses_7a98",
      ]);
    });
  });

  describe("combined filtering and grouping", () => {
    it("applies status filter with grouping, showing only matching rows", async () => {
      const grouping: TableGroupingState = {
        primary: {
          fieldId: "owner",
          order: TableGroupOrder.Ascending,
          showEmptyGroups: false,
        },
        secondary: EMPTY_TABLE_GROUPING.secondary,
      };
      const screen = await renderDemo({
        initialGrouping: grouping,
        initialStatuses: [SessionStatus.Active],
      });
      expect(screen.getByText("agent/refactor-auth-guard")).toBeTruthy();
      expect(screen.getByText("feat/grid-table-toolbar")).toBeTruthy();
      expect(screen.queryByText("fix/token-rounding")).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("renders an empty state when all rows are filtered out", async () => {
      const _screen = await renderDemo({
        initialStatuses: ["NonexistentStatus"],
      });
      expect(metricValueText("Sessions")).toBe("0");
      expect(metricValueText("Token spend")).toBe("$0.00");
    });

    it("groups with secondary level Descending", async () => {
      const grouping: TableGroupingState = {
        primary: {
          fieldId: "owner",
          order: TableGroupOrder.Custom,
          showEmptyGroups: false,
        },
        secondary: {
          fieldId: "status",
          order: TableGroupOrder.Descending,
          showEmptyGroups: false,
        },
      };
      const screen = await renderDemo({ initialGrouping: grouping });
      const failed = screen.getByRole("button", { name: FAILED_PATTERN });
      const blocked = screen.getByRole("button", { name: BLOCKED_PATTERN });
      expect(precedes(failed, blocked)).toBe(true);
    });
  });
});

function renderedRowIds() {
  return Array.from(document.querySelectorAll("[data-grid-row-id]")).map(
    (row) => row.getAttribute("data-grid-row-id")
  );
}
