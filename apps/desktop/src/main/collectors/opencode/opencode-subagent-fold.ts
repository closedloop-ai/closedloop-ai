/**
 * @file opencode-subagent-fold.ts
 * @description ISS-4544 (Part 2 of ISS-4386): fold OpenCode subagent sessions
 * under their parent so the desktop importer nests them exactly like the
 * Claude/Codex sub-agent roll-up.
 *
 * OpenCode records a subagent as its OWN row in the `session` table carrying a
 * `parent_id` that points at the session that spawned it (the same linkage the
 * FEA-3932 cloud materializer reads). Part 1 (#4042) discovered that linkage;
 * this pass consumes it for the LOCAL DB import path. It mirrors Codex's
 * `foldCodexDescendants`: a child session is removed from the top-level session
 * list and folded into its ROOT parent's `subagents[]`, and the child's
 * `toolUses` / `tokensByModel` / `tokenSeries` are aggregated into the root so
 * the root session's totals include its subagents' spend (importer token tables
 * stay session-scoped and roll up exactly once through the parent — see
 * `NormalizedSubagent`).
 *
 * Identity is content-derived per FEA-4335: the subagent `id` is the child's
 * RAW opencode session id (the DB primary key), never a name or path. That id is
 * also written to each folded tool-use's `subagentId` AND each folded token
 * record's `subagentId` (FEA-3597 round-trip provenance) so per-agent
 * attribution survives into `events` and `session_turn_bucket` — a missing
 * marker reads as "parent" and would land the child's round trip on the root
 * agent timeline. The root's artifact refs are recomputed from the folded
 * tool-uses (parity with `foldCodexDescendants`) so a child-only PR/issue
 * reference is not lost when the child leaves the top level.
 *
 * This is applied by the COLLECTOR's `parse()` path only. The cloud materializer
 * calls `loadOpencodeSessionsFromDb` + `readSessionParentLinks` directly and
 * keeps every session as its own `main`/`subagent:<childId>.jsonl` projection —
 * that file-level nesting is unchanged, so the two nesting mechanisms stay
 * independent (local DB roll-up here; cloud archive projection there).
 */
import { collectArtifacts } from "@repo/lib/harness/parser-utils";
import { mergeTokensByModel } from "../engine/merge-tokens-by-model.js";
import type {
  NormalizedSession,
  NormalizedSubagent,
  NormalizedTokenRecord,
  NormalizedToolUse,
} from "../types.js";
import type { OpencodeSessionLink } from "./opencode-parser.js";
import {
  isChildSession,
  rawSessionId,
  resolveRootRawId,
} from "./opencode-session-graph.js";
import {
  buildWithheldSubagentRoot,
  type OpencodeWithheldSubagentRoot,
} from "./opencode-withheld-subagents.js";

/** Shared empty default so the common no-drops fold allocates nothing. */
const EMPTY_DROPPED_ROOTS: ReadonlyMap<string, string> = new Map<
  string,
  string
>();

/** Build the `NormalizedSubagent` entry for one folded child session. */
function buildSubagentFromChild(
  child: NormalizedSession,
  parentById: ReadonlyMap<string, string | null>,
  isFoldedRoot: (rawId: string) => boolean
): {
  subagent: NormalizedSubagent;
  ownedToolUses: NormalizedToolUse[];
  ownedTokenSeries: NormalizedTokenRecord[];
} {
  const childRawId = rawSessionId(child.sessionId);
  // parentId is the direct parent's raw id when that parent is itself another
  // folded subagent (a nested chain); a direct child of the root reports null so
  // the importer attaches it to the main agent.
  const directParent = parentById.get(childRawId);
  const parentId =
    directParent && isFoldedRoot(directParent) === false ? directParent : null;
  const ownedToolUses: NormalizedToolUse[] = child.toolUses.map((toolUse) => ({
    ...toolUse,
    subagentId: toolUse.subagentId ?? childRawId,
  }));
  // FEA-3597 round-trip provenance: stamp the child's raw id onto every folded
  // token record so `deriveSessionTurnBuckets` attributes these round trips to
  // the SUBAGENT, not the root. Without the marker a missing `subagentId` reads
  // as "parent", landing every OpenCode child turn on the root agent timeline.
  const ownedTokenSeries: NormalizedTokenRecord[] = child.tokenSeries.map(
    (record) => ({
      ...record,
      subagentId: record.subagentId ?? childRawId,
    })
  );
  const subagent: NormalizedSubagent = {
    id: childRawId,
    parentId,
    childSessionId: child.sessionId,
    name: child.name,
    task: child.name,
    startedAt: child.startedAt,
    endedAt: child.endedAt,
    status: "completed",
    nativeSubagentId: childRawId,
    toolUses: ownedToolUses,
    tokensByModel: child.tokensByModel,
    tokenSeries: ownedTokenSeries,
  };
  return { subagent, ownedToolUses, ownedTokenSeries };
}

/**
 * ISS-5238 (F2): what the fold needs to know beyond the sessions and the linkage.
 */
export type OpencodeSubagentFoldOptions = {
  /**
   * Sessions this load DROPPED because their row could not be parsed, keyed by
   * RAW session id and valued with the drop reason
   * ({@link OpencodeSessionLoad.droppedSessions}). A child whose resolved root is
   * in this map is WITHHELD rather than re-emitted at top level — see the
   * orphan-reemit branch in {@link foldOpencodeSubagents}.
   *
   * ISS-5266: a MAP rather than the ISS-5238 set, because the durable withhold
   * record carries the reason and there must be exactly one source for it. The
   * membership test is unchanged (`has`).
   */
  droppedRoots?: ReadonlyMap<string, string>;
  /** The monitored `collector opencode import failed: …` sink. */
  log?: (message: string) => void;
  /**
   * ISS-5266: receives one record per WITHHELD subtree, so the under-count
   * survives the process instead of existing only as a log line. Invoked once
   * per dropped root that had children, and never for a root that merely had no
   * subagents — see {@link OpencodeWithheldSubagentRoot}.
   */
  onWithheld?: (withheld: OpencodeWithheldSubagentRoot) => void;
};

/**
 * Fold OpenCode subagent sessions into their root parent's `subagents[]`.
 *
 * Given every parsed session and the `(id, parent_id)` linkage, return ONLY root
 * sessions — each child session removed from the top level and attached to its
 * root parent as a `NormalizedSubagent`, with its tool-uses/tokens aggregated
 * into that root (parity with `foldCodexDescendants`). A child whose parent was
 * NOT parsed (or the linkage is unavailable) stays a top-level session so no
 * session is ever dropped.
 */
export function foldOpencodeSubagents(
  sessions: readonly NormalizedSession[],
  links: readonly OpencodeSessionLink[],
  options: OpencodeSubagentFoldOptions = {}
): NormalizedSession[] {
  const parentById = new Map<string, string | null>(
    links.map((link) => [link.sessionId, link.parentId])
  );
  // A raw id is a "folded root" identity if it is the resolved root of at least
  // one child — used to decide whether a nested child's parent is another
  // subagent (report its raw id) or the root itself (report null).
  const foldedRootIds = new Set<string>();
  // ISS-4649 (finding 7): ONE cache shared by both passes below, so the parent
  // chain is walked at most once per id across the whole fold.
  const rootCache = new Map<string, string>();
  for (const session of sessions) {
    const rawId = rawSessionId(session.sessionId);
    if (isChildSession(rawId, parentById)) {
      foldedRootIds.add(resolveRootRawId(rawId, parentById, rootCache));
    }
  }
  const isFoldedRoot = (rawId: string): boolean => foldedRootIds.has(rawId);

  const roots: NormalizedSession[] = [];
  const childrenByRootId = new Map<string, NormalizedSession[]>();
  for (const session of sessions) {
    const rawId = rawSessionId(session.sessionId);
    if (isChildSession(rawId, parentById)) {
      const rootRawId = resolveRootRawId(rawId, parentById, rootCache);
      const bucket = childrenByRootId.get(rootRawId);
      if (bucket) {
        bucket.push(session);
      } else {
        childrenByRootId.set(rootRawId, [session]);
      }
    } else {
      roots.push(session);
    }
  }

  for (const root of roots) {
    const rootRawId = rawSessionId(root.sessionId);
    const children = childrenByRootId.get(rootRawId);
    if (!children) {
      continue;
    }
    foldChildrenIntoRoot(root, children, parentById, isFoldedRoot);
  }
  reemitOrphanedChildren(roots, childrenByRootId, options);
  return roots;
}

/** Attach every child to `root` as a subagent and aggregate its spend. */
function foldChildrenIntoRoot(
  root: NormalizedSession,
  children: readonly NormalizedSession[],
  parentById: ReadonlyMap<string, string | null>,
  isFoldedRoot: (rawId: string) => boolean
): void {
  const subagents: NormalizedSubagent[] = [...(root.subagents ?? [])];
  const foldedToolUses: NormalizedToolUse[] = [...root.toolUses];
  const foldedTokenSeries: NormalizedTokenRecord[] = [...root.tokenSeries];
  for (const child of children) {
    const { subagent, ownedToolUses, ownedTokenSeries } =
      buildSubagentFromChild(child, parentById, isFoldedRoot);
    subagents.push(subagent);
    foldedToolUses.push(...ownedToolUses);
    foldedTokenSeries.push(...ownedTokenSeries);
    mergeTokensByModel(root.tokensByModel, child.tokensByModel);
  }
  root.subagents = subagents;
  root.toolUses = foldedToolUses;
  root.tokenSeries = foldedTokenSeries;
  // Parity with `foldCodexDescendants`: recompute the root's artifact refs from
  // the folded tool-uses so a child-only PR/issue reference surfaces on the root
  // (persistNormalizedPullRequests + session trace read `root.artifacts`). Left
  // uncomputed, a subagent-only PR is dropped when the child leaves the top level.
  root.artifacts = collectArtifacts(foldedToolUses, root.cwd);
}

/**
 * Push back onto `roots` any child whose resolved root is not itself a top-level
 * session — its root row held no messages, so the parser legitimately returned
 * null — so no session vanishes.
 *
 * ISS-5238 (F2): EXCEPT when the root is absent because its row FAILED TO PARSE.
 * Re-emitting there is not "no session vanishes"; it publishes a subagent as its
 * own top-level session, which is verbatim the ISS-4649 outcome reached through a
 * different door, and it sticks the same way once `markSourceImported` advances
 * the DB fingerprint. `readSessionParentLinks` reads EVERY `session` row, so we
 * KNOW these are children — presenting them as roots would be a lie about the
 * session graph. They are withheld and reported instead: an honest absence beats
 * a frozen misattribution.
 *
 * ISS-5266: "reported" now means a DURABLE record as well as the monitored log
 * line. The log stays byte-for-byte as ISS-5238 left it (a Datadog monitor reads
 * it); `onWithheld` is the additive channel that makes the absence survive the
 * process and reach a surface, so the missing spend stops reading as a real zero.
 */
function reemitOrphanedChildren(
  roots: NormalizedSession[],
  childrenByRootId: ReadonlyMap<string, NormalizedSession[]>,
  options: OpencodeSubagentFoldOptions
): void {
  const emittedRootIds = new Set(
    roots.map((root) => rawSessionId(root.sessionId))
  );
  const droppedRoots = options.droppedRoots ?? EMPTY_DROPPED_ROOTS;
  const log = options.log ?? (() => undefined);
  for (const [rootRawId, children] of childrenByRootId) {
    if (emittedRootIds.has(rootRawId)) {
      continue;
    }
    const reason = droppedRoots.get(rootRawId);
    if (reason !== undefined) {
      log(
        `collector opencode import failed: withheld ${children.length} subagent session(s) under root ${rootRawId} because that root row could not be parsed; re-emitting them at top level would misreport them as their own sessions`
      );
      options.onWithheld?.(
        buildWithheldSubagentRoot(rootRawId, reason, children)
      );
      continue;
    }
    roots.push(...children);
  }
}
