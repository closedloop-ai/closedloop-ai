import { TableInlineCreateRow } from "@repo/design-system/components/ui/table-inline-create-row";
import type { Meta, StoryObj } from "@storybook/react";
import { type ComponentProps, useState } from "react";
import { expect, fireEvent, fn, userEvent, within } from "storybook/test";

const meta = {
  title: "Composites v1.0/Data Display/Tables/Table Inline Create Row",
  tags: ["deprecated"],
  component: TableInlineCreateRow,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TableInlineCreateRow>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    active: false,
    gridTemplateColumns: "36px minmax(260px, 1fr) 160px",
    label: "Add artifact",
    onActivate: fn(),
    onCancel: fn(),
    onCommit: fn(),
    placeholder: "Artifact name",
  },
  render: (args) => <InlineCreateRowStory {...args} />,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Add artifact" }));
    const input = canvas.getByRole("textbox", { name: "Add artifact name" });
    await expect(input).toHaveFocus();
    await userEvent.type(input, "Portable surface");
    fireEvent.keyDown(input, { key: "Enter" });
    await expect(args.onCommit).toHaveBeenCalledWith("Portable surface");
  },
};

function InlineCreateRowStory({
  onActivate,
  onCancel,
  onCommit,
  ...props
}: ComponentProps<typeof TableInlineCreateRow>) {
  const [active, setActive] = useState(false);
  return (
    <main className="min-h-screen bg-background p-8">
      <div className="overflow-hidden rounded-md border">
        <TableInlineCreateRow
          {...props}
          active={active}
          onActivate={() => {
            setActive(true);
            onActivate();
          }}
          onCancel={() => {
            setActive(false);
            onCancel();
          }}
          onCommit={onCommit}
        />
      </div>
    </main>
  );
}
