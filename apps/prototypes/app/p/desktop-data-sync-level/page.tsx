"use client";

import { DataSyncLevelCard } from "@repo/app/shared/components/data-sync-level-card";
import { DataSyncLevelVisual } from "@repo/app/shared/components/data-sync-level-visual";
import { DATA_SYNC_LEVEL_COPY } from "@repo/app/shared/lib/data-sync-copy";
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
import { ArrowDownRightIcon, ArrowUpRightIcon, CloudIcon } from "lucide-react";
import { useId, useState } from "react";
import {
  DATA_SYNC_LEVEL_RANK,
  DATA_SYNC_PICKER_LEVELS,
  type DataSyncLevel,
  DEFAULT_DATA_SYNC_LEVEL,
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
  const nextTitle = DATA_SYNC_LEVEL_COPY[next].title;
  const delta = DATA_SYNC_LEVEL_RANK[next] - DATA_SYNC_LEVEL_RANK[previous];
  if (delta > 0) {
    return {
      tone: "success",
      icon: "up",
      message: `Raised to ${nextTitle}. Additional sync lanes open on the next sync evaluation.`,
    };
  }
  return {
    tone: "warning",
    icon: "down",
    message: `Lowered to ${nextTitle}. Wider sync lanes close on the next sync evaluation.`,
  };
}

const CurrentLevelSummary = ({ level }: { level: DataSyncLevel }) => {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs">Current level</span>
      <Badge variant={level === Level.Off ? "muted" : "accent"}>
        {DATA_SYNC_LEVEL_COPY[level].badgeLabel}
      </Badge>
    </div>
  );
};

const DataSyncTab = () => {
  const radioName = useId();
  // Start on the level the shared card badges Recommended, so the selection and
  // the chip agree.
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
          {/* ISS-12522: the canonical shared card with its opt-in visual of
              what stays on this device and what is uploaded, rather than a
              sandbox look-alike of it. */}
          {DATA_SYNC_PICKER_LEVELS.map((level) => (
            <DataSyncLevelCard
              control={
                <RadioGroupItem
                  // Named from the copy source the card prints, as the
                  // production picker does, so the name contains the label.
                  aria-label={DATA_SYNC_LEVEL_COPY[level].title}
                  className="mt-0.5"
                  id={`${radioName}-${level}`}
                  value={level}
                />
              }
              htmlFor={`${radioName}-${level}`}
              key={level}
              level={level}
              selected={selected === level}
              visual={<DataSyncLevelVisual level={level} />}
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
