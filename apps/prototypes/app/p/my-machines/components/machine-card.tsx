"use client";

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
import { DownloadIcon } from "lucide-react";
import { useId, useState } from "react";
import { type Machine, needsActionState, rollupFor } from "../mock";
import { MachineDetail } from "./machine-detail";
import { MachineSummary } from "./machine-summary";

// One machine, summary-first with the per-component detail behind a disclosure
// (Parker: progressive disclosure, summary first, detail on demand). The card is
// the machine; its header carries name + online/offline, its body the summary,
// and the disclosure reveals the component list. A machine that has work opens
// expanded (matching the admin matrix, which defaults to expanded) so the answer
// to "does anything need me" isn't hidden behind a click.

type MachineCardProps = {
  machine: Machine;
  onComponentAction: (machineId: string, componentId: string) => void;
};

// Online/offline shown as a plain word, not a glyph. The check/swap glyphs below
// own the install vocabulary; reusing a filled check for "Online" would give the
// same shape two meanings on one card, so online status is text only.
const OnlineStatus = ({ online }: { online: boolean }) => (
  <span className="text-muted-foreground text-sm">
    {online ? "Online" : "Offline"}
  </span>
);

export const MachineCard = ({
  machine,
  onComponentAction,
}: MachineCardProps) => {
  const rollup = rollupFor(machine);
  // Open expanded when there is work to see, so the card doesn't hide the very
  // thing this screen exists to answer. Offline machines can't be acted on, so
  // they stay collapsed regardless of last-known state.
  const hasWork = machine.online && rollup.needsAction > 0;
  const [open, setOpen] = useState(hasWork);
  const detailId = useId();

  // Bring every actionable component on this machine to installed in one move,
  // count driven off the same rollup as the rows so it can't drift from them.
  const handleInstallAll = () => {
    for (const component of machine.components) {
      if (needsActionState(component.state)) {
        onComponentAction(machine.id, component.id);
      }
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{machine.name}</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-x-2">
          <span>{machine.platform}</span>
          <span aria-hidden="true">·</span>
          <OnlineStatus online={machine.online} />
        </CardDescription>
        {hasWork ? (
          <CardAction>
            <Button className="gap-1.5" onClick={handleInstallAll} size="sm">
              <DownloadIcon aria-hidden="true" className="size-4" />
              Install {rollup.needsAction}{" "}
              {rollup.needsAction === 1 ? "component" : "components"}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        <Collapsible onOpenChange={setOpen} open={open}>
          <MachineSummary machine={machine} rollup={rollup} />
          <CollapsibleTrigger asChild>
            <Button
              aria-controls={detailId}
              aria-expanded={open}
              className="mt-3 gap-1.5 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
              size="sm"
              variant="ghost"
            >
              {open ? "Hide components" : "Show components"}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent id={detailId}>
            <Separator className="my-3" />
            <MachineDetail
              machine={machine}
              onComponentAction={onComponentAction}
            />
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
};
