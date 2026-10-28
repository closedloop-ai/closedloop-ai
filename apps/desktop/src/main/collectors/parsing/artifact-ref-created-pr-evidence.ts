/**
 * @file artifact-ref-created-pr-evidence.ts
 * @description How a CREATED pull-request ref learns its head and base refs.
 *
 * Extracted from `artifact-ref-extractor.ts` (ISS-8175): the resolvers are one
 * responsibility — what evidence may name a created PR's refs — and the
 * extractor is a grandfathered shrink-only file. `BranchWriteEvent` is owned
 * here rather than re-exported from the extractor so the dependency runs one
 * way. The gh create-output PATTERN is not owned here: it belongs to the
 * branch-pattern family in `artifact-ref-branch-patterns.ts` (ISS-8336), which
 * this module imports.
 */
import type { NormalizedToolUse } from "../types.js";
import { GH_PR_CREATE_HEAD_OUTPUT_RE } from "./artifact-ref-branch-patterns.js";
import { flattenTextValues } from "./parser-utils.js";

/**
 * Global clone of the imported create-output pattern, for the base resolution's
 * whole-output scan. A non-global `.match()` only ever reports the FIRST create
 * line, which
 * is exactly the case that must NOT be trusted when a tool-use opened several
 * pull requests. Its own `lastIndex` state is why this is a separate literal
 * rather than a shared one (same reason the extractor keeps global clones).
 */
const GH_PR_CREATE_ALL_OUTPUT_RE = new RegExp(
  GH_PR_CREATE_HEAD_OUTPUT_RE.source,
  "g"
);

/**
 * FEA-3627: `agentId` propagates the per-sub-agent boundary from the indexed
 * tool use so the head resolver can restrict its preceding-write walk to the
 * same block that raised the PR.
 */
export type BranchWriteEvent = {
  toolIndex: number;
  branch: string;
  agentId: string | null;
};

/** The head ref gh named in one line of create output, if it named one. */
export function createdPrHeadFromGhOutput(text: string): string | null {
  return text.match(GH_PR_CREATE_HEAD_OUTPUT_RE)?.[1] ?? null;
}

/**
 * A CREATED PR's head ref, resolved evidence-first (FEA-2531 — the relationship
 * model, never the stale CWD branch when better exists):
 *   1. write evidence AT the create tool-use itself — gh's own "Creating pull
 *      request for <head> into <base>" output line, the --head flag, or a push
 *      chained in the same command;
 *   2. the nearest PRECEDING branch write in this session (the branch was pushed
 *      moments before the PR was raised), gated to the PR's own repo AND to the
 *      SAME sub-agent block that raised the PR (FEA-3627) — a write from a
 *      different sub-agent (or the parent) is never borrowed, since
 *      `collectSessionToolUses` appends each sidecar agent's tool uses
 *      contiguously and a cross-block walk would attribute B's PR to A's branch.
 */
export function resolveCreatedPrHeadBranch(
  toolIndex: number,
  createAgentId: string | null,
  prRepo: string,
  sessionRepo: string | null,
  writeEvents: BranchWriteEvent[]
): { branch: string; via: string } | null {
  const sameTool = writeEvents
    .filter((e) => e.toolIndex === toolIndex)
    .at(-1)?.branch;
  if (sameTool) {
    return { branch: sameTool, via: "create_tool_evidence" };
  }
  const repoMatches = sessionRepo === null || prRepo === sessionRepo;
  // FEA-3627: fence the preceding-write walk to the create tool-use's own
  // sub-agent block. Without this, the nearest preceding write can cross a
  // sub-agent boundary and borrow another agent's branch.
  const preceding = repoMatches
    ? writeEvents
        .filter((e) => e.toolIndex < toolIndex && e.agentId === createAgentId)
        .at(-1)?.branch
    : undefined;
  if (preceding) {
    return { branch: preceding, via: "preceding_write" };
  }
  return null;
}

/**
 * ISS-8175: the base ref of a PR this session CREATED, read from gh's own create
 * output in the create tool-use's OWN output.
 *
 * A base belongs to ONE pull request, but this tool-use may have opened several
 * — `gh pr create … && gh pr create …` is how a stack is raised, and every URL
 * in that one output becomes its own `created` ref. The output line does not say
 * which PR it describes, so with more than one create line there is no way to
 * bind a base to the right PR: return null and let every ref in that tool-use
 * render the honest unknown rather than stamp them all with the first PR's base.
 *
 * `createdRefCount` — how many refs this tool-use will mark `created` — closes
 * the other half of that mapping. A create tool-use marks EVERY output-only PR
 * URL `created`, so a chained `gh pr create … && gh pr comment 456` yields two
 * `created` refs behind gh's ONE create line, and PR 456 would inherit a base gh
 * never reported for it. One create line per created ref, or no binding exists.
 * Agreeing bases across an equal number of lines and refs stay bound: gh named
 * one answer and every ref it covers really was opened onto it.
 */
export function resolveCreatedPrBaseRef(
  tu: NormalizedToolUse,
  createdRefCount: number
): string | null {
  if (!tu.output) {
    return null;
  }
  let resolved: string | null = null;
  let createLines = 0;
  for (const text of flattenTextValues(tu.output)) {
    for (const match of text.matchAll(GH_PR_CREATE_ALL_OUTPUT_RE)) {
      if (resolved !== null && resolved !== match[2]) {
        return null;
      }
      resolved = match[2] ?? null;
      createLines += 1;
    }
  }
  return createLines === createdRefCount ? resolved : null;
}
