import { MatchList } from "@repo/design-system/components/ui/primitives/match-list";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * Shows a list of search hits, grep style: each entry carries a file path, a
 * line number, and the matching line of text, inside a bordered card with a
 * search icon. Use it to display the results of a text or code search,
 * rather than Key Value Grid, which is built for a single record's fields. A
 * match can leave out its file or line number, in which case that piece is
 * simply dropped from the row instead of shown blank.
 */
const meta = {
  title: "Primitives/Data Display/Match List",
  component: MatchList,
  tags: ["autodocs"],
  argTypes: {
    matches: {
      control: "object",
      description:
        "Grep-style hits. Each entry renders its file, line, and text when present.",
    },
  },
  parameters: { layout: "padded" },
  args: {
    matches: [
      {
        file: "apps/app/app/(authenticated)/sessions/page.tsx",
        line: 52,
        text: "function SessionsTable({ items }: { items: AgentSessionListItem[] }) {",
      },
      {
        file: "packages/design-system/components/ui/composites/session-table.tsx",
        line: 35,
        text: "export function SessionTable({ rows }: SessionTableProps) {",
      },
    ],
  },
} satisfies Meta<typeof MatchList>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
