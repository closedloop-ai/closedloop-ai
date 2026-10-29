import { Priority } from "@repo/api/src/types/common";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import type { AgentSessionsDataSource } from "../../data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "../../data-source/provider";
import { createSessionTableRowFixture } from "./session-list-fixtures";
import { SessionPriorityCell } from "./session-priority-cell";

/**
 * ISS-10332: the Sessions grid's `Priority` cell in its 120px track. Tests pin
 * the words; what only a render answers is whether the glyph-plus-label fits
 * the track, whether the unset dash sits at the label's own scale, and what the
 * trigger's hover box and focus ring look like beside the row's Tags trigger.
 *
 * Controls: `row` is the one prop, and its `priority` is the whole matrix, so
 * each state is its own story rather than a control that would let the sandbox
 * assemble a row the producer never emits.
 */
const meta = {
  title: "Composites v1.0/Sessions/Session Priority Cell",
  component: SessionPriorityCell,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "padded",
    appCore: {
      apiRoutes: [
        // The write the editor commits through; the fixture transport answers
        // it so the optimistic row settles as accepted.
        { method: "PATCH", path: "/agent-sessions/*", respond: () => ({}) },
      ],
    },
  },
  decorators: [inTrack],
  args: {
    row: createSessionTableRowFixture({ priority: Priority.High }),
  },
} satisfies Meta<typeof SessionPriorityCell>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A set value: glyph and word, the trigger being the whole mark. */
export const WithValue: Story = {};

/** Unset: the grid's own empty mark, at the label's scale, still a trigger. */
export const Unset: Story = {
  args: { row: createSessionTableRowFixture({ priority: null }) },
};

/**
 * A producer that OMITTED the field (an older API or Desktop build): the empty
 * glyph and no control at all.
 */
export const Omitted: Story = {
  args: { row: createSessionTableRowFixture() },
};

/**
 * A member only a newer peer knows: the design system's fallback glyph and
 * "Unknown priority", never folded to none.
 */
export const UnknownMember: Story = {
  args: {
    // The wire boundary lets a value outside this build's vocabulary through;
    // the row type is narrower than the wire, so the story spells it as one.
    row: createSessionTableRowFixture({ priority: "CRITICAL" as Priority }),
  },
};

/**
 * A source that cannot write (an older Desktop build's local store): the same
 * mark, and no control that could not commit.
 */
export const ReadOnly: Story = {
  decorators: [withReadOnlySource],
};

/** The 120px track the column declares, so crowding is judged at width. */
function inTrack(Story: Parameters<Decorator>[0]) {
  return (
    <div className="w-[120px] border-border border-x border-dashed px-3">
      <Story />
    </div>
  );
}

/**
 * A read-only source: every read rejects (the cell never reads), and there is
 * no `updatePriority`, which is the whole signal the cell keys off.
 */
function withReadOnlySource(Story: Parameters<Decorator>[0]) {
  return (
    <AgentSessionsDataSourceProvider dataSource={READ_ONLY_SOURCE}>
      <Story />
    </AgentSessionsDataSourceProvider>
  );
}

const unread = () => Promise.reject(new Error("not read by this story"));

const READ_ONLY_SOURCE: AgentSessionsDataSource = {
  scope: "story-read-only",
  list: unread,
  detail: unread,
  usage: unread,
  analytics: unread,
  pageData: unread,
};
