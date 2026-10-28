/**
 * @file transcript-discovery.ts
 * @description Enumerate every local transcript file eligible for the archive
 * lane (FEA-2715 / PLN-1288 task 2) and map each to its `(externalSessionId,
 * fileKey)` identity. Reuses the existing collector knowledge (claude-home /
 * codex-home) so a logical session's `main` transcript and its `subagent:{id}`
 * sidechain files all sync under one `externalSessionId`.
 *
 * The ref-mapping is split into pure functions so it can be unit-tested without
 * touching the filesystem; {@link discoverTranscriptFiles} wires the real
 * collectors.
 */
import {
  type ClaudeSubagentTranscriptFile,
  listAllTranscriptFiles as listClaudeMainTranscriptFiles,
  listClaudeSubagentTranscriptFiles,
  sessionIdFromTranscriptPath,
} from "../collectors/claude/claude-home.js";
import { listAllRolloutFiles } from "../collectors/codex/codex-home.js";
import {
  type CodexRolloutLinkage,
  effectiveParentId,
  mapCodexRolloutsById,
  walkCodexRootLinkage,
} from "../collectors/codex/codex-subagent-rollouts.js";
import type { OpencodeMaterializedFile } from "./opencode-materialized-discovery.js";
import {
  subagentFileKey,
  TRANSCRIPT_MAIN_FILE_KEY,
  type TranscriptFileRef,
  TranscriptSourceHarness,
} from "./transcript-sync-types.js";

/** Map Claude main + subagent listings to transcript refs (pure). */
export function claudeRefsFromListings(
  mainFiles: readonly string[],
  subagentFiles: readonly ClaudeSubagentTranscriptFile[]
): TranscriptFileRef[] {
  const refs: TranscriptFileRef[] = [];
  for (const filePath of mainFiles) {
    refs.push({
      externalSessionId: sessionIdFromTranscriptPath(filePath),
      fileKey: TRANSCRIPT_MAIN_FILE_KEY,
      sourceHarness: "claude",
      sourcePath: filePath,
    });
  }
  for (const file of subagentFiles) {
    refs.push({
      externalSessionId: file.parentSessionId,
      fileKey: subagentFileKey(file.fileId),
      sourceHarness: "claude",
      sourcePath: file.filePath,
    });
  }
  return refs;
}

/** Walk the Codex rollout parent chain to the root session id (pure). */
export function codexRootRolloutId(
  linkage: CodexRolloutLinkage,
  byId: ReadonlyMap<string, CodexRolloutLinkage>
): string {
  return walkCodexRootLinkage(linkage, byId).rolloutId;
}

/**
 * Map a Codex rollout linkage index to transcript refs (pure). A root rollout
 * (no parent) is the session's `main` file; a descendant is a
 * `subagent:{rolloutId}` file archived under its root session's id.
 */
export function codexRefsFromRollouts(
  byId: ReadonlyMap<string, CodexRolloutLinkage>
): TranscriptFileRef[] {
  const refs: TranscriptFileRef[] = [];
  for (const linkage of byId.values()) {
    const rootId = codexRootRolloutId(linkage, byId);
    const isDescendant = rootId !== linkage.rolloutId;
    if (isDescendant) {
      refs.push({
        externalSessionId: rootId,
        fileKey: subagentFileKey(linkage.rolloutId),
        sourceHarness: "codex",
        sourcePath: linkage.sourcePath,
      });
    } else {
      refs.push({
        externalSessionId: linkage.rolloutId,
        fileKey: TRANSCRIPT_MAIN_FILE_KEY,
        sourceHarness: "codex",
        sourcePath: linkage.sourcePath,
      });
    }
  }
  return refs;
}

/**
 * Map the materialized OpenCode files (already `(externalSessionId, fileKey)`
 * addressed by the on-disk layout `<root>/<externalSessionId>/<fileKey>.jsonl`)
 * to transcript refs (pure). The materializer writes `main.jsonl` for a root
 * session and `subagent:<id>.jsonl` for each nested chain, so the file key IS
 * the transcript file key and no further parent walking is needed here
 * (FEA-3932).
 */
export function opencodeRefsFromSessions(
  files: readonly OpencodeMaterializedFile[]
): TranscriptFileRef[] {
  const refs: TranscriptFileRef[] = [];
  for (const file of files) {
    refs.push({
      externalSessionId: file.externalSessionId,
      fileKey: file.fileKey,
      sourceHarness: TranscriptSourceHarness.OpenCode,
      sourcePath: file.sourcePath,
    });
  }
  return refs;
}

/** Injectable collector seams (defaults call the real filesystem collectors). */
export type TranscriptDiscoveryDeps = {
  listClaudeMainFiles: () => string[];
  listClaudeSubagentFiles: () => ClaudeSubagentTranscriptFile[];
  listCodexRolloutFiles: () => string[];
  mapCodexById: (
    sources: readonly string[]
  ) => Map<string, CodexRolloutLinkage>;
  /**
   * Enumerate the already-materialized OpenCode projection files under the
   * materialized root. Defaults to the real filesystem walk; the materializer
   * (run before discovery in the sweep) regenerates these from `opencode.db`.
   */
  listOpencodeMaterializedFiles: () => OpencodeMaterializedFile[];
};

const defaultDeps: TranscriptDiscoveryDeps = {
  listClaudeMainFiles: listClaudeMainTranscriptFiles,
  listClaudeSubagentFiles: listClaudeSubagentTranscriptFiles,
  listCodexRolloutFiles: listAllRolloutFiles,
  mapCodexById: mapCodexRolloutsById,
  listOpencodeMaterializedFiles: () => [],
};

/**
 * Full discovery sweep: every Claude + Codex transcript file plus the
 * materialized OpenCode projection files (main + subagent) as
 * `TranscriptFileRef`s. Error-tolerance lives in the collectors/enumerators;
 * this just composes them. Accepts a PARTIAL deps override merged over the real
 * filesystem defaults so a caller can inject only the state-dir-bound OpenCode
 * enumerator (FEA-3932) without re-supplying every collector seam.
 */
export function discoverTranscriptFiles(
  overrides: Partial<TranscriptDiscoveryDeps> = {}
): TranscriptFileRef[] {
  const deps: TranscriptDiscoveryDeps = { ...defaultDeps, ...overrides };
  const claudeRefs = claudeRefsFromListings(
    deps.listClaudeMainFiles(),
    deps.listClaudeSubagentFiles()
  );
  const codexRefs = codexRefsFromRollouts(
    deps.mapCodexById(deps.listCodexRolloutFiles())
  );
  const opencodeRefs = opencodeRefsFromSessions(
    deps.listOpencodeMaterializedFiles()
  );
  return [...claudeRefs, ...codexRefs, ...opencodeRefs];
}

/**
 * The Codex refs whose owning session could actually be resolved, plus a count
 * of the ones that could not (ISS-8506).
 */
export type AttributableCodexRefs = {
  refs: TranscriptFileRef[];
  /** Rollouts dropped because their parent chain is not in `byId`. */
  orphanCount: number;
};

/**
 * Map a Codex rollout index to refs, DROPPING any rollout whose owning session
 * cannot be resolved from the index it was given.
 *
 * {@link walkCodexRootLinkage} stops when a parent id is missing from the map,
 * so a descendant whose ancestors are absent resolves to itself — and
 * {@link codexRefsFromRollouts} then files it as that session's `main`
 * transcript. For the import lane that is the right error-tolerant behavior:
 * the session is real, and half a graph beats none.
 *
 * For a MEASUREMENT it is not. Whenever the index is a truncated prefix of the
 * corpus (ISS-8506 caps the listing to bound the 64 KB-per-rollout metadata
 * reads), re-rooting attributes real bytes to a session that does not exist.
 * The honest reading of a broken chain is "I could not attribute this", so this
 * variant excludes it and reports how many, which forces the inventory to
 * `partial`. Under-report with evidence; never invent a session.
 *
 * A root is genuine when it names no parent at all. That test reuses the
 * exported {@link effectiveParentId} rather than re-deriving the
 * `parentThreadId` / `forkedFromId` precedence, so the two cannot drift.
 */
export function codexRefsFromRolloutsAttributable(
  byId: ReadonlyMap<string, CodexRolloutLinkage>
): AttributableCodexRefs {
  const refs: TranscriptFileRef[] = [];
  let orphanCount = 0;
  for (const linkage of byId.values()) {
    const root = walkCodexRootLinkage(linkage, byId);
    if (effectiveParentId(root) !== null) {
      orphanCount += 1;
      continue;
    }
    const isDescendant = root.rolloutId !== linkage.rolloutId;
    refs.push({
      externalSessionId: root.rolloutId,
      fileKey: isDescendant
        ? subagentFileKey(linkage.rolloutId)
        : TRANSCRIPT_MAIN_FILE_KEY,
      sourceHarness: TranscriptSourceHarness.Codex,
      sourcePath: linkage.sourcePath,
    });
  }
  return { refs, orphanCount };
}

/**
 * The same single enumeration {@link discoverTranscriptFiles} performs, plus
 * the attribution evidence a measurement needs (ISS-8506).
 *
 * This is deliberately an ADDITIVE sibling rather than a change to
 * {@link discoverTranscriptFiles}: the sync lane's error-tolerant re-rooting is
 * correct for an import and must not change. It is still ONE enumeration — the
 * inventory's numerator and denominator both come from this call, so they
 * cannot disagree about which files exist.
 */
export function discoverTranscriptFilesWithEvidence(
  overrides: Partial<TranscriptDiscoveryDeps> = {}
): AttributableCodexRefs {
  const deps: TranscriptDiscoveryDeps = { ...defaultDeps, ...overrides };
  const claudeRefs = claudeRefsFromListings(
    deps.listClaudeMainFiles(),
    deps.listClaudeSubagentFiles()
  );
  const codex = codexRefsFromRolloutsAttributable(
    deps.mapCodexById(deps.listCodexRolloutFiles())
  );
  const opencodeRefs = opencodeRefsFromSessions(
    deps.listOpencodeMaterializedFiles()
  );
  return {
    refs: [...claudeRefs, ...codex.refs, ...opencodeRefs],
    orphanCount: codex.orphanCount,
  };
}
