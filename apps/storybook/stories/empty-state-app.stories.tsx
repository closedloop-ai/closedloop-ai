import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import type { Meta, StoryObj } from "@storybook/react";
import { FolderSearchIcon } from "lucide-react";

/**
 * This shows the same empty state block dressed in real product copy: no
 * related artifacts yet, and no favorites yet, each pairing an icon, a
 * title, a description, and a call to action button. Look here when writing
 * the wording for a new empty state, since it shows how a title,
 * description, and button actually read together rather than in the
 * abstract. Drop the button entirely when there's nothing useful to send
 * someone to do next, and the layout adjusts to fill the space on its own.
 */
const meta = {
  title: "Composites/Feedback & Status/Empty State App Example",
  component: EmptyState,
  tags: ["autodocs"],
  argTypes: {
    icon: {
      control: false,
      description: "Lucide icon component rendered above the title.",
    },
    title: { control: "text" },
    titleAs: {
      options: ["h1", "h2", "h3"],
      control: { type: "radio" },
      description:
        "Promotes the title to a real heading for full-page empty states.",
    },
    description: { control: "text" },
    size: {
      options: ["default", "compact"],
      control: { type: "radio" },
    },
    action: {
      control: false,
      description: "Optional call-to-action node rendered under the copy.",
    },
    className: { control: "text" },
  },
  args: {
    icon: FolderSearchIcon,
    size: "default",
    title: "No related artifacts yet",
    description:
      "Attach a PRD or implementation plan to start building the relationship graph.",
    action: <Button>Create related artifact</Button>,
  },
} satisfies Meta<typeof EmptyState>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithoutAction: Story = {
  args: {
    action: undefined,
    title: "No favorites yet",
    description:
      "Pin projects or artifacts to keep important work within reach in the sidebar.",
  },
};
