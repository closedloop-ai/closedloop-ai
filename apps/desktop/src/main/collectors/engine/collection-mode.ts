/**
 * @file collection-mode.ts
 * @description FEA-1839: the single source of truth for hooks-vs-watcher routing
 * across every agent harness the desktop collects from (PRD-468 Phase 1; ADR of
 * record FEA-1716 §"Mutual Exclusivity Rule").
 *
 * INVARIANT — live watcher and hook listener for the same harness never co-run.
 * A harness's live telemetry is captured by EXACTLY ONE channel at a time:
 *   - "hooks"   — Closedloop hook handlers own live capture (Claude only, when
 *                 its hook config is installed). The harness's live JSONL
 *                 watcher is NOT started; the one-time boot import still runs and
 *                 is idempotent, so historical sessions are not lost.
 *   - "watcher" — the live JSONL file watcher owns capture (every harness without
 *                 an installed hook path).
 *   - "disabled"— no live collection path for this harness (defensive default for
 *                 an unknown/unsupported harness; unreachable for the five current
 *                 ones).
 *
 * Running both a watcher and a hook listener for one harness double-counts every
 * tool-call and lifecycle row. To prevent that drift this routing must stay
 * explicit and centralized:
 *
 *   EVERY new harness must derive its live-collection decision from
 *   `getActiveCollectionMode`. Do not reintroduce an inline `hooksInstalled`
 *   conditional at a call site — route it through this function instead.
 */
import type { Harness } from "../types.js";

/** What channel, if any, owns a harness's live telemetry capture. */
export type CollectionMode = "hooks" | "watcher" | "disabled";

/**
 * Whether each hook-capable harness currently has Closedloop hooks installed.
 * Resolved by the caller from the desktop's persisted hook flags — kept out of
 * this module so the predicate stays pure and unit-testable (no electron `app`
 * dependency).
 */
export type HooksInstalledState = {
  /** Claude Code hooks present in `settings.json`. */
  claude: boolean;
};

/**
 * The single typed predicate that answers "what mode is harness X in right now?".
 * Claude runs in `"hooks"` mode when its hook config is installed, otherwise
 * `"watcher"`; Codex / Cursor / Copilot / OpenCode have no hook path and always
 * run in `"watcher"` mode (Codex hooks were removed — PRD-431). See the
 * file-level INVARIANT.
 */
export function getActiveCollectionMode(
  harness: Harness,
  hooks: HooksInstalledState
): CollectionMode {
  switch (harness) {
    case "claude":
      return hooks.claude ? "hooks" : "watcher";
    case "codex":
    case "cursor":
    case "copilot":
    case "opencode":
      return "watcher";
    default:
      return "disabled";
  }
}
