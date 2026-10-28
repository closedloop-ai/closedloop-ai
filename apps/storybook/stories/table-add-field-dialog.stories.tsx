import { Button } from "@repo/design-system/components/ui/button";
import {
  TableAddFieldDialog,
  type TableCustomFieldDefinition,
  type TableCustomFieldDraft,
  type TableCustomFieldReferenceSource,
} from "@repo/design-system/components/ui/table-add-field-dialog";
import type { Meta, StoryObj } from "@storybook/react";
import { Layers2Icon, SquareCheckIcon } from "lucide-react";
import { useState } from "react";
import { expect, fireEvent, screen, within } from "storybook/test";

const REFERENCE_SOURCES: readonly TableCustomFieldReferenceSource[] = [
  { icon: Layers2Icon, label: "Artifacts", value: "artifacts" },
  { icon: SquareCheckIcon, label: "Issues", value: "issues" },
];
const FIELD_TITLE_PATTERN = /Field title/;

const meta = {
  title: "Composites v1.0/Data Display/Tables/Table Add Field Dialog",
  tags: ["deprecated"],
  component: TableAddFieldDialog,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TableAddFieldDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    onCreate: () => undefined,
    onOpenChange: () => undefined,
    open: true,
    referenceSources: REFERENCE_SOURCES,
  },
  render: () => <TableAddFieldDialogStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await screen.findByRole("dialog");
    await expect(
      within(dialog).getByRole("heading", { name: "Add field" })
    ).toBeVisible();
    await expect(within(dialog).queryByText("Applies to")).toBeNull();

    fireEvent.change(
      within(dialog).getByRole("textbox", { name: FIELD_TITLE_PATTERN }),
      { target: { value: "Stage" } }
    );
    fireEvent.change(
      within(dialog).getAllByPlaceholderText("Type an option name")[0],
      { target: { value: "Ready" } }
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create field" })
    );

    await expect(canvas.getByText("Stage · Single-select")).toBeVisible();
  },
};

function TableAddFieldDialogStory() {
  const [open, setOpen] = useState(true);
  const [field, setField] = useState<TableCustomFieldDefinition | null>(null);
  const onCreate = (draft: TableCustomFieldDraft) => {
    setField({ ...draft, id: "story-field" });
  };
  return (
    <main className="min-h-screen bg-background p-8">
      <Button onClick={() => setOpen(true)} type="button">
        Add field
      </Button>
      {field ? (
        <p className="mt-4 text-sm">
          {field.label} · {field.type}
        </p>
      ) : null}
      <TableAddFieldDialog
        onCreate={onCreate}
        onOpenChange={setOpen}
        open={open}
        referenceSources={REFERENCE_SOURCES}
      />
    </main>
  );
}
