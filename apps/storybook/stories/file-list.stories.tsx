import { FileList } from "@repo/design-system/components/ui/primitives/file-list";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Primitives/File List",
  component: FileList,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    paths: [
      "apps/app/app/(authenticated)/sessions/page.tsx",
      "packages/design-system/components/ui/composites/session-table.tsx",
      "apps/storybook/stories/session-table.stories.tsx",
    ],
  },
} satisfies Meta<typeof FileList>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
