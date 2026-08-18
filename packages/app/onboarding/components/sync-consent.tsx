"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { DataSyncLevelCard } from "../../shared/components/data-sync-level-card";
import {
  DATA_SYNC_LEVEL_COPY,
  DataSyncLevelValue,
} from "../../shared/lib/data-sync-copy";

/**
 * The canonical data-sync level the user consents to in onboarding — the SAME
 * value the desktop Settings "Data & Sync" tab persists (FEA-4055). Onboarding
 * no longer writes a separate `syncObservabilityTier`: it writes this one value
 * through the consolidated `setDataSyncLevel` setter, which deterministically
 * derives every connectivity/sync boolean (`transcriptSyncEnabled`,
 * `cloudConnectionEnabled`, the observability tier) from it. Picking "Full
 * transcripts" here therefore actually enables transcript upload end-to-end,
 * instead of writing only the tier and leaving transcripts local (the FEA-4103
 * defect this fixes).
 *
 * Onboarding surfaces three of the four canonical levels — `full`, `metadata`,
 * `off` — omitting `redacted` (a forward-compat level that behaves as metadata
 * until its lane ships and does not need its own onboarding choice). The values
 * are the canonical {@link DataSyncLevelValue} literals so the payload maps 1:1
 * onto the desktop `DataSyncLevel` the setter consumes.
 */
export type SyncConsentLevel =
  | typeof DataSyncLevelValue.Full
  | typeof DataSyncLevelValue.Metadata
  | typeof DataSyncLevelValue.Off;

/**
 * @deprecated Legacy alias for {@link SyncConsentLevel}, kept so existing
 * importers keep compiling during the FEA-4055 consolidation. NOTE the value set
 * changed: the old `SyncObservabilityTier` used `local`; the canonical
 * `DataSyncLevel` uses `off`. Prefer {@link SyncConsentLevel}.
 */
export type SyncTier = SyncConsentLevel;

/**
 * The recommended level a fresh onboarding lands on. Metadata — the SAFEST option
 * that still unlocks cloud insight — so the pre-selected state never pre-consents
 * the user to uploading complete transcript bodies they never chose. Users opt UP
 * from here. Pinned to the shipped desktop Settings default
 * ({@link DEFAULT_DATA_SYNC_LEVEL_VALUE} `= Metadata`) by the desktop parity test
 * so the two surfaces recommend the same level; the literal is used here (not the
 * wider-typed shared const) because `SyncConsentLevel` deliberately excludes
 * `redacted`, which onboarding does not surface.
 */
export const DEFAULT_SYNC_LEVEL: SyncConsentLevel = DataSyncLevelValue.Metadata;

/** @deprecated Legacy alias for {@link DEFAULT_SYNC_LEVEL}. */
export const DEFAULT_SYNC_TIER = DEFAULT_SYNC_LEVEL;

/**
 * The level the ISS-5489 post-auth consent takeover lands on — deliberately
 * NOT {@link DEFAULT_SYNC_LEVEL}.
 *
 * This divergence is a product decision (ISS-5249), recorded in the
 * `post-auth-desktop-onboarding` prototype, not drift: the takeover asks the
 * question ONCE, blocking, at the moment the user has just chosen to join an
 * org, so it starts from the level that makes the product work and lets them opt
 * DOWN — whereas onboarding is a step a user walks past, so its pre-selection
 * must not be the widest one.
 *
 * ISS-5318 narrowed this divergence to the PRE-SELECTION only. The takeover used
 * to also carry its own chip ("Default", where the selection starts) against
 * onboarding's "Recommended", and that per-surface chip is what let one word
 * point at two levels once Settings started endorsing the widest one. The chip
 * now comes from `dataSyncLevelBadge` for every surface; only the starting
 * selection differs.
 *
 * Keep the two constants distinct. Collapsing them silently changes what a user
 * consents to on one of the two surfaces, in one direction or the other.
 */
export const DEFAULT_TAKEOVER_SYNC_LEVEL: SyncConsentLevel =
  DataSyncLevelValue.Full;

/**
 * The onboarding levels in the prototype's agreed presentation order, ranked
 * LEAST-to-most exposure, each rendered from the shared
 * {@link DATA_SYNC_LEVEL_COPY} SSOT so the onboarding card and the Settings card
 * tell the identical "what leaves the machine" story from ONE copy source and
 * can never drift.
 *
 * The order is asserted by `sync-consent.test.tsx`; a fourth level goes where
 * its exposure places it, not at the end.
 */
const SYNC_CONSENT_LEVELS: readonly SyncConsentLevel[] = [
  DataSyncLevelValue.Off,
  DataSyncLevelValue.Metadata,
  DataSyncLevelValue.Full,
];

type SyncLevelOptionProps = {
  /**
   * Native radio-group name. Supplied by the parent from `useId` rather than
   * hardcoded: `name` is DOCUMENT-global, so a fixed value silently joins every
   * mounted copy of this control into ONE radio group. Two consent surfaces on
   * screen at once then fight — the browser keeps a single input checked across
   * both and unchecks the rest WITHOUT firing React's `onChange`, so the
   * controlled `checked` state and the DOM diverge: nothing looks selected,
   * clicks appear dead, and the host still submits its own state. That is a real
   * shipped bug (ISS-5489), not a hypothetical.
   */
  groupName: string;
  /** Which level this radio represents. */
  level: SyncConsentLevel;
  /** Whether this option is the currently selected level. */
  checked: boolean;
  /** Fired when this option is picked. */
  onSelect: (level: SyncConsentLevel) => void;
};

function SyncLevelOption({
  groupName,
  level,
  checked,
  onSelect,
}: SyncLevelOptionProps) {
  return (
    <DataSyncLevelCard
      control={
        <input
          // Name the radio by its title so its accessible name is crisp ("Off",
          // "Metadata only", "Full transcripts") rather than the whole card body;
          // the description, per-line breakdown, and caveat stay in the label's
          // subtree for a screen reader to read as it moves through the card.
          aria-label={DATA_SYNC_LEVEL_COPY[level].title}
          checked={checked}
          className="mt-0.5 size-4 shrink-0"
          name={groupName}
          onChange={() => onSelect(level)}
          type="radio"
          value={level}
        />
      }
      level={level}
      selected={checked}
    />
  );
}

type SyncConsentProps = {
  /** Fired with the chosen level when the user confirms. */
  onConfirm: (level: SyncConsentLevel) => void;
  /**
   * Initially-selected level. Defaults to the recommended {@link
   * DEFAULT_SYNC_LEVEL} (`"metadata"`) — never a broader level than the user has
   * chosen.
   */
  defaultLevel?: SyncConsentLevel;
  /** Controlled in-flight state (host-owned): drives the spinner + disables. */
  confirming?: boolean;
  /**
   * Applied to this step's heading so a host that owns the surrounding surface
   * can name it from what is actually on screen (ISS-5112: the desktop account
   * dialog's `aria-labelledby`). Omitted everywhere else.
   */
  headingId?: string;
};

/**
 * The third and final step of the unified auth onboarding flow (PRD-532): the
 * user chooses what session data syncs to the ClosedLoop cloud. Surface-agnostic
 * and presentational only — the host owns the in-flight state and persists the
 * chosen level via `onConfirm` (which routes through the consolidated
 * `setDataSyncLevel` setter). Pre-selects the SAFEST insight-bearing level
 * ({@link DEFAULT_SYNC_LEVEL}, `"metadata"`, matching the shipped Settings
 * default) so the happy path never silently pre-consents to uploading prompt or
 * file contents; the user opts up to "Full transcripts" or down to "Off".
 *
 * FEA-4055: each level breaks its data down into per-line "syncs to cloud /
 * stays local" rows — rendered from the SAME shared {@link DATA_SYNC_LEVEL_COPY}
 * the desktop Settings "Data & Sync" tab uses — so this consent step and Settings
 * show the identical, verified breakdown of what leaves the machine.
 */
export function SyncConsent({
  onConfirm,
  defaultLevel = DEFAULT_SYNC_LEVEL,
  confirming = false,
  headingId,
}: SyncConsentProps) {
  const [selected, setSelected] = useState<SyncConsentLevel>(defaultLevel);

  return (
    <div className="mx-auto flex w-full max-w-[440px] flex-col text-center">
      <h1 className="font-semibold text-2xl tracking-tight" id={headingId}>
        Choose what syncs to the cloud
      </h1>
      <p className="mx-auto mt-2 max-w-[400px] text-pretty text-muted-foreground text-sm leading-relaxed">
        Get more insight into your sessions, invite teammates, and compare how
        AI is used across the team. You control exactly what leaves this device
        — and can change it anytime.
      </p>

      <SyncLevelOptions
        className="mt-5"
        onSelect={setSelected}
        selected={selected}
      />

      <Button
        aria-busy={confirming}
        className="mt-5 w-full"
        disabled={confirming}
        onClick={() => onConfirm(selected)}
        size="lg"
        type="button"
      >
        {confirming ? <Loader2 className="animate-spin" /> : null}
        Continue
      </Button>
    </div>
  );
}

/**
 * The three consent levels as a radio group, with no heading and no confirm
 * button.
 *
 * Extracted (ISS-5489) so the post-auth takeover can put the SAME per-level
 * breakdown inside its own modal chrome — which owns the dialog's title and
 * description for accessibility — without either surface reimplementing the
 * cards or the copy lookup. The alternative, passing the takeover's heading and
 * button label into {@link SyncConsent}, would have made one component carry two
 * unrelated layouts.
 */
export function SyncLevelOptions({
  selected,
  onSelect,
  className,
}: {
  selected: SyncConsentLevel;
  onSelect: (level: SyncConsentLevel) => void;
  className?: string;
}) {
  // One radio-group name per mounted instance. See `groupName` on
  // SyncLevelOptionProps for what a shared name actually breaks.
  const groupName = useId();

  return (
    <fieldset className={cn("flex flex-col gap-2.5", className)}>
      <legend className="sr-only">Sync level</legend>
      {SYNC_CONSENT_LEVELS.map((level) => (
        <SyncLevelOption
          checked={selected === level}
          groupName={groupName}
          key={level}
          level={level}
          onSelect={onSelect}
        />
      ))}
    </fieldset>
  );
}
