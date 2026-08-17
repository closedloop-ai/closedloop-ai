import type {
  NormalizedApiError,
  NormalizedHookUse,
  NormalizedMessage,
  NormalizedPlan,
  NormalizedPrRef,
  NormalizedSlashCommand,
  NormalizedSubagent,
  NormalizedToolResultError,
  NormalizedToolUse,
  NormalizedTurnDuration,
} from "../types";
import type { ClaudeDelegation } from "./parse-claude-delegations";
import type { ScheduledPromptRegistration } from "./prompt-injection";

export const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Every `type` the transcript schema defines. A const object rather than a TS
 * `enum` — Biome forbids those — so the values stay plain strings at runtime
 * while the switch below reads as a closed set instead of loose literals.
 */
export const ClaudeRecordType = {
  Assistant: "assistant",
  User: "user",
  Attachment: "attachment",
  AiTitle: "ai-title",
  LastPrompt: "last-prompt",
  Mode: "mode",
  PermissionMode: "permission-mode",
  PrLink: "pr-link",
  FileHistorySnapshot: "file-history-snapshot",
  System: "system",
  QueueOperation: "queue-operation",
} as const;
export type ClaudeRecordType =
  (typeof ClaudeRecordType)[keyof typeof ClaudeRecordType];

/** Stands in for a record carrying no `type` at all, so it tallies separately. */
export const ABSENT_RECORD_TYPE = "(absent)";

/** Failed tool-result text is a diagnostic, not a payload — store a prefix. */
export const TOOL_RESULT_ERROR_MAX_CHARS = 500;

/** Same for an API error message. */
export const API_ERROR_MAX_CHARS = 500;

/**
 * THESE SETS ARE A DRIFT DETECTOR, NOT A TO-DO LIST.
 *
 * They record every attribute the harness is KNOWN to emit — whether this parser
 * consumes it, deliberately ignores it, or has not decoded it yet. Against a
 * corpus of current transcripts the attribute report is therefore silent, and
 * the first thing it says is that the harness started sending something new.
 *
 * So: adding an attribute here is an assertion that we have SEEN it, not that we
 * handle it. What is still undecoded is tracked by the failing suites, not here.
 * When the report names an attribute, decide what it means and then add it.
 */

/** Envelope attributes that can ride on any record, whatever its type. */

export type ParseSessionLogger = (message: string) => void;

/**
 * The session-level metadata gathered across the scan. Every field here is
 * FIRST-WINS except the timestamp bounds, which widen, and `modelSwitchLabel`,
 * which is last-wins.
 */
export type SessionAccumulator = {
  cwd: string | null;
  version: string | null;
  slug: string | null;
  gitBranch: string | null;
  entrypoint: string | null;
  permissionMode: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** The API model id an assistant record reported — a real, priceable wire id. */
  model: string | null;
  /**
   * The human-readable model NAME echoed by a `/model` command, last-wins. A
   * DISPLAY name, never a priceable id, so it must not become a token key. It
   * stands in for `model` only when no assistant record supplied a real one.
   */
  modelSwitchLabel: string | null;
  /**
   * The harness-generated session title, last-wins. The harness may emit several
   * across a session as it refines the label, and the newest is the one a user
   * recognises. Display-only: session identity stays keyed on the file's id.
   */
  aiTitle: string | null;
  /** Turns a human actually submitted — see `processUserRecord`. */
  userMessageCount: number;
  readonly messages: NormalizedMessage[];
  readonly slashCommands: NormalizedSlashCommand[];
  /** Invoking turn id -> its command's index, so a later definition finds it. */
  readonly slashCommandIndexByTurnId: Map<string, number>;
  readonly toolResultErrors: NormalizedToolResultError[];
  /**
   * ScheduleWakeup firings awaiting their re-injection as a `user` record.
   * Populated from assistant tool_use records, which this step does not decode
   * yet, so it is empty for now — an empty registry makes the injection check
   * fall through to its text-only rules, which is correct, just incomplete.
   */
  readonly scheduledPrompts: ScheduledPromptRegistration[];
  /** Assistant reasoning blocks, counted but never stored in plaintext. */
  thinkingBlockCount: number;
  readonly toolUses: NormalizedToolUse[];
  /** Provider `tool_use` id → its index in `toolUses`, so a later result finds it. */
  readonly toolUseIdIndex: Map<string, number>;
  /** Sub-agents seen INLINE in this transcript, keyed on their normalized id. */
  readonly subagents: Map<string, NormalizedSubagent>;
  // The diff-stats accumulator the shared Edit/Write/MultiEdit handlers mutate.
  // `readContentByPath` retains a file's last Read body so a later Write of the
  // same path diffs against it instead of counting the whole file as additions.
  totalAdded: number;
  totalRemoved: number;
  readonly diffFiles: Set<string>;
  readonly readContentByPath: Map<string, string>;
  /**
   * Assistant records carrying usage, held for the dedup pass at finalize.
   *
   * One API turn is written across MANY records that share a `message.id` and
   * repeat the same usage snapshot, so summing per record inflates a session
   * several-fold. Deduping needs the whole set, which is why this is collected
   * rather than accumulated in place.
   */
  readonly assistantUsageRecords: Array<{
    entry: Record<string, unknown>;
    iso: string | null;
  }>;
  /**
   * Why each delegated agent was spawned, gathered from wherever it was stated.
   *
   * No single record carries the whole answer: the spawning tool call holds the
   * prompt but names no child, the answering result names the child but is
   * terse, and the agent's own meta file is a direct link that does not always
   * carry the call id. They are collected here and reconciled at the end.
   */
  readonly turnDurations: NormalizedTurnDuration[];
  readonly apiErrors: NormalizedApiError[];
  readonly compactions: Array<{
    uuid: string | null;
    timestamp: string | null;
  }>;
  readonly hooks: NormalizedHookUse[];
  /** Hook firings already recorded, so a replayed record does not double-count. */
  readonly seenHooks: Set<string>;
  readonly prLinks: NormalizedPrRef[];
  readonly seenPrLinks: Set<string>;
  readonly plans: NormalizedPlan[];
  /** Plan bodies already recorded, deduped by content across the two sources. */
  readonly seenPlanContent: Set<string>;
  readonly delegations: ClaudeDelegation[];
  /** Every team name the transcript's records were stamped with. */
  readonly teams: Set<string>;
  readonly serviceTiers: Set<string>;
  readonly speeds: Set<string>;
  readonly inferenceGeos: Set<string>;
  /**
   * Highest `web_search_requests` seen. The provider reports it CUMULATIVELY
   * across a session's turns, so the maximum is the session total — summing the
   * per-turn snapshots would count every earlier search again.
   */
  webSearchRequests: number;
  /**
   * Whether to retain drift diagnostics at all.
   *
   * The keys below are TRANSCRIPT-CONTROLLED, so retaining them is proportional
   * to the input rather than to the schema: a file with a unique `type` per line
   * makes a streaming parse hold one map entry per line. A caller with nowhere
   * to report to must therefore pay nothing, not merely ignore the result —
   * `parseClaudeTranscript` derives this from whether it was given a logger, and
   * the cloud renderer deliberately has none.
   */
  readonly collectDiagnostics: boolean;
  /**
   * Parse diagnostics rather than session data: how many records of each
   * undecoded `type` this transcript carried, reported once when the scan ends.
   * Bounded — see the caps in `parse-claude-drift.ts`.
   */
  readonly unknownRecordTypes: Map<string, number>;
  /**
   * Also diagnostics: per record type, the attribute names nothing consumes yet.
   * A set, not a count — the question is WHICH attributes are on the floor, and
   * the answer is the same for every record of that kind.
   */
  readonly unknownAttributes: Map<string, Set<string>>;
  /**
   * Occurrences a cap refused, so the report can say it is incomplete. Counts
   * REFUSALS rather than distinct names — knowing how many distinct names were
   * turned away would mean retaining them, which is the cost the cap exists to
   * avoid.
   */
  droppedUnknownTypes: number;
  droppedUnknownAttributes: number;
};
/**
 * A fresh accumulator with every field unset.
 *
 * `collectDiagnostics` defaults to OFF: the drift maps are keyed on
 * transcript-controlled strings, so retaining them without a reporter is unbounded
 * cost for no signal. A caller that will pass a logger to `reportUnknownRecords`
 * has to opt in here; forgetting yields a silent report rather than a leak, which
 * is the direction that fails safe.
 */
export function createSessionAccumulator(
  options: { collectDiagnostics?: boolean } = {}
): SessionAccumulator {
  return {
    cwd: null,
    version: null,
    slug: null,
    gitBranch: null,
    entrypoint: null,
    permissionMode: null,
    startedAt: null,
    endedAt: null,
    model: null,
    modelSwitchLabel: null,
    aiTitle: null,
    userMessageCount: 0,
    messages: [],
    slashCommands: [],
    slashCommandIndexByTurnId: new Map<string, number>(),
    toolResultErrors: [],
    scheduledPrompts: [],
    thinkingBlockCount: 0,
    toolUses: [],
    toolUseIdIndex: new Map<string, number>(),
    subagents: new Map<string, NormalizedSubagent>(),
    totalAdded: 0,
    totalRemoved: 0,
    diffFiles: new Set<string>(),
    readContentByPath: new Map<string, string>(),
    assistantUsageRecords: [],
    turnDurations: [],
    apiErrors: [],
    compactions: [],
    hooks: [],
    seenHooks: new Set<string>(),
    prLinks: [],
    seenPrLinks: new Set<string>(),
    plans: [],
    seenPlanContent: new Set<string>(),
    delegations: [],
    teams: new Set<string>(),
    serviceTiers: new Set<string>(),
    speeds: new Set<string>(),
    inferenceGeos: new Set<string>(),
    webSearchRequests: 0,
    collectDiagnostics: options.collectDiagnostics ?? false,
    unknownRecordTypes: new Map<string, number>(),
    unknownAttributes: new Map<string, Set<string>>(),
    droppedUnknownTypes: 0,
    droppedUnknownAttributes: 0,
  };
}
