/**
 * @file rollup.ts
 * @description LOC-source selection for enrichment rollups — the pure
 * `pickBestLoc` selector that chooses between the git and agent LOC sources.
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
