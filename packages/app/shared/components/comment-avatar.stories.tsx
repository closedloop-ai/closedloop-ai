import { PrCommentAuthorKind } from "@repo/api/src/types/branch-view";
import { CommentAvatar } from "@repo/app/shared/components/comment-avatar";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * Every story renders the avatar inside the AUTHOR ROW, because that row is the
 * component's contract rather than set dressing (whitlockk, PR #6640).
 *
 * `CommentAvatar` is decorative by design since ISS-7441 — the photo carries
 * `alt=""` and the bot glyph is `aria-hidden` — so the caller owns the name.
 * Mounted bare, `WithImage` was a story with NO accessible author at all: once
 * that data URI loads, Radix unmounts the `AvatarFallback` and the initials go
 * with it. `Bot` was the same, its glyph having always been silent. A story is
 * the reference render, so one that drops the name teaches the mount this
 * component's own docstring forbids.
 *
 * The row is the shape production uses (`renderSessionCell`'s owner cell): the
 * avatar, then the name, on shared spacing and type tokens.
 */
const meta = {
  title: "Composites v1.0/App Shell/Comment Avatar",
  component: CommentAvatar,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
  decorators: [
    (Story, context) => (
      <span className="flex min-w-0 items-center gap-2">
        <Story />
        <span className="truncate text-sm">{context.args.author}</span>
      </span>
    ),
  ],
  args: {
    author: "Annie Case",
    authorAvatar: null,
    authorKind: PrCommentAuthorKind.User,
    size: "md",
  },
  argTypes: {
    author: { control: "text", table: { category: "Identity" } },
    authorAvatar: { control: "text", table: { category: "Image" } },
    authorKind: {
      control: "inline-radio",
      options: Object.values(PrCommentAuthorKind),
      table: { category: "Identity" },
    },
    size: {
      control: "inline-radio",
      options: ["md", "sm", "xs"],
      table: { category: "Appearance" },
    },
  },
} satisfies Meta<typeof CommentAvatar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Human: Story = {};

export const Bot: Story = {
  args: {
    author: "Closedloop Bot",
    authorKind: PrCommentAuthorKind.Bot,
  },
};

export const WithImage: Story = {
  args: {
    authorAvatar:
      "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 80'><rect width='80' height='80' fill='%23d4d4d8'/><circle cx='40' cy='30' r='16' fill='%239ca3af'/><path d='M16 68c6-14 18-22 24-22s18 8 24 22' fill='%239ca3af'/></svg>",
    size: "sm",
  },
};

export const FailedImage: Story = {
  args: {
    authorAvatar: "data:image/png;base64,broken",
  },
};

/** The smallest size — compact rails and inline mention chips. */
export const Xs: Story = {
  args: {
    size: "xs",
  },
};
