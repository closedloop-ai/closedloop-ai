import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { Input } from "@closedloop-ai/design-system/components/ui/input";
import { Label } from "@closedloop-ai/design-system/components/ui/label";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";
import {
  SANDBOX_MISSING_DIRECTORY_MESSAGE,
  SANDBOX_RISKY_ROOT_MESSAGE,
} from "../../../shared/sandbox-messages.js";
import type { SandboxInspectResult } from "../../types/desktop-api";

const INSPECT_DEBOUNCE_MS = 300;

const DESTRUCTIVE_TONE = "text-[var(--destructive)]";
const MUTED_TONE = "text-[var(--muted-foreground)]";

/**
 * FEA-4005: sandbox scope-root field for a gateway profile. Shows the current
 * path for inspection, offers the native directory picker, and surfaces inline
 * validity feedback (risky root / not-yet-a-workspace hint) reusing the existing
 * `pickSandboxDirectory` + `inspectSandboxPath` IPC. The authoritative risky-root
 * rejection still happens in the main process on save.
 *
 * The field is optional: an empty value means "inherit the global sandbox"
 * (shown as the placeholder), so it never scolds a profile that predates it.
 *
 * Split into its own module (rather than living in the already-oversized
 * SettingsPanel.tsx) so that grandfathered file trends smaller, per the repo
 * file-size discipline.
 */
export function ProfileSandboxField({
  value,
  onChange,
  onEnter,
  globalSandbox,
  onValidityChange,
}: {
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  globalSandbox: string;
  /**
   * ISS-4577 (wongk review): report whether the field's current value is a
   * KNOWN-invalid sandbox (settled risky root / missing directory) so the owning
   * profile form can block its Save. Without this the field showed the invalid
   * state inline but both profile Save paths still persisted it. Blank (inherit)
   * is never invalid.
   */
  onValidityChange?: (invalid: boolean) => void;
}) {
  const fieldId = useId();
  const inspection = useSandboxInspection(value);
  const handleBrowse = usePickSandboxDirectory(onChange);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      onEnter?.();
    }
  };

  const feedback = getSandboxFieldFeedback(value, inspection);
  const invalid = isSandboxValueSettledInvalid(value, inspection);
  useEffect(() => {
    onValidityChange?.(invalid);
  }, [invalid, onValidityChange]);

  return (
    <div className="space-y-1 sm:col-span-2">
      <Label className="text-xs" htmlFor={fieldId}>
        Sandbox Directory
      </Label>
      <div className="flex gap-2">
        <Input
          className="font-mono text-xs"
          id={fieldId}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={globalSandbox || "/Users/you/projects"}
          type="text"
          value={value}
        />
        <Button
          className="shrink-0"
          onClick={handleBrowse}
          type="button"
          variant="outline"
        >
          Browse
        </Button>
      </div>
      {feedback && (
        <p className={`text-xs ${feedback.tone}`}>{feedback.message}</p>
      )}
    </div>
  );
}

/**
 * FEA-4005 / ISS-4577: derive the inline sandbox-field helper text + tone from
 * the current value and its inspection, or `null` when there is nothing to say
 * (the common happy path — no permanent sentence cluttering the grid). A risky
 * root or a missing directory is an error (each is rejected — risky in the main
 * process on save, missing by disk state); a git repo hints the parent is
 * usually the better scope. Exported so every sandbox editor (the per-profile
 * field and the global Settings sandbox card) shows identical validity copy.
 */
export function getSandboxFieldFeedback(
  value: string,
  inspection: SandboxInspectResult | null
): { message: string; tone: string } | null {
  if (!value.trim()) {
    return null;
  }
  if (inspection?.isRisky) {
    return { message: SANDBOX_RISKY_ROOT_MESSAGE, tone: DESTRUCTIVE_TONE };
  }
  // `exists === false` is a *known* missing directory; `undefined` (a
  // TCC-protected folder or an older main-process build without the field) is
  // "unknown" and must not be reported as missing (no lying UI).
  if (inspection?.exists === false) {
    return {
      message: SANDBOX_MISSING_DIRECTORY_MESSAGE,
      tone: DESTRUCTIVE_TONE,
    };
  }
  if (inspection?.isGitRepo) {
    return {
      message:
        "This folder is itself a git repo. Its parent usually scopes a workspace of repos better.",
      tone: MUTED_TONE,
    };
  }
  return null;
}

/**
 * FEA-4005 / ISS-4577: debounced main-process inspection of a sandbox path value
 * (risky-root, git-repo, and existence flags). Shared by every sandbox editor so
 * the probe cadence and cancellation semantics stay identical. Returns the latest
 * inspection, or `null` while the value is blank or the probe has not resolved.
 */
export function useSandboxInspection(
  value: string
): SandboxInspectResult | null {
  const [inspection, setInspection] = useState<SandboxInspectResult | null>(
    null
  );

  useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      setInspection(null);
      return;
    }
    let active = true;
    // Debounce so only the settled value fires the synchronous main-process fs
    // probe, not every keystroke.
    const timer = setTimeout(() => {
      window.desktopApi
        .inspectSandboxPath(trimmed)
        .then((result) => {
          if (active) {
            setInspection(result);
          }
        })
        .catch(() => {
          if (active) {
            setInspection(null);
          }
        });
    }, INSPECT_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [value]);

  return inspection;
}

/**
 * FEA-4005 / ISS-4577: open the native directory picker and hand the chosen path
 * back through `onChange`. Sets exactly what the user picked (the git-repo hint
 * then offers the parent rather than silently substituting a different folder).
 * Picker cancellation / failure is non-fatal — the field keeps its value.
 * Shared so the per-profile field and the global Settings card pick identically.
 */
export function usePickSandboxDirectory(
  onChange: (value: string) => void
): () => void {
  return useCallback(() => {
    window.desktopApi
      .pickSandboxDirectory()
      .then((result) => {
        if (result) {
          onChange(result.path);
        }
      })
      .catch(() => {
        // Picker cancellation / failure is non-fatal.
      });
  }, [onChange]);
}

/**
 * ISS-4577: does the settled inspection for `value` describe a KNOWN-invalid
 * sandbox path — a risky root or a directory that does not exist on disk?
 *
 * Shared single source of truth for every sandbox editor's validity gate (the
 * global Settings card AND the per-gateway-profile field), so a "shows invalid
 * but still persists it" gap can't reopen on one surface. Returns `false` for a
 * blank value (blank means "unset"/"inherit the global sandbox", which each
 * caller handles) and for an inspection that has not settled onto the current
 * trimmed value yet or reports `exists: undefined` (a TCC-protected / unknown
 * folder — never reported as invalid, no lying UI). The main process stays the
 * authority on the risky/blank reject; this only mirrors what the UI already
 * shows so Save can be blocked before the round-trip.
 */
export function isSandboxValueSettledInvalid(
  value: string,
  inspection: SandboxInspectResult | null
): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (inspection?.path !== trimmed) {
    return false;
  }
  return inspection.isRisky === true || inspection.exists === false;
}
