/**
 * The canonical harness display vocabulary — one label + tone per known harness.
 *
 * Hoisted out of `session-status-badges.tsx` (#4480 review) so the value is a
 * dependency-light module rather than a component-local constant: the Sessions
 * "Group by" band header has to name a harness the same word the `HarnessBadge`
 * in the row does, and `session-grouping.ts` is deliberately React-free, so it
 * could not reach the map where it used to live.
 *
 * Lookup is case-insensitive because producers emit both `claude` and `Claude`;
 * an unrecognized value degrades to the raw string rather than a fabricated
 * label, which is what keeps a newly-added harness readable before its entry
 * lands here.
 */
import { Harness } from "@repo/api/src/types/agent-component";
import { HARNESS_LABEL } from "@repo/api/src/utils/agent-component-reduce";
import type { Tone } from "@repo/design-system/components/ui/types";

export type HarnessDisplayConfig = { label: string; tone: Tone };

/** Fallback harness when a row carries none — the historical default. */
export const DEFAULT_HARNESS_ID = "claude";

export const HARNESS_DISPLAY_CONFIG: Readonly<
  Record<string, HarnessDisplayConfig>
> = {
  claude: { label: "Claude", tone: "accent" },
  codex: { label: "Codex", tone: "info" },
  cursor: { label: "Cursor", tone: "warning" },
  copilot: { label: "Copilot", tone: "success" },
  // `muted`, not `danger`: red reads as an error state for what is just a third
  // harness name. Kept in sync with HARNESS_META in component-meta.tsx (T8).
  opencode: { label: "OpenCode", tone: "muted" },
};

/**
 * ISS-5524: the entry `HARNESS_DISPLAY_CONFIG` never had.
 *
 * `Harness.Both` is not a harness — it is the marker `resolveComponentHarness`
 * returns when a component's usage spans more than one — so the map above, which
 * was written against a different vocabulary (it still carries `cursor` and
 * `copilot`, which are not `Harness` members at all) and is typed
 * `Record<string, …>` so nothing could demand the member, simply had no row for
 * it. The fallback then handed the raw wire value through and 30 components in
 * this org rendered a lowercase `both` beside properly-cased `Codex` and
 * `Claude` badges.
 *
 * The label is READ from `HARNESS_LABEL`, not restated: the honest wording
 * ("Multiple harnesses", never "Claude + Codex", which would assert a harness
 * the component never touched) is already decided in two places and a third copy
 * is how they drift. `info` matches `HARNESS_META[Harness.Both].variant`, the
 * tone the group header's own chip already carries.
 *
 * Kept OUT of `HARNESS_DISPLAY_CONFIG` itself so the correction is gateable:
 * `resolveHarnessLabel` also feeds the Sessions "Group by" band header, which is
 * React-free and cannot read a flag, and folding the row into the shared map
 * would flip that surface with no gate at all.
 */
export const MULTIPLE_HARNESSES_DISPLAY_CONFIG: HarnessDisplayConfig = {
  label: HARNESS_LABEL[Harness.Both],
  tone: "info",
};

/**
 * The label + tone the `HarnessBadge` renders for `harness`, with the same
 * empty/unknown degradation the badge has always had.
 */
export function resolveHarnessDisplayConfig(
  harness: string | null | undefined
): HarnessDisplayConfig {
  const raw = harness || DEFAULT_HARNESS_ID;
  return (
    HARNESS_DISPLAY_CONFIG[raw.toLowerCase()] ?? {
      label: raw,
      tone: "accent",
    }
  );
}

/**
 * ISS-5524: the same resolution with the `Harness.Both` row present.
 *
 * A whole second answer rather than a parameter on the resolver above, because
 * the caller that swaps on the gate wants one of two complete configs — and the
 * resolver stays the untouched flag-OFF shape, which is what keeps the gate
 * flippable in both directions.
 */
export function resolveHonestHarnessDisplayConfig(
  harness: string | null | undefined
): HarnessDisplayConfig {
  if (harness?.toLowerCase() === Harness.Both) {
    return MULTIPLE_HARNESSES_DISPLAY_CONFIG;
  }
  return resolveHarnessDisplayConfig(harness);
}

/** Just the label — what a band header, chip, or plain-text caption needs. */
export function resolveHarnessLabel(
  harness: string | null | undefined
): string {
  return resolveHarnessDisplayConfig(harness).label;
}
