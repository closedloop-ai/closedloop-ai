"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
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
  CheckIcon,
  CloudIcon,
  EyeOffIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useId, useState } from "react";
import {
  findSyncTierOption,
  SYNC_TIER_RANK,
  SyncTier,
  type SyncTierOption,
  syncTierOptions,
} from "./mock";

// The Settings tabs, mirroring apps/desktop SettingsPanel. Only "Cloud Sync"
// (the durable tier control this prototype introduces) has real content here.
const SETTINGS_TABS = [
  { id: "account", label: "Account" },
  { id: "relay-gateway", label: "Relay / Gateway" },
  { id: "security", label: "Security" },
  { id: "binary-paths", label: "CLI Tools" },
  { id: "cloud-sync", label: "Cloud Sync" },
  { id: "labs", label: "Labs" },
] as const;

type SaveEffect = {
  tone: "success" | "warning";
  icon: "up" | "down" | "cloud";
  message: string;
};

const DataLine = ({
  label,
  kind,
}: {
  label: string;
  kind: "sync" | "local";
}) => (
  <div className="flex items-center gap-2 text-xs">
    {kind === "sync" ? (
      <CheckIcon className="size-3.5 shrink-0 text-success" />
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

const TierRadioCard = ({
  option,
  fieldId,
  selected,
}: {
  option: SyncTierOption;
  fieldId: string;
  selected: boolean;
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
    <RadioGroupItem className="mt-0.5" id={fieldId} value={option.tier} />
    <div className="min-w-0 flex-1">
      <p className="font-medium text-sm">{option.title}</p>
      <p className="mt-1 text-pretty text-muted-foreground text-xs leading-relaxed">
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

function computeEffect(previous: SyncTier | null, next: SyncTier): SaveEffect {
  const nextOption = findSyncTierOption(next);
  if (previous === null) {
    return {
      tone: "success",
      icon: "cloud",
      message: `Sync level set to ${nextOption.title}. Uploads start on the next sync evaluation.`,
    };
  }
  const delta = SYNC_TIER_RANK[next] - SYNC_TIER_RANK[previous];
  if (delta > 0) {
    return {
      tone: "success",
      icon: "up",
      message: `Upgraded to ${nextOption.title}. Additional sync lanes open on the next sync evaluation.`,
    };
  }
  return {
    tone: "warning",
    icon: "down",
    message: `Downgraded to ${nextOption.title}. Wider sync lanes close on the next sync evaluation.`,
  };
}

const CurrentTierSummary = ({ tier }: { tier: SyncTier | null }) => {
  // Unset is the state this panel exists to warn about: sessions silently
  // strand on the device until a level is chosen. Surface it as a real Alert.
  if (tier === null) {
    return (
      <Alert variant="warning">
        <TriangleAlertIcon />
        <AlertTitle>Not set. Choose a level below.</AlertTitle>
        <AlertDescription>
          Until you pick a level, sessions stay on this device and nothing syncs
          to the cloud.
        </AlertDescription>
      </Alert>
    );
  }
  // Once set, the Badge alone carries the state — plain row, no fence.
  const option = findSyncTierOption(tier);
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs">Current level</span>
      <Badge variant={tier === SyncTier.Local ? "muted" : "accent"}>
        {option.badgeLabel}
      </Badge>
    </div>
  );
};

const CloudSyncTab = () => {
  const radioName = useId();
  // Land on the unset state: the risky path (uploads stranded until a tier is
  // chosen) is the first thing in view, matching the acceptance criterion.
  const [currentTier, setCurrentTier] = useState<SyncTier | null>(null);
  const [selected, setSelected] = useState<SyncTier | null>(null);
  const [effect, setEffect] = useState<SaveEffect | null>(null);

  const dirty = selected !== null && selected !== currentTier;

  let saveStateLabel = "Saved.";
  if (selected === null) {
    saveStateLabel = "Select a level to enable sync.";
  } else if (dirty) {
    saveStateLabel = "Unsaved change.";
  }

  const handleApply = () => {
    if (selected === null) {
      return;
    }
    setEffect(computeEffect(currentTier, selected));
    setCurrentTier(selected);
  };

  return (
    <div className="mt-4 space-y-4">
      <Section
        contentClassName="space-y-4"
        description="Select what to sync to the ClosedLoop cloud. You can change this at any time."
        title="Cloud Sync"
      >
        <CurrentTierSummary tier={currentTier} />

        <RadioGroup
          onValueChange={(value) => setSelected(value as SyncTier)}
          value={selected ?? ""}
        >
          {syncTierOptions.map((option) => (
            <TierRadioCard
              fieldId={`${radioName}-${option.tier}`}
              key={option.tier}
              option={option}
              selected={selected === option.tier}
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

const DesktopSyncSettingsPrototypePage = () => {
  const [tab, setTab] = useState<string>("cloud-sync");

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="space-y-4 rounded-xl border border-border bg-background p-6 shadow-sm">
        <h2 className="font-semibold text-foreground text-lg">Settings</h2>

        <Tabs onValueChange={setTab} value={tab}>
          <TabsList>
            {SETTINGS_TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="cloud-sync">
            <CloudSyncTab />
          </TabsContent>
          {SETTINGS_TABS.filter((t) => t.id !== "cloud-sync").map((t) => (
            <TabsContent key={t.id} value={t.id}>
              <InactiveTab label={t.label} />
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </main>
  );
};

export default DesktopSyncSettingsPrototypePage;
