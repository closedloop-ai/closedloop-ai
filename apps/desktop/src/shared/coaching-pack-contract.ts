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
