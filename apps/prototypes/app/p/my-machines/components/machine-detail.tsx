"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  COMPONENT_KIND_LABEL,
  DEMO_PACK,
  HARNESS_LABEL,
  InstallState,
  type Machine,
  type MachineComponent,
  needsActionState,
} from "../mock";
import { COMPONENT_STATUS } from "./component-status";

// The expanded per-component detail for one machine: one plain row per pack
// component, with its status glyph+label, kind, harness, and version. This is the
// member-scoped, single-machine slice of the admin matrix. No target-by-harness
// grid, just "what did this pack put on THIS box, and does anything need me". On
// an offline machine the rows show the LAST-KNOWN state (with no action buttons),
// so the disclosure still says something rather than a wall of unknowns.

type MachineDetailProps = {
  machine: Machine;
  onComponentAction: (machineId: string, componentId: string) => void;
};

// Kind label for the row uses the singular form; it labels one component, not a
// count.
const kindLabel = (component: MachineComponent): string =>
  COMPONENT_KIND_LABEL[component.kind].one;

// Version text for the row. An update row is the one place the version is the
// point, so it says from-what-to-what; everything else shows the single version
// it is on.
const versionText = (component: MachineComponent): string =>
  component.state === InstallState.Updatable
    ? `v${component.version} → v${DEMO_PACK.version}`
    : `v${component.version}`;

const ComponentRow = ({
  machineId,
  machineName,
  component,
  online,
  onComponentAction,
}: {
  machineId: string;
  machineName: string;
  component: MachineComponent;
  online: boolean;
  onComponentAction: (machineId: string, componentId: string) => void;
}) => {
  const status = COMPONENT_STATUS[component.state];
  const actionable = online && needsActionState(component.state);
  const actionLabel =
    component.state === InstallState.Updatable ? "Update" : "Install";

  return (
    <div className="flex items-center gap-3 py-2.5">
      {status.render(20)}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="truncate font-medium text-sm">{component.name}</span>
          <span className="text-muted-foreground text-xs capitalize">
            {kindLabel(component)}
          </span>
          <span className="text-muted-foreground text-xs">
            {HARNESS_LABEL[component.harness]}
          </span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {versionText(component)}
          </span>
        </div>
        <span
          className={`text-sm ${
            status.emphatic ? "text-foreground" : "text-muted-foreground"
          }`}
        >
          {status.label}
        </span>
      </div>
      {actionable ? (
        <Button
          aria-label={`${actionLabel} ${component.name} on ${machineName}`}
          onClick={() => onComponentAction(machineId, component.id)}
          size="sm"
          variant="outline"
        >
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
};

export const MachineDetail = ({
  machine,
  onComponentAction,
}: MachineDetailProps) => (
  <div className="divide-y divide-border">
    {machine.components.map((component) => (
      <ComponentRow
        component={component}
        key={component.id}
        machineId={machine.id}
        machineName={machine.name}
        onComponentAction={onComponentAction}
        online={machine.online}
      />
    ))}
  </div>
);
