import {
  TableChoiceListCell,
  TableReferenceListCell,
} from "@repo/design-system/components/ui/table-cell-list-primitives";
import { TableCellValueState } from "@repo/design-system/components/ui/table-cell-primitives";
import type { Meta, StoryObj } from "@storybook/react";
import { FileTextIcon } from "lucide-react";
import { useState } from "react";

// Self-contained so the primitive's story needs no network host and no
// application-domain fixture.
const EXAMPLE_AVATAR_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' rx='20' fill='%23c7d2fe'/%3E%3Ccircle cx='20' cy='16' r='7' fill='%234f46e5'/%3E%3Cpath d='M7 40c1-9 6-14 13-14s12 5 13 14' fill='%234f46e5'/%3E%3C/svg%3E";
const BROKEN_AVATAR_URL = "data:image/svg+xml,broken";

const meta = {
  title: "Composites v1.0/Data Display/Tables/Table Cell List Primitives",
  tags: ["deprecated"],
  parameters: { layout: "centered" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const FitAndOverflow: Story = {
  tags: ["!manifest"],
  render: () => (
    <div className="grid w-[520px] grid-cols-[120px_180px] items-center gap-x-6 gap-y-4">
      <span className="text-muted-foreground text-sm">Choices</span>
      <TableChoiceListCell
        choices={[
          { id: "artifact", label: "artifact" },
          { id: "prototype", label: "prototype" },
          { id: "governance", label: "governance" },
        ]}
      />
      <span className="text-muted-foreground text-sm">References</span>
      <TableReferenceListCell
        references={[
          {
            className: "border-success/25 bg-success/10 text-success",
            id: "session-1",
            initials: "AE",
            label: "2:15 PM",
            tooltip: "SES-1842 · Ottilie Eastwick · Active · Wrote to artifact",
          },
          {
            className: "border-border bg-muted text-muted-foreground",
            id: "session-2",
            initials: "PB",
            label: "Yesterday",
          },
          { icon: FileTextIcon, id: "doc-3", label: "DOC-1838" },
        ]}
      />
      <span className="text-muted-foreground text-sm">Empty</span>
      <TableReferenceListCell references={[]} />
      <span className="text-muted-foreground text-sm">Withheld</span>
      {/* ISS-9317: a producer delivered one reference and reports two more it
          capped away. The pill counts them and its tooltip names the gap. */}
      <TableReferenceListCell
        hiddenReferenceCount={2}
        references={[
          {
            className: "border-success/25 bg-success/10 text-success",
            id: "session-4",
            initials: "RD",
            label: "7:01 PM",
            tooltip: "SES-9100 · Riley Demo · Active · Contributed",
          },
        ]}
      />
    </div>
  ),
};

export const AvatarSources: Story = {
  tags: ["!manifest"],
  render: () => (
    <div className="grid w-[420px] grid-cols-[130px_240px] items-center gap-x-6 gap-y-4">
      <span className="text-muted-foreground text-sm">Picture</span>
      <TableReferenceListCell
        references={[
          {
            avatarUrl: EXAMPLE_AVATAR_URL,
            className: "border-success/25 bg-success/10 text-success",
            id: "picture",
            initials: "AE",
            label: "2:15 PM",
            tooltip: "SES-1842 · Ottilie Eastwick · Active · Wrote to artifact",
          },
        ]}
      />
      <span className="text-muted-foreground text-sm">Picture only</span>
      <TableReferenceListCell
        references={[
          {
            avatarUrl: EXAMPLE_AVATAR_URL,
            id: "picture-only",
            label: "1:40 PM",
            tooltip: "SES-1843 · Ottilie Eastwick · Active",
          },
        ]}
      />
      <span className="text-muted-foreground text-sm">Broken picture</span>
      <TableReferenceListCell
        references={[
          {
            avatarUrl: BROKEN_AVATAR_URL,
            className: "border-border bg-muted text-muted-foreground",
            id: "broken-picture",
            initials: "PB",
            label: "Yesterday",
            tooltip: "SES-1844 · Pascoe Bell · Inactive",
          },
        ]}
      />
      <span className="text-muted-foreground text-sm">Initials only</span>
      <TableReferenceListCell
        references={[
          {
            className: "border-border bg-muted text-muted-foreground",
            id: "initials-only",
            initials: "PB",
            label: "Yesterday",
            tooltip: "SES-1845 · Pascoe Bell · Inactive",
          },
        ]}
      />
    </div>
  ),
};

export const StateMatrix: Story = {
  tags: ["!manifest"],
  render: () => <StateMatrixDemo />,
};

function StateMatrixDemo() {
  const [lastAction, setLastAction] = useState("No action yet");
  const choices = [
    { id: "artifact", label: "artifact" },
    { id: "prototype", label: "prototype" },
  ];
  const references = [
    {
      icon: FileTextIcon,
      id: "doc-1",
      label: "DOC-1842",
      onSelect: () => setLastAction("Opened DOC-1842"),
    },
  ];

  return (
    <div className="grid w-[640px] grid-cols-[150px_220px_220px] items-center gap-x-6 gap-y-4">
      <span className="text-muted-foreground text-sm">State</span>
      <span className="text-muted-foreground text-sm">Choices</span>
      <span className="text-muted-foreground text-sm">References</span>
      <span className="text-muted-foreground text-sm">Default</span>
      <TableChoiceListCell choices={choices} />
      <TableReferenceListCell references={references} />
      <span className="text-muted-foreground text-sm">Loading</span>
      <TableChoiceListCell
        choices={choices}
        loadingLabel="Loading choices"
        state={TableCellValueState.Loading}
      />
      <TableReferenceListCell
        loadingLabel="Loading references"
        references={references}
        state={TableCellValueState.Loading}
      />
      <span className="text-muted-foreground text-sm">Unavailable</span>
      <TableChoiceListCell
        choices={choices}
        state={TableCellValueState.Unavailable}
      />
      <TableReferenceListCell
        references={references}
        state={TableCellValueState.Unavailable}
      />
      <span className="text-muted-foreground text-sm">Forbidden</span>
      <TableChoiceListCell
        choices={choices}
        state={TableCellValueState.Forbidden}
      />
      <TableReferenceListCell
        references={references}
        state={TableCellValueState.Forbidden}
      />
      <span className="text-muted-foreground text-sm">Partial</span>
      <TableChoiceListCell
        choices={choices}
        state={TableCellValueState.Partial}
      />
      <TableReferenceListCell
        references={references}
        state={TableCellValueState.Partial}
      />
      <span className="text-muted-foreground text-sm">Empty</span>
      <TableChoiceListCell choices={[]} />
      <TableReferenceListCell references={[]} />
      <span className="text-muted-foreground text-sm">Error</span>
      <TableChoiceListCell
        choices={choices}
        errorLabel="Choices failed to load"
        state={TableCellValueState.Error}
      />
      <TableReferenceListCell
        errorLabel="References failed to load"
        references={references}
        state={TableCellValueState.Error}
      />
      <span className="text-muted-foreground text-sm">Selected</span>
      <TableChoiceListCell choices={choices} selected />
      <TableReferenceListCell references={references} selected />
      <span className="text-muted-foreground text-sm">Focus</span>
      <TableChoiceListCell choices={choices} focusVisible />
      <TableReferenceListCell focusVisible references={references} />
      <span className="text-muted-foreground text-sm">Disabled</span>
      <TableChoiceListCell choices={choices} disabled />
      <TableReferenceListCell disabled references={references} />
      <span aria-live="polite" className="sr-only">
        {lastAction}
      </span>
    </div>
  );
}
