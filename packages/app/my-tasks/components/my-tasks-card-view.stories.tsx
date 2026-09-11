import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import type { Meta, StoryObj } from "@storybook/react";
import { CheckSquareIcon } from "lucide-react";
import type { ReactNode } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import type { DocumentRowData } from "../../documents/lib/artifact-row-adapter";
import { makeArtifact } from "../../shared/test-fixtures/documents";
import { MyTasksCardView } from "./my-tasks-card-view";

/**
 * ISS-4683 — the My Tasks card board's six-way state matrix, on a canvas.
 *
 * The matrix diverges HERE and nowhere else: the leaf pieces this composes each
 * have one job, while this component decides which of load-failed, loading,
 * signed-out, empty-queue, filtered-to-nothing, all-undrawable and
 * populated-with-footer the reader gets. Those branches are what the ISS-4576
 * review kept catching honesty bugs in — an empty board that means three
 * different things, a footer total that stopped describing the screen — so they
 * are the thing worth being able to see side by side.
 *
 * `board` and `emptyState` are slots (they reach for host-app route and modal
 * context), which is what makes every state renderable here with a stub.
 */

function StubBoard({ label }: Readonly<{ label: string }>) {
  return (
    <div className="flex flex-1 items-center justify-center rounded-md border border-dashed p-8 text-muted-foreground text-sm">
      {label}
    </div>
  );
}

const POPULATED_BOARD: ReactNode = <StubBoard label="Kanban board" />;
const QUEUE_CLEAR_STATE: ReactNode = (
  <EmptyState
    description="Ready to start something new?"
    icon={CheckSquareIcon}
    title="Your queue is clear"
  />
);

function cardsOf(count: number): DocumentRowData[] {
  return Array.from({ length: count }, (_unused, i) =>
    makeArtifact({ id: `doc-${i}`, assigneeId: "user-1" })
  );
}

/**
 * The container deciding what the My Tasks board shows: the kanban board, a
 * loading state, an error, an empty queue, or a no results from filters
 * message.
 */
const meta = {
  title: "Composites/My Tasks/Card View",
  component: MyTasksCardView,
  tags: ["autodocs"],
  argTypes: {
    artifacts: {
      control: "object",
      description:
        "This page's rows after any client-side search or facet narrowing.",
      table: { category: "Data" },
    },
    assigneeId: {
      control: "text",
      description: "Null is the signed-out branch.",
      table: { category: "Data" },
    },
    total: {
      control: { type: "number", min: 0, step: 1 },
      description: "The server's count of the viewer's assigned artifacts.",
      table: { category: "Data" },
    },
    pageCount: {
      control: { type: "number", min: 0, step: 1 },
      description: "How many rows the server returned before client narrowing.",
      table: { category: "Data" },
    },
    offset: {
      control: { type: "number", min: 0, step: 1 },
      table: { category: "Data" },
    },
    page: {
      control: { type: "number", min: 0, step: 1 },
      table: { category: "Data" },
    },
    totalPages: {
      control: { type: "number", min: 0, step: 1 },
      table: { category: "Data" },
    },
    board: {
      control: false,
      description:
        "The kanban board, injected as a slot because it reaches for host-app route context.",
      table: { category: "Content" },
    },
    emptyState: {
      control: false,
      description: "The queue-is-clear state, injected for the same reason.",
      table: { category: "Content" },
    },
    isError: { control: "boolean", table: { category: "State" } },
    isLoading: { control: "boolean", table: { category: "State" } },
    isNarrowed: { control: "boolean", table: { category: "State" } },
    isUserLoading: { control: "boolean", table: { category: "State" } },
    onClearFilters: { control: false, table: { category: "Events" } },
    onPageChange: { control: false, table: { category: "Events" } },
    onRetry: { control: false, table: { category: "Events" } },
  },
  parameters: { layout: "fullscreen" },
  args: {
    artifacts: cardsOf(50),
    assigneeId: "user-1",
    board: POPULATED_BOARD,
    emptyState: QUEUE_CLEAR_STATE,
    isError: false,
    isLoading: false,
    isNarrowed: false,
    isUserLoading: false,
    offset: 0,
    onClearFilters: fn(),
    onPageChange: fn(),
    onRetry: fn(),
    page: 0,
    pageCount: 50,
    total: 137,
    totalPages: 3,
  },
  decorators: [
    (Story) => (
      <div className="flex h-[32rem] flex-col border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MyTasksCardView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A full page, with the range readout and the pager beneath it. */
export const Populated: Story = {};

/**
 * The read failed. Rendered BEFORE every empty branch, so a failure can never be
 * mistaken for an empty queue.
 */
export const LoadFailed: Story = {
  args: { artifacts: [], isError: true, pageCount: 0, total: 0 },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Couldn't load your tasks")).toBeVisible();

    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await expect(args.onRetry).toHaveBeenCalled();
  },
};

/** The board owns the loading state — and the footer states no range yet. */
export const Loading: Story = {
  args: {
    artifacts: [],
    board: <StubBoard label="Loading…" />,
    isLoading: true,
    pageCount: 0,
  },
};

/** The board owns the signed-out state too. */
export const SignedOut: Story = {
  args: {
    artifacts: [],
    assigneeId: null,
    board: <StubBoard label="Sign in to see your assigned tasks." />,
    pageCount: 0,
  },
};

/** A genuinely empty queue — the only state that may say so. */
export const EmptyQueue: Story = {
  args: { artifacts: [], pageCount: 0, total: 0, totalPages: 1 },
};

/**
 * A filter emptied a page of a queue that is NOT empty. Different fact, different
 * copy, and a way back out.
 */
export const FilteredToNothing: Story = {
  args: { artifacts: [], isNarrowed: true, pageCount: 50 },
};

/**
 * ISS-4682 item 4: every row on this page is non-navigable, so the board can
 * draw none of them — with no filter set. The prior copy told the reader to
 * adjust a filter they never touched.
 */
export const AllUndrawablePage: Story = {
  args: { artifacts: [], pageCount: 50 },
};

/**
 * ISS-4682 item 3: the board drew 49 of the 50 rows it was sent. The range line
 * stays the anchor and the caveat takes the second line, instead of the range
 * being replaced and costing the reader their place.
 */
export const PartiallyDrawnPage: Story = {
  args: { artifacts: cardsOf(49), pageCount: 50 },
};
