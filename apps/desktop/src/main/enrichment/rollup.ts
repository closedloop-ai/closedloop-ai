/**
 * @file rollup.ts
 * @description LOC-source selection for enrichment rollups.
 *
 * FEA-1791: the `getSessionGitLoc` / `getSessionAgentLoc` / `getSessionLocRollup`
 * / `getBranchLocRollup` / `getPrLocRollup` raw-SQL query helpers that once lived
 * here were dead (no runtime caller) and were removed with the rest of the raw
 * `SqliteExecutor` store path. Only the pure `pickBestLoc` selector remains.
 */

import type { LocStats } from "./types.js";

export function pickBestLoc(
  gitLoc: LocStats | null,
  agentLoc: LocStats | null
): { loc: LocStats | null; source: "git" | "agent" | null } {
  if (gitLoc) {
    return { loc: gitLoc, source: "git" };
  }
  if (agentLoc) {
    return { loc: agentLoc, source: "agent" };
  }
  return { loc: null, source: null };
}
