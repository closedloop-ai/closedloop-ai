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

/** Just the label — what a band header, chip, or plain-text caption needs. */
export function resolveHarnessLabel(
  harness: string | null | undefined
): string {
  return resolveHarnessDisplayConfig(harness).label;
}
