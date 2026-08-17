import { DataSyncLevelCard } from "@repo/app/shared/components/data-sync-level-card";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { findDataSyncLevelCopy } from "@repo/app/shared/lib/data-sync-copy";
import {
  Alert,
  AlertDescription,
} from "@closedloop-ai/design-system/components/ui/alert";
import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { Section } from "@closedloop-ai/design-system/components/ui/layout/section";
import {
  RadioGroup,
  RadioGroupItem,
} from "@closedloop-ai/design-system/components/ui/radio-group";
import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import { CheckIcon, ShieldAlertIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { DataSyncLevel } from "../../../shared/contracts";
import { DATA_SYNC_LEVELS } from "../../../shared/data-sync-level";
import { DESKTOP_SHOW_REDACTED_SYNC_LEVEL_FEATURE_FLAG_KEY } from "../../../shared/feature-flags";

function CurrentLevelSummary({ level }: { level: DataSyncLevel }) {
  const copy = findDataSyncLevelCopy(level);
  return (
    <div className="flex items-center gap-2">
      <span className="text-[var(--muted-foreground)] text-xs">
        Current level
      </span>
      <Badge variant={level === DataSyncLevel.Off ? "muted" : "accent"}>
        {copy.badgeLabel}
      </Badge>
    </div>
  );
}

/**
 * FEA-3907 — the graduated "data sync level" control (Settings → Data & Sync).
 * A single radio-group that is the product-grade SSOT for how much data goes to
 * the cloud, superseding the scattered Cloud Connection / Transcript Sync /
 * Cloud Commands Paused Labs toggles. The main process derives those booleans
 * from the chosen level; this surface only reads/persists the level via IPC.
 * Built to the `desktop-data-sync-level` prototype the design pass agreed on.
 */
export function DataSyncTab() {
  const radioName = useId();
  const [currentLevel, setCurrentLevel] = useState<DataSyncLevel | null>(null);
  const [selected, setSelected] = useState<DataSyncLevel | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The directional confirmation shown after a successful Apply ("Raised to
  // …" / "Lowered to …"), the payoff of the interaction on the one screen whose
  // job is telling people how much data leaves their machine.
  const [confirmation, setConfirmation] = useState<string | null>(null);

  useEffect(() => {
    window.desktopApi
      .getDataSyncLevel()
      .then((result) => {
        setCurrentLevel(result.level);
        setSelected(result.level);
      })
      .catch(() => {
        // A privacy control must not assert a level it has not read; surface an
        // error rather than defaulting the switches to a guessed state.
        setLoadFailed(true);
      });
  }, []);

  // ISS-4779 closed-by-default: the "Redacted sessions" option is gated behind a
  // Labs flag (off by default) because its redaction lane is not plumbed yet.
  // The `redacted` VALUE stays valid everywhere else (copy, boolean mapping,
  // migration); only the picker's rendered option set is gated. A level a user
  // is already on stays visible so their current selection is never orphaned.
  const showRedacted = useFeatureFlagEnabledOptional(
    DESKTOP_SHOW_REDACTED_SYNC_LEVEL_FEATURE_FLAG_KEY
  );
  const visibleLevels = DATA_SYNC_LEVELS.filter(
    (level) =>
      showRedacted || level !== DataSyncLevel.Redacted || level === currentLevel
  );

  const loading = currentLevel === null && !loadFailed;
  const dirty =
    selected !== null && currentLevel !== null && selected !== currentLevel;

  let saveStateLabel = "Saved.";
  if (dirty) {
    saveStateLabel = "Unsaved change.";
  }

  const handleApply = async () => {
    if (selected === null) {
      return;
    }
    const previousLevel = currentLevel;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await window.desktopApi.setDataSyncLevel(selected);
      setCurrentLevel(result.level);
      setSelected(result.level);
      setConfirmation(describeLevelChange(previousLevel, result.level));
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to update data sync level"
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <Section
        contentClassName="space-y-4"
        description="One control for how much of your data goes to the Closedloop cloud. Choose a level below. You can change it at any time."
        title="Data & Sync"
      >
        {renderDataSyncBody({
          loadFailed,
          loading,
          levels: visibleLevels,
          currentLevel,
          selected,
          radioName,
          saveStateLabel,
          saveError,
          confirmation,
          saving,
          dirty,
          onSelect: (value) => {
            setSelected(value);
            setSaveError(null);
            // A new pending choice supersedes the last apply's confirmation.
            setConfirmation(null);
          },
          onApply: () => {
            handleApply().catch(() => {
              // handleApply already surfaces the error via saveError.
            });
          },
        })}
      </Section>
    </div>
  );
}

// Rendered inside the Section. Split out so the load-failed / loading / ready
// branches are early returns rather than a nested ternary in the JSX.
function renderDataSyncBody(props: {
  loadFailed: boolean;
  loading: boolean;
  /** The levels to render as options — the Redacted level is filtered out here
   * unless its Labs flag is on or the user is already on it. */
  levels: readonly DataSyncLevel[];
  currentLevel: DataSyncLevel | null;
  selected: DataSyncLevel | null;
  radioName: string;
  saveStateLabel: string;
  saveError: string | null;
  confirmation: string | null;
  saving: boolean;
  dirty: boolean;
  onSelect: (level: DataSyncLevel) => void;
  onApply: () => void;
}) {
  if (props.loadFailed) {
    return (
      <Alert variant="error">
        <ShieldAlertIcon />
        <AlertDescription>
          Couldn't read your data sync level. Reopen Settings to try again.
        </AlertDescription>
      </Alert>
    );
  }
  if (props.loading) {
    return (
      <div className="space-y-3">
        {props.levels.map((level) => (
          <div
            className="flex items-start gap-3 rounded-xl border border-[var(--border)] p-4"
            key={level}
          >
            <Skeleton className="mt-0.5 size-4 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-64" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <>
      {props.currentLevel ? (
        <CurrentLevelSummary level={props.currentLevel} />
      ) : null}
      <RadioGroup
        aria-label="Data & Sync level"
        onValueChange={(value) => props.onSelect(value as DataSyncLevel)}
        value={props.selected ?? ""}
      >
        {orderLevelsForDisplay(props.levels).map((level) => (
          <DataSyncLevelCard
            control={
              <RadioGroupItem
                className="mt-0.5"
                id={`${props.radioName}-${level}`}
                value={level}
              />
            }
            htmlFor={`${props.radioName}-${level}`}
            key={level}
            level={level}
            selected={props.selected === level}
          />
        ))}
      </RadioGroup>
      {props.saveError ? (
        <Alert variant="error">
          <ShieldAlertIcon />
          <AlertDescription>{props.saveError}</AlertDescription>
        </Alert>
      ) : null}
      {props.confirmation && !props.dirty ? (
        <Alert variant="success">
          <CheckIcon />
          <AlertDescription>{props.confirmation}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex items-center justify-end gap-3 border-[var(--border)] border-t pt-3">
        <span className="mr-auto text-[var(--muted-foreground)] text-xs">
          {props.saveStateLabel}
        </span>
        <Button
          disabled={!props.dirty || props.saving}
          onClick={props.onApply}
          size="sm"
        >
          {props.saving ? "Applying..." : "Apply changes"}
        </Button>
      </div>
    </>
  );
}

/**
 * The directional confirmation shown after a successful Apply. Compares the new
 * level against the previous one by ranked exposure (least → most) so the copy
 * names the direction ("Raised to …" / "Lowered to …") rather than repeating a
 * state the badge already shows, and appends the one detail neither the badge
 * nor the save-state carries: the sync lanes reconcile on the next evaluation.
 */
function describeLevelChange(
  previous: DataSyncLevel | null,
  next: DataSyncLevel
): string {
  const title = findDataSyncLevelCopy(next).badgeLabel;
  const tail = "sync lanes reconcile on the next sync evaluation.";
  if (previous === null || previous === next) {
    return `Data sync level set to ${title}; ${tail}`;
  }
  const raised =
    DATA_SYNC_LEVELS.indexOf(next) > DATA_SYNC_LEVELS.indexOf(previous);
  return `${raised ? "Raised" : "Lowered"} to ${title}; ${tail}`;
}

/**
 * The order the options are RENDERED in — ISS-5318 puts the recommended
 * (most-permissive) level first, so the list runs most-to-least exposure.
 *
 * Deliberately a render-layer reversal of a copy, not a change to
 * `DATA_SYNC_LEVELS`: that array is the canonical exposure RANKING, read by
 * `dataSyncLevelToBooleans` and by the raised/lowered confirmation. Reversing
 * the source would silently invert the direction the confirmation reports.
 */
function orderLevelsForDisplay(
  levels: readonly DataSyncLevel[]
): readonly DataSyncLevel[] {
  return [...levels].toReversed();
}
