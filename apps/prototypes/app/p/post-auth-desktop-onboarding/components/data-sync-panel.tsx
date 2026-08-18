"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import {
  RadioGroup,
  RadioGroupItem,
} from "@repo/design-system/components/ui/radio-group";
import { cn } from "@repo/design-system/lib/utils";
import { ArrowUpRightIcon, EyeOffIcon } from "lucide-react";
import { useId } from "react";
import {
  type DataLine as DataLineModel,
  type DataSyncLevel,
  type DataSyncLevelOption,
  dataSyncLevelOptions,
} from "../mock";

// Reused Data & Sync control — a faithful local copy of the desktop
// Settings → Data & Sync tab (apps/desktop/.../settings/data-sync-tab.tsx),
// which the post-auth onboarding takeover reuses per ISS-5249. Prototypes
// cannot import the real component (it pulls in @repo/app + desktop-only
// modules), so the radio-card control is replicated here from the shared copy
// source. Presentational + controlled: the takeover owns the selection and the
// Save affordance.

type DataSyncPanelProps = {
  selected: DataSyncLevel;
  onSelect: (level: DataSyncLevel) => void;
  // The pre-selected level, marked with the "Default" chip — the pre-selected
  // default (where the selection starts), not a "Recommended" safety judgment.
  // The onboarding takeover passes Full transcripts; Settings passes Metadata.
  defaultLevel: DataSyncLevel;
};

const DataLine = ({ label, kind }: DataLineModel) => (
  // A "sync" line means this data LEAVES the device, so it must not read as the
  // reassuring success-green a check implies. A neutral up-and-out arrow says
  // "uploaded" without the all-clear tone; green stays reserved for what stays
  // local. The local line keeps the muted eye-off ("kept private").
  <div className="flex items-center gap-2 text-xs">
    {kind === "sync" ? (
      <ArrowUpRightIcon className="size-3.5 shrink-0 text-foreground" />
    ) : (
      <EyeOffIcon className="size-3.5 shrink-0 text-muted-foreground" />
    )}
    <span
      className={kind === "sync" ? "text-foreground" : "text-muted-foreground"}
    >
      {label}
    </span>
  </div>
);

const LevelRadioCard = ({
  option,
  fieldId,
  selected,
  isDefault,
}: {
  option: DataSyncLevelOption;
  fieldId: string;
  selected: boolean;
  isDefault: boolean;
}) => (
  <label
    className={cn(
      "flex w-full cursor-pointer items-start gap-3 rounded-xl border bg-card p-4 text-left transition-colors",
      selected
        ? "border-primary/40 bg-primary/5 ring-3 ring-primary/15"
        : "border-border hover:border-primary/25"
    )}
    htmlFor={fieldId}
  >
    <RadioGroupItem className="mt-0.5" id={fieldId} value={option.level} />
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium text-sm">{option.title}</p>
        {isDefault ? <Badge variant="accent">Default</Badge> : null}
      </div>
      {/* Every option shows its full egress breakdown, mirroring the prod
          Settings → Data & Sync control. The blocking dialog scrolls, so the
          pre-selected level stays reachable without hiding the others' subtext. */}
      <p className="mt-1 text-pretty text-foreground/80 text-sm leading-relaxed">
        {option.description}
      </p>
      <div className="mt-3 flex flex-col gap-1.5">
        {option.dataLines.map((line) => (
          <DataLine key={line.label} kind={line.kind} label={line.label} />
        ))}
      </div>
      {option.caveat ? (
        <p className="mt-2.5 text-muted-foreground text-xs">{option.caveat}</p>
      ) : null}
    </div>
  </label>
);

export const DataSyncPanel = ({
  selected,
  onSelect,
  defaultLevel,
}: DataSyncPanelProps) => {
  const radioName = useId();
  return (
    <RadioGroup
      aria-label="Data & Sync level"
      onValueChange={(value) => onSelect(value as DataSyncLevel)}
      value={selected}
    >
      {dataSyncLevelOptions.map((option) => (
        <LevelRadioCard
          fieldId={`${radioName}-${option.level}`}
          isDefault={option.level === defaultLevel}
          key={option.level}
          option={option}
          selected={selected === option.level}
        />
      ))}
    </RadioGroup>
  );
};
