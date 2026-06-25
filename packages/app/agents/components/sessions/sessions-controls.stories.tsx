import {
  sessionControls,
  sessionsPagination,
} from "@repo/app/agents/lib/session-mock-data";
import type { SessionControls } from "@repo/app/agents/lib/session-types";
import type { PaginationState } from "@repo/design-system/components/ui/types";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { SessionsControls } from "./sessions-controls";

const meta = {
  title: "App Core/Agents/Sessions Controls",
  component: SessionsControls,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    controls: sessionControls,
    pagination: sessionsPagination,
  },
} satisfies Meta<typeof SessionsControls>;

export default meta;
type Story = StoryObj<typeof meta>;

function InteractiveSessionsControls() {
  const [controls, setControls] = useState<SessionControls>(sessionControls);
  const [pagination, setPagination] =
    useState<PaginationState>(sessionsPagination);

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

export const Default: Story = {
  render: () => <InteractiveSessionsControls />,
};

export const EmptyResults: Story = {
  render: () => (
    <SessionsControls
      controls={{
        ...sessionControls,
        searchValue: "no-match",
        statusValue: "error",
      }}
      onRefresh={() => undefined}
      pagination={{ ...sessionsPagination, page: 0, total: 0, totalPages: 1 }}
    />
  ),
};

export const PartialWiring: Story = {
  render: () => (
    <SessionsControls
      controls={{
        ...sessionControls,
        harnessValue: "claude",
        refreshLabel: "Refresh sync status",
        statusValue: "waiting",
      }}
      onHarnessValueChange={() => undefined}
      onPageChange={() => undefined}
      onRefresh={() => undefined}
      pagination={{ ...sessionsPagination, page: 1 }}
    />
  ),
};

export const ReadOnlySnapshot: Story = {
  render: () => (
    <SessionsControls
      controls={{
        ...sessionControls,
        directoryValue: "/workspace/symphony-alpha",
        harnessValue: "codex",
        searchValue: "review",
        sortDescending: false,
        sortValue: "duration",
        statusValue: "completed",
      }}
      pagination={{ ...sessionsPagination, page: 2, totalPages: 6 }}
    />
  ),
};
