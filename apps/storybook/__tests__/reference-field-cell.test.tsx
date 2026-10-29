import type { TableCustomFieldDefinition as CustomFieldDefinition } from "@repo/design-system/components/ui/table-add-field-dialog";
import { composeStory } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { describe, expect, it, vi } from "vitest";
import { EditableReferenceFieldCell } from "../../../packages/app/shared/components/generic-artifact-surface/reference-field-cell";

const FEA_2481_PATTERN = /FEA-2481/;
const ISS_4382_PATTERN = /ISS-4382/;
const BRN_GRID_TABLE_V2_PATTERN = /BRN-grid-table-v2/;
const SES_7B91_PATTERN = /SES-7B91/;
const DOC_184_PATTERN = /DOC-184/;
const AGT_REVIEW_SOUL_PATTERN = /AGT-review-soul/;
const PRJ_SYMPHONY_PATTERN = /PRJ-symphony/;
const DONE_BUTTON_NAME = "Done";

const FIELD_NO_SOURCES: CustomFieldDefinition = {
  id: "custom-related",
  label: "Related",
  type: "Reference",
};

const FIELD_ISSUES_SINGLE: CustomFieldDefinition = {
  id: "custom-parent-issue",
  label: "Parent issue",
  type: "Reference",
  sources: ["Issues"],
};

const FIELD_ISSUES_MULTI: CustomFieldDefinition = {
  id: "custom-related-issues",
  label: "Related issues",
  type: "Reference (multi)",
  sources: ["Issues"],
};

const FIELD_ARTIFACTS_MULTI_VIA_SOURCE: CustomFieldDefinition = {
  id: "custom-related-artifacts",
  label: "Related artifacts",
  type: "Reference",
  sources: ["Artifacts"],
};

function renderReferenceFieldCell({
  field,
  values = [],
  onChange = vi.fn(),
}: {
  field: CustomFieldDefinition;
  values?: readonly string[];
  onChange?: (value: string | readonly string[] | null) => void;
}) {
  const Story = composeStory(
    {
      render: () => (
        <EditableReferenceFieldCell
          field={field}
          onChange={onChange}
          values={values}
        />
      ),
    },
    {
      title: "Test/EditableReferenceFieldCell",
      component: EditableReferenceFieldCell,
    }
  );
  return { Story, onChange };
}

async function openPopover(screen: ReturnType<typeof within>, source: string) {
  await userEvent.click(
    screen.getByRole("button", {
      name: `Edit ${source.toLowerCase()} reference`,
    })
  );
  return screen.findByLabelText(`Search ${source.toLowerCase()} references`);
}

describe("EditableReferenceFieldCell", () => {
  describe("source resolution", () => {
    it("falls back to Artifacts when field.sources is undefined, and shows every source kind's options", async () => {
      const { Story } = renderReferenceFieldCell({ field: FIELD_NO_SOURCES });
      await Story.run();
      const screen = within(document.body);
      const searchInput = await openPopover(screen, "Artifacts");
      expect(searchInput).toHaveAttribute("placeholder", "Search Artifacts…");

      expect(
        screen.getByRole("button", { name: FEA_2481_PATTERN })
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: ISS_4382_PATTERN })
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: BRN_GRID_TABLE_V2_PATTERN })
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: SES_7B91_PATTERN })
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: DOC_184_PATTERN })
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: AGT_REVIEW_SOUL_PATTERN })
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: PRJ_SYMPHONY_PATTERN })
      ).toBeTruthy();
    });

    it("filters options down to the matching source kind when source is not Artifacts", async () => {
      const { Story } = renderReferenceFieldCell({
        field: FIELD_ISSUES_SINGLE,
      });
      await Story.run();
      const screen = within(document.body);
      const searchInput = await openPopover(screen, "Issues");
      expect(searchInput).toHaveAttribute("placeholder", "Search Issues…");

      expect(
        screen.getByRole("button", { name: FEA_2481_PATTERN })
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: ISS_4382_PATTERN })
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: BRN_GRID_TABLE_V2_PATTERN })
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: SES_7B91_PATTERN })
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: DOC_184_PATTERN })
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: AGT_REVIEW_SOUL_PATTERN })
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: PRJ_SYMPHONY_PATTERN })
      ).toBeNull();
    });
  });

  describe("toggling a value", () => {
    it("single mode: selecting an option reports a single id and closes the popover", async () => {
      const { Story, onChange } = renderReferenceFieldCell({
        field: FIELD_ISSUES_SINGLE,
      });
      await Story.run();
      const screen = within(document.body);
      await openPopover(screen, "Issues");

      await userEvent.click(
        screen.getByRole("button", { name: FEA_2481_PATTERN })
      );

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith("FEA-2481");
      expect(screen.queryByLabelText("Search issues references")).toBeNull();
    });

    it("multiple mode via Reference (multi): selecting a new option adds to the existing values", async () => {
      const { Story, onChange } = renderReferenceFieldCell({
        field: FIELD_ISSUES_MULTI,
        values: ["FEA-2481"],
      });
      await Story.run();
      const screen = within(document.body);
      await openPopover(screen, "Issues");

      await userEvent.click(
        screen.getByRole("button", { name: ISS_4382_PATTERN })
      );

      expect(onChange).toHaveBeenCalledWith(["FEA-2481", "ISS-4382"]);
      // Multiple mode never auto-closes on selection.
      expect(screen.getByLabelText("Search issues references")).toBeTruthy();
    });

    it("multiple mode: selecting an already-selected option removes it", async () => {
      const { Story, onChange } = renderReferenceFieldCell({
        field: FIELD_ISSUES_MULTI,
        values: ["FEA-2481", "ISS-4382"],
      });
      await Story.run();
      const screen = within(document.body);
      await openPopover(screen, "Issues");

      await userEvent.click(
        screen.getByRole("button", { name: FEA_2481_PATTERN })
      );

      expect(onChange).toHaveBeenCalledWith(["ISS-4382"]);
    });

    it("multiple mode driven by an Artifacts source: toggling reports an array across kinds", async () => {
      const { Story, onChange } = renderReferenceFieldCell({
        field: FIELD_ARTIFACTS_MULTI_VIA_SOURCE,
      });
      await Story.run();
      const screen = within(document.body);
      await openPopover(screen, "Artifacts");

      await userEvent.click(
        screen.getByRole("button", { name: PRJ_SYMPHONY_PATTERN })
      );

      expect(onChange).toHaveBeenCalledWith(["PRJ-symphony"]);
      expect(screen.getByLabelText("Search artifacts references")).toBeTruthy();
    });
  });

  describe("Done button", () => {
    it("shows a selection count and closes the popover when clicked, only in multiple mode with values", async () => {
      const { Story } = renderReferenceFieldCell({
        field: FIELD_ISSUES_MULTI,
        values: ["FEA-2481"],
      });
      await Story.run();
      const screen = within(document.body);
      await openPopover(screen, "Issues");

      expect(screen.getByText("1 selected")).toBeTruthy();
      await userEvent.click(
        screen.getByRole("button", { name: DONE_BUTTON_NAME })
      );

      expect(screen.queryByLabelText("Search issues references")).toBeNull();
    });

    it("is absent in multiple mode when there are no selected values", async () => {
      const { Story } = renderReferenceFieldCell({
        field: FIELD_ISSUES_MULTI,
        values: [],
      });
      await Story.run();
      const screen = within(document.body);
      await openPopover(screen, "Issues");

      expect(
        screen.queryByRole("button", { name: DONE_BUTTON_NAME })
      ).toBeNull();
    });

    it("is absent in single mode even when a value is present", async () => {
      const { Story } = renderReferenceFieldCell({
        field: FIELD_ISSUES_SINGLE,
        values: ["FEA-2481"],
      });
      await Story.run();
      const screen = within(document.body);
      await openPopover(screen, "Issues");

      expect(
        screen.queryByRole("button", { name: DONE_BUTTON_NAME })
      ).toBeNull();
    });
  });

  describe("search", () => {
    it("filters the option list by slug or title text", async () => {
      const { Story } = renderReferenceFieldCell({ field: FIELD_NO_SOURCES });
      await Story.run();
      const screen = within(document.body);
      const searchInput = await openPopover(screen, "Artifacts");

      await userEvent.type(searchInput, "review");

      expect(
        screen.getByRole("button", { name: AGT_REVIEW_SOUL_PATTERN })
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: FEA_2481_PATTERN })
      ).toBeNull();
    });

    it("renders 'No matching artifacts' when the query matches nothing", async () => {
      const { Story } = renderReferenceFieldCell({ field: FIELD_NO_SOURCES });
      await Story.run();
      const screen = within(document.body);
      const searchInput = await openPopover(screen, "Artifacts");

      await userEvent.type(searchInput, "zzz-nonexistent");

      expect(screen.getByText("No matching artifacts")).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: FEA_2481_PATTERN })
      ).toBeNull();
    });

    it("clears the query when the popover closes, so reopening shows the full list again", async () => {
      const { Story } = renderReferenceFieldCell({ field: FIELD_NO_SOURCES });
      await Story.run();
      const screen = within(document.body);
      const searchInput = await openPopover(screen, "Artifacts");

      await userEvent.type(searchInput, "review");
      expect(
        screen.queryByRole("button", { name: FEA_2481_PATTERN })
      ).toBeNull();

      // Toggle the trigger to close, then reopen.
      await userEvent.click(
        screen.getByRole("button", { name: "Edit artifacts reference" })
      );
      expect(screen.queryByLabelText("Search artifacts references")).toBeNull();

      const reopenedSearchInput = await openPopover(screen, "Artifacts");
      expect(reopenedSearchInput).toHaveValue("");
      expect(
        screen.getByRole("button", { name: FEA_2481_PATTERN })
      ).toBeTruthy();
    });
  });

  describe("unknown reference id", () => {
    it("renders the raw id as a fallback label when the value has no matching option", async () => {
      const { Story } = renderReferenceFieldCell({
        field: FIELD_NO_SOURCES,
        values: ["unknown-id-123"],
      });
      await Story.run();
      const screen = within(document.body);
      // The raw id appears in both the slug span and the label — assert it exists at all
      expect(screen.getAllByText("unknown-id-123").length).toBeGreaterThan(0);
    });
  });
});
