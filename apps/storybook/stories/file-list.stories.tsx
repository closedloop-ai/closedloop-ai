import { FileList } from "@repo/design-system/components/ui/primitives/file-list";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A simple bordered panel that lists file paths, each on its own row with a
 * folder icon, under a "Files" header. Use it for a short reference list of
 * file paths, such as the files a change touched, not for anything a person
 * needs to sort, filter, or click into. Long paths wrap rather than
 * truncate, and an empty list shows an italic "No files" message instead of
 * collapsing to nothing.
 */
const meta = {
  title: "Primitives/Data Display/File List",
  component: FileList,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    paths: {
      control: "object",
      description: "Repository-relative file paths, rendered in order.",
    },
  },
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
