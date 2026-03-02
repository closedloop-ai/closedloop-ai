"use client";

import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@repo/design-system/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { cn } from "@repo/design-system/lib/utils";
import { Check, ChevronDown, Server } from "lucide-react";
import { useMemo, useState } from "react";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";
import { useIsMounted } from "@/hooks/use-is-mounted";
import {
  ensureElectronDetection,
  useElectronDetection,
} from "@/lib/engineer/electron-detection";
import {
  setEngineerRoutingManualSelection,
  useEngineerRoutingSelection,
} from "@/lib/engineer/routing-store";
import { appEnvironment } from "@/lib/environment";

type LocalOption = {
  id: "local-electron" | "local-dev";
  mode: "local-electron" | "local-dev";
  label: string;
  description: string;
};

type CloudOption = {
  id: string;
  mode: "cloud-relay";
  label: string;
  description: string;
  target: ComputeTarget;
};

type SelectorOption = LocalOption | CloudOption;

function isCloudOption(option: SelectorOption): option is CloudOption {
  return option.mode === "cloud-relay";
}

function normalizeMachineName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isSameMachineTarget(
  target: ComputeTarget,
  localMachineName: string | null
): boolean {
  if (!localMachineName) {
    return false;
  }
  return (
    normalizeMachineName(target.machineName) ===
    normalizeMachineName(localMachineName)
  );
}

function buildOptions(
  detection: { detected: boolean; machineName: string | null },
  targets: ComputeTarget[]
): SelectorOption[] {
  const options: SelectorOption[] = [];

  if (detection.detected) {
    options.push({
      id: "local-electron",
      mode: "local-electron",
      label: "Local (Electron)",
      description: "Direct localhost execution",
    });
  }

  if (appEnvironment === "local") {
    options.push({
      id: "local-dev",
      mode: "local-dev",
      label: "Local (dev server)",
      description: "Run on local Next.js server",
    });
  }

  const visibleTargets = detection.detected
    ? targets.filter(
        (target) => !isSameMachineTarget(target, detection.machineName)
      )
    : targets;

  const sortedTargets = [...visibleTargets].sort((a, b) => {
    if (a.isOnline !== b.isOnline) {
      return a.isOnline ? -1 : 1;
    }
    return a.machineName.localeCompare(b.machineName);
  });

  for (const target of sortedTargets) {
    options.push({
      id: target.id,
      mode: "cloud-relay",
      label: target.machineName,
      description: `${target.platform}${target.isOnline ? " • online" : " • offline"}`,
      target,
    });
  }

  return options;
}

function resolveActiveOption(
  options: SelectorOption[],
  mode: string,
  computeTargetId: string | null
): SelectorOption | null {
  if (mode === "cloud-relay") {
    if (!computeTargetId) {
      return null;
    }
    return (
      options.find(
        (option) =>
          isCloudOption(option) && option.target.id === computeTargetId
      ) ?? null
    );
  }

  if (mode === "local-electron" || mode === "local-dev") {
    return (
      options.find(
        (option) => !isCloudOption(option) && option.mode === mode
      ) ?? null
    );
  }

  return null;
}

function TargetStatusDot({ online }: { online: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mr-2 inline-block size-2 rounded-full",
        online ? "bg-emerald-500" : "bg-red-500"
      )}
    />
  );
}

function isOnlineOption(option: SelectorOption): boolean {
  if (isCloudOption(option)) {
    return option.target.isOnline;
  }
  return option.mode === "local-electron";
}

export function ComputeTargetSelector() {
  const mounted = useIsMounted();
  const [open, setOpen] = useState(false);
  const detection = useElectronDetection();
  const { data: targets = [], isFetching } = useComputeTargets({
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const routing = useEngineerRoutingSelection();

  const options = useMemo(
    () => buildOptions(detection, targets),
    [detection, targets]
  );

  const activeOption = useMemo(
    () => resolveActiveOption(options, routing.mode, routing.computeTargetId),
    [options, routing.mode, routing.computeTargetId]
  );

  if (!mounted || options.length === 0) {
    return null;
  }

  return (
    <Popover
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          ensureElectronDetection({ force: true }).catch(() => undefined);
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <Button
          className="min-w-[220px] justify-between"
          role="combobox"
          size="sm"
          variant="outline"
        >
          <span className="flex items-center truncate">
            {activeOption ? (
              <TargetStatusDot online={isOnlineOption(activeOption)} />
            ) : null}
            <span className="truncate">
              {activeOption?.label ?? "Select compute target"}
            </span>
          </span>
          <ChevronDown className="ml-2 size-4 shrink-0 opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[300px] p-0">
        <Command>
          <CommandList>
            <CommandEmpty>No compute targets available.</CommandEmpty>
            <CommandGroup heading="Execution targets">
              {options.map((option) => {
                const selected =
                  activeOption &&
                  ((isCloudOption(option) &&
                    isCloudOption(activeOption) &&
                    option.target.id === activeOption.target.id) ||
                    (!(isCloudOption(option) || isCloudOption(activeOption)) &&
                      option.mode === activeOption.mode));

                return (
                  <CommandItem
                    className="cursor-pointer"
                    key={option.id}
                    onSelect={() => {
                      if (isCloudOption(option)) {
                        setEngineerRoutingManualSelection(
                          "cloud-relay",
                          option.target.id
                        );
                      } else {
                        setEngineerRoutingManualSelection(option.mode);
                      }
                      setOpen(false);
                    }}
                    value={`${option.label} ${option.description}`}
                  >
                    <Check
                      className={cn(
                        "mr-2 size-4",
                        selected ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      {isCloudOption(option) ? (
                        <TargetStatusDot online={option.target.isOnline} />
                      ) : option.mode === "local-electron" ? (
                        <TargetStatusDot online />
                      ) : (
                        <Server className="size-3.5 text-muted-foreground" />
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-sm">{option.label}</p>
                        <p className="truncate text-muted-foreground text-xs">
                          {option.description}
                        </p>
                      </div>
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
      {isFetching ? (
        <span className="sr-only">Refreshing compute targets</span>
      ) : null}
    </Popover>
  );
}
