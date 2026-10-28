import {
  TableCellValueState,
  TableChangeCell,
  TableChoiceCell,
  TableCountCell,
  TableDateCell,
  TableFavoriteCell,
  TableIdentityCell,
  TableNumberCell,
  TablePeopleCell,
  TablePersonCell,
  TableTextCell,
  TableVersionCell,
} from "@repo/design-system/components/ui/table-cell-primitives";
import type { Meta, StoryObj } from "@storybook/react";
import { FlaskConicalIcon, MessageSquareIcon } from "lucide-react";
import { useState } from "react";

const meta = {
  title: "Composites v1.0/Data Display/Tables/Table Cell Primitives",
  tags: ["deprecated"],
  parameters: { layout: "centered" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const TypeMatrix: Story = {
  tags: ["!manifest"],
  render: () => <TypeMatrixDemo />,
};

export const StateMatrix: Story = {
  tags: ["!manifest"],
  render: () => <StateMatrixDemo />,
};

function TypeMatrixDemo() {
  const [favorite, setFavorite] = useState(false);
  const [lastAction, setLastAction] = useState("No action yet");

  return (
    <div className="grid w-[720px] grid-cols-[140px_minmax(0,1fr)] items-center gap-x-6 gap-y-4">
      <CellExample label="Identity">
        <TableIdentityCell
          icon={FlaskConicalIcon}
          slug="PRO-1842"
          title="Generic artifact UX"
        />
      </CellExample>
      <CellExample label="Person">
        <TablePersonCell
          person={{ initials: "AE", name: "Ottilie Eastwick" }}
        />
      </CellExample>
      <CellExample label="People">
        <TablePeopleCell
          people={[
            { initials: "AE", name: "Ottilie Eastwick" },
            { initials: "PB", name: "Pascoe Birchall" },
            { initials: "SC", name: "Sam Chen" },
            { initials: "JL", name: "Jordan Lee" },
            { initials: "RK", name: "Riley Kim" },
          ]}
        />
      </CellExample>
      <CellExample label="Choice">
        <TableChoiceCell
          className="border-warning/25 bg-warning/10 text-warning"
          label="In review"
        />
      </CellExample>
      <CellExample label="Actionable count">
        <TableCountCell
          ariaLabel="14 comments"
          count={14}
          icon={MessageSquareIcon}
          onClick={() => setLastAction("Opened 14 comments")}
        />
      </CellExample>
      <CellExample label="Date">
        <TableDateCell
          fullValue="August 13, 2026 at 1:05 PM"
          value="2 hours ago"
        />
      </CellExample>
      <CellExample label="Version">
        <TableVersionCell
          ariaLabel="Open version 18"
          onClick={() => setLastAction("Opened version 18")}
          value="v18"
        />
      </CellExample>
      <CellExample label="Text">
        <TableTextCell value="closedloop-ai" />
      </CellExample>
      <CellExample label="Number">
        <TableNumberCell value="$42.18" />
      </CellExample>
      <CellExample label="Change">
        <TableChangeCell additions={184} deletions={42} />
      </CellExample>
      <CellExample label="Empty">
        <TablePersonCell person={null} />
      </CellExample>
      <CellExample label="Favorite">
        <TableFavoriteCell
          favorited={favorite}
          itemLabel="Generic artifact UX"
          onFavoriteChange={(nextFavorite) => {
            setFavorite(nextFavorite);
            setLastAction(nextFavorite ? "Favorited row" : "Unfavorited row");
          }}
        />
      </CellExample>
      <span aria-live="polite" className="sr-only">
        {lastAction}
      </span>
    </div>
  );
}

function StateMatrixDemo() {
  const [lastAction, setLastAction] = useState("No action yet");

  return (
    <div className="grid w-[760px] grid-cols-[150px_minmax(0,1fr)] items-center gap-x-6 gap-y-4">
      <CellExample label="Default">
        <TableTextCell value="Ready for review" />
      </CellExample>
      <CellExample label="Loading">
        <TableTextCell
          loadingLabel="Loading title"
          state={TableCellValueState.Loading}
          value="Cached title"
        />
      </CellExample>
      <CellExample label="Unavailable">
        <TableTextCell state={TableCellValueState.Unavailable} />
      </CellExample>
      <CellExample label="Forbidden">
        <TableTextCell state={TableCellValueState.Forbidden} />
      </CellExample>
      <CellExample label="Partial">
        <TableTextCell state={TableCellValueState.Partial} />
      </CellExample>
      <CellExample label="Empty">
        <TableTextCell value="" />
      </CellExample>
      <CellExample label="Error">
        <TableTextCell
          errorLabel="Title failed to load"
          state={TableCellValueState.Error}
          value="Cached title"
        />
      </CellExample>
      <CellExample label="Number loading">
        <TableNumberCell
          loadingLabel="Loading cost"
          state={TableCellValueState.Loading}
          value="$42.18"
        />
      </CellExample>
      <CellExample label="Number error">
        <TableNumberCell
          errorLabel="Cost failed to load"
          state={TableCellValueState.Error}
          value="$42.18"
        />
      </CellExample>
      <CellExample label="Change loading">
        <TableChangeCell
          additions={184}
          deletions={42}
          loadingLabel="Loading changes"
          state={TableCellValueState.Loading}
        />
      </CellExample>
      <CellExample label="Change error">
        <TableChangeCell
          additions={184}
          deletions={42}
          errorLabel="Changes failed to load"
          state={TableCellValueState.Error}
        />
      </CellExample>
      <CellExample label="Selected">
        <TableChoiceCell label="Approved" selected />
      </CellExample>
      <CellExample label="Focus">
        <TableVersionCell focusVisible value="v18" />
      </CellExample>
      <CellExample label="Disabled count">
        <TableCountCell
          ariaLabel="3 comments"
          count={3}
          disabled
          icon={MessageSquareIcon}
          onClick={() => setLastAction("Opened disabled comments")}
        />
      </CellExample>
      <CellExample label="Disabled favorite">
        <TableFavoriteCell
          disabled
          favorited={false}
          itemLabel="Generic artifact UX"
          onFavoriteChange={() => setLastAction("Changed disabled favorite")}
        />
      </CellExample>
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
