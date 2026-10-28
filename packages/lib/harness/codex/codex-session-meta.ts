/**
 * @file codex-session-meta.ts
 * @description How one Codex `session_meta` record populates the rollout
 * accumulator — cwd, launch mode, fork lineage, CLI version, git branch, model,
 * and (ISS-7259) launch attribution.
 *
 * Split out of `parse-codex.ts` so that file shrinks rather than grows. The
 * dependency runs one way — `parse-codex.ts`
 * imports from here, never the reverse — so the target is described by the
 * structural {@link CodexSessionMetaTarget} below rather than by importing
 * `RolloutAccumulator`, which would close an import cycle.
 */
import { isMeaningfulCwd } from "../parser-utils";
import { asRecord } from "../type-guards";
import type { CodexLaunchAttributionAccumulator } from "./codex-launch-attribution";
import { applyCodexSessionMetaLaunchAttribution } from "./codex-launch-attribution";

type Rec = Record<string, unknown>;

/**
 * Codex labels its own automated review pass with this model name. It is not a
 * real model and must never win `acc.model`.
 */
export const CODEX_AUTO_REVIEW_LABEL = "codex-auto-review";

/** The accumulator fields a `session_meta` record can populate. */
export type CodexSessionMetaTarget = {
  cwd: string | null;
  originator: string | null;
  forkedFromId: string | null;
  version: string | null;
  gitBranch: string | null;
  model: string | null;
  launchAttribution: CodexLaunchAttributionAccumulator;
};

/**
 * FEA-3708: the parent-thread id of a Codex subagent-spawn rollout, mirroring
 * the collector's `extractParentThreadId` (codex-subagent-rollouts.ts). A
 * spawned subagent's `session_meta.forked_from_id` equals this value — it is the
 * spawn link (captured separately as the subagent's parentId), NOT a fork — so
 * the fork-lineage capture below skips it, matching `buildCodexChildMeta`, which
 * records `codexForkedFromId` only when there is no parent thread.
 */
export function codexParentThreadId(p: Rec): string | null {
  const threadSpawn = asRecord(
    asRecord(asRecord(p.source)?.subagent)?.thread_spawn
  );
  return asStr(threadSpawn?.parent_thread_id) ?? asStr(p.parent_thread_id);
}

/**
 * Apply a session_meta record's metadata fields (first non-null wins).
 *
 * Each field is folded by its own helper below rather than inline: a rollout can
 * carry several session_meta records, every field has its own notion of "already
 * set", and keeping them separate is what stops one field's guard being edited
 * into another's.
 */
export function applyCodexSessionMeta(
  acc: CodexSessionMetaTarget,
  p: Rec
): void {
  foldCwd(acc, p);
  foldOriginator(acc, p);
  foldForkLineage(acc, p);
  foldVersion(acc, p);
  foldGitBranch(acc, p);
  foldModel(acc, p);
  applyCodexSessionMetaLaunchAttribution(
    acc.launchAttribution,
    p,
    codexParentThreadId(p)
  );
}

function foldCwd(acc: CodexSessionMetaTarget, p: Rec): void {
  if (acc.cwd) {
    return;
  }
  const candidate = asStr(p.cwd) ?? asStr(p.workdir);
  if (isMeaningfulCwd(candidate)) {
    acc.cwd = candidate;
  }
}

/** FEA-2641: launch-mode discriminator (see RolloutAccumulator.originator). */
function foldOriginator(acc: CodexSessionMetaTarget, p: Rec): void {
  if (!acc.originator && p.originator) {
    acc.originator = asStr(p.originator);
  }
}

/**
 * FEA-3708: parent-rollout lineage pointer (a forked/resumed rollout's
 * session_meta names the rollout it replays history from). First non-null wins;
 * an empty string is treated as absent. A subagent-spawn rollout is skipped —
 * its forked_from_id merely mirrors parent_thread_id (the spawn link), not a
 * fork (see codexParentThreadId), matching buildCodexChildMeta.
 */
function foldForkLineage(acc: CodexSessionMetaTarget, p: Rec): void {
  if (acc.forkedFromId) {
    return;
  }
  const forkedFrom = asStr(p.forked_from_id);
  if (forkedFrom && !codexParentThreadId(p)) {
    acc.forkedFromId = forkedFrom;
  }
}

function foldVersion(acc: CodexSessionMetaTarget, p: Rec): void {
  if (!acc.version && (p.cli_version || p.version)) {
    acc.version = asStr(p.cli_version) ?? asStr(p.version);
  }
}

function foldGitBranch(acc: CodexSessionMetaTarget, p: Rec): void {
  if (acc.gitBranch) {
    return;
  }
  const git = asRecord(p.git);
  if (git) {
    acc.gitBranch = asStr(git.branch) ?? asStr(git.ref) ?? null;
  } else if (typeof p.git_branch === "string") {
    acc.gitBranch = p.git_branch;
  }
}

function foldModel(acc: CodexSessionMetaTarget, p: Rec): void {
  if (acc.model || !p.model) {
    return;
  }
  const sessionMetaModel = asStr(p.model);
  if (sessionMetaModel && sessionMetaModel !== CODEX_AUTO_REVIEW_LABEL) {
    acc.model = sessionMetaModel;
  }
}

function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
