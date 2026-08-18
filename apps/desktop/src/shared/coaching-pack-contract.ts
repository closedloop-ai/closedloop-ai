/**
 * @file coaching-pack-contract.ts — the single shared shape for a "coaching
 * pack" crossing the main↔renderer boundary.
 *
 * A coaching pack is a distributable folder whose `signals` REPLACE the
 * built-in agentic-development best-practice signals used by Agent Coaching
 * Tips. The main-process store lives in `main/agent-coaching-packs.ts`; the
 * renderer consumes the active pack over IPC (`getCoachingPack`). Both sides
 * import this type so the contract never drifts.
 */

/**
 * Structured outcome of a local coaching-harness run (`claude -p` / codex /
 * opencode) crossing the main↔renderer boundary. The harness resolves to this
 * for BOTH success and operational failure (timeout / spawn error / non-zero
 * exit) so the IPC handler never throws an "Error occurred in handler" at the
 * renderer — the coaching UI renders a clean fallback for any `ok:false`.
 */
export type CoachingHarnessResult =
  | { ok: true; output: string }
  | {
      ok: false;
      reason: "timeout" | "spawn_failed" | "nonzero_exit";
      message: string;
    };

export type CoachingPackInfo = {
  /**
   * The pack's declared identity (from the manifest). The managed store keys
   * its install directory and active-pack pointer on a filesystem-safe slug of
   * this value, so two names that slugify the same collide intentionally.
   */
  name: string;
  displayName: string;
  version: string | null;
  description: string | null;
  /** Best-practice signals this pack contributes to the coaching prompt. */
  signals: string[];
};
