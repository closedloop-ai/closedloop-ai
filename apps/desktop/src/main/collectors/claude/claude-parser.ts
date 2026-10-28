/**
 * @file claude-parser.ts
 * @description The desktop importer's file-I/O shell around the Claude parser
 * core in `@repo/lib/harness` (FEA-2717) — the core owns every question of what a record
 * MEANS, and this file owns only the disk.
 *
 * Two things live here because they need local disk and the cloud renderer has
 * no equivalent: merging each delegated agent's own `agent-*.jsonl` into the
 * session, and stamping the source file's mtime for the catchup cache. Both sit
 * BETWEEN the core's scan and its build, which is why this shell drives the
 * core's pieces rather than calling its one-shot `parseClaudeTranscript`.
 *
 * An unreadable transcript REJECTS; one that reads fine and carries no usable
 * timestamp resolves `null`. The pre-rewrite shell answered `null` to both,
 * which made a real IO fault indistinguishable from nothing to import — and
 * every consumer treats `null` as a terminal answer and marks the source seen,
 * so a transcript that happened to be locked on one boot was discarded for good.
 *
 * The two answers travel deliberately different paths, and each consumer already
 * routed them that way before this rewrite:
 *
 *   `claude-collector.ts` `parse()` lets the rejection through, so the import
 *   engine classifies the source `threw` and leaves it UNMARKED for the next
 *   pass (`collector-manager-source-parse.ts`). Only `InvalidTokenCountError`
 *   marks it seen, because re-reading cannot fix a counter the parser refuses.
 *
 *   `artifact-link-backfill.ts` and `activity-segment-backfill.ts` each catch,
 *   count an error, and `continue` WITHOUT writing their seen-marker, so the
 *   transcript is retried on the next boot. Their `null` branch writes the
 *   marker, which is what stops a timestamp-less transcript being re-parsed
 *   forever.
 *
 * Parse QUARANTINE is not involved. It is keyed on a parse that never settles —
 * a CPU-spin bounded by `bounded-parse.ts` — and only the timeout path records
 * an attempt. A rejection has always been dead-lettered and retried instead.
 *
 * `transcript-sources.ts` only carries the function as a descriptor; the
 * activity-segment backfill above is its consumer.
 *
 * `test/claude-unreadable-transcript.test.ts` pins each answer against its
 * paired control, at the parser and again at the collector.
 */
import { createReadStream, type Stats, statSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { isDeepStrictEqual } from "node:util";
import {
  extractDedupedUsage,
  parseJsonValue,
} from "@repo/lib/harness/claude/claude-usage";
import type { ClaudeLineageReplay } from "@repo/lib/harness/claude/fork-replay";
import {
  buildSession,
  type ClaudeParseQuality,
  type ClaudeSessionUsage,
  deriveSessionUsage,
  ownDiffStats,
  ownToolUses,
  scanTranscriptLines,
} from "@repo/lib/harness/claude/parse-claude";
import {
  ClaudeRecordType,
  createSessionAccumulator,
  type ParseSessionLogger,
  type SessionAccumulator,
} from "@repo/lib/harness/claude/parse-claude-accumulator";
import {
  type ClaudeDelegation,
  delegationFromToolUseResult,
  delegationsFromEntryToolUses,
  toolResultIdFromEntry,
} from "@repo/lib/harness/claude/parse-claude-delegations";
import { reportUnknownRecords } from "@repo/lib/harness/claude/parse-claude-drift";
import { createSidecarSubagent } from "@repo/lib/harness/claude/parse-claude-subagents";
import { isReplayedTranscriptEntry } from "@repo/lib/harness/claude/replayed-entry";
import type { NormalizedParseQuality } from "@repo/lib/harness/parse-quality";
import {
  asRecord,
  classifyToolKind,
  toIso,
} from "@repo/lib/harness/parser-utils";
import { InvalidTokenCountError } from "@repo/lib/harness/token-counts";
import { selectToolResultFacts } from "@repo/lib/harness/tool-result-facts";
import type {
  NormalizedSession,
  NormalizedSubagent,
  NormalizedToolUse,
} from "@repo/lib/harness/types";
import {
  foldDedupMap,
  mergeFoldedUsage,
  takeUnfoldedUsage,
} from "@repo/lib/harness/usage-dedup";
import { effectiveParsePolicy } from "../../parse-policy/effective-parse-policy.js";
import type { ParsePolicy } from "../../parse-policy/parse-policy.js";
import {
  createParseQualityScan,
  foldChildParseQuality,
  readJsonlLinesWithQuality,
} from "../engine/parse-quality-scan.js";
import { isImportableSourcePath } from "../engine/source-admission.js";
import { stampFileCreatedAt } from "../file-created-at.js";
import {
  accumulateSubagentToolUseEntry,
  createSubagentToolUseAccumulator,
  finalizeSubagentToolUses,
  type SubagentToolUseRecord,
} from "../parsing/subagent-scanner.js";
import { resolveClaudeForkLineage } from "./claude-fork-lineage.js";
import { walkSubagentTranscripts } from "./claude-home.js";
import {
  enrichSidecarSubagents,
  firstAttributionAgent,
  type SidecarSubagentPending,
} from "./claude-subagent-meta.js";
import {
  accumulateSidecarDiffStatsEntry,
  createSidecarDiffStatsPass,
  foldSidecarDiffStats,
  ownDiffFilePaths,
  parentCountedDiffToolUseIds,
  type SidecarDiffStatsContribution,
  sidecarDiffStatsFromAccumulator,
} from "./sidecar-diff-stats.js";

/**
 * Parse a Claude transcript file into a NormalizedSession.
 *
 * THROWS when the transcript cannot be read (see the interface-change note in
 * the file header). Malformed LINES inside a readable file are a different
 * thing: they are skipped and counted into `parseQuality`, never fatal.
 */
export async function parseSessionFile(
  filePath: string,
  logger?: ParseSessionLogger,
  onUnreadableParse?: (quality: NormalizedParseQuality) => void,
  parsePolicy: ParsePolicy = effectiveParsePolicy()
): Promise<NormalizedSession | null> {
  const sessionId = path.basename(filePath, ".jsonl");
  // Resolved before the stream below is opened: awaiting it afterwards would
  // let the stream flow with nothing reading it. ISS-12552 (PRD-800
  // "Rollout"): read only under the attribution policy; off, a headless fork
  // keeps its copied history as it did before PRD-800.
  const lineageReplay = parsePolicy.attributionEvidence
    ? await forkLineageOf(filePath, logger)
    : undefined;

  // Held so the `finally` can destroy it. Belt-and-braces rather than load
  // bearing: `readline.Interface.close()` releases the interface and not its
  // input, but the stream's own `autoClose`/`autoDestroy` defaults already
  // release the descriptor at EOF and on an open/read error alike. No reachable
  // input was found that leaks one without this line, so do not read it as
  // covering a case the suite proves — it covers a default not changing.
  const input = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  // Diagnostics cost input-proportional memory (the drift maps are keyed on
  // transcript-controlled strings), so they are retained only when this parse has
  // somewhere to report them. The desktop importer passes the engine's log; the
  // cloud renderer deliberately passes nothing.
  const accumulator = createSessionAccumulator({
    collectDiagnostics: logger !== undefined,
    ...(lineageReplay ? { lineageReplay } : {}),
    attributionEvidence: parsePolicy.attributionEvidence,
  });
  let parseQuality: ClaudeParseQuality;
  try {
    parseQuality = await scanTranscriptLines(rl, accumulator);
  } finally {
    // No catch: the read error is the caller's to handle. This only guarantees
    // the descriptor is released on every exit — normal, thrown, or abandoned.
    rl.close();
    input.destroy();
  }

  reportUnknownRecords(accumulator, logger);

  // A transcript with no usable timestamp anywhere cannot be placed on any
  // timeline, so it is not importable as a session. Distinct from an unreadable
  // file, which throws: this one was read fine and simply carries nothing.
  if (!accumulator.startedAt) {
    // ISS-7625: `scanTranscriptLines` has already filled `parseQuality` by here,
    // and this `null` used to be where those counts died. Hand them over so an
    // all-malformed transcript can be counted as an ingest failure rather than
    // reading as a source that was simply empty. No subagent fold has run yet,
    // which is correct — a transcript with no timestamp has no session to fold
    // sidecars onto.
    onUnreadableParse?.(parseQuality);
    return null;
  }

  const usage = deriveSessionUsage(accumulator);
  // Agents created from their OWN file, awaiting reconciliation once every
  // agent's tool calls are in place. Lane state, so the shell owns it.
  const pendingAgents: SidecarSubagentPending[] = [];
  const diffStats = await processAgentFiles(filePath, accumulator, {
    usage,
    parseQuality,
    pendingAgents,
  });

  const fileStats = readFileStats(filePath);
  const session = buildSession(accumulator, {
    sessionId,
    parseQuality,
    usage,
    diffStats,
    fileModifiedAt: fileStats?.mtimeMs ?? null,
  });
  stampFileCreatedAt(session, fileStats);

  // Reconciled last, once every agent's tool calls are in place: the join walks
  // the meta file's link, then the spawning call's input, then the answering
  // result, then the file's own attribution. Strictly additive, so an inline
  // agent the core already resolved is never overwritten.
  enrichSidecarSubagents(session, pendingAgents, accumulator.delegations);

  return session;
}

/**
 * Merge every delegated agent's own transcript into the session, and return the
 * session's combined `diffStats`.
 *
 * FEA-1459 / FEA-3420. A delegated agent writes its work to
 * `<sessionId>/subagents/agent-*.jsonl` beside the parent transcript. Discovery
 * RECURSES, because a workflow agent
 * nests another level down, and a one-level scan drops its tokens, models, and
 * tools from the parent entirely.
 *
 * This is desktop-only. It needs local disk, and the cloud renderer instead
 * fetches each agent's file as a transcript in its own right.
 */
async function processAgentFiles(
  filePath: string,
  accumulator: SessionAccumulator,
  session: AgentFileMergeTarget
): Promise<NormalizedSession["diffStats"]> {
  const sessionDir = path.dirname(filePath);
  const sessionId = path.basename(filePath, ".jsonl");
  const agentDir = path.join(sessionDir, sessionId, "subagents");

  let agentFiles: Array<{ agentFile: string; agentId: string }> = [];
  try {
    agentFiles = walkSubagentTranscripts(agentDir)
      .filter((entry) => isImportableSourcePath(entry.filePath, [sessionDir]))
      // The merge APPENDS to order-sensitive arrays, and the walk already
      // returns a sorted list, so parse output is identical on every machine.
      .map((entry) => ({ agentFile: entry.filePath, agentId: entry.relId }));
  } catch {
    // No agent directory — the normal shape for a session that never delegated.
  }

  // ISS-5426: the line-side twin of `billedKeys`, seeded from what this transcript
  // already counted. ONE set across the whole loop: a record two agent files
  // both carry is counted once rather than once per file. The two guards must
  // agree on what one turn is, or a session counts its lines once and its cost
  // twice.
  // ISS-8659: the OWN list, not `accumulator.toolUses`. A replayed call stays in
  // the raw array so its own replayed result still resolves to it, but nothing
  // booked its lines — `applyDiffStatsToolUseState` runs a replayed handler
  // against throwaway totals, so its paths never reach `accumulator.diffFiles`.
  // Passing the raw array here claimed replayed ids as already-counted when
  // nothing counted them, and inflated `ownFilePaths` past the parent's real
  // set, which is exactly the case the clamp below this comment warns silently
  // undercounts `filesChanged`.
  const ownParentToolUses = ownToolUses(accumulator);
  const countedDiffToolUseIds = parentCountedDiffToolUseIds(ownParentToolUses);
  // Parent diff totals are already booked. Preserve their path population even
  // if later semantic reconciliation quarantines a conflicting tool projection.
  const parentDiffFilePaths = ownDiffFilePaths(ownParentToolUses);
  const contributions: SidecarDiffStatsContribution[] = [];

  for (const { agentFile, agentId } of agentFiles) {
    try {
      await processAgentFile(agentFile, agentId, sessionId, accumulator, {
        ...session,
        countedDiffToolUseIds,
        contributions,
      });
    } catch (error) {
      if (error instanceof InvalidTokenCountError) {
        throw error;
      }
      // Fail-silent per agent file: one unreadable child must not cost the
      // parent its own parse. Distinct from the parent transcript, which throws.
    }
  }

  return foldSidecarDiffStats(
    ownDiffStats(accumulator),
    parentDiffFilePaths,
    contributions
  );
}

/** What one agent file merges into, threaded through the loop above. */
type AgentFileMergeTarget = {
  usage: ClaudeSessionUsage;
  parseQuality: { totalLines: number; malformedLines: number };
  pendingAgents: SidecarSubagentPending[];
};

/**
 * Merge one delegated agent's transcript: its parse quality, its token usage,
 * its authored lines, and its tool calls.
 */
async function processAgentFile(
  agentFile: string,
  agentId: string,
  sessionId: string,
  accumulator: SessionAccumulator,
  target: AgentFileMergeTarget & {
    countedDiffToolUseIds: Set<string>;
    contributions: SidecarDiffStatsContribution[];
  }
): Promise<void> {
  const read = await readAgentFile(
    agentFile,
    agentId,
    sessionId,
    target.countedDiffToolUseIds,
    accumulator.attributionEvidence
  );
  accumulator.delegations.push(...read.delegations);

  // FEA-2905: a corrupt line in this file silently drops that turn's merged tokens, so it
  // must surface on the parent rather than read as a clean parse. The shared
  // helper discounts this file's OWN trailing truncation, which is the benign
  // shape of a live write; only mid-file corruption inflates the parent.
  foldChildParseQuality(target.parseQuality, read);

  // Every record in this file belongs to this agent, so its id is
  // file-authoritative provenance. That beats deriving provenance per record,
  // which for a nested workflow agent would yield the bare basename and leave
  // its records unmatched to its own row.
  const dedupedUsage = extractDedupedUsage(read.entries, agentId);
  // The agent's OWN row keeps the full total — those round-trips are its work
  // wherever they were written down — while the session sees each exactly once.
  // Taking the entries also marks them, so a turn present in two agent files is
  // counted once across the whole loop.
  const ownUsage = foldDedupMap(dedupedUsage);
  mergeFoldedUsage(
    target.usage,
    foldDedupMap(takeUnfoldedUsage(dedupedUsage, target.usage.billedKeys))
  );
  // ISS-5402: pushed AFTER the token merge, never before. Everything here runs inside the
  // caller's per-file catch, so a push placed earlier would leave this agent's
  // LINES in the parent while its TOKENS never arrived — over-reporting `LOC/$`
  // by exactly this agent's share. With the push here a failing file drops out
  // of the numerator and the denominator together, or out of neither.
  target.contributions.push(read.diffStats);

  const existing = accumulator.subagents.get(agentId);
  const agent =
    existing ?? createSidecarSubagent(agentId, accumulator.startedAt);
  const toolUseMerge = mergeAgentToolUses(agent, read.toolUses);
  const conflictedIds = new Set([
    ...read.conflictedToolUseIds,
    ...toolUseMerge.conflictedIds,
  ]);
  agent.toolUses = toolUseMerge.toolUses.filter(
    (toolUse) => !(toolUse.id && conflictedIds.has(toolUse.id))
  );
  if (conflictedIds.size > 0) {
    for (let index = accumulator.toolUses.length - 1; index >= 0; index--) {
      const toolUseId = accumulator.toolUses[index]?.id;
      if (toolUseId && conflictedIds.has(toolUseId)) {
        accumulator.toolUses.splice(index, 1);
      }
    }
    reindexToolUses(accumulator.toolUseIdIndex, accumulator.toolUses);
  }
  agent.tokensByModel = ownUsage.tokensByModel;
  agent.tokenSeries = ownUsage.tokenSeries;
  if (!existing) {
    accumulator.subagents.set(agentId, agent);
  }

  // Queued rather than reconciled here: resolving a NESTED delegation needs
  // every agent's tool calls in place, and a sibling file may not be read yet.
  // The first `attributionAgent` on this file's own lines is the type-only last
  // resort when neither the meta file nor a call join resolves it.
  target.pendingAgents.push({
    subagent: agent,
    subFile: agentFile,
    attributionAgent: firstAttributionAgent(read.entries),
  });
}

/** One agent file's usage records, authored lines, and parse quality — one pass. */
async function readAgentFile(
  agentFile: string,
  agentId: string,
  sessionId: string,
  countedDiffToolUseIds: Set<string>,
  attributionEvidence: boolean
): Promise<{
  entries: Array<{ entry: Record<string, unknown>; iso: string | null }>;
  toolUses: NormalizedToolUse[];
  delegations: ClaudeDelegation[];
  diffStats: SidecarDiffStatsContribution;
  totalLines: number;
  malformedLines: number;
  truncatedFinalLine: boolean;
  conflictedToolUseIds: string[];
}> {
  const entries: Array<{
    entry: Record<string, unknown>;
    iso: string | null;
  }> = [];
  const toolUseAccumulator = createSubagentToolUseAccumulator(
    sessionId,
    agentId
  );
  const delegations: ClaudeDelegation[] = [];
  // FEA-3453: an agent's transcript is replayed on resume exactly like its parent's, so
  // the same filter applies — and because this is now the ONLY read of the file,
  // applying it here covers every fact derived from it. A record with no
  // `tool_use.id` cannot be deduped downstream at all, which is why the filter
  // has to sit at the line rather than at the merge.
  const seenEntryUuids = new Set<string>();
  // Derived from the raw input this pass already reads. ISS-6480 removed the
  // 1000-character bound that was this pass's stated reason for existing, so
  // whether it still needs the raw lines is open — ISS-7164. Do not delete it
  // on the strength of the retired premise, and do not assume a redundancy
  // that was never established.
  const diffPass = createSidecarDiffStatsPass(countedDiffToolUseIds);
  const scan = createParseQualityScan();
  for await (const { entry } of readJsonlLinesWithQuality(agentFile, scan)) {
    if (isReplayedTranscriptEntry(seenEntryUuids, entry)) {
      continue;
    }
    if (
      entry.type === ClaudeRecordType.Assistant &&
      asRecord(entry.message).usage
    ) {
      entries.push({ entry, iso: toIso(entry.timestamp) });
    }
    accumulateSubagentToolUseEntry(toolUseAccumulator, entry);
    accumulateSidecarDiffStatsEntry(diffPass, entry);
    // A NESTED delegation's spawning call lives in its PARENT agent's file.
    // This loop reads that file's lines directly, so the surviving reason to
    // keep the raw read is NOT scoping — the merged records for this same file
    // do carry the spawning tool_use. It is that `finalizeSubagentToolUses`
    // merges, dedupes, and DROPS conflicted ids, which this pass does not.
    // Whether that difference still justifies a second read is ISS-7164.
    delegations.push(...delegationsFromEntryToolUses(entry));
    const fromResult = delegationFromToolUseResult(
      toolResultIdFromEntry(entry),
      entry.toolUseResult
    );
    if (fromResult) {
      delegations.push(fromResult);
    }
  }
  return {
    entries,
    delegations,
    // ISS-6454: a malformed line is skipped and counted into `parseQuality`,
    // the same posture every surrounding lane takes. It does NOT discard this
    // file's tool uses, which is what the ISS-5542 rule did.
    //
    // That rule guarded a hazard this path cannot reach: it feared a truncated
    // line splitting a `tool_use` block, but `readJsonlLinesWithQuality` drops
    // an unparseable line before any block is inspected, so every block
    // arriving here came from a line that parsed whole. The cost was real,
    // though — a delegated agent whose transcript was still being written lost
    // every tool call it made while its tokens, authored lines, and delegations
    // all still counted. Cost retained, work discarded.
    toolUses: finalizeSubagentToolUses(toolUseAccumulator).map((toolUse) =>
      normalizedAgentToolUse(toolUse, attributionEvidence)
    ),
    conflictedToolUseIds: [...toolUseAccumulator.conflictedIds].sort(),
    diffStats: sidecarDiffStatsFromAccumulator(diffPass.acc),
    totalLines: scan.totalLines,
    malformedLines: scan.malformedLines,
    truncatedFinalLine: scan.lastLineMalformed,
  };
}

/**
 * Merge an agent file's tool calls onto its row, deduped by provider id — the
 * parent transcript may already carry the same call as an inline record, and it
 * is one invocation. A call with NO id cannot be deduped here at all; the
 * replay filter in `readAgentFile` is what covers that case.
 */
function mergeAgentToolUses(
  agent: NormalizedSubagent,
  toolUses: readonly NormalizedToolUse[]
): { toolUses: NormalizedToolUse[]; conflictedIds: ReadonlySet<string> } {
  const merged = [...(agent.toolUses ?? [])];
  const indexById = new Map<string, number>();
  const conflictedIds = new Set<string>();
  for (const [index, toolUse] of merged.entries()) {
    if (toolUse.id) {
      indexById.set(toolUse.id, index);
    }
  }
  for (const toolUse of toolUses) {
    if (toolUse.id) {
      if (conflictedIds.has(toolUse.id)) {
        continue;
      }
      const existingIndex = indexById.get(toolUse.id);
      if (existingIndex !== undefined) {
        const reconciled = reconcileAgentToolUse(
          merged[existingIndex],
          toolUse
        );
        if (reconciled) {
          merged[existingIndex] = reconciled;
        } else {
          merged.splice(existingIndex, 1);
          conflictedIds.add(toolUse.id);
          reindexToolUses(indexById, merged);
        }
        continue;
      }
      indexById.set(toolUse.id, merged.length);
    }
    merged.push(toolUse);
  }
  return { toolUses: merged, conflictedIds };
}

function reconcileAgentToolUse(
  inline: NormalizedToolUse,
  sidecar: NormalizedToolUse
): NormalizedToolUse | null {
  if (!areToolUseIdentitiesCompatible(inline, sidecar)) {
    return null;
  }
  const output = reconcileCompletionValue(inline.output, sidecar.output);
  const resultTimestamp = reconcileCompletionValue(
    inline.resultTimestamp ?? undefined,
    sidecar.resultTimestamp ?? undefined
  );
  const isError = reconcileCompletionError(inline, sidecar);
  if (output.conflict || resultTimestamp.conflict || isError.conflict) {
    return null;
  }
  if (output.value !== undefined) {
    inline.output = output.value;
    // ISS-10736: the footprint describes THIS output, so it travels with it. An
    // inline record that already carried its own count keeps it — both lanes
    // count the same result text, and the sidecar has none when it saw none.
    if (sidecar.outputFootprintTokens !== undefined) {
      inline.outputFootprintTokens ??= sidecar.outputFootprintTokens;
    }
  }
  if (resultTimestamp.value !== undefined) {
    inline.resultTimestamp = resultTimestamp.value;
  }
  if (isError.value !== undefined) {
    inline.isError = isError.value;
  }
  return inline;
}

function reconcileCompletionError(
  inline: NormalizedToolUse,
  sidecar: NormalizedToolUse
): { conflict: boolean; value: boolean | undefined } {
  const inlineCompleted = inline.output !== undefined;
  const sidecarCompleted = sidecar.output !== undefined;
  if (inlineCompleted && sidecarCompleted) {
    const inlineError = inline.isError === true;
    const sidecarError = sidecar.isError === true;
    if (inlineError !== sidecarError) {
      return { conflict: true, value: undefined };
    }
    return {
      conflict: false,
      value: inline.isError ?? sidecar.isError,
    };
  }
  if (inlineCompleted) {
    return { conflict: false, value: inline.isError };
  }
  if (sidecarCompleted) {
    return { conflict: false, value: sidecar.isError };
  }
  return reconcileCompletionValue(inline.isError, sidecar.isError);
}

function areToolUseIdentitiesCompatible(
  inline: NormalizedToolUse,
  sidecar: NormalizedToolUse
): boolean {
  const identityPairs: ReadonlyArray<readonly [unknown, unknown]> = [
    [inline.id, sidecar.id],
    [inline.name, sidecar.name],
    [inline.rawName, sidecar.rawName],
    [inline.normalizedName, sidecar.normalizedName],
    [inline.kind, sidecar.kind],
    [inline.timestamp, sidecar.timestamp],
    [inline.input, sidecar.input],
    [inline.mcpServer, sidecar.mcpServer],
    [inline.mcpMethod, sidecar.mcpMethod],
    [inline.skillName, sidecar.skillName],
    [inline.diffDelta, sidecar.diffDelta],
    [inline.definitionSnapshot, sidecar.definitionSnapshot],
    [inline.gitBranch, sidecar.gitBranch],
    [inline.subagentId, sidecar.subagentId],
  ];
  return identityPairs.every(([left, right]) => {
    if (left === null || left === undefined) {
      return true;
    }
    if (right === null || right === undefined) {
      return true;
    }
    return isDeepStrictEqual(left, right);
  });
}

function reconcileCompletionValue<T>(
  left: T | undefined,
  right: T | undefined
): { conflict: boolean; value: T | undefined } {
  if (left === undefined) {
    return { conflict: false, value: right };
  }
  if (right === undefined) {
    return { conflict: false, value: left };
  }
  return isDeepStrictEqual(left, right)
    ? { conflict: false, value: left }
    : { conflict: true, value: undefined };
}

function reindexToolUses(
  indexById: Map<string, number>,
  toolUses: readonly NormalizedToolUse[]
): void {
  indexById.clear();
  for (const [index, toolUse] of toolUses.entries()) {
    if (toolUse.id) {
      indexById.set(toolUse.id, index);
    }
  }
}

/** Convert one native-id-joined sidecar record into the shared parser shape. */
function normalizedAgentToolUse(
  toolUse: SubagentToolUseRecord,
  attributionEvidence: boolean
): NormalizedToolUse {
  const input = scannedToolInput(toolUse);
  const skill = toolUse.toolName === "Skill" ? asRecord(input).skill : null;
  return {
    ...(toolUse.toolUseId ? { id: toolUse.toolUseId } : {}),
    ...(attributionEvidence && toolUse.requestKey
      ? { requestKey: toolUse.requestKey }
      : {}),
    name: toolUse.toolName,
    kind: classifyToolKind(toolUse.toolName),
    ...(typeof skill === "string" ? { skillName: skill } : {}),
    timestamp: toIso(toolUse.timestamp),
    input,
    ...(toolUse.output === null
      ? {}
      : { output: parseJsonValue(toolUse.output) }),
    // ISS-10736 (tamsinb review): the scanner counted the UNTRUNCATED result;
    // `output` above is its bounded form and cannot be recounted downstream.
    ...(toolUse.outputFootprintTokens === null
      ? {}
      : { outputFootprintTokens: toolUse.outputFootprintTokens }),
    ...(toolUse.resultTimestamp === null
      ? {}
      : { resultTimestamp: toIso(toolUse.resultTimestamp) }),
    ...(toolUse.isError === null ? {} : { isError: toolUse.isError }),
    ...(attributionEvidence && toolUse.resultFacts !== null
      ? selectToolResultFacts({ name: toolUse.toolName }, toolUse.resultFacts)
      : {}),
    subagentId: toolUse.agentId,
  };
}

/**
 * ISS-6480: the scanner carries the raw input, so this reads it straight
 * through. It used to re-parse a bounded string, which dropped every input over
 * the bound. `null` is the scanner's absent sentinel; a falsy-but-real `0`,
 * `""`, or `false` passes through intact. Known limitation, tracked as
 * ISS-7161: a tool input that genuinely was `null` reads as absent here,
 * because the producer stores `null` for both meanings.
 */
function scannedToolInput(toolUse: SubagentToolUseRecord): unknown {
  return toolUse.input === null ? undefined : toolUse.input;
}

/**
 * The source file's stat: its mtime is what the catchup cache keys on to notice
 * a changed transcript, and its birth time is the session's `fileCreatedAt`.
 *
 * Deliberately NOT fatal, unlike a read failure: the transcript has already been
 * read in full by this point, so a stat that fails here means the file vanished
 * during the parse. Discarding a complete parse over that race would lose more
 * than it protects. See the interface note — whether this should also throw is
 * an open question.
 */
function readFileStats(filePath: string): Stats | undefined {
  try {
    return statSync(filePath);
  } catch {
    return;
  }
}

/**
 * ISS-12552: a headless fork's copied history. Best-effort: a sibling that
 * cannot be read leaves the parse exactly as it was before lineage existed.
 */
async function forkLineageOf(
  filePath: string,
  logger: ParseSessionLogger | undefined
): Promise<ClaudeLineageReplay | undefined> {
  try {
    return await resolveClaudeForkLineage(filePath);
  } catch (error) {
    logger?.(
      `fork lineage unavailable for ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}
