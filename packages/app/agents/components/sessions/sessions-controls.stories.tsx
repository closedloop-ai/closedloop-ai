import {
  sessionControls,
  sessionsPagination,
} from "@repo/app/agents/lib/session-mock-data";
import type { SessionControls } from "@repo/app/agents/lib/session-types";
import type { PaginationState } from "@repo/design-system/components/ui/types";
import { remountKey } from "@repo/design-system/storybook/remount-key";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { SessionsControls } from "./sessions-controls";

const meta = {
  title: "Composites v1.0/Sessions/Sessions Controls",
  component: SessionsControls,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
  args: {
    controls: sessionControls,
    pagination: sessionsPagination,
  },
  argTypes: {
    // `controls` is the whole `SessionControls` shape — labels, live-state
    // flags, and four `directoryOptions`/`harnessOptions`/`statusOptions`/
    // `sortOptions` arrays — with no single primitive sub-field exposed as its
    // own arg. A JSON-object control would let someone type invalid option
    // arrays past the component's own types, so this stays documented
    // (visible in the ArgTypes/Docs table) but not editable from the panel;
    // the interactive `Default` story's own controls are the real editing
    // surface for this state.
    controls: { control: false },
    // `pagination` is `{ page, pageSize, total, totalPages }` — a flat object,
    // but still one whole-object arg: the four numbers move together (e.g.
    // `page` past `totalPages` is a state the component never actually
    // reaches), so there is no single meaningful widget for it either.
    pagination: { control: false },
    // Every remaining prop is a callback. This repo has no actions addon
    // wired into `.storybook/main.ts`, so a function arg gets no usable
    // widget at all — only the broken "Setup controls" placeholder — and each
    // story already wires (or omits) these directly in `args` to demonstrate
    // the wired/read-only split, so a live control would not do anything a
    // reader could act on anyway.
    onSearchValueChange: { control: false },
    onDirectoryValueChange: { control: false },
    onSortValueChange: { control: false },
    onSortDirectionChange: { control: false },
    onRefresh: { control: false },
    onHarnessValueChange: { control: false },
    onStatusValueChange: { control: false },
    onPageChange: { control: false },
  },
} satisfies Meta<typeof SessionsControls>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Seeds its local state from the args it is given rather than reading the
 * mock fixtures directly, so editing `controls`/`pagination` in the Controls
 * panel actually changes what mounts (remounted via {@link remountKey}) while
 * staying interactive in the canvas afterward — the same seed-then-remount
 * pattern `filter-popover.stories.tsx`'s `FilterPopoverDemo` uses.
 */
function InteractiveSessionsControls({
  controls: initialControls,
  pagination: initialPagination,
}: {
  controls: SessionControls;
  pagination: PaginationState;
}) {
  const [controls, setControls] = useState<SessionControls>(initialControls);
  const [pagination, setPagination] =
    useState<PaginationState>(initialPagination);

  return (
    <SessionsControls
      controls={controls}
      onDirectoryValueChange={(value) =>
        setControls((current) => ({ ...current, directoryValue: value }))
      }
      onHarnessValueChange={(value) =>
        setControls((current) => ({ ...current, harnessValue: value }))
      }
      onPageChange={(page) =>
        setPagination((current) => ({ ...current, page }))
      }
      onRefresh={() => undefined}
      onSearchValueChange={(value) =>
        setControls((current) => ({ ...current, searchValue: value }))
      }
      onSortDirectionChange={(sortDescending) =>
        setControls((current) => ({ ...current, sortDescending }))
      }
      onSortValueChange={(sortValue) =>
        setControls((current) => ({ ...current, sortValue }))
      }
      onStatusValueChange={(value) =>
        setControls((current) => ({ ...current, statusValue: value }))
      }
      pagination={pagination}
    />
  );
}

/** Fully wired: every control seeds the canvas and stays interactive. */
export const Default: Story = {
  render: (args) => (
    <InteractiveSessionsControls
      controls={args.controls}
      key={remountKey(args.controls, args.pagination)}
      pagination={args.pagination}
    />
  ),
};

/** A search/status combination with no matching rows; refresh stays wired. */
export const EmptyResults: Story = {
  args: {
    controls: {
      ...sessionControls,
      searchValue: "no-match",
      statusValue: "error",
    },
    onRefresh: () => undefined,
    pagination: { ...sessionsPagination, page: 0, total: 0, totalPages: 1 },
  },
};

/** Only harness, page and refresh are wired; every other field is read-only. */
export const PartialWiring: Story = {
  args: {
    controls: {
      ...sessionControls,
      harnessValue: "claude",
      refreshLabel: "Refresh sync status",
      statusValue: "waiting",
    },
    onHarnessValueChange: () => undefined,
    onPageChange: () => undefined,
    onRefresh: () => undefined,
    pagination: { ...sessionsPagination, page: 1 },
  },
};

/** No handlers at all — every field renders its value with nothing wired. */
export const ReadOnlySnapshot: Story = {
  args: {
    controls: {
      ...sessionControls,
      directoryValue: "/workspace/closedloop-ai",
      harnessValue: "codex",
      searchValue: "review",
      sortDescending: false,
      sortValue: "duration",
      statusValue: "completed",
    },
    pagination: { ...sessionsPagination, page: 2, totalPages: 6 },
  },
};
