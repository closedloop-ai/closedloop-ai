import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { Input } from "@closedloop-ai/design-system/components/ui/input";
import { Label } from "@closedloop-ai/design-system/components/ui/label";
import { type KeyboardEvent, useEffect, useId, useState } from "react";
import { cleanIpcError } from "../../clean-ipc-error";
import {
  getSandboxFieldFeedback,
  isSandboxValueSettledInvalid,
  usePickSandboxDirectory,
  useSandboxInspection,
} from "./gateway-profile-sandbox-field";

/**
 * ISS-4577: view + edit the GLOBAL sandbox base directory in Settings.
 *
 * The sandbox path is written once during first-run setup
 * (`ManagedOnboardingController` → `settingsStore.update({ sandboxBaseDirectory })`).
 * Before this section there was nowhere to see or change it afterward, so it was
 * effectively write-once. It surfaces the SAME value setup wrote —
 * the global `settings.sandboxBaseDirectory` — as a first-class editable field:
 * a directory picker + inline existence/risky-root validation, persisted through
 * the EXISTING `updateSettings` IPC (`desktop:update-settings`), which is the
 * exact save path setup uses (required + risky-root reject + repo reseed).
 *
 * Rendered as a `border-t` SECTION inside the one Security Settings card
 * (wongk review, ISS-4577), matching the rhythm of the sibling Manage API Key
 * and Dangerous Auto-Approve sections rather than sitting as its own card.
 *
 * This is distinct from the per-gateway-profile sandbox (`ProfileSandboxField`,
 * FEA-4005), which scopes one gateway profile and defaults to inheriting this
 * global value. This section owns the global default itself.
 */
export function GlobalSandboxSection({
  settings,
  onSettingsChange,
}: {
  settings: Record<string, unknown> | null;
  onSettingsChange: (s: Record<string, unknown>) => void;
}) {
  const fieldId = useId();
  const headingId = useId();
  // `null` settings means the async settings load has not resolved yet — the
  // stored value is genuinely unknown, distinct from a resolved-but-empty value
  // (wongk review, ISS-4577). We must not render a placeholder path as if it
  // were the confined folder before we know the real one.
  const settingsLoaded = settings !== null;
  const savedValue = (settings?.sandboxBaseDirectory as string) || "";
  const [value, setValue] = useState(savedValue);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Re-seed the editor whenever the canonical stored value changes (e.g. after a
  // refresh or a save elsewhere), so the field always reflects the source of
  // truth rather than a stale local edit.
  //
  // Guard against clobbering a newer in-flight edit (shafty review, ISS-4577):
  // an in-flight save of value A resolves with the persisted settings, which
  // lands A into `savedValue`; without this guard the effect would then reset
  // the field to A even if the user had moved on to B. We (a) disable the input
  // + Browse while `saving` so no B can be typed during a save, and (b) skip the
  // re-seed while `saving` so the save response can never overwrite the field
  // mid-save. The post-save `savedValue` change re-seeds once `saving` clears.
  useEffect(() => {
    if (saving) {
      return;
    }
    setValue(savedValue);
  }, [savedValue, saving]);

  const inspection = useSandboxInspection(value);
  const handleBrowse = usePickSandboxDirectory(setValue);
  const feedback = getSandboxFieldFeedback(value, inspection);

  const trimmed = value.trim();
  const isUnchanged = trimmed === savedValue.trim();
  // The inspection is debounced (300 ms) + an async IPC round trip, so right
  // after an edit `inspection` is still null or still describes the PREVIOUS
  // value. Saving in that window would send an unvalidated path — the main
  // settings handler rejects blank/risky but NOT a missing directory, so a
  // mistyped/stale path could persist despite this UI claiming to validate it
  // (codex + wongk review). Treat the inspection as authoritative only when it
  // describes the current trimmed value; until then the value is unsettled.
  const inspectionMatchesValue = inspection?.path === trimmed;
  const inspectionPending = trimmed.length > 0 && !inspectionMatchesValue;
  // The main process is the authority on risky/blank rejection; disable Save for
  // the states we already know are invalid (or not yet validated) so the user
  // gets immediate feedback instead of a round-trip error or a silent bad save.
  // The settled risky/missing check is the shared `isSandboxValueSettledInvalid`
  // (SSOT with the per-profile field, ISS-4577); the global section additionally
  // treats blank as invalid (this field is required, not inherit) and blocks
  // while the inspection is still pending.
  const knownInvalid =
    trimmed.length === 0 ||
    inspectionPending ||
    isSandboxValueSettledInvalid(value, inspection);

  // Any edit clears a prior "Saved" confirmation so it can't imply the current
  // (unsaved) value was persisted.
  const handleChange = (next: string) => {
    setValue(next);
    setSaved(false);
  };

  const handleSave = async () => {
    if (isUnchanged || knownInvalid) {
      return;
    }
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      // The updateSettings IPC returns the full, freshly-persisted settings, so
      // it is the authoritative save result — use it directly instead of a
      // second getSettings round-trip (shafty review, ISS-4577). A separate
      // readback shared this catch: a transient getSettings failure AFTER the
      // write already committed would have reported the committed write as
      // failed and left stale parent state, so a retry would repeat a write the
      // filesystem boundary already applied. There is no readback to fail now —
      // a thrown error here means the write itself failed.
      const updated = await window.desktopApi.updateSettings({
        sandboxBaseDirectory: trimmed,
      });
      onSettingsChange(updated as Record<string, unknown>);
      setSaved(true);
    } catch (err) {
      setSaveError(cleanIpcError(err, "Failed to update sandbox directory"));
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleSave().catch(() => {
        // Errors surface through saveError state below.
      });
    }
  };

  // The stored value is empty once settings have loaded: say so plainly instead
  // of leaving the field looking like it shows a configured folder (wongk
  // review, ISS-4577). Held silent until settings resolve so the section never
  // asserts a security boundary it doesn't yet know.
  const showNotSet = settingsLoaded && savedValue.trim().length === 0;

  return (
    <section aria-labelledby={headingId} className="space-y-2 border-t pt-2">
      <div className="space-y-1">
        <h4 className="font-medium text-sm" id={headingId}>
          Sandbox Directory
        </h4>
        <p className="text-[var(--muted-foreground)] text-xs">
          Agents can only read and write inside this folder. Change it to point
          at a different project or workspace folder. A gateway profile can
          point somewhere else.
        </p>
      </div>
      <div className="space-y-1">
        <Label className="sr-only" htmlFor={fieldId}>
          Sandbox Directory
        </Label>
        <div className="flex gap-2">
          <Input
            className="flex-1 font-mono text-xs"
            disabled={saving || !settingsLoaded}
            id={fieldId}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            type="text"
            value={value}
          />
          <Button
            aria-label="Browse for sandbox directory"
            className="shrink-0"
            disabled={saving || !settingsLoaded}
            onClick={handleBrowse}
            size="sm"
            type="button"
            variant="outline"
          >
            Browse
          </Button>
          <Button
            className="shrink-0"
            disabled={saving || isUnchanged || knownInvalid}
            onClick={handleSave}
            size="sm"
            type="button"
          >
            Save
          </Button>
          {saved && (
            <span
              aria-live="polite"
              className="self-center text-[var(--muted-foreground)] text-xs"
              role="status"
            >
              Saved
            </span>
          )}
        </div>
        {showNotSet && (
          <p className="text-[var(--muted-foreground)] text-xs">Not set</p>
        )}
        {feedback && (
          <p className={`text-xs ${feedback.tone}`}>{feedback.message}</p>
        )}
        {saveError && (
          <p className="text-[var(--destructive)] text-xs">{saveError}</p>
        )}
      </div>
    </section>
  );
}
