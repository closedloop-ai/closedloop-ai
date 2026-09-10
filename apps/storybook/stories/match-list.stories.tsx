import { MatchList } from "@repo/design-system/components/ui/primitives/match-list";
import type { Meta, StoryObj } from "@storybook/react";

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
