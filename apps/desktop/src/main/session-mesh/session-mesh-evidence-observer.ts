import type { SessionMeshDeliveryEvidence } from "@repo/api/src/types/session-mesh-evidence";
import { SessionMeshEvidenceArm } from "@repo/api/src/types/session-mesh-evidence";
import { z } from "zod";
import {
  extractSessionMeshSubjects,
  sessionMeshObservedToolText,
} from "./session-mesh-send-message-relevance.js";

/**
 * Observes the recipient's tool stream around a delivery and produces the
 * evidence the usefulness proxies are computed from (ISS-11755, ISS-11761).
 *
 * The receipt confirmation gives an exact turn boundary at which the message
 * entered the model's context, so THE SESSION IS ITS OWN CONTROL: behavior
 * before that boundary is the counterfactual for behavior after it. No model
 * call, no prompt (operator ruling 2026-10-01).
 *
 * What is observable, and therefore the ceiling on what this can claim: the hook
 * carries `tool_name` and `tool_input` only — no assistant prose, no tool
 * results. Every proxy here is a claim about what the session DID.
 */
const MAX_TRACKED_AGENTS = 500;
const MAX_TRACKED_SUBJECTS = 40;
const MAX_HISTORY_TOKENS = 400;
const OBSERVATION_TTL_MS = 3_600_000;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/**
 * The fields {@link sessionMeshEvidenceSeeds} reads off one inbox delivery row.
 *
 * Narrower than `sessionMeshInboxResponseValidator` on purpose: `relevance` is
 * `z.unknown()` on the wire, so the shape this derivation depends on is declared
 * here and a row that does not carry it is skipped rather than coerced.
 */
const evidenceSeedSourceValidator = z.object({
  relevance: z
    .object({ pathOverlap: z.array(z.string()).catch([]) })
    .nullish()
    .catch(null),
  message: z.object({
    id: z.string().trim().min(1),
    paths: z.array(z.string()).catch([]),
    expiresAt: z.string().or(z.date()).nullish().catch(null),
  }),
});

type Tracked = {
  messageId: string;
  subject: string;
  placebo: string | null;
  arm: SessionMeshEvidenceArm;
  deliveredAt: number;
  deliveredTurn: number;
  claimExpiresAt: number | null;
  intentBeforeDelivery: boolean;
  subjectSeenBefore: boolean;
  placeboSeenBefore: boolean;
  /**
   * Whether the history this delivery's `seenBefore` reads were taken from was
   * still complete. False once MAX_HISTORY_TOKENS was hit: an absent token is
   * then "not recorded", not "never referenced", and adoption is unknowable.
   */
  historyComplete: boolean;
  subjectSeenAfter: boolean;
  placeboSeenAfter: boolean;
  editedDuringClaim: boolean;
  editedAfterClaim: boolean;
  inFlightEdit: string | null;
  /**
   * False once an edit on the subject arrived with no completion signal at all.
   * Abandonment is then UNKNOWABLE for this delivery rather than absent, and
   * `abandonedInFlight` reports `null` instead of a confident `false`.
   */
  completionObservable: boolean;
  convergenceTrips: number | null;
};

type AgentState = {
  /** Tokens this session has referenced, for the provenance test. */
  history: Set<string>;
  /**
   * False once a token was refused at the MAX_HISTORY_TOKENS cap. The cap stays
   * (unbounded growth is not an option), but a saturated history can no longer
   * answer "was this token referenced before", so the uncertainty is carried
   * rather than collapsed into a confident `false`.
   */
  historyComplete: boolean;
  turn: number;
  /**
   * The tool call the last observed event belonged to. A turn is a tool call,
   * not a hook event: where a harness delivers both a pre and a post event for
   * one `toolUseId`, counting events doubles every convergence measurement.
   * Desktop installs `PreToolUse` only (`SESSION_MESH_CLAUDE_HOOK_TYPES`, and
   * `removeObsoleteToolHooks` deletes any `PostToolUse` entry), so today the
   * pair does not arrive — this stays correct for a harness where it does.
   */
  lastToolUseId: string | null;
  tracked: Tracked[];
  updatedAt: number;
};

export class SessionMeshEvidenceObserver {
  private readonly now: () => number;
  private readonly agents = new Map<string, AgentState>();

  constructor(options: { now: () => number }) {
    this.now = options.now;
  }

  /** Every tool event, delivered or not — this is what builds the history. */
  observeTool(input: {
    agentKey: string;
    toolName: string;
    files: readonly string[];
    text: string;
    toolUseId?: string;
    /**
     * Whether the tool call COMPLETED, or `undefined` when the hook stream
     * cannot say. Desktop's installed matcher fires on `PreToolUse` only, so
     * production passes `undefined`: the edit is observed for convergence and
     * for the claim window, and abandonment — the one proxy that needs the
     * missing signal — reports `null` rather than a fabricated boolean.
     */
    completed?: boolean;
    workspaceRoot?: string;
  }): void {
    const state = this.state(input.agentKey);
    const sameCall =
      input.toolUseId !== undefined && input.toolUseId === state.lastToolUseId;
    if (!sameCall) {
      state.turn += 1;
    }
    state.lastToolUseId = input.toolUseId ?? null;
    const tokens = [
      ...input.files,
      ...extractSessionMeshSubjects(input.text, input.workspaceRoot).subjects,
    ];
    const isEdit = EDIT_TOOLS.has(input.toolName);
    for (const token of tokens) {
      this.applyToken(state, token, isEdit, input.completed);
      if (state.history.has(token)) {
        continue;
      }
      if (state.history.size < MAX_HISTORY_TOKENS) {
        state.history.add(token);
        continue;
      }
      state.historyComplete = false;
    }
  }

  /** Called when a receipt confirms the context reached the model. */
  recordDelivery(input: {
    agentKey: string;
    messageId: string;
    subject: string;
    placebo?: string | null;
    arm: SessionMeshEvidenceArm;
    claimExpiresAt?: number | null;
    /**
     * Demonstrated intent, from the SERVER's `relevance.pathOverlap` — the
     * intersection of the publisher's paths with the recipient presence's own
     * declared paths, computed at publish time and already persisted on every
     * delivery row.
     *
     * NOT derived from this observer's history, deliberately. The hook matcher
     * is `^(?:Edit|Write|MultiEdit|SendMessage)$`, so the tool stream cannot see
     * a Read — and reading a file is how intent is usually expressed before
     * editing it. Deriving intent here would under-detect it, push most
     * deliveries into `unknown`, and compute the avoidance rate over a small
     * biased subset. Widening the matcher instead would put a subprocess on the
     * hot path of every tool call, which is the cost the engagement module
     * already refused to pay.
     */
    intentBeforeDelivery: boolean;
  }): void {
    const state = this.state(input.agentKey);
    if (state.tracked.some((item) => item.messageId === input.messageId)) {
      return;
    }
    state.tracked.push({
      messageId: input.messageId,
      subject: input.subject,
      placebo: input.placebo ?? null,
      arm: input.arm,
      deliveredAt: this.now(),
      deliveredTurn: state.turn,
      claimExpiresAt: input.claimExpiresAt ?? null,
      intentBeforeDelivery: input.intentBeforeDelivery,
      // Adoption still reads local history, and must be read NOW: a token first
      // seen after this moment is adopted, and reading it later would let
      // post-delivery work vote for its own cause.
      subjectSeenBefore: state.history.has(input.subject),
      placeboSeenBefore: input.placebo
        ? state.history.has(input.placebo)
        : false,
      historyComplete: state.historyComplete,
      subjectSeenAfter: false,
      placeboSeenAfter: false,
      editedDuringClaim: false,
      editedAfterClaim: false,
      inFlightEdit: null,
      completionObservable: true,
      convergenceTrips: null,
    });
    state.tracked = state.tracked.slice(-MAX_TRACKED_SUBJECTS);
  }

  /** The evidence for one agent's tracked deliveries, oldest first. */
  evidence(agentKey: string): SessionMeshDeliveryEvidence[] {
    return this.prune(agentKey).map((item) => ({
      messageId: item.messageId,
      arm: item.arm,
      subject: item.subject,
      intentBeforeDelivery: item.intentBeforeDelivery,
      editedDuringClaim: item.editedDuringClaim,
      editedAfterClaim: item.editedAfterClaim,
      // Adoption requires the token to have been UNREACHABLE before: seen after,
      // never seen before. Seen-before-and-after is ordinary continued work.
      subjectAdopted: adopted(
        item,
        item.subjectSeenBefore,
        item.subjectSeenAfter
      ),
      abandonedInFlight: abandoned(item),
      convergenceTrips: item.convergenceTrips,
      placeboAdopted: adopted(
        item,
        item.placeboSeenBefore,
        item.placeboSeenAfter
      ),
    }));
  }

  clear(): void {
    this.agents.clear();
  }

  private applyToken(
    state: AgentState,
    token: string,
    isEdit: boolean,
    completed: boolean | undefined
  ): void {
    for (const item of state.tracked) {
      if (state.turn <= item.deliveredTurn) {
        continue;
      }
      if (token === item.placebo) {
        item.placeboSeenAfter = true;
      }
      if (token !== item.subject) {
        continue;
      }
      item.subjectSeenAfter = true;
      if (!isEdit) {
        continue;
      }
      this.applyEdit(state, item, completed);
    }
  }

  private applyEdit(
    state: AgentState,
    item: Tracked,
    completed: boolean | undefined
  ): void {
    if (completed === false) {
      // An edit announced and OBSERVED not to complete is the abandonment
      // signal. `undefined` is not that: it is no observation at all.
      item.inFlightEdit = item.subject;
      return;
    }
    item.inFlightEdit = null;
    item.completionObservable = completed === true;
    if (item.convergenceTrips === null) {
      item.convergenceTrips = state.turn - item.deliveredTurn;
    }
    const live =
      item.claimExpiresAt === null || this.now() <= item.claimExpiresAt;
    if (live) {
      item.editedDuringClaim = true;
      return;
    }
    item.editedAfterClaim = true;
  }

  private state(agentKey: string): AgentState {
    const existing = this.agents.get(agentKey);
    if (existing) {
      existing.updatedAt = this.now();
      return existing;
    }
    const created: AgentState = {
      history: new Set<string>(),
      historyComplete: true,
      turn: 0,
      lastToolUseId: null,
      tracked: [],
      updatedAt: this.now(),
    };
    this.agents.set(agentKey, created);
    while (this.agents.size > MAX_TRACKED_AGENTS) {
      const oldest = this.agents.keys().next().value;
      if (oldest === undefined || oldest === agentKey) {
        break;
      }
      this.agents.delete(oldest);
    }
    return created;
  }

  private prune(agentKey: string): Tracked[] {
    const state = this.agents.get(agentKey);
    if (!state) {
      return [];
    }
    const cutoff = this.now() - OBSERVATION_TTL_MS;
    state.tracked = state.tracked.filter((item) => item.deliveredAt >= cutoff);
    return state.tracked;
  }
}

/**
 * Whether the message's subject was ADOPTED, or `null` when that cannot be
 * known.
 *
 * `null` only where the answer is genuinely absent: the token was not in history
 * AND the history had saturated, so "never referenced before" was never
 * established. Reporting `true` there credited the message for a file the
 * session had already been working on; reporting `false` would claim a measured
 * absence of adoption. Both halves that ARE decidable stay decided — a token
 * seen before is not adoption, and a token never seen after is not adoption,
 * whatever the history's state.
 */
function adopted(
  item: Tracked,
  seenBefore: boolean,
  seenAfter: boolean
): boolean | null {
  if (seenBefore || !seenAfter) {
    return false;
  }
  return item.historyComplete ? true : null;
}

/**
 * Whether an edit on the subject was abandoned in flight, or `null` when that
 * cannot be known.
 *
 * `null` only where the answer is genuinely absent: an edit on the subject was
 * observed with no completion signal, so "never completed" was never
 * established. `false` stays decided wherever it is decidable — no edit was
 * announced at all, or one was and its completion was observed.
 */
function abandoned(item: Tracked): boolean | null {
  if (item.inFlightEdit !== null) {
    return true;
  }
  return item.completionObservable ? false : null;
}

/**
 * The observer's per-agent key, scoped by account source.
 *
 * Both call sites compose it through this one function: a receipt confirmed for
 * one account must never attach its evidence to the observations of another.
 */
export function sessionMeshEvidenceAgentKey(
  sourceKey: string,
  agentId: string
): string {
  return `${sourceKey}:${agentId}`;
}

/**
 * Feed one native hook event into the evidence observer.
 *
 * Mirrors {@link recordSessionMeshEngagement}: the runtime hands over the raw
 * event fields and keeps the decisions. `completed` is deliberately omitted —
 * Desktop installs `PreToolUse` only, so the stream announces an edit and never
 * reports its outcome, and {@link SessionMeshEvidenceObserver.observeTool}
 * carries that as unknown rather than as a boolean nobody measured.
 */
export function recordSessionMeshEvidence(
  observer: SessionMeshEvidenceObserver,
  input: {
    sourceKey: string;
    agentId: string;
    toolName: unknown;
    toolInput: unknown;
    files: readonly string[];
    /** The git toplevel; see {@link SessionMeshEvidenceObserver.observeTool}. */
    workspaceRoot?: string;
  }
): void {
  observer.observeTool({
    agentKey: sessionMeshEvidenceAgentKey(input.sourceKey, input.agentId),
    toolName: typeof input.toolName === "string" ? input.toolName : "",
    files: input.files,
    text: sessionMeshObservedToolText(input.toolName, input.toolInput),
    workspaceRoot: input.workspaceRoot,
  });
}

/**
 * The per-message evidence a delivery carries, captured at the moment the
 * context is handed to the hook.
 *
 * Captured there and persisted on the receipt because the receipt is what
 * confirms the context reached the model, and by then the inbox rows — and the
 * server's relevance verdict on them — are gone.
 */
export type SessionMeshEvidenceSeed = {
  /** The overlapping repository path this evidence is about. */
  subject: string;
  /** A path in the recipient's own workspace that the message did NOT name. */
  placebo: string | null;
  intentBeforeDelivery: boolean;
  claimExpiresAt: number | null;
};

/**
 * Derive the evidence seeds for the messages about to be delivered, keyed by
 * message id.
 *
 * A message with no repository path named anywhere is omitted: there is no
 * subject for the proxies to be about, and recording one would make every later
 * tool use look like evidence for it.
 */
export function sessionMeshEvidenceSeeds(
  deliveries: readonly unknown[],
  workspacePaths: readonly string[]
): Record<string, SessionMeshEvidenceSeed> {
  const seeds: Record<string, SessionMeshEvidenceSeed> = Object.create(null);
  for (const delivery of deliveries) {
    const parsed = evidenceSeedSourceValidator.safeParse(delivery);
    if (!parsed.success) {
      continue;
    }
    const { relevance, message } = parsed.data;
    const overlap = relevance?.pathOverlap ?? [];
    const named = [...new Set([...overlap, ...message.paths])];
    const subject = named[0];
    if (!subject) {
      continue;
    }
    seeds[message.id] = {
      subject,
      // The control must be reachable for THIS session, so it is drawn from the
      // recipient's own declared paths rather than invented.
      placebo: workspacePaths.find((path) => !named.includes(path)) ?? null,
      // The server's own verdict, never inferred from the tool stream — see
      // `SessionMeshEvidenceObserver.recordDelivery`.
      intentBeforeDelivery: overlap.length > 0,
      claimExpiresAt: claimWindowFrom(message.expiresAt),
    };
  }
  return seeds;
}

/**
 * The per-message `recordDelivery` calls a confirmed receipt owes the observer.
 *
 * The arm is always `delivered`: a receipt is the hook's own confirmation that
 * the context was flushed to the model. The `withheld` control is a held,
 * refused or dismissed delivery, which never reaches a hook and so is counted
 * server-side from the delivery row's own status.
 */
export function recordSessionMeshDeliveredEvidence(
  observer: SessionMeshEvidenceObserver,
  input: {
    sourceKey: string;
    agentId: string;
    messageIds: readonly string[];
    seeds: Record<string, SessionMeshEvidenceSeed> | undefined;
  }
): void {
  const agentKey = sessionMeshEvidenceAgentKey(input.sourceKey, input.agentId);
  for (const messageId of input.messageIds) {
    const seed = input.seeds?.[messageId];
    if (!seed) {
      // A receipt minted by a build that predates this field, or a message that
      // named no path. Recording it with a fabricated subject would attribute
      // the session's next edit to a delivery that never named it.
      continue;
    }
    observer.recordDelivery({
      agentKey,
      messageId,
      subject: seed.subject,
      placebo: seed.placebo,
      arm: SessionMeshEvidenceArm.Delivered,
      claimExpiresAt: seed.claimExpiresAt,
      intentBeforeDelivery: seed.intentBeforeDelivery,
    });
  }
}

/** Epoch ms of a wire timestamp, or `null` when it cannot be read as one. */
function claimWindowFrom(
  value: string | Date | null | undefined
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const at = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(at) ? at : null;
}
