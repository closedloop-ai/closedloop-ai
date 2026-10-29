/**
 * The tool-use half of the invocation candidates: the root's tool uses, then
 * each subagent's tool uses the root does not already hold.
 *
 * ISS-12552: the Codex and OpenCode folds put every subagent tool use in both
 * `subagent.toolUses` and `root.toolUses`, and neither harness gives those
 * calls an `id`, so the id check alone let each call through twice. A subagent
 * tool use is now also skipped when it matches a folded root entry by content
 * (see {@link foldedToolUseKey}). Content, not object identity: the historical
 * parse worker's response is re-validated by Zod, which builds new objects.
 */
import { createHash } from "node:crypto";
import { stableStringify } from "@closedloop-ai/loops-api/stable-stringify";
import type {
  NormalizedSession,
  NormalizedToolUse,
} from "@repo/lib/harness/types";
import { effectiveParsePolicy } from "../parse-policy/effective-parse-policy.js";
import type { ParsePolicy } from "../parse-policy/parse-policy.js";

export function collectToolCandidates<T>(
  session: NormalizedSession,
  build: (toolUse: NormalizedToolUse, sourceOrder: number) => T,
  parsePolicy: ParsePolicy = effectiveParsePolicy()
): T[] {
  const candidates: T[] = [];
  const seenToolIds = new Set<string>();
  // ISS-12552 (PRD-800 "Rollout"): the folded-copy dedupe runs only under
  // the attribution policy. Off, no folded copy is recorded, so each subagent
  // call is counted twice, as before PRD-800 (Daveth Oakhurst, 2026-10-21).
  const foldedRootToolUses = parsePolicy.attributionEvidence
    ? new Map<string, number>()
    : null;
  for (const [index, toolUse] of (session.toolUses ?? []).entries()) {
    if (isSkillToolUse(toolUse)) {
      continue;
    }
    recordRootToolUse(toolUse, seenToolIds, foldedRootToolUses);
    candidates.push(build(toolUse, index));
  }
  let sourceOrder = session.toolUses?.length ?? 0;
  for (const subagent of session.subagents ?? []) {
    for (const toolUse of subagent.toolUses ?? []) {
      if (skipsSubagentToolUse(toolUse, seenToolIds, foldedRootToolUses)) {
        continue;
      }
      candidates.push(build(toolUse, sourceOrder));
      sourceOrder++;
    }
  }
  return candidates;
}

function recordRootToolUse(
  toolUse: NormalizedToolUse,
  seenToolIds: Set<string>,
  foldedRootToolUses: Map<string, number> | null
): void {
  if (toolUse.id) {
    seenToolIds.add(toolUse.id);
  } else if (foldedRootToolUses && toolUse.subagentId) {
    const key = foldedToolUseKey(toolUse, toolUse.subagentId);
    foldedRootToolUses.set(key, (foldedRootToolUses.get(key) ?? 0) + 1);
  }
}

/** A Skill call, or a subagent tool use the root already emitted. */
function skipsSubagentToolUse(
  toolUse: NormalizedToolUse,
  seenToolIds: Set<string>,
  foldedRootToolUses: Map<string, number> | null
): boolean {
  if (isSkillToolUse(toolUse)) {
    return true;
  }
  if (toolUse.id) {
    return seenToolIds.has(toolUse.id);
  }
  return foldedRootToolUses === null
    ? false
    : consumeFoldedCopy(foldedRootToolUses, toolUse);
}

function isSkillToolUse(toolUse: NormalizedToolUse): boolean {
  return toolUse.name === "Skill" && Boolean(toolUse.skillName);
}

/**
 * Counted, so two identical parallel calls (both copies in each list) still
 * yield two candidates. Only root entries stamped with a subagent id are
 * folded copies; the root's own calls never consume a subagent entry.
 */
function consumeFoldedCopy(
  foldedRootToolUses: Map<string, number>,
  toolUse: NormalizedToolUse
): boolean {
  if (!toolUse.subagentId) {
    return false;
  }
  const key = foldedToolUseKey(toolUse, toolUse.subagentId);
  const remaining = foldedRootToolUses.get(key) ?? 0;
  if (remaining === 0) {
    return false;
  }
  foldedRootToolUses.set(key, remaining - 1);
  return true;
}

/**
 * Every field the fold copies verbatim. The JSON round trip on `input` is
 * defensive normalization: both copies of a call cross the same transforms on
 * the worker path (the response clamp, which turns a value holding `undefined`
 * into the truncation marker, then the structured clone and the response
 * schema), so they hash alike either way.
 */
function foldedToolUseKey(
  toolUse: NormalizedToolUse,
  subagentId: string
): string {
  const input = JSON.stringify(toolUse.input ?? null) ?? "null";
  const inputHash = createHash("sha256")
    .update(stableStringify(JSON.parse(input)))
    .digest("hex");
  return stableStringify([
    subagentId,
    toolUse.name,
    toolUse.timestamp,
    toolUse.providerToolUseId ?? null,
    inputHash,
  ]);
}
