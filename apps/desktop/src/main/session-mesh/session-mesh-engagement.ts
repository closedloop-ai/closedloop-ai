import {
  extractSessionMeshSubjects,
  sessionMeshObservedToolText,
} from "./session-mesh-send-message-relevance.js";

/**
 * Engagement: whether a session that was DELIVERED a Mesh message then worked in
 * that message's subject area (ISS-11435).
 *
 * This is the missing middle of the Mesh's value signal, and the whole point is
 * that it needs NO judgment and NO model call. Delivery is already measured
 * (`ContextDelivered`); value is a voluntary `feedback` call that in practice
 * never happens; so today an ignored delivery and a useful one both record the
 * same nothing. Engagement is observable from the tool stream Desktop already
 * receives, so `delivered, not engaged` becomes a recorded fact instead of
 * silence — and `engaged` is what earns the ONE value prompt.
 *
 * WHAT IS OBSERVED, exactly: the tool events the Mesh hook is installed for —
 * `Edit`/`Write`/`MultiEdit` (their file paths) and `SendMessage` (the paths and
 * ticket slugs it names). Read/Grep/Bash are NOT observed, deliberately: the
 * hook spawns a process per matched call, so admitting every read would put a
 * subprocess on the hot path of every tool use to widen a metric. Engagement is
 * therefore a LOWER BOUND on work in the subject area, never an upper one, and
 * the reporting side says so rather than presenting it as complete.
 */
const MAX_TRACKED_AGENTS = 500;
const MAX_TRACKED_MESSAGES = 20;
const ENGAGEMENT_TTL_MS = 3_600_000;
const WINDOWS_SEPARATOR = /\\/g;

export type SessionMeshEngagementPrompt = {
  messageId: string;
  subject: string;
  evidence: string;
};

type Tracked = {
  sourceKey: string;
  messageId: string;
  subjects: string[];
  deliveredAt: number;
  engagedWith: string | null;
  engagedSubject: string | null;
  prompted: boolean;
};

/**
 * Per-agent delivery subjects, the engagement they were matched by, and whether
 * the one value prompt has already been issued. Bounded in every dimension and
 * cleared on runtime stop, so a previous lifecycle cannot report engagement.
 */
export class SessionMeshEngagement {
  private readonly now: () => number;
  private readonly tracked = new Map<string, Tracked[]>();

  constructor(options: { now: () => number }) {
    this.now = options.now;
  }

  /** Called when a delivery receipt confirms the context reached the model. */
  recordDelivery(input: {
    sourceKey: string;
    agentId: string;
    messageId: string;
    summary: string;
    paths: readonly string[];
  }): void {
    // No `workspaceRoot`: this summary is a PEER's published text, already
    // relativized against the peer's own toplevel (#8088). Relativizing it a
    // second time against THIS checkout would be the wrong operand, so an
    // absolute path here is dropped as naming another checkout — the same rule
    // `normalizeSubjectPath` already states for publication.
    const { subjects } = extractSessionMeshSubjects(input.summary);
    const all = [...new Set([...subjects, ...input.paths])];
    if (!all.length) {
      // A message that names no subject has nothing engagement could be matched
      // against. Recording it as trackable would make every later tool use look
      // like engagement with it, which is worse than not measuring it.
      return;
    }
    const key = `${input.sourceKey}:${input.agentId}`;
    const list = this.prune(key);
    if (list.some((item) => item.messageId === input.messageId)) {
      return;
    }
    list.push({
      sourceKey: input.sourceKey,
      messageId: input.messageId,
      subjects: all,
      deliveredAt: this.now(),
      engagedWith: null,
      engagedSubject: null,
      prompted: false,
    });
    this.tracked.set(key, list.slice(-MAX_TRACKED_MESSAGES));
    if (this.tracked.size > MAX_TRACKED_AGENTS) {
      this.tracked.delete(this.tracked.keys().next().value ?? "");
    }
  }

  /**
   * Match this tool event's own paths and text against every delivery still
   * tracked for the agent, and report the ones newly engaged. Purely textual —
   * no cloud call, no model call.
   */
  observe(input: {
    sourceKey: string;
    agentId: string;
    files: readonly string[];
    text: string;
    /**
     * The git TOPLEVEL this event's session runs in, so an absolute path named
     * in `command`/`path`/`pattern` relativizes to the SAME spelling a
     * repository-relative delivered subject carries. Without it every such path
     * fails `normalizeSubjectPath`'s prefix test and is dropped outright, so the
     * fields `OBSERVED_FIELDS` admits beyond `file_path` — which arrives raw in
     * `files` — can never match anything (#8088, ISS-11435).
     */
    workspaceRoot?: string;
  }): SessionMeshEngagementPrompt[] {
    const key = `${input.sourceKey}:${input.agentId}`;
    const list = this.prune(key);
    // Windows tool paths arrive `\`-separated while delivered workspace paths are
    // always `/`-separated, so without this no ordinary edit on Windows would
    // ever match a repository-relative subject.
    const tokens = [
      ...input.files,
      ...extractSessionMeshSubjects(input.text, input.workspaceRoot).subjects,
    ].map(normalizeSeparators);
    if (!(list.length && tokens.length)) {
      return [];
    }
    const engaged: SessionMeshEngagementPrompt[] = [];
    for (const item of list) {
      if (item.engagedWith || item.sourceKey !== input.sourceKey) {
        continue;
      }
      const match = matchSubject(
        item.subjects.map(normalizeSeparators),
        tokens
      );
      if (match) {
        item.engagedWith = match.evidence;
        item.engagedSubject = match.subject;
        engaged.push({
          messageId: item.messageId,
          subject: match.subject,
          evidence: match.evidence,
        });
      }
    }
    return engaged;
  }

  /**
   * The engaged deliveries whose ONE value prompt has not been issued yet, marked
   * as prompted so no message is ever asked about twice.
   */
  pendingPrompts(
    sourceKey: string,
    agentId: string
  ): SessionMeshEngagementPrompt[] {
    const pending: SessionMeshEngagementPrompt[] = [];
    for (const item of this.prune(`${sourceKey}:${agentId}`)) {
      if (item.engagedWith && !item.prompted && item.sourceKey === sourceKey) {
        pending.push({
          messageId: item.messageId,
          // The subject that actually MATCHED, not the first one recorded: a
          // delivery naming several subjects would otherwise ask the model about
          // an unrelated one while the evidence named the matched token.
          subject: item.engagedSubject ?? item.subjects[0] ?? "",
          evidence: item.engagedWith,
        });
      }
    }
    return pending;
  }

  /**
   * Mark prompts as asked. Called only once the hook CONFIRMS the context reached
   * the model, or immediately when the context carries no receipt to confirm.
   *
   * Composing the prompt is not asking it: a context can be evicted at the
   * ready-context cap, expire past its staleness window, or be superseded, and
   * marking at composition would burn the only value prompt a message ever gets.
   */
  markPrompted(
    sourceKey: string,
    agentId: string,
    asked: readonly { messageId: string }[]
  ): void {
    const messageIds = asked.map((prompt) => prompt.messageId);
    for (const item of this.prune(`${sourceKey}:${agentId}`)) {
      if (item.sourceKey === sourceKey && messageIds.includes(item.messageId)) {
        item.prompted = true;
      }
    }
  }

  clear(): void {
    this.tracked.clear();
  }

  private prune(key: string): Tracked[] {
    const cutoff = this.now() - ENGAGEMENT_TTL_MS;
    const list = (this.tracked.get(key) ?? []).filter(
      (item) => item.deliveredAt >= cutoff
    );
    if (!list.length) {
      // Never CREATE an entry for a key merely asked about. `observe` runs on
      // every hook event, so writing here made an agent with no tracked delivery
      // leave a permanent row and grew the map past its own stated bound.
      this.tracked.delete(key);
      return list;
    }
    this.tracked.set(key, list);
    while (this.tracked.size > MAX_TRACKED_AGENTS) {
      const oldest = this.tracked.keys().next().value;
      if (oldest === undefined || oldest === key) {
        break;
      }
      this.tracked.delete(oldest);
    }
    return list;
  }
}

/**
 * Whether any observed token touches one of the delivery's subjects.
 *
 * A path matches on either direction of containment, because the delivered
 * summary may name `packages/api/src/types/session-mesh.ts` while the tool event
 * carries an absolute path for the same file. A ticket slug matches exactly.
 */
function normalizeSeparators(value: string): string {
  return value.replace(WINDOWS_SEPARATOR, "/");
}

function matchSubject(
  subjects: readonly string[],
  tokens: readonly string[]
): { subject: string; evidence: string } | null {
  for (const subject of subjects) {
    for (const token of tokens) {
      // Containment requires the CONTAINED side to be multi-segment. A delivered
      // bare filename (`index.ts`, `route.ts`) would otherwise match an edit to
      // any same-named file in any directory and record engagement with a
      // message about a different file entirely.
      if (
        token === subject ||
        (subject.includes("/") && token.endsWith(`/${subject}`)) ||
        (token.includes("/") && subject.endsWith(`/${token}`))
      ) {
        return { subject, evidence: token };
      }
    }
  }
  return null;
}

/**
 * Observe this event's tool stream and enqueue an `acknowledged` disposition for
 * every delivery it newly engaged with. The runtime supplies the enqueue so the
 * denial latch and idempotency stay in one place.
 *
 * The SendMessage mirror's own event is EXCLUDED: a session relaying a delivered
 * summary to a sibling quotes the subject back, which would match its own
 * delivery and inflate engagement with the recipient's own forwarding.
 */
export function recordSessionMeshEngagement(
  engagement: SessionMeshEngagement,
  input: {
    sourceKey: string;
    agentId: string;
    toolName: unknown;
    toolInput: unknown;
    files: readonly string[];
    /** The git toplevel; see {@link SessionMeshEngagement.observe}. */
    workspaceRoot?: string;
  },
  enqueue: (path: string, body: unknown, id: string) => void
): void {
  const engaged = engagement.observe({
    sourceKey: input.sourceKey,
    agentId: input.agentId,
    files: input.files,
    workspaceRoot: input.workspaceRoot,
    text: sessionMeshObservedToolText(input.toolName, input.toolInput),
  });
  for (const { id, body } of engagementDispositions(input.agentId, engaged)) {
    enqueue("/session-mesh/inbox/disposition", body, id);
  }
}

/**
 * The `acknowledged` inbox dispositions an observed engagement should enqueue.
 *
 * `acknowledged` is the existing first-class status for "the recipient acted on
 * this", and until now NOTHING produced it — `/session-mesh/acknowledge` had zero
 * production calls over 30 days, so the insights card rendered a permanent `0`
 * from a dead producer. This is its producer, and why each carries the matched
 * evidence rather than a bare status.
 */
export function engagementDispositions(
  agentId: string,
  engaged: readonly SessionMeshEngagementPrompt[]
): Array<{
  id: string;
  body: {
    agentId: string;
    messageId: string;
    status: "acknowledged";
    reason: string;
  };
}> {
  return engaged.map((item) => ({
    id: `engaged:${agentId}:${item.messageId}`,
    body: {
      agentId,
      messageId: item.messageId,
      status: "acknowledged" as const,
      // The delivered SUBJECT, never the raw tool path: the evidence token can be
      // an absolute path carrying a home directory and username, and this string
      // is persisted server-side on the metric event.
      reason: `Observed work touching ${item.subject} after delivery`,
    },
  }));
}
