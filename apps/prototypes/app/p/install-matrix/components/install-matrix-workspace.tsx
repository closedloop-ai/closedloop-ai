"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { Separator } from "@repo/design-system/components/ui/separator";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { ChevronDownIcon, DownloadIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  applyCellAction,
  type CellAction,
  CellState,
  COMPONENT_KIND_LABEL,
  cellStateFor,
  DEMO_COMPONENT,
  DEMO_TARGETS,
  HARNESS_ORDER,
  type Harness,
  needsActionState,
  type Target,
} from "../mock";
import { InstallMatrix } from "./install-matrix";
import { MatrixLegend } from "./matrix-legend";
import { MatrixShell } from "./matrix-shell";
import { MatrixEmpty, MatrixError, MatrixLoading } from "./matrix-states";
import { MatrixSummary } from "./matrix-summary";

// Which non-happy state to render. The default is Data, landed (per the spec) on
// a target with a problem, not an all-green mock. The switcher lets a reviewer
// flip through loading / error / empty without wiring real data.
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

// Count of individual cells across all targets that can be acted on right now
// (not-installed, update-available, or a failed attempt). This is the true unit
// of "roll it out everywhere": one target can carry two actionable cells, so the
// count is per cell, not per target, and the button verb has to cover install
// AND update.
const countActionableCells = (targets: readonly Target[]): number => {
  let count = 0;
  for (const target of targets) {
    for (const harness of HARNESS_ORDER) {
      if (needsActionState(cellStateFor(DEMO_COMPONENT, target, harness))) {
        count += 1;
      }
    }
  }
  return count;
};

const DetailHeader = () => (
  <div className="mx-auto w-full max-w-5xl space-y-2 px-6 pt-8">
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-2">
        <h1 className="font-semibold text-2xl tracking-tight">
          {DEMO_COMPONENT.name}
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          {DEMO_COMPONENT.description}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-muted-foreground text-sm">
          <Badge variant="muted">
            {COMPONENT_KIND_LABEL[DEMO_COMPONENT.kind]}
          </Badge>
          <span>{DEMO_COMPONENT.pack}</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">v{DEMO_COMPONENT.version}</span>
        </div>
      </div>
    </div>
  </div>
);

// The state switcher, shown in the app header so a reviewer can walk every
// state. Not part of the real feature; a prototype affordance.
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

const MatrixBody = ({
  demoState,
  targets,
  onCellAction,
  onRetry,
}: {
  demoState: DemoState;
  targets: readonly Target[];
  onCellAction: (
    targetId: string,
    harness: Harness,
    action: CellAction
  ) => void;
  onRetry: () => void;
}) => {
  if (demoState === DemoState.Loading) {
    return <MatrixLoading />;
  }
  if (demoState === DemoState.Error) {
    return <MatrixError onRetry={onRetry} />;
  }
  if (demoState === DemoState.Empty || targets.length === 0) {
    return <MatrixEmpty />;
  }
  return (
    <InstallMatrix
      component={DEMO_COMPONENT}
      onCellAction={onCellAction}
      targets={targets}
    />
  );
};

export const InstallMatrixWorkspace = () => {
  const [demoState, setDemoState] = useState<DemoState>(DemoState.Data);
  const [targets, setTargets] = useState<readonly Target[]>(DEMO_TARGETS);
  const [expanded, setExpanded] = useState(true);

  // Actionable cells (not targets) across the grid, driving the "roll it out
  // everywhere" affordance count so the header never lies about scope: one
  // click here is one cell, and a target with two stale harnesses is two.
  const actionableCells = useMemo(
    () => countActionableCells(targets),
    [targets]
  );

  const handleCellAction = (
    targetId: string,
    harness: Harness,
    action: CellAction
  ) => {
    setTargets((prev) =>
      prev.map((target) => {
        if (target.id !== targetId) {
          return target;
        }
        const current = cellStateFor(DEMO_COMPONENT, target, harness);
        // Apply the action the user chose, not one re-derived from current
        // state, so a stale double-click can't invert into the opposite op.
        return {
          ...target,
          cells: {
            ...target.cells,
            [harness]: applyCellAction(current, action),
          },
        };
      })
    );
  };

  // Bulk affordance: bring every actionable cell to installed in one pass
  // (mocked, local only). Offline / converting / unsupported cells are left
  // untouched — the count and the effect stay in lockstep with the grid.
  const handleInstallEverywhere = () => {
    setTargets((prev) =>
      prev.map((target) => {
        const nextCells = { ...target.cells };
        for (const harness of HARNESS_ORDER) {
          const current = cellStateFor(DEMO_COMPONENT, target, harness);
          if (needsActionState(current)) {
            nextCells[harness] = CellState.Installed;
          }
        }
        return { ...target, cells: nextCells };
      })
    );
  };

  const isMatrix = demoState === DemoState.Data;

  return (
    <MatrixShell
      actions={<StateSwitcher onChange={setDemoState} value={demoState} />}
      breadcrumbs={[
        { label: "Packs" },
        { label: "Platform Core" },
        { label: DEMO_COMPONENT.name, isCurrent: true },
      ]}
    >
      <main className="pb-12">
        <DetailHeader />
        <div className="mx-auto w-full max-w-5xl px-6 pt-8">
          <Card>
            <CardHeader className="border-b">
              <CardTitle>Install matrix</CardTitle>
              <CardDescription>
                Every registered target, per harness.
              </CardDescription>
              {isMatrix && actionableCells > 0 ? (
                <CardAction>
                  <Button
                    className="gap-1.5"
                    onClick={handleInstallEverywhere}
                    size="sm"
                  >
                    <DownloadIcon className="size-4" />
                    Update {actionableCells}{" "}
                    {actionableCells === 1 ? "cell" : "cells"}
                  </Button>
                </CardAction>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-5">
              <MatrixLegend />
              {isMatrix ? (
                <Collapsible onOpenChange={setExpanded} open={expanded}>
                  <div className="flex items-center justify-between gap-4">
                    <CollapsibleTrigger asChild>
                      <Button
                        aria-expanded={expanded}
                        className="gap-1.5 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                        size="sm"
                        variant="ghost"
                      >
                        <ChevronDownIcon
                          aria-hidden="true"
                          className={`size-4 transition-transform ${
                            expanded ? "" : "-rotate-90"
                          }`}
                        />
                        {expanded ? "Hide full matrix" : "Show full matrix"}
                      </Button>
                    </CollapsibleTrigger>
                  </div>
                  {expanded ? null : (
                    <div className="pt-1">
                      <MatrixSummary
                        component={DEMO_COMPONENT}
                        targets={targets}
                      />
                    </div>
                  )}
                  <CollapsibleContent>
                    <Separator className="my-3" />
                    <MatrixBody
                      demoState={demoState}
                      onCellAction={handleCellAction}
                      onRetry={() => setDemoState(DemoState.Data)}
                      targets={targets}
                    />
                  </CollapsibleContent>
                </Collapsible>
              ) : (
                <MatrixBody
                  demoState={demoState}
                  onCellAction={handleCellAction}
                  onRetry={() => setDemoState(DemoState.Data)}
                  targets={targets}
                />
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    </MatrixShell>
  );
};
