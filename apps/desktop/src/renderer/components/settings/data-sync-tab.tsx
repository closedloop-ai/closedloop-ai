import {
  Alert,
  AlertDescription,
} from "@closedloop-ai/design-system/components/ui/alert";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { Section } from "@closedloop-ai/design-system/components/ui/layout/section";
import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import {
  type DataSyncLevel,
  isMoreExposedDataSyncLevel,
  toDataSyncLevel,
} from "@repo/api/src/types/data-sync-level";
import { DataSyncLevelPicker } from "@repo/app/shared/components/data-sync-level-picker";
import { DataSyncPolicySummary } from "@repo/app/shared/components/data-sync-policy-summary";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { findDataSyncLevelCopy } from "@repo/app/shared/lib/data-sync-copy";
import {
  offeredDataSyncLevelsWithoutRedaction,
  offeredDataSyncLevelsWithRedaction,
} from "@repo/app/shared/lib/data-sync-level-options";
import { CheckIcon, ShieldAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { DESKTOP_SHOW_REDACTED_SYNC_LEVEL_FEATURE_FLAG_KEY } from "../../../shared/feature-flags-labs-detail";
import { hasAnsweredSyncConsent } from "../../../shared/sync-consent";
import { cleanIpcError } from "../../clean-ipc-error";
import { parseSyncConsentRecord } from "../../shared/sync-consent-record-boundary";

/**
 * FEA-3907 — the graduated "data sync level" control (Settings → Data & Sync).
 * A single radio-group that is the product-grade SSOT for how much data goes to
 * the cloud, superseding the scattered Cloud Connection / Transcript Sync /
 * Cloud Commands Paused Labs toggles. The main process derives those booleans
 * from the chosen level; this surface only reads/persists the level via IPC.
 * Built to the `desktop-data-sync-level` prototype the design pass agreed on.
 */
export function DataSyncTab() {
  const [currentLevel, setCurrentLevel] = useState<DataSyncLevel | null>(null);
  const [selected, setSelected] = useState<DataSyncLevel | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The directional confirmation shown after a successful Apply ("Raised to
  // …" / "Lowered to …"), the payoff of the interaction on the one screen whose
  // job is telling people how much data leaves their machine.
  const [confirmation, setConfirmation] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() =>
        Promise.all([
          globalThis.window.desktopApi.getDataSyncLevel(),
          globalThis.window.desktopApi.getSyncConsentRecord(),
        ])
      )
      .then(([result, rawRecord]) => {
        if (cancelled) {
          return;
        }
        const record = parseSyncConsentRecord(rawRecord);
        const effectiveLevel = toDataSyncLevel(result?.level);
        if (!record || effectiveLevel === undefined) {
          setLoadFailed(true);
          return;
        }
        const level = hasAnsweredSyncConsent(record) ? effectiveLevel : null;
        setCurrentLevel(level);
        setSelected(level);
      })
      .catch(() => {
        // A privacy control must not assert a level it has not read; surface an
        // error rather than defaulting the switches to a guessed state.
        if (!cancelled) {
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ISS-4779 closed-by-default: the "Redacted sessions" option is gated behind a
  // Labs flag (off by default) because its redaction lane is not plumbed yet.
  // The `redacted` VALUE stays valid everywhere else (copy, boolean mapping,
  // migration); only the picker's rendered option set is gated.
  //
  // The subset rule itself moved to `@repo/app/shared/lib/data-sync-level-options`
  // (PLN-1915 Step 4) — the two functions called just below — so the Settings v2
  // Connected Devices panel, which offers the same choice on the same machine,
  // cannot come to a different answer.
  const showRedacted = useFeatureFlagEnabledOptional(
    DESKTOP_SHOW_REDACTED_SYNC_LEVEL_FEATURE_FLAG_KEY
  );
  const visibleLevels = showRedacted
    ? offeredDataSyncLevelsWithRedaction()
    : offeredDataSyncLevelsWithoutRedaction(currentLevel);

  const dirty = selected !== null && selected !== currentLevel;

  let saveStateLabel = currentLevel === null ? "" : "Saved.";
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
      setSaveError(cleanIpcError(err, "Failed to update data sync level"));
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
      <DataSyncPolicySummary level={props.currentLevel} />
      <DataSyncLevelPicker
        disabled={props.saving}
        label="Data & Sync level"
        levels={props.levels}
        onSelect={props.onSelect}
        selected={props.selected}
      />
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
          data-analytics-sync-choice={props.selected ?? ""}
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
  const raised = isMoreExposedDataSyncLevel(next, previous);
  return `${raised ? "Raised" : "Lowered"} to ${title}; ${tail}`;
}
