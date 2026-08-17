import { useCallback, useState } from "react";
import {
  DESKTOP_COMMAND_SIGNING_ENFORCEMENT_FEATURE_FLAG_KEY,
  FEATURE_FLAGS,
  type FlagDefinition,
} from "../../../shared/feature-flags";
import {
  RequiresRestartNote,
  SettingsToggleRow,
  SettingsToggleRowSkeleton,
  useFlagToggle,
} from "./settings-flag-toggle";

// FEA-4130: the user-configurable Security opt-ins surfaced as toggles in the
// Security Settings card, selected by explicit key — NOT by
// `category === "Security"`. `category` groups flags for the registry; a future
// internal/registry-only Security flag (a `hiddenFromLabs` gate with no user
// control) must not auto-inherit a writable toggle here (wongk review).
// Currently just Trusted Browser Enforcement; add a key to this list to surface
// another Security opt-in.
const SECURITY_TOGGLE_FLAG_KEYS: readonly string[] = [
  DESKTOP_COMMAND_SIGNING_ENFORCEMENT_FEATURE_FLAG_KEY,
];
const SECURITY_FLAGS: readonly FlagDefinition[] = SECURITY_TOGGLE_FLAG_KEYS.map(
  (key) => {
    const flag = FEATURE_FLAGS.find((f) => f.key === key);
    if (!flag) {
      throw new Error(`Unknown Security toggle flag: ${key}`);
    }
    return flag;
  }
);

// FEA-4130: the Security-category flags (currently just the Trusted Browser
// Enforcement opt-in) render as a bordered section inside the Security Settings
// card, right under Dangerous Auto-Approve — the same grammar as its closest
// sibling (a security switch with a one-line description), not a second card
// with its own visual language. The settings record is read once by the parent
// tab and threaded down so the card paints in a single step; a user-set opt-in
// (default OFF), so a failed toggle surfaces inline rather than snapping the
// switch back silently.
export function SecurityFlagsSection({
  settings,
  onSettingsChange,
}: {
  settings: Record<string, unknown> | null;
  onSettingsChange: (settings: Record<string, unknown>) => void;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  const setError = useCallback((key: string, message: string) => {
    setErrors((prev) => {
      if (!message) {
        if (!(key in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: message };
    });
  }, []);

  const { saving, handleToggle } = useFlagToggle(
    (updated) => onSettingsChange(updated),
    setError
  );

  // `settings === null` means the parent's one read is still in flight; hold the
  // switch behind a skeleton until it resolves. A quick click on a
  // confidently-rendered default would write the wrong value.
  const loading = settings === null;

  return (
    <div className="space-y-3 border-t pt-2">
      {SECURITY_FLAGS.map((flag) => {
        if (loading) {
          return <SettingsToggleRowSkeleton key={flag.key} />;
        }
        // Off by default (dark launch); an absent key reads as OFF rather than
        // the registry default, matching the Labs surface it moved from.
        const value = settings?.[flag.key] === true;
        return (
          <SettingsToggleRow
            checked={value}
            description={flag.description}
            disabled={saving === flag.key}
            error={errors[flag.key]}
            key={flag.key}
            label={flag.label}
            note={flag.requiresRestart ? <RequiresRestartNote /> : undefined}
            onToggle={() => handleToggle(flag.key, value)}
          />
        );
      })}
    </div>
  );
}
