import type {
  NormalizedApiError,
  NormalizedCompaction,
  NormalizedHookUse,
  NormalizedMessage,
  NormalizedPlan,
  NormalizedPrRef,
  NormalizedSlashCommand,
  NormalizedSubagent,
  NormalizedToolResultError,
  NormalizedToolUse,
  NormalizedTurnDuration,
  NormalizedWorktreeEntry,
} from "../types";
import type { ClaudeLineageReplay } from "./fork-replay";
import type { ClaudeDelegation } from "./parse-claude-delegations";
import type { ScheduledPromptRegistration } from "./prompt-injection";

export const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Every `type` this parser recognises. A const object rather than a TS `enum` —
 * Biome forbids those — so the values stay plain strings at runtime while the
 * dispatch switch reads as a closed set instead of loose literals.
 *
 * Not a claim to be the transcript schema's whole enum: what the harness emits
 * beyond this list is exactly what the drift detector exists to report.
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
  WorktreeState: "worktree-state",
  // ISS-7258: seen across the live corpus and consumed by nothing. Listed here
  // so the drift report stops naming them; their dispatch is a deliberate no-op
  // — see the grouped cases in `processRecord`.
  Relocated: "relocated",
  AgentSetting: "agent-setting",
  AgentName: "agent-name",
  CustomTitle: "custom-title",
  FileHistoryDelta: "file-history-delta",
  AtisLatch: "atis-latch",
  BridgeSession: "bridge-session",
  FrameLink: "frame-link",
  ArtifactCommentMonitor: "artifact-comment-monitor",
  ArtifactAutoreactLedger: "artifact-autoreact-ledger",
} as const;
export type ClaudeRecordType =
  (typeof ClaudeRecordType)[keyof typeof ClaudeRecordType];

/**
 * Stands in for a field the record does not state — a record with no `type`, a
 * `queued_command` with no readable `commandMode` — so the absence tallies
 * under a name of its own instead of going unreported.
 */
export const ABSENT_FIELD_VALUE = "(absent)";

/** Failed tool-result text is a diagnostic, not a payload — store a prefix. */
export const TOOL_RESULT_ERROR_MAX_CHARS = 500;

/** Same for an API error message. */
export const API_ERROR_MAX_CHARS = 500;

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
  /**
   * ISS-8659: the span of the fork-REPLAYED records, kept apart from the span
   * above so it can never widen it.
   *
   * It exists only as a last resort. `!startedAt` is the parser's "this file
   * carries no usable timestamp anywhere, so it is not a session" test, and the
   * desktop shell additionally reports that case as an INGEST FAILURE. Gating
   * the widening on `replayed` made those two things stop meaning the same
   * thing: a `/fork` child observed before its own first record lands — forked
   * and abandoned, or picked up by the watcher between the replay being written
   * and the user typing — has hundreds of perfectly readable timestamps and
   * would be dropped from ingest AND counted as malformed. Falling back to this
   * span keeps such a session importable. It cannot re-inflate anything: a fork
   * with even one own record never reads these fields.
   */
  replayedStartedAt: string | null;
  replayedEndedAt: string | null;
  /**
   * ISS-8659: the same fallback shape as the span above, for the same reason.
   * `model` is first-wins, and a fork's FIRST assistant record is a replayed
   * one, so an ungated assignment reports the PARENT's model as the child's —
   * wrong wherever `session.model` is read as this session's own, which is the
   * Sessions filter and summary. Gating it alone would leave a fork that has
   * not answered yet with no model at all, so the replayed id is kept here and
   * applied only when the fork contributed none of its own.
   */
  replayedModel: string | null;
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
   *
   * ISS-6576: this used to say the registry was empty because assistant
   * tool_use records were not decoded yet. They are — `ScheduleWakeup`'s
   * handler in `parse-claude-assistant.ts` calls `recordScheduledPrompt`, and
   * `processUserRecord` consumes a registration to mark the re-injected turn
   * automated rather than typed.
   */
  readonly scheduledPrompts: ScheduledPromptRegistration[];
  /** Assistant reasoning blocks, counted but never stored in plaintext. */
  thinkingBlockCount: number;
  readonly toolUses: NormalizedToolUse[];
  /**
   * ISS-8659: the subset of `toolUses` replayed out of a forked session's
   * parent, held by object identity.
   *
   * They stay IN `toolUses` on purpose. `toolUseIdIndex` stores an index into
   * that array, and `applyToolResult` resolves a `tool_result` through it —
   * dropping a replayed CALL while its replayed RESULT still arrives would send
   * every one of them down the orphan path and mint a phantom delegation. So the
   * call is kept and indexed, marked here, and excluded once at the emit
   * boundary (`buildSession`). Identity rather than id because a tool call
   * carrying no provider id must be excludable too.
   */
  readonly forkReplayedToolUses: Set<NormalizedToolUse>;
  /**
   * ISS-8659: the parent session a fork was branched from, first-wins.
   *
   * Read from the `forkedFrom` stamp, which only a REPLAYED record carries — so
   * this is captured outside the replay gate on purpose. Null for a root
   * session, which is what keeps the emitted field absent there.
   */
  forkParentSessionId: string | null;
  /** ISS-12552: a headless fork's copied entries, supplied by the caller. */
  readonly lineageReplay: ClaudeLineageReplay | null;
  /**
   * ISS-12552 (PRD-800 "Rollout"): record the attribution evidence (each
   * call's request key and its result facts). Off, the parse is the one before
   * PRD-800.
   */
  readonly attributionEvidence: boolean;
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
  readonly compactions: NormalizedCompaction[];
  readonly hooks: NormalizedHookUse[];
  /** Hook firings already recorded, so a replayed record does not double-count. */
  readonly seenHooks: Set<string>;
  readonly prLinks: NormalizedPrRef[];
  readonly seenPrLinks: Set<string>;
  /**
   * ISS-7970: `pr-link` records whose `prNumber` was present as a number but is
   * not a PR identity (fractional, non-positive, non-finite, or past the
   * persisted Int range). The link is omitted rather than minted as a phantom
   * `#1.5` ref, and this counts the omission so a corrupt producer is
   * distinguishable from a session that simply opened no PR.
   */
  malformedPrLinkNumbers: number;
  readonly plans: NormalizedPlan[];
  /** Plan bodies already recorded, deduped by content across the two sources. */
  readonly seenPlanContent: Set<string>;
  readonly delegations: ClaudeDelegation[];
  /** Every team name the transcript's records were stamped with. */
  readonly teams: Set<string>;
  readonly serviceTiers: Set<string>;
  readonly speeds: Set<string>;
  readonly inferenceGeos: Set<string>;
  /** ISS-7258: distinct reasoning-effort tiers the assistant turns ran at. */
  readonly efforts: Set<string>;
  /**
   * ISS-7258: distinct worktree entries, keyed by their own content.
   *
   * The harness rewrites the whole `worktree-state` record on every change — one
   * session holds 652 copies — so the raw record count is not the entry count.
   * A Map keyed on the serialized entry is what makes "distinct" mean distinct.
   */
  readonly worktreeEntries: Map<string, NormalizedWorktreeEntry>;
  /** ISS-7258: `"bg"` for a background session; first-wins, absent when unstated. */
  sessionKind: string | null;
  /**
   * ISS-7258: `compactMetadata` scalars keyed by the compaction marker they
   * describe.
   *
   * They arrive on a SEPARATE record from the marker — a `system` /
   * `compact_boundary` whose own `isCompactSummary` is false — and the two are
   * joined by `preservedSegment.anchorUuid`, exact on 173 of 173 across the
   * live corpus. Collected here and reconciled at build time because the
   * boundary can precede or follow its marker in the transcript.
   */
  readonly compactMetadataByAnchor: Map<string, Partial<NormalizedCompaction>>;
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
  /**
   * ISS-6738 (whitlockk): records whose `timestamp` carried a NON-EMPTY value that no
   * `Date` could read — counted apart from a record that simply has none.
   *
   * The distinction is load-bearing. A transcript with no usable timestamp
   * anywhere is dropped outright (`if (!accumulator.startedAt) return null`), the
   * pass then reports zero sessions, the catchup cache marks the file seen, and
   * the orphan self-heal readmits it because no session row exists — forever, and
   * silently. Before ISS-6738 the Claude normalizer echoed unparseable text back,
   * so `startedAt` was truthy and the session survived; collapsing to one
   * normalizer routes that input into the drop for the first time. Counting it is
   * what lets the parse report say so instead of looking like an empty file.
   */
  unreadableTimestamps: number;
  /**
   * ISS-6576: refusals PER RECORD TYPE. A single session-wide counter made the
   * report append the overflow suffix to every type's line, so a type that
   * dropped nothing read as truncated.
   */
  readonly droppedUnknownAttributes: Map<string, number>;
  /**
   * ISS-7259: the first `attributionSkill` an assistant record carried, and every
   * distinct one after it — counting only names short enough for the facet to
   * record, so the set's size can never claim a skill the facet cannot name.
   *
   * Both are kept because they answer different questions. The FIRST is the
   * launch attribution — the earliest skill the harness attributed a turn to.
   * The SET's size says whether that first value is the whole story: a session
   * can invoke several skills, and reporting only the first would let a consumer
   * read "launched by X" where the truth is "X, then two others".
   */
  firstAttributionSkill: string | null;
  readonly attributionSkills: Set<string>;
  /**
   * ISS-7508: the 1-based ordinal of the record `firstAttributionSkill` was taken
   * from, written by the SAME statement that sets it so the two cannot disagree
   * about which record was recorded — an over-long skill is skipped there, and
   * an index pointing at the skipped record would name a skill the facet refuses
   * to carry.
   */
  firstAttributionSkillRecordIndex: number | null;
  /**
   * ISS-7508: how many records the session-attribute pass has visited, which is
   * both the denominator for the index above and the source of the index itself.
   * Incremented once per record BEFORE anything reads it, so the ordinal a record
   * is assigned is its own and `index <= count` holds by construction rather than
   * by two counters agreeing.
   */
  observedRecordCount: number;
  /** ISS-7259: `promptSource` of the first user turn that stated one. */
  firstPromptSource: string | null;
};
/**
 * A fresh accumulator with every field unset.
 *
 * ISS-6576: `collectDiagnostics` is REQUIRED, not defaulted. A drift test
 * written without it used to assert silence against a collector that never ran
 * — green for the wrong reason. Making it explicit means `tsc` catches the
 * omission instead. It is normally OFF: the drift maps are keyed on
 * transcript-controlled strings, so retaining them without a reporter is unbounded
 * cost for no signal. A caller that will pass a logger to `reportUnknownRecords`
 * has to opt in here; forgetting yields a silent report rather than a leak, which
 * is the direction that fails safe.
 */
export function createSessionAccumulator(options: {
  collectDiagnostics: boolean;
  lineageReplay?: ClaudeLineageReplay;
  attributionEvidence?: boolean;
}): SessionAccumulator {
  return {
    lineageReplay: options.lineageReplay ?? null,
    attributionEvidence: options.attributionEvidence ?? true,
    cwd: null,
    version: null,
    slug: null,
    gitBranch: null,
    entrypoint: null,
    permissionMode: null,
    startedAt: null,
    endedAt: null,
    replayedStartedAt: null,
    replayedEndedAt: null,
    replayedModel: null,
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
    forkReplayedToolUses: new Set<NormalizedToolUse>(),
    forkParentSessionId: null,
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
    malformedPrLinkNumbers: 0,
    plans: [],
    seenPlanContent: new Set<string>(),
    delegations: [],
    teams: new Set<string>(),
    serviceTiers: new Set<string>(),
    speeds: new Set<string>(),
    inferenceGeos: new Set<string>(),
    efforts: new Set<string>(),
    compactMetadataByAnchor: new Map<string, Partial<NormalizedCompaction>>(),
    worktreeEntries: new Map<string, NormalizedWorktreeEntry>(),
    sessionKind: null,
    webSearchRequests: 0,
    collectDiagnostics: options.collectDiagnostics,
    unknownRecordTypes: new Map<string, number>(),
    unknownAttributes: new Map<string, Set<string>>(),
    droppedUnknownTypes: 0,
    unreadableTimestamps: 0,
    droppedUnknownAttributes: new Map<string, number>(),
    firstAttributionSkill: null,
    attributionSkills: new Set<string>(),
    firstAttributionSkillRecordIndex: null,
    observedRecordCount: 0,
    firstPromptSource: null,
  };
}
