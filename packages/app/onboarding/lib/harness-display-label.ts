/**
 * @file Human labels for agent-harness ids (ISS-10492).
 *
 * Moved here from the desktop import splash's `import-splash-state.ts` when that
 * surface was retired. It sits beside the analysis bar's own inputs because the
 * bar's desktop feed (`use-onboarding-session-discovery.ts`) is one of the two
 * live readers; the other is the dashboard tour's "Harnesses found" row.
 */

import type { Harness } from "@repo/lib/harness/types";

/**
 * Every harness the collectors scan, named. Exhaustive over `Harness`, so a
 * harness added there fails `tsc` here until a person names it rather than
 * reaching the consent line as a title-cased id (ISS-11346).
 */
const SCANNED_HARNESS_LABELS: Readonly<Record<Harness, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot",
  opencode: "OpenCode",
};

const HARNESS_LABELS: Readonly<Record<string, string>> = {
  ...SCANNED_HARNESS_LABELS,
  gemini: "Gemini CLI",
};

/**
 * Human label for a harness id, title-casing an id the map does not carry
 * rather than showing the raw lowercase slug — matching `harnessLabel` in
 * `packages/app/packs/components/pack-meta.tsx`.
 *
 * The title-case fallback is load-bearing: these rows read the local store,
 * which can hold any recorded string, and `windsurf` sitting next to
 * "Claude Code" reads as a bug.
 */
export function harnessDisplayLabel(id: string): string {
  const mapped = HARNESS_LABELS[id];
  if (mapped) {
    return mapped;
  }
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** The name of a scanned harness, from the exhaustive map above; no fallback. */
export function scannedHarnessLabel(harness: Harness): string {
  return SCANNED_HARNESS_LABELS[harness];
}
