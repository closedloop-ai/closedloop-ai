import {
  TableAddFieldDialog,
  type TableCustomFieldReferenceSource,
  TableCustomFieldType,
} from "@closedloop-ai/design-system/components/ui/table-add-field-dialog";
import { TABLE_FIELD_OPTION_COLORS } from "@closedloop-ai/design-system/components/ui/table-add-field-dialog-colors";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Layers2Icon } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

const REFERENCE_SOURCES: readonly TableCustomFieldReferenceSource[] = [
  { icon: Layers2Icon, label: "Artifacts", value: "artifact" },
];
const FIELD_TITLE_PATTERN = /Field title/;

describe("TableAddFieldDialog", () => {
  it("adds an existing field without entering the create form", async () => {
    const onCreate = vi.fn();
    const onOpenChange = vi.fn();
    const onSelectExisting = vi.fn();
    render(
      <TableAddFieldDialog
        existingFields={[
          {
            description: "Primary owner",
            id: "owner-field",
            label: "Owner",
            typeLabel: "People",
          },
        ]}
        onCreate={onCreate}
        onOpenChange={onOpenChange}
        onSelectExisting={onSelectExisting}
        open
      />
    );

    expect(
      screen.getByRole("combobox", { name: "Search fields" })
    ).toHaveFocus();
    expect(
      screen.queryByRole("textbox", { name: FIELD_TITLE_PATTERN })
    ).toBeNull();

    fireEvent.click(screen.getByText("Owner"));

    await waitFor(() =>
      expect(onSelectExisting).toHaveBeenCalledWith("owner-field")
    );
    expect(onCreate).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("enters the existing create form from the picker", async () => {
    const onCreate = vi.fn();
    const onSelectExisting = vi.fn();
    render(
      <TableAddFieldDialog
        existingFields={[]}
        onCreate={onCreate}
        onOpenChange={vi.fn()}
        onSelectExisting={onSelectExisting}
        open
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Create new field" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: FIELD_TITLE_PATTERN }),
      { target: { value: "Stage" } }
    );
    fireEvent.change(screen.getAllByPlaceholderText("Type an option name")[0], {
      target: { value: "Ready" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create field" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onSelectExisting).not.toHaveBeenCalled();
  });

  it("creates an option field without exposing cross-entity applicability", async () => {
    const onCreate = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <TableAddFieldDialog
        onCreate={onCreate}
        onOpenChange={onOpenChange}
        open
        referenceSources={REFERENCE_SOURCES}
      />
    );

    expect(screen.getByRole("heading", { name: "Add field" })).toBeVisible();
    expect(screen.queryByText("Applies to")).not.toBeInTheDocument();
    expect(screen.queryByText("Display options")).not.toBeInTheDocument();

    fireEvent.change(
      screen.getByRole("textbox", { name: FIELD_TITLE_PATTERN }),
      {
        target: { value: "Stage" },
      }
    );
    const optionInputs = screen.getAllByPlaceholderText("Type an option name");
    fireEvent.change(optionInputs[0] as HTMLElement, {
      target: { value: "Ready" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create field" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith({
      description: undefined,
      label: "Stage",
      optionColors: ["bg-success"],
      options: ["Ready"],
      sources: undefined,
      timeFormat: undefined,
      type: TableCustomFieldType.SingleSelect,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("requires one reference source instead of artifact applicability", async () => {
    const onCreate = vi.fn();
    render(
      <TableAddFieldDialog
        onCreate={onCreate}
        onOpenChange={vi.fn()}
        open
        referenceSources={REFERENCE_SOURCES}
      />
    );

    fireEvent.change(
      screen.getByRole("textbox", { name: FIELD_TITLE_PATTERN }),
      {
        target: { value: "Parent" },
      }
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Field type" }));
    fireEvent.click(await screen.findByRole("option", { name: "Reference" }));

    expect(screen.getByText("Source")).toBeVisible();
    expect(screen.getByRole("radio", { name: "Artifacts" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Create field" })).toBeDisabled();

    fireEvent.click(screen.getByRole("radio", { name: "Artifacts" }));
    fireEvent.click(screen.getByRole("button", { name: "Create field" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      label: "Parent",
      sources: ["artifact"],
      type: TableCustomFieldType.Reference,
    });
  });

  it("keeps the dialog open and reports a rejected create", async () => {
    render(
      <TableAddFieldDialog
        onCreate={vi.fn().mockRejectedValue(new Error("unavailable"))}
        onOpenChange={vi.fn()}
        open
      />
    );

    fireEvent.change(
      screen.getByRole("textbox", { name: FIELD_TITLE_PATTERN }),
      {
        target: { value: "Stage" },
      }
    );
    fireEvent.change(screen.getAllByPlaceholderText("Type an option name")[0], {
      target: { value: "Ready" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create field" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't create field. Try again."
    );
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  /**
   * The tuple is a published contract now, not an implementation detail: a
   * consumer keys its persisted-colour map by this element type, so adding,
   * removing or respelling a swatch changes what that consumer can store. Pinned
   * with independent literals in declaration order — the dialog seeds a new
   * option's colour by index, so the ORDER is as load-bearing as the members.
   */
  it("publishes its option swatch classes in a stable order", () => {
    expect([...TABLE_FIELD_OPTION_COLORS]).toEqual([
      "bg-success",
      "bg-warning",
      "bg-primary",
    ]);
  });
});
