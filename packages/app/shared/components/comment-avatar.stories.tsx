import { PrCommentAuthorKind } from "@repo/api/src/types/branch-view";
import { CommentAvatar } from "@repo/app/shared/components/comment-avatar";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A small square avatar for a pull request comment's author, including a bot
 * icon, used instead of the design system's general round Avatar.
 */
const meta = {
  title: "Composites/Branches/Comment Avatar",
  component: CommentAvatar,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    author: {
      control: "text",
      description: "Also the source of the two-letter fallback initials.",
    },
    authorAvatar: {
      control: "text",
      description: "Image URL. Null or absent falls back to the initials.",
    },
    authorKind: {
      control: { type: "radio" },
      options: Object.values(PrCommentAuthorKind),
      description: "Bot authors get the glyph tile instead of an avatar.",
    },
    size: { control: { type: "radio" }, options: ["md", "sm", "xs"] },
  },
  args: {
    author: "Annie Case",
    authorAvatar: null,
    authorKind: PrCommentAuthorKind.User,
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
