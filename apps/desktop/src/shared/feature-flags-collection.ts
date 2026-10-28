/**
 * @file feature-flags-collection.ts
 * @description The gates over WHAT THE DESKTOP READS OFF LOCAL DISK and derives
 * from it — the per-harness collectors, the OpenTelemetry capture gate, and plan
 * extraction — split out of `feature-flags.ts` (ISS-7431).
 *
 * These five entries are a contiguous run at the HEAD of the registry for
 * historical review stability. ISS-8753 deleted Settings -> Labs, so registry
 * order is no longer a rendered UI contract; the surviving witness checks
 * membership, not panel order.
 */

import { CLAUDE_CODE_OTEL_CAPTURE_FEATURE_FLAG_KEY } from "./claude-code-otel-capture-flag.js";

/**
 * FEA-3741 (slice 1) — per-tool collector enable/disable toggles ("Data
 * Collection" first-run permissions & access UX; Marisol's decision 2026-07-22:
 * collectors ON by default, individually disableable).
 *
 * Each key gates whether the desktop agent-data collector for that harness runs
 * at all. Default ON (unchanged always-on posture). When a user flips one off,
 * `getActiveCollectionMode` resolves that harness to `"disabled"` — the single
 * source-of-truth routing seam (FEA-1839) — so neither the live JSONL watcher
 * nor the hook path attaches for it, and its tool-home walk (`~/.claude`,
 * `~/.cursor`, Copilot workspace storage) is never started. These are the
 * collectors that can incidentally touch TCC-protected folders when a user's
 * real projects live under Desktop/Downloads/Documents, so a disable is the
 * user's lever to stop that scan entirely. `requiresRestart` because the toggle
 * is snapshotted at collector (re)start; the CLI Tools settings surface restarts
 * collectors on change so it takes effect immediately.
 *
 * These do NOT loosen any sandbox/security invariant — they only ever REDUCE
 * what the collectors read (FEA-3641/#3398 TCC-folder guards remain the
 * enforcement floor and are untouched).
 */
export const DESKTOP_COLLECT_CLAUDE_ENABLED_FEATURE_FLAG_KEY =
  "collectClaudeEnabled";
export const DESKTOP_COLLECT_CURSOR_ENABLED_FEATURE_FLAG_KEY =
  "collectCursorEnabled";
export const DESKTOP_COLLECT_COPILOT_ENABLED_FEATURE_FLAG_KEY =
  "collectCopilotEnabled";

/** Registry entries for the local collection gates, in registry order. */
export const COLLECTION_FEATURE_FLAGS = [
  {
    // ISS-7352 — INTERNAL gate, rendered by NO settings surface. Why `"Labs"` and not the `"Data Collection"` it sits beside, and all other rationale: `claude-code-otel-capture-flag.ts`.
    key: CLAUDE_CODE_OTEL_CAPTURE_FEATURE_FLAG_KEY,
    default: false,
    label: "Capture Claude Code OpenTelemetry",
    description:
      "Store the cost, API-request, and tool-permission measurements Claude Code already sends to the local collector, instead of discarding them. Identifiers and numbers only — never prompts, responses, or tool inputs.",
    category: "Labs" as const,
    hiddenFromLabs: true,
  },
  {
    key: DESKTOP_COLLECT_CLAUDE_ENABLED_FEATURE_FLAG_KEY,
    default: true,
    label: "Collect Claude Code sessions",
    description:
      "Reads your local Claude Code transcripts (~/.claude) to populate the Agent Dashboard. Turn off to stop Claude data collection entirely.",
    category: "Data Collection" as const,
    requiresRestart: true,
    // Rendered by a dedicated per-tool card in the CLI Tools settings tab, not
    // the generic flag list, so it lives beside the tool it collects from.
    hiddenFromLabs: true,
  },
  {
    key: DESKTOP_COLLECT_CURSOR_ENABLED_FEATURE_FLAG_KEY,
    default: true,
    label: "Collect Cursor sessions",
    description:
      "Reads your local Cursor transcripts (~/.cursor) to populate the Agent Dashboard. Turn off to stop Cursor data collection entirely.",
    category: "Data Collection" as const,
    requiresRestart: true,
    hiddenFromLabs: true,
  },
  {
    key: DESKTOP_COLLECT_COPILOT_ENABLED_FEATURE_FLAG_KEY,
    default: true,
    label: "Collect GitHub Copilot sessions",
    description:
      "Reads your local GitHub Copilot chat/CLI history (VS Code workspace storage, ~/.copilot) to populate the Agent Dashboard. Turn off to stop Copilot data collection entirely.",
    category: "Data Collection" as const,
    requiresRestart: true,
    hiddenFromLabs: true,
  },
  {
    key: "planExtractionEnabled" as const,
    default: false,
    label: "Plan Extraction",
    description:
      "Host-owned opt-in for Plans / plan extraction UI in the embedded Agent Dashboard.",
    category: "Experimental" as const,
  },
] as const;
