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
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  extractDedupedUsage,
  isoTs,
  parseJsonValue,
} from "@repo/lib/harness/claude/parse-claude";
import {
  ClaudeRecordType,
  createSessionAccumulator,
  type ParseSessionLogger,
  type SessionAccumulator,
} from "@repo/lib/harness/claude/parse-claude-accumulator";
import {
  buildSession,
  type ClaudeParseQuality,
  type ClaudeSessionUsage,
  deriveSessionUsage,
  ownDiffStats,
  scanTranscriptLines,
} from "@repo/lib/harness/claude/parse-claude-core";
import {
  type ClaudeDelegation,
  delegationFromToolUseResult,
  delegationsFromEntryToolUses,
  toolResultIdFromEntry,
} from "@repo/lib/harness/claude/parse-claude-delegations";
import { reportUnknownRecords } from "@repo/lib/harness/claude/parse-claude-drift";
import { createSidecarSubagent } from "@repo/lib/harness/claude/parse-claude-subagents";
import { isReplayedTranscriptEntry } from "@repo/lib/harness/claude/replayed-entry";
import {
  asRecord,
  classifyToolKind,
  stringValue,
} from "@repo/lib/harness/parser-utils";
import { InvalidTokenCountError } from "@repo/lib/harness/token-counts";
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
import {
  createParseQualityScan,
  foldChildParseQuality,
  readJsonlLinesWithQuality,
} from "../engine/parse-quality-scan.js";
import { isImportableSourcePath } from "../engine/source-admission.js";
import { stringifyBounded } from "../parsing/subagent-scanner.js";
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
  logger?: ParseSessionLogger
): Promise<NormalizedSession | null> {
  const sessionId = path.basename(filePath, ".jsonl");

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

  const session = buildSession(accumulator, {
    sessionId,
    parseQuality,
    usage,
    diffStats,
    fileModifiedAt: readFileModifiedAt(filePath),
  });

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
  const countedDiffToolUseIds = parentCountedDiffToolUseIds(
    accumulator.toolUses
  );
  const contributions: SidecarDiffStatsContribution[] = [];

  for (const { agentFile, agentId } of agentFiles) {
    try {
      await processAgentFile(agentFile, agentId, accumulator, {
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
    ownDiffFilePaths(accumulator.toolUses),
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
  accumulator: SessionAccumulator,
  target: AgentFileMergeTarget & {
    countedDiffToolUseIds: Set<string>;
    contributions: SidecarDiffStatsContribution[];
  }
): Promise<void> {
  const read = await readAgentFile(
    agentFile,
    agentId,
    target.countedDiffToolUseIds
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
  agent.toolUses = mergeAgentToolUses(agent, read.toolUses);
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
  countedDiffToolUseIds: Set<string>
): Promise<{
  entries: Array<{ entry: Record<string, unknown>; iso: string | null }>;
  toolUses: NormalizedToolUse[];
  delegations: ClaudeDelegation[];
  diffStats: SidecarDiffStatsContribution;
  totalLines: number;
  malformedLines: number;
  truncatedFinalLine: boolean;
}> {
  const entries: Array<{
    entry: Record<string, unknown>;
    iso: string | null;
  }> = [];
  const toolUses: NormalizedToolUse[] = [];
  const delegations: ClaudeDelegation[] = [];
  // FEA-3453: an agent's transcript is replayed on resume exactly like its parent's, so
  // the same filter applies — and because this is now the ONLY read of the file,
  // applying it here covers every fact derived from it. A record with no
  // `tool_use.id` cannot be deduped downstream at all, which is why the filter
  // has to sit at the line rather than at the merge.
  const seenEntryUuids = new Set<string>();
  // Derived from the same untruncated raw input this pass already reads — the
  // merged tool-use records bound each input at 1000 characters, which is
  // unparseable as a patch.
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
      entries.push({ entry, iso: isoTs(entry.timestamp) });
    }
    toolUses.push(...agentToolUses(entry, agentId));
    accumulateSidecarDiffStatsEntry(diffPass, entry);
    // A NESTED delegation's spawning call lives in its PARENT agent's file, and
    // this raw pass is the only place those lines are read untruncated — the
    // merged tool-use records cap each input well below a real prompt.
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
    // One malformed line drops this file's tool uses WHOLE, on the rule that a
    // truncated line can split a `tool_use` block and half a block is not a
    // tool use. Adopted to match the landed behaviour rather than because this
    // rewrite agrees with it: an unparseable line is dropped before any block is
    // read, so no partial block reaches here, and the file's tokens, authored
    // lines, and delegations are all still kept — only this one projection is
    // discarded. Filed as ISS-6454 rather than settled here.
    toolUses: scan.malformedLines > 0 ? [] : toolUses,
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
): NormalizedToolUse[] {
  const merged = [...(agent.toolUses ?? [])];
  const seen = new Set(
    merged
      .map((toolUse) => toolUse.id)
      .filter((id): id is string => typeof id === "string")
  );
  for (const toolUse of toolUses) {
    if (toolUse.id) {
      if (seen.has(toolUse.id)) {
        continue;
      }
      seen.add(toolUse.id);
    }
    merged.push(toolUse);
  }
  return merged;
}

/**
 * The tool calls one agent-file record made.
 *
 * The input is round-tripped through `stringifyBounded` → `parseJsonValue`, which
 * is not a serialization step — it is the production behaviour, reproduced. The
 * scanner this read replaced bounded each input to 1000 JSON characters, and the
 * shell then re-parsed that string; for any input longer than the bound the slice
 * lands mid-token, `JSON.parse` throws, and the input is dropped ENTIRELY rather
 * than kept as a 1000-character preview. Across the golden corpus that is 84 of
 * 1,886 agent tool calls, every one of them over the bound and every one under it
 * intact — a clean split, so the bound explains all of it and nothing else does.
 *
 * Reproduced here rather than fixed, so this rewrite stays behaviour-identical to
 * what ships and the improvement is its own reviewable change: ISS-6480.
 */
function agentToolUses(
  record: Record<string, unknown>,
  agentId: string
): NormalizedToolUse[] {
  const timestamp = isoTs(record.timestamp);
  // FLAT SHAPE FIRST, exactly as `extractToolUses` does. An agent file can carry
  // a tool at the TOP level (`{"type":"tool_use","name":…}`) rather than nested in
  // `message.content`, and the reader this replaced accepted both. The live-hook
  // lane still reaches those records through `extractToolUses`, so dropping the
  // shape here would not lose the tool — it would make the two readers of the same
  // file disagree, and a DATA_REVISION rebuild would silently strip tools from
  // sessions that live ingestion had recorded correctly.
  const flat = flatAgentToolUse(record, agentId, timestamp);
  if (flat) {
    return [flat];
  }
  const content = asRecord(record.message).content;
  if (!Array.isArray(content)) {
    return [];
  }
  const toolUses: NormalizedToolUse[] = [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (block.type !== "tool_use" || typeof block.name !== "string") {
      continue;
    }
    const bounded = stringifyBounded(block.input);
    const input = bounded ? parseJsonValue(bounded) : undefined;
    // Read from the BOUNDED value, not the raw block: production resolves the
    // Skill name from the same re-parsed copy, so an over-bound Skill input
    // yields no name there and must yield none here. Reading the raw block would
    // be a better answer and a NEW divergence — it belongs with ISS-6480.
    const skill = block.name === "Skill" ? asRecord(input).skill : null;
    toolUses.push({
      ...(stringValue(block.id) ? { id: stringValue(block.id) as string } : {}),
      name: block.name,
      kind: classifyToolKind(block.name),
      ...(typeof skill === "string" ? { skillName: skill } : {}),
      timestamp,
      input,
      subagentId: agentId,
    });
  }
  return toolUses;
}

/**
 * A tool written at the TOP level of an agent record rather than inside
 * `message.content`.
 *
 * `extractToolUses` — the live-hook lane's reader of these same files — accepts
 * `type: "tool_use"` and `type: "tool_result"` in this position, keyed on the
 * record's own `name`/`id`/`input`/`result`. Both lanes must accept it, and
 * populate the same fields from it, or the same file yields different tools
 * depending on which one read it.
 *
 * `result` is the field that makes this shape worth having: it is the ONLY
 * position an agent-file tool carries its output in, the sibling reader captures
 * it as `output`, and `importToolEventData` persists that as
 * `events.data.tool_response` — the Session Trace's per-call detail. Reading the
 * shape without it restores the tool row and drops what the tool returned.
 */
function flatAgentToolUse(
  record: Record<string, unknown>,
  agentId: string,
  timestamp: string | null
): NormalizedToolUse | null {
  if (record.type !== "tool_use" && record.type !== "tool_result") {
    return null;
  }
  const name = stringValue(record.name);
  if (!name) {
    return null;
  }
  // The same bounded round-trip the nested path uses, so an over-bound input is
  // dropped identically in both shapes rather than only in one (ISS-6480).
  const bounded = stringifyBounded(record.input);
  const input = bounded ? parseJsonValue(bounded) : undefined;
  const boundedResult = stringifyBounded(record.result);
  const skill = name === "Skill" ? asRecord(input).skill : null;
  return {
    ...(stringValue(record.id) ? { id: stringValue(record.id) as string } : {}),
    name,
    kind: classifyToolKind(name),
    ...(typeof skill === "string" ? { skillName: skill } : {}),
    timestamp,
    input,
    ...(boundedResult ? { output: parseJsonValue(boundedResult) } : {}),
    subagentId: agentId,
  };
}

/**
 * The source file's mtime, which the catchup cache keys on to notice a changed
 * transcript.
 *
 * Deliberately NOT fatal, unlike a read failure: the transcript has already been
 * read in full by this point, so a stat that fails here means the file vanished
 * during the parse. Discarding a complete parse over that race would lose more
 * than it protects. See the interface note — whether this should also throw is
 * an open question.
 */
function readFileModifiedAt(filePath: string): number | null {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}
