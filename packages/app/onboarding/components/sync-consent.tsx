"use client";

import {
  DataSyncLevel,
  RECOMMENDED_DATA_SYNC_LEVEL,
} from "@repo/api/src/types/data-sync-level";
import { Button } from "@repo/design-system/components/ui/button";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { DataSyncLevelPicker } from "../../shared/components/data-sync-level-picker";

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
 * are the canonical {@link DataSyncLevel} literals so the payload maps 1:1
 * onto the desktop `DataSyncLevel` the setter consumes.
 */
export type SyncConsentLevel =
  | typeof DataSyncLevel.Full
  | typeof DataSyncLevel.Metadata
  | typeof DataSyncLevel.Off;

/**
 * @deprecated Legacy alias for {@link SyncConsentLevel}, kept so existing
 * importers keep compiling during the FEA-4055 consolidation. NOTE the value set
 * changed: the old `SyncObservabilityTier` used `local`; the canonical
 * `DataSyncLevel` uses `off`. Prefer {@link SyncConsentLevel}.
 */
export type SyncTier = SyncConsentLevel;

/**
 * @deprecated Legacy alias for {@link RECOMMENDED_DATA_SYNC_LEVEL}, kept so
 * existing importers keep compiling.
 */
export const DEFAULT_SYNC_TIER: SyncConsentLevel = RECOMMENDED_DATA_SYNC_LEVEL;

/**
 * Which levels the consent surfaces offer — the canonical set minus `redacted`,
 * a forward-compat level that behaves as metadata until its lane ships and does
 * not need its own consent choice.
 *
 * ISS-6147: a SUBSET, not a sequence. `DataSyncLevelPicker` sorts whatever it is
 * given, so this array's order is not rendered and a fourth level added here
 * lands where its exposure ranking places it.
 */
export const SYNC_CONSENT_LEVELS: readonly SyncConsentLevel[] = [
  DataSyncLevel.Off,
  DataSyncLevel.Metadata,
  DataSyncLevel.Full,
];

/** Accessible name for the consent surfaces' level group. */
export const SYNC_LEVEL_GROUP_LABEL = "Sync level";

type SyncConsentProps = {
  /** Fired with the chosen level when the user confirms. */
  onConfirm: (level: SyncConsentLevel) => void;
  /**
   * A previously recorded choice. An unanswered policy starts unset.
   */
  defaultLevel?: SyncConsentLevel | null;
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
 * `setDataSyncLevel` setter). Unanswered policies have no preselected level
 * (ISS-12523); a recommendation never substitutes for a saved choice.
 *
 * FEA-4055: each level breaks its data down into per-line "syncs to cloud /
 * stays local" rows — rendered from the SAME shared {@link DATA_SYNC_LEVEL_COPY}
 * the desktop Settings "Data & Sync" tab uses — so this consent step and Settings
 * show the identical, verified breakdown of what leaves the machine.
 */
export function SyncConsent({
  onConfirm,
  defaultLevel = null,
  confirming = false,
  headingId,
}: SyncConsentProps) {
  const [selected, setSelected] = useState<SyncConsentLevel | null>(
    defaultLevel
  );

  return (
    <div className="mx-auto flex w-full max-w-[440px] flex-col text-center">
      <h1 className="font-semibold text-2xl tracking-tight" id={headingId}>
        Choose what syncs to the cloud
      </h1>
      <p className="mx-auto mt-2 max-w-[400px] text-pretty text-muted-foreground text-sm leading-relaxed">
        Get more insight into your sessions, invite teammates, and compare how
        AI is used across the team. You control exactly what leaves this device
        and can change it anytime.
      </p>

      <DataSyncLevelPicker
        className="mt-5"
        disabled={confirming}
        label={SYNC_LEVEL_GROUP_LABEL}
        levels={SYNC_CONSENT_LEVELS}
        onSelect={setSelected}
        selected={selected}
      />

      <Button
        aria-busy={confirming}
        className="mt-5 w-full"
        disabled={confirming || selected === null}
        onClick={() => {
          if (selected !== null) {
            onConfirm(selected);
          }
        }}
        size="lg"
        type="button"
      >
        {confirming ? <Loader2 className="animate-spin" /> : null}
        Continue
      </Button>
    </div>
  );
}
