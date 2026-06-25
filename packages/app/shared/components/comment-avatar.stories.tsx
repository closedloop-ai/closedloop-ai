import { CommentAvatar } from "@repo/app/shared/components/comment-avatar";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "App Core/Shared/Comment Avatar",
  component: CommentAvatar,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    author: "Annie Case",
    authorAvatar: null,
    size: "md",
  },
} satisfies Meta<typeof CommentAvatar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Human: Story = {};

export const Bot: Story = {
  args: {
    author: "Closedloop Bot",
    authorKind: "bot",
  },
};

export const WithImage: Story = {
  args: {
    authorAvatar:
      "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 80'><rect width='80' height='80' fill='%23d4d4d8'/><circle cx='40' cy='30' r='16' fill='%239ca3af'/><path d='M16 68c6-14 18-22 24-22s18 8 24 22' fill='%239ca3af'/></svg>",
    size: "sm",
  },
};
