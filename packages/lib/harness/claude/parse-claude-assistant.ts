import {
  asRecord,
  boundedStringValue,
  classifyToolKind,
  stringValue,
  toIso,
  truncateText,
} from "../parser-utils";
import { requestKeyFor } from "../request-key";
import type { NormalizedSubagent, NormalizedToolUse } from "../types";
import { claudeTranscriptEntryUuidScheme } from "../usage-dedup";
import { readClaudeUsageCounts } from "./claude-usage";
import {
  applyDiffStatsToolUseState,
  DIFF_STATS_TOOL_HANDLERS,
  isUsableDiffStatsToolInput,
} from "./diff-stats-tool-handlers";
import {
  ClaudeRecordType,
  type SessionAccumulator,
  SYNTHETIC_MODEL,
} from "./parse-claude-accumulator";
import { delegationsFromEntryToolUses } from "./parse-claude-delegations";
import {
  ASSISTANT_ATTRIBUTES,
  collectUnknownAttributes,
} from "./parse-claude-drift";
import { collectSlashCommands } from "./parse-claude-slash-commands";
import {
  deriveSidechainSubagentId,
  normalizeSidechainSubagentId,
} from "./parse-claude-subagents";
import { recordScheduledPrompt } from "./prompt-injection";

/**
 * Decode an `assistant` record: the session's model, its content blocks, and the
 * tool calls it made.
 *
 * One API turn is written across SEVERAL of these records, one per content
 * block, all sharing a `message.id`. Everything here is per-block and safe to
 * repeat; the per-turn facts (token usage, turn counts) are derived from a dedup
 * pass instead and are not this handler's business.
 */
export function processAssistantRecord(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator,
  replayed: boolean
): void {
  const message = asRecord(record.message);
  const model = stringValue(message.model);
  recordReportedModel(model, accumulator, replayed);

  const timestamp = toIso(record.timestamp);
  const textParts: string[] = [];
  for (const raw of Array.isArray(message.content) ? message.content : []) {
    processAssistantBlock(
      record,
      asRecord(raw),
      timestamp,
      model,
      textParts,
      accumulator,
      replayed
    );
  }

  // Source one: the spawning call's own input, which carries the richest
  // description of the work but names no child.
  accumulator.delegations.push(...delegationsFromEntryToolUses(record));

  // Scanned on the FULL text, before truncation, so a heading and its phases
  // cannot be split apart by the message cap.
  const assistantText = textParts.join("\n");
  // The harness echoes a command marker into ASSISTANT text on expansion and on
  // replay, not only into the user turn that typed it. Scanning both lanes is
  // what lets the following `isMeta` definition record find its command by turn
  // id; scanning only the user lane drops the invocation and its snapshot.
  // ISS-8659: a replayed record re-states a command the PARENT ran and a plan it
  // wrote. Both are per-session sets, so counting them here credited the fork
  // with the parent's work.
  if (!replayed) {
    collectSlashCommands(record, assistantText, timestamp, accumulator);
    const inlinePlan = inlinePlanText(assistantText);
    if (inlinePlan) {
      recordPlan(accumulator, "claude-inline-plan", inlinePlan, timestamp);
    }
  }

  // ISS-7258: the reasoning-effort tier sits on the RECORD, not inside `usage`
  // like its `usageExtras` siblings, so it is read here rather than in
  // `collectUsageExtras`. A session can change tier mid-run, hence a set.
  // `boundedStringValue`: an over-cap tier is dropped here rather than rejecting
  // the whole source at the `.strict()` worker boundary. A tier is an enum-ish
  // word in every shape the harness emits, so nothing legitimate is lost.
  // ISS-8659: gated for the same reason as the `usageExtras` sets below it — a
  // replayed record states the tier the PARENT ran at. Post-dates the ISS-8659
  // issue text, which enumerates the sets that existed when it was written; same
  // defect class.
  const effort = replayed ? null : boundedStringValue(record.effort);
  if (effort) {
    accumulator.efforts.add(effort);
  }

  const usage = message.usage ? asRecord(message.usage) : null;
  if (usage) {
    // ISS-8659: a replayed snapshot states how the PARENT's turn ran. The issue
    // text lists these four as unaffected, on the ground that the three sets
    // union and `webSearchRequests` takes a max, so neither can double-count
    // WITHIN a session. True, and not the same as harmless.
    //
    // For the sets the damage is attribution: a fork whose parent ran a different
    // service tier, speed or geo reported one it never used.
    //
    // `web_search_requests` is worse, because it is priced, not descriptive:
    // `import-metadata-builders.ts` persists it, then `webSearchCostSql`
    // (`token-cost-writes.ts`) charges it onto `sessions.cost_usd_estimated` and
    // `sessionWebSearchCostUsd` (`@repo/cost/session-web-search-cost`) onto the
    // cloud's `SessionDetail.estimatedCost`. Taking the parent's max BILLED the
    // fork for searches the parent had already paid for — the volume defect this
    // ticket exists to end, reached through a field the issue ruled out.
    if (!replayed) {
      collectUsageExtras(usage, accumulator);
    }
    // Held for the dedup pass. A synthetic turn is skipped outright: nobody was
    // billed for it, so it must not reach the token totals.
    //
    // ISS-8659: a fork replays the parent's assistant records with the SAME
    // `message.id` and the SAME usage snapshot. The dedup map is keyed per
    // session, so it cannot see that the parent was already billed for them —
    // this gate is what stops a fork re-billing its parent's whole history.
    if (!replayed && model && model !== SYNTHETIC_MODEL) {
      // The dedup pass stamps provenance onto EVERY record held here, via the
      // same id formula the roster row is built from. Creating the row only from
      // the `tool_use` handler therefore left a delegated turn that merely spoke
      // — text or thinking — billing tokens to an agent the session never listed.
      // Ensuring it for exactly the set that gets stamped is what makes the
      // `tokenSeries.subagentId` → `subagents[].id` join total.
      ensureSidechainSubagent(record, timestamp, accumulator);
      accumulator.assistantUsageRecords.push({ entry: record, iso: timestamp });
    }
  }

  accumulator.messages.push({
    role: "assistant",
    timestamp,
    text: truncateText(assistantText),
    model,
    // Per-message counts are display detail, so a snapshot this record cannot
    // read is dropped for THIS message rather than failing the transcript.
    ...(usage ? { tokens: readClaudeUsageCounts(usage) ?? undefined } : {}),
    ...(replayed ? { isForkReplayed: true } : {}),
  });

  collectUnknownAttributes(
    ClaudeRecordType.Assistant,
    record,
    ASSISTANT_ATTRIBUTES,
    accumulator
  );
}

/** Gather the non-token facts a usage snapshot carries about how a turn ran. */
function collectUsageExtras(
  usage: Record<string, unknown>,
  accumulator: SessionAccumulator
): void {
  const serviceTier = stringValue(usage.service_tier);
  if (serviceTier) {
    accumulator.serviceTiers.add(serviceTier);
  }
  const speed = stringValue(usage.speed);
  if (speed) {
    accumulator.speeds.add(speed);
  }
  const inferenceGeo = stringValue(usage.inference_geo);
  // "not_available" is the provider saying it does not know, which is not a geo.
  if (inferenceGeo && inferenceGeo !== "not_available") {
    accumulator.inferenceGeos.add(inferenceGeo);
  }
  const webSearch = asRecord(usage.server_tool_use).web_search_requests;
  if (
    typeof webSearch === "number" &&
    Number.isFinite(webSearch) &&
    webSearch > accumulator.webSearchRequests
  ) {
    accumulator.webSearchRequests = Math.trunc(webSearch);
  }
}

/**
 * Handle one content block of an assistant record. The three kinds are disjoint:
 * text accumulates into the turn's message, `tool_use` becomes a tool record,
 * and `thinking` is counted and emitted with its text REDACTED — reasoning is
 * never stored in plaintext.
 */
function processAssistantBlock(
  record: Record<string, unknown>,
  block: Record<string, unknown>,
  timestamp: string | null,
  model: string | null,
  textParts: string[],
  accumulator: SessionAccumulator,
  replayed: boolean
): void {
  if (block.type === "text" && typeof block.text === "string") {
    textParts.push(block.text);
    return;
  }
  if (block.type === "thinking") {
    // ISS-8659: the message itself is kept below — it is the fork's inherited
    // conversation — but the COUNT is the session's own reasoning effort.
    if (!replayed) {
      accumulator.thinkingBlockCount++;
    }
    accumulator.messages.push({
      role: "assistant",
      timestamp,
      text: null,
      model,
      isThinking: true,
      ...(replayed ? { isForkReplayed: true } : {}),
    });
    return;
  }
  if (block.type === "tool_use" && typeof block.name === "string") {
    recordToolUse(record, block, timestamp, accumulator, replayed);
  }
}

/** Build the tool record, run its per-tool handler, and index it by provider id. */
function recordToolUse(
  record: Record<string, unknown>,
  block: Record<string, unknown>,
  timestamp: string | null,
  accumulator: SessionAccumulator,
  replayed: boolean
): void {
  // ISS-8659: a replayed record's `isSidechain` marks a delegation the PARENT
  // made. Creating the row here would put an agent the fork never spawned into
  // its own roster — `buildSession` exports every accumulated subagent, and the
  // per-call attribution below is already skipped for replay, so the row would
  // arrive empty and unexplained. The corpus cannot catch this (no replayed
  // record in it is a sidechain), so the gate is the only thing holding it.
  const subagent = replayed
    ? null
    : ensureSidechainSubagent(record, timestamp, accumulator);
  const name = block.name as string;
  const input = block.input ?? null;
  const toolUse: NormalizedToolUse = {
    name,
    kind: classifyToolKind(name),
    timestamp: timestamp ?? accumulator.startedAt,
    input,
    subagentId: subagent?.id ?? null,
    // The branch checked out WHEN this tool ran, which is per-record and can
    // differ from the session's start branch after a mid-session checkout.
    gitBranch: stringValue(record.gitBranch),
    ...(accumulator.attributionEvidence ? requestKeyOf(record) : {}),
  };

  // ISS-6761: `input` is the raw `tool_use` block off the parsed `.jsonl` line —
  // nothing has normalized `content`/`old_string`/`edits` — so this lane is fed
  // exactly what the desktop sidecar lane is fed and applies the SAME payload
  // gate. Fail-open for any tool with no diffStats schema, so it only ever
  // withholds a diffStats handler from a payload that cannot yield a trustworthy
  // delta — and withholds it WHOLE, per ISS-5402: a partially corrupt `Edit`/
  // `MultiEdit` loses its well-formed lines here exactly as in the sidecar lane.
  //
  // ISS-8659: a REPLAYED tool use runs its handler for the STATE transition only.
  // Skipping it outright would be wrong in the opposite direction from counting
  // it: `readContentByPath` retains a file's last `Read`/`Write` body as the
  // baseline the NEXT diff is measured against, so a dropped replayed `Read`
  // leaves the path looking never-seen and the fork's own later `Write` counts
  // the whole file as additions. `applyDiffStatsToolUseState` is the existing
  // primitive for exactly this — real `readContentByPath`, throwaway totals.
  if (replayed) {
    applyDiffStatsToolUseState(accumulator, name, input);
  } else if (isUsableDiffStatsToolInput(name, input)) {
    TOOL_USE_HANDLERS.get(name)?.(accumulator, toolUse, input);
  }

  const providerId = stringValue(block.id);
  if (providerId) {
    accumulator.toolUseIdIndex.set(providerId, accumulator.toolUses.length);
    toolUse.id = providerId;
    toolUse.providerToolUseId = providerId;
  }
  accumulator.toolUses.push(toolUse);
  // ISS-8659: kept in `toolUses` and indexed above so its own replayed
  // `tool_result` still resolves to it rather than falling to the orphan path and
  // minting a phantom delegation; marked here and dropped once at the emit
  // boundary. It is deliberately NOT attached to the subagent row, which states
  // that agent's own work.
  if (replayed) {
    accumulator.forkReplayedToolUses.add(toolUse);
    return;
  }
  if (subagent) {
    subagent.toolUses = [...(subagent.toolUses ?? []), toolUse];
  }
}

/**
 * The sub-agent a sidechain record belongs to, created on first sight.
 *
 * A delegated turn is written into the PARENT transcript flagged `isSidechain`,
 * and the same work also lands in that agent's own sidecar file. The id is
 * normalized to the sidecar's `agent-<hex>` shape so the two representations
 * reconcile to one row rather than doubling.
 */
function ensureSidechainSubagent(
  record: Record<string, unknown>,
  timestamp: string | null,
  accumulator: SessionAccumulator
): NormalizedSubagent | null {
  if (record.isSidechain !== true) {
    return null;
  }
  const id = deriveSidechainSubagentId(record);
  if (!id) {
    return null;
  }
  const providerAgentId = stringValue(record.agentId);
  const attributionAgent = stringValue(record.attributionAgent);
  const existing = accumulator.subagents.get(id);
  if (existing) {
    // Identity is first-wins; the NAME is not. The record that first identifies
    // an agent frequently carries no `attributionAgent`, and a later one does —
    // returning the row untouched would leave it generically named for the whole
    // session. Fill only what is still empty, so the first real answer stands.
    if (attributionAgent && !existing.rawName) {
      existing.name = attributionAgent;
      existing.rawName = attributionAgent;
      existing.normalizedName = attributionAgent;
      existing.type = attributionAgent;
    }
    return existing;
  }
  // With no provider id the agent's id falls back to this record's own `uuid`,
  // so taking `parentUuid` as the parent would make an agent its own ancestor
  // whenever the two point at the same thread. Only a record that identified
  // itself by `uuid` can claim a parent at all.
  const parentId =
    providerAgentId === null && stringValue(record.uuid) !== null
      ? stringValue(record.parentUuid)
      : null;
  const subagent: NormalizedSubagent = {
    id,
    parentId,
    name: attributionAgent ?? `Claude subagent ${id.slice(0, 8)}`,
    ...(attributionAgent
      ? {
          rawName: attributionAgent,
          normalizedName: attributionAgent,
          type: attributionAgent,
        }
      : {}),
    startedAt: timestamp,
    endedAt: timestamp,
    status: "completed",
    nativeSubagentId:
      providerAgentId ?? normalizeSidechainSubagentId(id, providerAgentId),
    toolUses: [],
    // Carried through to the persisted `agents.metadata` column. No consumer
    // reads either key by name today, but they record which thread spawned this
    // agent and what the provider called it — the two facts the derived id
    // deliberately normalizes away — so dropping them in a refactor would be a
    // silent narrowing of a persisted payload rather than a decision.
    metadata: {
      parentUuid: stringValue(record.parentUuid),
      providerAgentId,
    },
  };
  accumulator.subagents.set(id, subagent);
  return subagent;
}

/**
 * Per-tool extraction, keyed on tool name. A tool absent from this map needs
 * nothing beyond the generic record built above.
 */
const TOOL_USE_HANDLERS = new Map<
  string,
  (
    accumulator: SessionAccumulator,
    toolUse: NormalizedToolUse,
    input: unknown
  ) => void
>([
  [
    "Skill",
    (_accumulator, toolUse, input) => {
      const skill = asRecord(input).skill;
      if (typeof skill === "string") {
        toolUse.skillName = skill;
      }
    },
  ],
  [
    // Registering the firing is what lets its later re-injection as a `user`
    // record be recognised as automated rather than typed. The tool record is
    // held by reference so a call that ERRORED — and therefore scheduled
    // nothing — can be excluded when the registration is consumed.
    "ScheduleWakeup",
    (accumulator, toolUse, input) => {
      const prompt = asRecord(input).prompt;
      if (typeof prompt === "string" && prompt.trim().length > 0) {
        recordScheduledPrompt(accumulator, prompt.trim(), toolUse);
      }
    },
  ],
  [
    // The structured, high-confidence plan signal: the text the model handed to
    // the plan-exit tool. It fires even outside a plan-mode session, which is
    // exactly the case where no plan file is written and this is the only record.
    "ExitPlanMode",
    (accumulator, toolUse, input) => {
      recordPlan(
        accumulator,
        "claude-exit-plan-mode",
        asRecord(input).plan,
        toolUse.timestamp
      );
    },
  ],
  ...DIFF_STATS_TOOL_HANDLERS,
]);

/**
 * Record a plan, deduped by its trimmed content.
 *
 * The same plan can arrive twice — once as the structured tool input and once
 * echoed into assistant prose — and it is one plan. Blank content is ignored.
 */
function recordPlan(
  accumulator: SessionAccumulator,
  source: string,
  content: unknown,
  timestamp: string | null
): void {
  const trimmed = typeof content === "string" ? content.trim() : "";
  if (!trimmed || accumulator.seenPlanContent.has(trimmed)) {
    return;
  }
  accumulator.seenPlanContent.add(trimmed);
  accumulator.plans.push({
    source,
    content: trimmed,
    timestamp: timestamp ?? accumulator.startedAt,
  });
}

/**
 * A plan the model presented as ordinary prose rather than through the tool.
 *
 * Deliberately strict, because mislabelling prose as a plan is worse than
 * missing one: it fires only when the text has BOTH a line that IS a plan
 * heading AND at least two enumerated phase or step markers. Prose that merely
 * mentions "the plan", or carries a single "Phase 1" aside, does not match.
 */
const PLAN_HEADING_RE =
  /^\s{0,3}(?:#{1,4}\s+)?(?:implementation\s+plan|plan)\s*(?:[:—–-].*)?$/im;
const PLAN_PHASE_RE = /^\s{0,3}(?:#{1,6}\s+)?(?:phase|step)\s+\d+\b/gim;

function inlinePlanText(text: string): string | null {
  if (!(text && PLAN_HEADING_RE.test(text))) {
    return null;
  }
  const phases = text.match(PLAN_PHASE_RE);
  return phases && phases.length >= 2 ? text.trim() : null;
}

/**
 * Which model id a session reports, from the records that are its own.
 *
 * First-wins, and never the synthetic placeholder: that marks a turn the harness
 * produced locally, which nobody was billed for.
 *
 * ISS-8659: and never a REPLAYED record. A fork's FIRST assistant record is the
 * parent's, so plain first-wins handed the child the parent's model id — the
 * same attribution defect as the `usageExtras` sets, but louder, because
 * `session.model` is what the Sessions list filters and summarises on. The
 * replayed id is retained rather than discarded, and `scanTranscriptLines`
 * applies it only when the fork reported none of its own; a fork that has not
 * answered yet still ran on the model its inherited conversation shows.
 */
function recordReportedModel(
  model: string | null,
  accumulator: SessionAccumulator,
  replayed: boolean
): void {
  if (!model || model === SYNTHETIC_MODEL) {
    return;
  }
  if (replayed) {
    accumulator.replayedModel ??= model;
    return;
  }
  accumulator.model ??= model;
}

/**
 * ISS-12552 (PRD-800): the request a tool call came from. Claude
 * writes one line per content block of a request, and the request's usage
 * identity lists every one of those line uuids, so the call's own line names
 * its request.
 */
function requestKeyOf(record: { uuid?: unknown }): { requestKey?: string } {
  const uuid = stringValue(record.uuid);
  return uuid
    ? { requestKey: requestKeyFor(claudeTranscriptEntryUuidScheme, uuid) }
    : {};
}
