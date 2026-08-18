import { Section } from "@closedloop-ai/design-system/components/ui/layout/section";
import {
  FEATURE_FLAGS,
  type FlagDefinition,
} from "../../../shared/feature-flags";
import {
  RequiresRestartNote,
  SettingsToggleRow,
  useFlagToggle,
} from "./settings-flag-toggle";

// The Labs panel is driven directly by the shared feature-flag registry
// (single source of truth). `hiddenFromLabs` flags — e.g. shared kebab-case UI
// flags that are not user-set — are excluded so only user-facing toggles render.
const LAB_FLAGS = FEATURE_FLAGS.filter((flag) => !flag.hiddenFromLabs);

/**
 * The Settings → Labs tab.
 *
 * ISS-5309: this whole tab — trigger and content — is behind the `labsNav`
 * container gate, so `SettingsPanel` never mounts it while Labs is off. It is
 * the only in-app UI for the per-item Labs flags, which is exactly why it has to
 * go dark with the rest of the section: a Settings tab still listing and
 * toggling experimental features would defeat the gate that just withdrew them.
 *
 * Extracted from `SettingsPanel.tsx` in the same change, matching the
 * one-tab-per-file shape of `data-sync-tab.tsx` and `desktop-account-tab.tsx`.
 *
 * ISS-5310 (stage cid 3726701547) — the list is now GROUPED, not one flat stack.
 * It had become forty-one identical bordered rows in a single card, thirty-six
 * of them wearing a "Labs" badge inside a card titled Labs: the badge was noise
 * on nearly every row and the borders gave the eye no path down the list. This
 * PR is what made that load-bearing — hunting one switch out of forty-one is now
 * the only way to get the Agents page back — so each flag's own `category` drives
 * a `Section`, and the section header does the job the per-row badge was doing
 * (the off-scale `text-[10px]` badge is gone with it).
 *
 * ISS-5310 (stage cid 3726701537): the Gateway Health card that used to sit
 * above this list moved to Relay / Gateway → Connection Status. It is not an
 * experiment, and behind an off-by-default gate the one rollup you want when the
 * desktop will not connect was invisible to the person who needs it.
 */
export function LabsTab({
  settings,
  onSettingsChange,
}: {
  settings: Record<string, unknown> | null;
  onSettingsChange: (s: Record<string, unknown>) => void;
}) {
  // Experimental Labs flags keep the best-effort convention: a failed toggle
  // just leaves the switch at its last-known value (no inline error), so no
  // onError is passed.
  const { saving, handleToggle } = useFlagToggle((updated) =>
    onSettingsChange(updated)
  );

  const isOn = (key: string) => settings?.[key] === true;

  return (
    <div className="mt-4 space-y-4">
      {groupFlagsByCategory(LAB_FLAGS).map(([category, flags]) => (
        <Section
          contentClassName="space-y-3"
          description={LABS_CATEGORY_DESCRIPTION[category]}
          key={category}
          title={category}
        >
          {flags.map((flag) => {
            const checked = isOn(flag.key);
            // ISS-5310: a dependent row is nested under its parent and its
            // switch is DISABLED while that parent is off, so the dependency is
            // something the UI enforces rather than something the copy claims.
            const blockedBy =
              flag.dependsOn && !isOn(flag.dependsOn) ? flag.dependsOn : null;
            return (
              <div
                className={flag.dependsOn ? "ml-6" : undefined}
                key={flag.key}
              >
                <SettingsToggleRow
                  checked={checked}
                  description={flag.description}
                  disabled={saving === flag.key || blockedBy !== null}
                  label={flag.label}
                  note={<FlagRowNote blockedBy={blockedBy} flag={flag} />}
                  onToggle={() => handleToggle(flag.key, checked)}
                />
              </div>
            );
          })}
        </Section>
      ))}
    </div>
  );
}

/**
 * What each Labs group is for, so the section header carries meaning rather than
 * just replacing the badge with a bigger badge.
 */
const LABS_CATEGORY_DESCRIPTION: Record<FlagDefinition["category"], string> = {
  "CLI Tools": "Which local agent CLIs Closedloop may detect and run.",
  Cloud: "How this desktop talks to the Closedloop cloud.",
  "Data Collection": "What this desktop captures from your local sessions.",
  Diagnostics: "Extra instrumentation for debugging Closedloop itself.",
  Experimental: "Unfinished work. Expect rough edges.",
  Labs: "Early access to experimental features and advanced controls.",
  Security: "Gateway and command-execution safeguards.",
};

/**
 * Registry order within a group, category order by first appearance — so adding
 * a flag never reshuffles the list, and a group's position stays wherever its
 * earliest flag sits in the registry.
 */
function groupFlagsByCategory(
  flags: readonly FlagDefinition[]
): [FlagDefinition["category"], FlagDefinition[]][] {
  const groups = new Map<FlagDefinition["category"], FlagDefinition[]>();
  for (const flag of flags) {
    const existing = groups.get(flag.category);
    if (existing) {
      existing.push(flag);
      continue;
    }
    groups.set(flag.category, [flag]);
  }
  return [...groups.entries()].map(([category, group]) => [
    category,
    orderDependentsUnderParents(group),
  ]);
}

/**
 * Lift each dependent row to sit directly under its parent, otherwise the indent
 * points at whatever flag happens to precede it in the registry.
 *
 * An explicit rebuild rather than `Array#sort` with a "is my parent" comparator:
 * that comparator returns 0 for every unrelated pair, so it is not a total
 * order and the result would be engine-defined. A dependent whose parent is not
 * in this group stays at its registry position (still disabled by the row's own
 * `blockedBy` check) rather than being hoisted under nothing.
 */
function orderDependentsUnderParents(
  group: readonly FlagDefinition[]
): FlagDefinition[] {
  const dependentsByParent = new Map<string, FlagDefinition[]>();
  const standalone: FlagDefinition[] = [];
  for (const flag of group) {
    const parentKey = flag.dependsOn;
    if (!(parentKey && group.some((peer) => peer.key === parentKey))) {
      standalone.push(flag);
      continue;
    }
    const siblings = dependentsByParent.get(parentKey);
    if (siblings) {
      siblings.push(flag);
      continue;
    }
    dependentsByParent.set(parentKey, [flag]);
  }
  const ordered: FlagDefinition[] = [];
  for (const flag of standalone) {
    ordered.push(flag, ...(dependentsByParent.get(flag.key) ?? []));
  }
  return ordered;
}

/** The restart hint and the blocked-by-parent hint, in one row slot. */
function FlagRowNote({
  blockedBy,
  flag,
}: {
  blockedBy: string | null;
  flag: FlagDefinition;
}) {
  if (blockedBy !== null) {
    return (
      <p className="mt-0.5 text-[var(--muted-foreground)] text-xs">
        {`Turn on ${labelForFlagKey(blockedBy)} first.`}
      </p>
    );
  }
  return flag.requiresRestart ? <RequiresRestartNote /> : null;
}

/**
 * The parent's own registry label, never a copy of it at the call site — the two
 * would drift the moment the parent is renamed.
 */
function labelForFlagKey(key: string): string {
  return FEATURE_FLAGS.find((flag) => flag.key === key)?.label ?? key;
}
