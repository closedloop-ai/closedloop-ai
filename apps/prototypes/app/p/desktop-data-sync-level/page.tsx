"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Section } from "@repo/design-system/components/ui/layout/section";
import {
  RadioGroup,
  RadioGroupItem,
} from "@repo/design-system/components/ui/radio-group";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { cn } from "@repo/design-system/lib/utils";
import {
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  CloudIcon,
  EyeOffIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { useId, useState } from "react";
import {
  DATA_SYNC_LEVEL_RANK,
  type DataLine as DataLineModel,
  type DataSyncLevel,
  type DataSyncLevelOption,
  DEFAULT_DATA_SYNC_LEVEL,
  dataSyncLevelOptions,
  findDataSyncLevelOption,
  DataSyncLevel as Level,
} from "./mock";

// The Settings tabs, mirroring apps/desktop SettingsPanel. Only "Data & Sync"
// (the graduated level control this prototype introduces) has real content.
const SETTINGS_TABS = [
  { id: "account", label: "Account" },
  { id: "relay-gateway", label: "Relay / Gateway" },
  { id: "security", label: "Security" },
  { id: "binary-paths", label: "CLI Tools" },
  { id: "data-sync", label: "Data & Sync" },
  { id: "labs", label: "Labs" },
] as const;

type SaveEffect = {
  tone: "success" | "warning";
  icon: "up" | "down" | "cloud";
  message: string;
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
        {option.elevated ? (
          <Badge variant="warning">
            <ShieldAlertIcon className="size-3" />
            Elevated
          </Badge>
        ) : null}
      </div>
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

const EFFECT_ICON = {
  up: ArrowUpRightIcon,
  down: ArrowDownRightIcon,
  cloud: CloudIcon,
} as const;

const EffectBanner = ({ effect }: { effect: SaveEffect }) => {
  const Icon = EFFECT_ICON[effect.icon];
  return (
    <Alert variant={effect.tone}>
      <Icon />
      <AlertDescription>{effect.message}</AlertDescription>
    </Alert>
  );
};

function computeEffect(
  previous: DataSyncLevel,
  next: DataSyncLevel
): SaveEffect {
  const nextOption = findDataSyncLevelOption(next);
  const delta = DATA_SYNC_LEVEL_RANK[next] - DATA_SYNC_LEVEL_RANK[previous];
  if (delta > 0) {
    return {
      tone: "success",
      icon: "up",
      message: `Raised to ${nextOption.title}. Additional sync lanes open on the next sync evaluation.`,
    };
  }
  return {
    tone: "warning",
    icon: "down",
    message: `Lowered to ${nextOption.title}. Wider sync lanes close on the next sync evaluation.`,
  };
}

const CurrentLevelSummary = ({ level }: { level: DataSyncLevel }) => {
  const option = findDataSyncLevelOption(level);
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs">Current level</span>
      <Badge variant={level === Level.Off ? "muted" : "accent"}>
        {option.badgeLabel}
      </Badge>
    </div>
  );
};

const DataSyncTab = () => {
  const radioName = useId();
  // Land on the recommended DEFAULT so the happy path is pre-selected, matching
  // the graduated-permission-selector reference.
  const [currentLevel, setCurrentLevel] = useState<DataSyncLevel>(
    DEFAULT_DATA_SYNC_LEVEL
  );
  const [selected, setSelected] = useState<DataSyncLevel>(
    DEFAULT_DATA_SYNC_LEVEL
  );
  const [effect, setEffect] = useState<SaveEffect | null>(null);

  const dirty = selected !== currentLevel;
  const saveStateLabel = dirty ? "Unsaved change." : "Saved.";

  const handleApply = () => {
    setEffect(computeEffect(currentLevel, selected));
    setCurrentLevel(selected);
  };

  return (
    <div className="mt-4 space-y-4">
      <Section
        contentClassName="space-y-4"
        description="One control for how much of your data goes to the Closedloop cloud. Choose a level below. You can change it at any time."
        title="Data & Sync"
      >
        <CurrentLevelSummary level={currentLevel} />

        <RadioGroup
          onValueChange={(value) => setSelected(value as DataSyncLevel)}
          value={selected}
        >
          {dataSyncLevelOptions.map((option) => (
            <LevelRadioCard
              fieldId={`${radioName}-${option.level}`}
              isDefault={option.level === DEFAULT_DATA_SYNC_LEVEL}
              key={option.level}
              option={option}
              selected={selected === option.level}
            />
          ))}
        </RadioGroup>

        {effect ? <EffectBanner effect={effect} /> : null}

        <div className="flex items-center justify-end gap-3 border-border border-t pt-3">
          <span className="mr-auto text-muted-foreground text-xs">
            {saveStateLabel}
          </span>
          <Button disabled={!dirty} onClick={handleApply} size="sm">
            Apply changes
          </Button>
        </div>
      </Section>
    </div>
  );
};

const InactiveTab = ({ label }: { label: string }) => (
  <div className="mt-4 rounded-lg border border-border border-dashed bg-muted/20 px-4 py-8 text-center text-muted-foreground text-sm">
    {label} settings are not part of this prototype.
  </div>
);

const DesktopDataSyncLevelPrototypePage = () => {
  const [tab, setTab] = useState<string>("data-sync");

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs onValueChange={setTab} value={tab}>
            <TabsList>
              {SETTINGS_TABS.map((t) => (
                <TabsTrigger key={t.id} value={t.id}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="data-sync">
              <DataSyncTab />
            </TabsContent>
            {SETTINGS_TABS.filter((t) => t.id !== "data-sync").map((t) => (
              <TabsContent key={t.id} value={t.id}>
                <InactiveTab label={t.label} />
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>
    </main>
  );
};

export default DesktopDataSyncLevelPrototypePage;
