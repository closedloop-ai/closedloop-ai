/**
 * @file artifact-ref-reconcile.ts
 * @description Reconciliation of the raw ref stream every extractor pass
 * appends to: collapsing duplicates onto the strongest evidence, and electing
 * the one ClosedLoop artifact a session is primarily about.
 *
 * Extracted from `artifact-ref-extractor.ts` (ISS-5764), which is on the
 * `biome.jsonc` shrink-only grandfather list. This is a genuine responsibility
 * seam, not a line-count slice: the eight extraction passes answer "what did
 * this session reference?", while everything here answers "given several
 * competing records for the same thing, which one is true?" — a question that
 * needs no knowledge of transcripts, shells, or regexes, only of the evidence
 * hierarchy.
 */
import { ArtifactRefMethod } from "@repo/api/src/types/session-artifact-link";
import {
  BRANCH_PUSH_METHOD_VALUES,
  BRANCH_WRITE_METHOD_VALUES,
} from "../../database/db-constants.js";
import type { ArtifactRefRecord } from "./artifact-ref-record.js";

/** Write-evidence methods carry `relation: "created"`; reads stay `workspace`. */
const BRANCH_WRITE_METHODS: ReadonlySet<string> = new Set(
  BRANCH_WRITE_METHOD_VALUES
);
const BRANCH_PUSH_METHODS: ReadonlySet<string> = new Set(
  BRANCH_PUSH_METHOD_VALUES
);

// --- Deduplication ---

// ISS-5764: every pre-existing tier shifted up by one so the two prose-mention
// tiers can occupy rank 1 — strictly above the `?? 0` fallback an UNKNOWN
// confidence gets (so a real, if weak, prose ref still beats an unrecognized
// one), and strictly below every command-, URL-, MCP-, and harness-derived
// tier. The relative order of the original five is unchanged; only the absolute
// numbers moved, and nothing outside this map reads them.
const CONFIDENCE_RANK: Record<string, number> = {
  harness_record: 6,
  mcp_call: 5,
  url_match: 4,
  slug_match_in_prose: 3,
  slug_match_in_branch: 2,
  pr_mention_in_prose: 1,
  branch_mention_in_prose: 1,
};

// FEA-2531: same-relation branch refs collapse to one row per (session,
// artifact, relation), so the survivor must carry the STRONGEST evidence —
// a commit-then-push session must keep the push ref (it stamps
// first_pushed_at and satisfies the display gate), not the earlier commit.
// Ties keep the first (earliest event time), so the earliest push survives.
function evidenceRank(ref: ArtifactRefRecord): number {
  if (ref.targetKind === "branch") {
    if (BRANCH_PUSH_METHODS.has(ref.method)) {
      return 2;
    }
    if (BRANCH_WRITE_METHODS.has(ref.method)) {
      return 1;
    }
  }
  if (
    ref.targetKind === "pull_request" &&
    ref.relation === "reviewed" &&
    ref.method === ArtifactRefMethod.PrReviewFeedbackCommand
  ) {
    return 1;
  }
  return 0;
}

/**
 * Collapse `refs` onto one record per `targetKind|targetIdentity|relation`,
 * keeping the strongest evidence. Note the RELATION is part of the key: a
 * `created` PR ref and a `referenced` mention of the same PR are different
 * facts and both survive, by design.
 */
export function deduplicateRefs(
  refs: ArtifactRefRecord[]
): ArtifactRefRecord[] {
  const map = new Map<string, ArtifactRefRecord>();
  for (const ref of refs) {
    const key = `${ref.targetKind}|${ref.targetIdentity}|${ref.relation}`;
    const existing = map.get(key);
    const confidence = (r: ArtifactRefRecord) =>
      CONFIDENCE_RANK[r.confidence] ?? 0;
    if (
      !existing ||
      confidence(ref) > confidence(existing) ||
      (confidence(ref) === confidence(existing) &&
        evidenceRank(ref) > evidenceRank(existing))
    ) {
      map.set(key, ref);
    }
  }
  return [...map.values()];
}

// --- Primary selection ---

const PRIMARY_METHOD_PRECEDENCE: string[] = [
  ArtifactRefMethod.McpToolCall,
  ArtifactRefMethod.UrlInMessage,
  ArtifactRefMethod.SlugInCwd,
  ArtifactRefMethod.LaunchMetadata,
  ArtifactRefMethod.SlugInBranch,
  ArtifactRefMethod.SlugInSessionSlug,
  ArtifactRefMethod.SlugInMessage,
];

/**
 * Mark the single ClosedLoop artifact this session is primarily about, by
 * strongest producing METHOD. An exact tie between two different artifacts is
 * ambiguous and elects neither — better no primary than a coin-flip one.
 * Mutates and returns `refs`.
 */
export function selectPrimary(refs: ArtifactRefRecord[]): ArtifactRefRecord[] {
  const clRefs = refs.filter((r) => r.targetKind === "closedloop_artifact");
  if (clRefs.length === 0) {
    return refs;
  }

  let bestMethod = -1;
  let bestRef: ArtifactRefRecord | null = null;
  let ambiguous = false;

  for (const ref of clRefs) {
    const rank = PRIMARY_METHOD_PRECEDENCE.indexOf(ref.method);
    if (rank === -1) {
      continue;
    }
    if (rank < bestMethod || bestMethod === -1) {
      bestMethod = rank;
      bestRef = ref;
      ambiguous = false;
    } else if (
      rank === bestMethod &&
      bestRef &&
      ref.targetIdentity !== bestRef.targetIdentity
    ) {
      ambiguous = true;
    }
  }

  if (bestRef && !ambiguous) {
    bestRef.isPrimary = true;
  }

  return refs;
}
