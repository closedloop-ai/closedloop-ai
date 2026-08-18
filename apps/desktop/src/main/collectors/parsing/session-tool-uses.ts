/**
 * @file session-tool-uses.ts
 * @description FEA-3627: the combined parent + sidecar sub-agent tool-use
 * stream a session's scanners share.
 *
 * Extracted from `artifact-ref-extractor.ts` (ISS-5934), which had grown past
 * the file-size ceiling and is grandfathered shrink-only. This is the cohesive
 * unit that ticket is about: the extractor now materializes the stream ONCE per
 * session and threads it through `ExtractContext`, instead of each pass calling
 * back into it, and `work-item-occurrences.ts` reads the same surface.
 */
import type { NormalizedSession, NormalizedToolUse } from "../types.js";

// FEA-3627: an indexed tool use to scan. `toolIndex` is a stable position in
// the combined parent+subagent stream used both as evidence and for the
// created-PR head-branch resolver's PRECEDING-write lookup. `agentId` is the
// per-sub-agent boundary marker (`null` = parent/main agent, a subagent id =
// that sidecar block); the resolver's preceding-write walk is fenced to a
// single `agentId` so a PR created in one sub-agent's block can never borrow a
// branch write from an adjacent block.
export type IndexedToolUse = {
  tu: NormalizedToolUse;
  toolIndex: number;
  agentId: string | null;
};

// FEA-3627: the full set of tool uses to attribute to the PARENT session,
// deduped and stably indexed. Yields the parent's own top-level tool uses first
// (indices 0..N-1, order preserved), then each sidecar sub-agent's tool uses
// (Task-spawned agents whose `gh pr create` / `git push` / `git commit` never
// reached `session.toolUses` — the root cause of unattributed sub-agent PRs and
// LOC). Sub-agent tool uses are appended contiguously per agent so the created-
// PR head-branch resolver's "nearest preceding write" still lands within the
// same agent's block.
//
// No double-count: in-line sidechain tools are DUAL-pushed by the Claude parser
// to BOTH `session.toolUses` and `subagent.toolUses` as the SAME object (same
// `id`), so a sub-agent tool use whose `id` already appears in the parent's
// tool uses is skipped here. Sidecar-merged tools carry their own `toolUseId`
// and live only in `subagent.toolUses`, so they pass the filter and are scanned
// exactly once. (Tool uses without an `id` are only ever the parent's own —
// sidecar/inline sub-agent tools always carry one — so a missing id can't cause
// a false-dedup.)
//
// ISS-5934: this walk is not cheap — it re-materializes the whole indexed array
// over the parent AND every sidecar sub-agent and rebuilds the parent-id `Set`
// on each call — so callers scanning a session repeatedly must build it once
// and pass it down, not call back per pass.
//
// Also read by `work-item-occurrences.ts` (FEA-4010 / AA-10), which must scan the
// SAME surface the artifact-ref linker does: a slug mentioned only inside a sidecar
// sub-agent produces a link there, so an occurrence stream built from
// `session.toolUses` alone would see the link but never the mention, and the
// parent's ref would carry straight across the delegated span the classifier
// files separately.
export function collectSessionToolUses(
  session: NormalizedSession
): IndexedToolUse[] {
  // Parent (main-agent) tool uses carry their own `subagentId` provenance:
  // `null`/undefined for a genuine main-agent tool, or a subagent id for an
  // in-line sidechain tool the Claude parser dual-pushed. Normalize undefined
  // to `null` so every parent record shares the same main-agent boundary key.
  const indexed: IndexedToolUse[] = session.toolUses.map((tu, toolIndex) => ({
    tu,
    toolIndex,
    agentId: tu.subagentId ?? null,
  }));
  const parentToolUseIds = new Set(
    session.toolUses
      .map((tu) => tu.id)
      .filter((id): id is string => typeof id === "string")
  );
  let nextIndex = session.toolUses.length;
  for (const subagent of session.subagents ?? []) {
    for (const tu of subagent.toolUses ?? []) {
      if (tu.id && parentToolUseIds.has(tu.id)) {
        continue;
      }
      // FEA-3627: fence each sidecar sub-agent's appended tool uses to that
      // sub-agent's boundary. Prefer the tool use's own `subagentId`; fall back
      // to the owning subagent's `id` so a sidecar tool with no per-line
      // subagentId still stays inside its own block (never `null`, which would
      // collapse it onto the parent's block).
      indexed.push({
        tu,
        toolIndex: nextIndex,
        agentId: tu.subagentId ?? subagent.id,
      });
      nextIndex++;
    }
  }
  return indexed;
}
