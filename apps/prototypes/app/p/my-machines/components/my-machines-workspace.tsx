"use client";

import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { useMemo, useState } from "react";
import {
  DEMO_MACHINES,
  DEMO_PACK,
  InstallState,
  type Machine,
  machinesWithInstallCount,
} from "../mock";
import { MachineCard } from "./machine-card";
import { MachinesShell } from "./machines-shell";
import {
  MachinesEmpty,
  MachinesError,
  MachinesLoading,
} from "./machines-states";

// Which state to render. Default is Data: the machine list, landed (per the
// spec) on a mix that includes an offline box, not an all-green mock. The
// switcher lets a reviewer flip loading / error / empty without real data.
const DemoState = {
  Data: "data",
  Loading: "loading",
  Error: "error",
  Empty: "empty",
} as const;

type DemoState = (typeof DemoState)[keyof typeof DemoState];

const DEMO_STATES: readonly { state: DemoState; label: string }[] = [
  { state: DemoState.Data, label: "Data" },
  { state: DemoState.Loading, label: "Loading" },
  { state: DemoState.Error, label: "Error" },
  { state: DemoState.Empty, label: "Empty" },
];

// The pack header: what the member is installing, and the top-line ratio across
// their own machines. This is the summary-of-summaries the whole screen answers
// to. The ratio is only shown alongside the machine list (Data state); in
// loading / error / empty there is no resolved count to state, so it is omitted
// rather than left showing a stale "2 of 3" above "No machines registered".
const PackHeader = ({
  ratio,
}: {
  ratio: { installed: number; total: number } | null;
}) => (
  <div className="mx-auto w-full max-w-3xl space-y-2 px-6 pt-8">
    <div className="flex items-baseline gap-x-3">
      <h1 className="font-semibold text-2xl tracking-tight">
        {DEMO_PACK.name}
      </h1>
      <span className="text-muted-foreground text-sm tabular-nums">
        v{DEMO_PACK.version}
      </span>
    </div>
    <p className="max-w-2xl text-muted-foreground">{DEMO_PACK.description}</p>
    {ratio ? (
      <p className="text-muted-foreground text-sm">
        Installed on{" "}
        <span className="font-medium text-foreground tabular-nums">
          {ratio.installed}
        </span>{" "}
        of your{" "}
        <span className="font-medium text-foreground tabular-nums">
          {ratio.total}
        </span>{" "}
        machines
      </p>
    ) : null}
  </div>
);

const StateSwitcher = ({
  value,
  onChange,
}: {
  value: DemoState;
  onChange: (state: DemoState) => void;
}) => (
  <ToggleGroup
    onValueChange={(next) => {
      if (next) {
        onChange(next as DemoState);
      }
    }}
    size="sm"
    type="single"
    value={value}
    variant="outline"
  >
    {DEMO_STATES.map((entry) => (
      <ToggleGroupItem
        aria-label={`Show ${entry.label} state`}
        key={entry.state}
        value={entry.state}
      >
        {entry.label}
      </ToggleGroupItem>
    ))}
  </ToggleGroup>
);

const MachinesBody = ({
  demoState,
  machines,
  onComponentAction,
  onRetry,
}: {
  demoState: DemoState;
  machines: readonly Machine[];
  onComponentAction: (machineId: string, componentId: string) => void;
  onRetry: () => void;
}) => {
  if (demoState === DemoState.Loading) {
    return <MachinesLoading />;
  }
  if (demoState === DemoState.Error) {
    return <MachinesError onRetry={onRetry} />;
  }
  if (demoState === DemoState.Empty || machines.length === 0) {
    return <MachinesEmpty />;
  }
  return (
    <div className="space-y-4">
      {machines.map((machine) => (
        <MachineCard
          key={machine.id}
          machine={machine}
          onComponentAction={onComponentAction}
        />
      ))}
    </div>
  );
};

export const MyMachinesWorkspace = () => {
  const [demoState, setDemoState] = useState<DemoState>(DemoState.Data);
  const [machines, setMachines] = useState<readonly Machine[]>(DEMO_MACHINES);

  // Top-line ratio recomputed from the live machine list so the header never
  // lies about scope: install one thing on a partial machine and it ticks up.
  // Only shown in Data state — loading / error / empty have no resolved count.
  const ratio = useMemo(() => {
    if (demoState !== DemoState.Data || machines.length === 0) {
      return null;
    }
    return machinesWithInstallCount(machines);
  }, [demoState, machines]);

  // Mocked, local-only: bring one component to installed on one machine. Offline
  // machines have no actionable components, so this only ever fires on a box we
  // can read, so the effect and the summary stay in lockstep.
  const handleComponentAction = (machineId: string, componentId: string) => {
    setMachines((prev) =>
      prev.map((machine) => {
        if (machine.id !== machineId) {
          return machine;
        }
        return {
          ...machine,
          components: machine.components.map((component) =>
            component.id === componentId
              ? { ...component, state: InstallState.Installed }
              : component
          ),
        };
      })
    );
  };

  return (
    <MachinesShell
      actions={<StateSwitcher onChange={setDemoState} value={demoState} />}
      breadcrumbs={[
        { label: "Packs" },
        { label: DEMO_PACK.name },
        { label: "My machines", isCurrent: true },
      ]}
    >
      <main className="pb-12">
        <PackHeader ratio={ratio} />
        <div className="mx-auto w-full max-w-3xl px-6 pt-6">
          <MachinesBody
            demoState={demoState}
            machines={machines}
            onComponentAction={handleComponentAction}
            onRetry={() => setDemoState(DemoState.Data)}
          />
        </div>
      </main>
    </MachinesShell>
  );
};
