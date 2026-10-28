import {
  CountCell,
  compareCountValues,
} from "@repo/design-system/components/ui/count-cell";
import type { Meta, StoryObj } from "@storybook/react";
import { MessageSquare, Users } from "lucide-react";

const meta = {
  title: "Composites v1.0/Data Display/Count Cell",
  component: CountCell,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "centered",
  },
  args: {
    count: 12,
    noun: "comments",
    icon: <MessageSquare aria-hidden />,
  },
} satisfies Meta<typeof CountCell>;

export default meta;
type Story = StoryObj<typeof meta>;

// A count of one must read "1 linked session"; the pair is how the cell knows.
const SESSIONS_NOUN = { one: "linked session", other: "linked sessions" };

export const Default: Story = {};

/**
 * The state matrix, and the reason this component exists. The three blanks are
 * deliberately the same glyph and never the same sentence — hover or read them
 * with a screen reader and "No comments", "comments unavailable", and "Loading
 * comments" are three different facts, not one ambiguous dash.
 */
export const States: Story = {
  tags: ["!manifest"],
  render: () => (
    <div className="grid grid-cols-[10rem_auto] items-center gap-x-6 gap-y-3 text-muted-foreground text-sm">
      <span>Has a count</span>
      <CountCell
        count={12}
        icon={<MessageSquare aria-hidden />}
        noun="comments"
      />
      <span>One</span>
      <CountCell
        count={1}
        icon={<MessageSquare aria-hidden />}
        noun="comments"
      />
      <span>Genuinely zero</span>
      <CountCell
        count={0}
        icon={<MessageSquare aria-hidden />}
        noun="comments"
      />
      <span>Not known</span>
      <CountCell
        count={null}
        icon={<MessageSquare aria-hidden />}
        noun="comments"
      />
      <span>Still arriving</span>
      <CountCell
        count={null}
        icon={<MessageSquare aria-hidden />}
        loading
        noun="comments"
      />
      <span>Impossible value</span>
      <CountCell
        count={-4}
        icon={<MessageSquare aria-hidden />}
        noun="comments"
      />
      <span>No icon</span>
      <CountCell count={7} noun="comments" />
    </div>
  ),
};

/**
 * Non-interactive by default. A count becomes a control only when the caller
 * supplies one, and a zero or unknown count never does — a link into an empty
 * list is a dead end, so it stays the shared empty value.
 */
export const Interaction: Story = {
  tags: ["!manifest"],
  render: () => (
    <div className="grid grid-cols-[10rem_auto] items-center gap-x-6 gap-y-3 text-muted-foreground text-sm">
      <span>Plain</span>
      <CountCell count={4} icon={<Users aria-hidden />} noun={SESSIONS_NOUN} />
      <span>Button</span>
      <CountCell
        count={4}
        icon={<Users aria-hidden />}
        noun={SESSIONS_NOUN}
        onSelect={() => undefined}
      />
      <span>Link</span>
      <CountCell
        count={4}
        icon={<Users aria-hidden />}
        noun={SESSIONS_NOUN}
        // Surfaces pass their navigation `Link`; a story has no router. The
        // accessible name is applied by the cell, so the caller supplies only
        // the element.
        renderLink={(content) => <a href="#linked-sessions">{content}</a>}
      />
      <span>One</span>
      <CountCell
        count={1}
        icon={<Users aria-hidden />}
        noun={SESSIONS_NOUN}
        renderLink={(content) => <a href="#linked-sessions">{content}</a>}
      />
      <span>Zero, with a link offered</span>
      <CountCell
        count={0}
        icon={<Users aria-hidden />}
        noun={SESSIONS_NOUN}
        renderLink={(content) => <a href="#linked-sessions">{content}</a>}
      />
    </div>
  ),
};

/**
 * `compareCountValues` sorts ascending and keeps every unknown after every
 * known value in BOTH directions, so flipping the column never floats "we don't
 * know" to the top.
 */
export const Sorting: Story = {
  render: () => {
    const values: (number | null)[] = [3, null, 0, 10];
    return (
      <div className="flex flex-col gap-2 text-sm">
        <SortRow
          label="Ascending"
          values={[...values].sort((a, b) => compareCountValues(a, b))}
        />
        <SortRow
          label="Descending"
          values={[...values].sort((a, b) => compareCountValues(a, b, "desc"))}
        />
      </div>
    );
  },
};

/**
 * The only place the contract is really legible: a column. `alignEnd` sinks
 * every state to the right edge, so the em-dash sits under the digits it stands
 * in for and the tabular figures line up row to row. The `sm` size is what the
 * denser tables (approved branches) render their count at.
 */
export const InAColumn: Story = {
  render: () => (
    <div className="w-64 divide-y rounded-md border text-sm">
      {COLUMN_ROWS.map((row) => (
        <div className="flex items-center px-3 py-2" key={row.label}>
          <span className="text-muted-foreground">{row.label}</span>
          <CountCell
            alignEnd
            count={row.count}
            icon={<Users aria-hidden />}
            loading={row.loading}
            noun={SESSIONS_NOUN}
            size={row.size}
          />
        </div>
      ))}
    </div>
  ),
};

const COLUMN_ROWS: {
  label: string;
  count: number | null;
  loading?: boolean;
  size?: "sm";
}[] = [
  { label: "feat/auth", count: 108 },
  { label: "feat/billing", count: 7 },
  { label: "fix/relay", count: 1 },
  { label: "chore/deps", count: 0 },
  { label: "spike/graph", count: null },
  { label: "feat/search", count: null, loading: true },
  { label: "Dense table", count: 12, size: "sm" },
];

function SortRow({
  label,
  values,
}: Readonly<{ label: string; values: (number | null)[] }>) {
  return (
    <div className="flex items-center gap-4">
      <span className="w-24 text-muted-foreground">{label}</span>
      {values.map((value) => (
        <CountCell
          count={value}
          icon={<MessageSquare aria-hidden />}
          key={`${label}-${String(value)}`}
          noun="comments"
        />
      ))}
    </div>
  );
}
