import { TableCellValueState } from "@repo/design-system/components/ui/table-cell-primitives";
import {
  TableModelCell,
  TablePriority,
  TablePriorityCell,
  TableRepositoryCell,
} from "@repo/design-system/components/ui/table-cell-semantic-primitives";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

const meta = {
  title: "Composites v1.0/Data Display/Tables/Table Cell Semantic Primitives",
  tags: ["deprecated"],
  parameters: { layout: "centered" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const TypeMatrix: Story = {
  tags: ["!manifest"],
  render: () => (
    <div className="grid w-[560px] grid-cols-[120px_minmax(0,1fr)] items-center gap-x-6 gap-y-4">
      <CellExample label="Priority">
        <TablePriorityCell priority={TablePriority.High} />
      </CellExample>
      <CellExample label="Model">
        <TableModelCell
          indicatorClassName="text-primary"
          model="claude-opus-4-6"
          providerLabel="Anthropic"
        />
      </CellExample>
      <CellExample label="Repository">
        <TableRepositoryCell
          fullName="closedloop-ai/closedloop-ai"
          label="closedloop-ai"
        />
      </CellExample>
      <CellExample label="Empty">
        <TableRepositoryCell label={null} />
      </CellExample>
    </div>
  ),
};

export const StateMatrix: Story = {
  tags: ["!manifest"],
  render: () => <StateMatrixDemo />,
};

function StateMatrixDemo() {
  const [lastAction, setLastAction] = useState("No action yet");

  return (
    <div className="grid w-[760px] grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-6 gap-y-4">
      <span className="text-muted-foreground text-sm">State</span>
      <span className="text-muted-foreground text-sm">Priority</span>
      <span className="text-muted-foreground text-sm">Model</span>
      <span className="text-muted-foreground text-sm">Repository</span>
      <span className="text-muted-foreground text-sm">Default</span>
      <TablePriorityCell priority={TablePriority.Medium} />
      <TableModelCell
        indicatorClassName="text-primary"
        model="claude-opus-4-6"
        providerLabel="Anthropic"
      />
      <TableRepositoryCell
        fullName="closedloop-ai/closedloop-ai"
        label="closedloop-ai"
        onSelect={() => setLastAction("Opened repository")}
      />
      <span className="text-muted-foreground text-sm">Loading</span>
      <TablePriorityCell
        loadingLabel="Loading priority"
        priority={TablePriority.Medium}
        state={TableCellValueState.Loading}
      />
      <TableModelCell
        loadingLabel="Loading model"
        model="claude-opus-4-6"
        state={TableCellValueState.Loading}
      />
      <TableRepositoryCell
        label="closedloop-ai"
        loadingLabel="Loading repository"
        state={TableCellValueState.Loading}
      />
      <span className="text-muted-foreground text-sm">Unavailable</span>
      <TablePriorityCell
        priority={TablePriority.Medium}
        state={TableCellValueState.Unavailable}
      />
      <TableModelCell
        model="claude-opus-4-6"
        state={TableCellValueState.Unavailable}
      />
      <TableRepositoryCell
        label="closedloop-ai"
        state={TableCellValueState.Unavailable}
      />
      <span className="text-muted-foreground text-sm">Forbidden</span>
      <TablePriorityCell
        priority={TablePriority.Medium}
        state={TableCellValueState.Forbidden}
      />
      <TableModelCell
        model="claude-opus-4-6"
        state={TableCellValueState.Forbidden}
      />
      <TableRepositoryCell
        label="closedloop-ai"
        state={TableCellValueState.Forbidden}
      />
      <span className="text-muted-foreground text-sm">Partial</span>
      <TablePriorityCell
        priority={TablePriority.Medium}
        state={TableCellValueState.Partial}
      />
      <TableModelCell
        model="claude-opus-4-6"
        state={TableCellValueState.Partial}
      />
      <TableRepositoryCell
        label="closedloop-ai"
        state={TableCellValueState.Partial}
      />
      <span className="text-muted-foreground text-sm">Empty</span>
      <TablePriorityCell priority={null} />
      <TableModelCell model={null} />
      <TableRepositoryCell label={null} />
      <span className="text-muted-foreground text-sm">Error</span>
      <TablePriorityCell
        errorLabel="Priority failed to load"
        priority={TablePriority.Medium}
        state={TableCellValueState.Error}
      />
      <TableModelCell
        errorLabel="Model failed to load"
        model="claude-opus-4-6"
        state={TableCellValueState.Error}
      />
      <TableRepositoryCell
        errorLabel="Repository failed to load"
        label="closedloop-ai"
        state={TableCellValueState.Error}
      />
      <span className="text-muted-foreground text-sm">Selected</span>
      <TablePriorityCell priority={TablePriority.High} selected />
      <TableModelCell model="claude-opus-4-6" selected />
      <TableRepositoryCell label="closedloop-ai" selected />
      <span className="text-muted-foreground text-sm">Focus</span>
      <TablePriorityCell focusVisible priority={TablePriority.High} />
      <TableModelCell focusVisible model="claude-opus-4-6" />
      <TableRepositoryCell focusVisible label="closedloop-ai" />
      <span className="text-muted-foreground text-sm">Disabled</span>
      <TablePriorityCell disabled priority={TablePriority.High} />
      <TableModelCell disabled model="claude-opus-4-6" />
      <TableRepositoryCell
        disabled
        label="closedloop-ai"
        onSelect={() => setLastAction("Opened disabled repository")}
      />
      <span aria-live="polite" className="sr-only">
        {lastAction}
      </span>
    </div>
  );
}

function CellExample({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <>
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="flex min-w-0 items-center">{children}</span>
    </>
  );
}
