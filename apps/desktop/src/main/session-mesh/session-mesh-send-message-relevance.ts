import { SESSION_MESH_MESSAGE_KIND } from "@repo/api/src/types/session-mesh";
import { redactSecrets } from "@repo/lib/security/redact-secrets";

/**
 * Whether a native sibling `SendMessage` call is worth mirroring into the
 * organization Mesh, and as which kind (ISS-11434).
 *
 * Pure over one tool input, so the runtime keeps only the decisions. Three
 * properties of this module are load-bearing rather than stylistic:
 *
 * - **The headline never carries the message body.** `SendMessage` is
 *   sibling-private; a Mesh publish is organization-wide. Only the author's own
 *   `summary` recap is forwarded, redacted, and length-capped — so a body that
 *   quotes a file or a credential cannot cross that scope change even before the
 *   server's own `sanitizeMeshText` runs.
 * - **The body IS read for subjects**, which are path- and ticket-shaped tokens
 *   only. That is what relevance routing places the message by, and it cannot
 *   reproduce prose.
 * - **Silence is the default, and the SUBJECT is what buys it.** A busy
 *   orchestrator sends constantly; a blind mirror would make the organization
 *   inbox worthless, which is the opposite of the Mesh's purpose. Lane chatter
 *   with no named subject returns `null` — that gate, not the phrase table, is
 *   what keeps the mirror quiet.
 */
export const SESSION_MESH_SEND_MESSAGE_TOOL = "SendMessage";
const MAX_OBSERVED_TOOL_TEXT = 20_000;
/** See {@link sessionMeshObservedToolText}. */
const OBSERVED_TOOL_FIELDS = [
  "file_path",
  "notebook_path",
  "path",
  "command",
  "pattern",
  "to",
  "summary",
] as const;
/**
 * The native sibling-messaging tools a Mesh-aware session pre-approves.
 *
 * `ListAgents` rides along because `SendMessage` without it can only address an
 * id the session has no way to discover. Pre-approval removes the PROMPT and
 * nothing else — whether either tool is offered at all is the harness's own
 * gate, which no settings file can reach from here.
 */
export const SESSION_MESH_NATIVE_MESSAGING_TOOLS = [
  SESSION_MESH_SEND_MESSAGE_TOOL,
  "ListAgents",
] as const;

/**
 * The closed subset of `SESSION_MESH_MESSAGE_KIND` a mirror may produce.
 *
 * Every member is typed as an `Extract` of the canonical list rather than a bare
 * string, so dropping or renaming one there fails `tsc` here instead of turning
 * every matching sibling message into a thrown `ZodError` on the hook path.
 */
type MirrorKind<Name extends (typeof SESSION_MESH_MESSAGE_KIND)[number]> = Name;
export const SessionMeshSendMessageKind = {
  Claim: "claim" satisfies MirrorKind<"claim">,
  Blocker: "blocker" satisfies MirrorKind<"blocker">,
  Discovery: "discovery" satisfies MirrorKind<"discovery">,
  Decision: "decision" satisfies MirrorKind<"decision">,
  Handoff: "handoff" satisfies MirrorKind<"handoff">,
  Request: "request" satisfies MirrorKind<"request">,
} as const;
export type SessionMeshSendMessageKind =
  (typeof SessionMeshSendMessageKind)[keyof typeof SessionMeshSendMessageKind];

export type SessionMeshSendMessageMirror = {
  kind: SessionMeshSendMessageKind;
  /** Classified, redacted, bounded. Never the message body. */
  headline: string;
  /** Repository paths and ticket slugs the message named, in first-seen order. */
  subjects: string[];
  /** The subset of {@link SessionMeshSendMessageMirror.subjects} that are paths. */
  paths: string[];
  /**
   * The ticket slugs, carried as workspace SYMBOLS on the publication.
   * `relevanceFor` routes on exact path OR symbol overlap and never reads the
   * summary, so a slug left only in prose reaches nobody.
   */
  tickets: string[];
};

const MAX_CLASSIFIED_TEXT = 20_000;
const MAX_HEADLINE = 300;
const MAX_SUBJECTS = 20;
const MAX_PATH = 1000;
/**
 * Includes the leading `/` or `./` on purpose. Without it an absolute path is
 * extracted with its root stripped, which both breaks the server's EXACT path
 * overlap and publishes `home/<username>/…` to the organization.
 */
const PATH_PATTERN = /(?:\.?\/)?[\w.@~-]+(?:\/[\w.@~-]+)+\.[a-z][\w]{0,7}\b/gi;
/**
 * Vetoes a blocker classification. "nothing blocking" and "no longer blocked"
 * both matched the blocker phrases, and a blocker is the one kind published
 * without a named subject, so status chatter went out org-wide as a blocker.
 */
const TRAILING_SLASHES = /\/+$/;
const BLOCKER_NEGATION =
  /\b(?:no longer|not|nothing|never|un)\s*(?:longer\s+)?block/i;
const TICKET_PATTERN = /\b(?:ISS|PLN|PRD|FEA|FEAT|PR)-\d{1,7}\b/gi;
/**
 * Ordered, so precedence is explicit: a message that reports a blocker AND asks
 * a question is a blocker. Every pattern is anchored on a phrase a session
 * actually writes when it has made the judgment a Mesh publish needs.
 *
 * The table RECOGNIZES kinds; it does not decide whether to publish. Anything it
 * does not recognize takes {@link MIRROR_DEFAULT_KIND} and is then decided by the
 * subject gate in {@link classifySessionMeshSendMessage}.
 */
const KIND_PATTERNS: ReadonlyArray<
  readonly [SessionMeshSendMessageKind, RegExp]
> = [
  [
    SessionMeshSendMessageKind.Blocker,
    /\b(?:blocked|blocker|blocking|cannot proceed|can't proceed|is broken|does not work|doesn't work|still failing|red in ci)\b/i,
  ],
  [
    SessionMeshSendMessageKind.Handoff,
    /\b(?:handing (?:this |it )?(?:off|over)|hand(?:ing)? over to|you (?:now )?own|taking over from|over to you|yours now)\b/i,
  ],
  [
    SessionMeshSendMessageKind.Decision,
    /\b(?:we(?:'re| are) going with|we decided|decided to|decision:|settled on|ruled out)\b/i,
  ],
  [
    SessionMeshSendMessageKind.Claim,
    /\b(?:i(?:'m| am) (?:taking|claiming|editing|implementing|working on|rewriting)|i(?:'ll| will) take|claiming|now editing|picking up)\b/i,
  ],
  [
    SessionMeshSendMessageKind.Discovery,
    /\b(?:root cause|found (?:the|a) (?:cause|bug|issue|problem|reason)|turns out|the reason is|is actually)\b/i,
  ],
  [
    SessionMeshSendMessageKind.Request,
    /\b(?:can you|could you|would you|please (?:check|review|verify|confirm|look|rerun)|need you to)\b/i,
  ],
];
/**
 * The kind a message takes when no pattern in {@link KIND_PATTERNS} matches.
 *
 * Operator ruling, Marisol Ashgrove 2026-10-01: "And classifyKind is why my briefs
 * produced nothing. -- fix that." A fixed table of English phrases returned
 * `null` for real coordination traffic — a day of briefs that every one named
 * repository paths and ticket slugs produced ZERO substantive publications,
 * because reporting a finding in prose the table does not list was indistinguishable
 * from lane chatter. So an unrecognized message is no longer dropped HERE: it is
 * classified generically and left to the gate that actually controls noise, which
 * is the subject gate plus the server's exact path/symbol overlap
 * (`relevanceFor`, `apps/api/app/session-mesh/service.ts`).
 *
 * `discovery` is the honest generic, not a convenience: a message that reports
 * something about a file or ticket it names IS a finding, and a more specific
 * kind still wins because the table is consulted first. It is deliberately not
 * `blocker`, the one kind published without a named subject — a default that
 * bypassed the subject gate would be the firehose this gate exists to prevent.
 */
const MIRROR_DEFAULT_KIND = SessionMeshSendMessageKind.Discovery;

/**
 * The separator a mirrored publication puts between its headline and its
 * subjects.
 *
 * Owned here, and consumed by `sessionMeshSendMessagePublication`, because
 * {@link isMeshEcho} has to recognize EXACTLY what that site emits. Two
 * spellings of this string would let a relayed row past the echo gate.
 */
export const SESSION_MESH_SUBJECT_JOINER = " — subject: ";
/**
 * The `[kind; messageId; author]` prefix the delivered-context block prints for
 * each inbox row (`session-mesh-context-text.ts`). Built from the canonical kind
 * list, so a kind added there is recognized here without a second edit.
 */
const MESH_CONTEXT_LINE_PATTERN = new RegExp(
  `\\[(?:${SESSION_MESH_MESSAGE_KIND.join("|")}); [0-9a-f]{8}-[0-9a-f]{4}-`,
  "i"
);

/**
 * Whether this text is a Mesh row the organization ALREADY published.
 *
 * Review thread on #8296, and the relay cycle it names is real: a session reads
 * a peer's row out of its context block and forwards it to a lane with
 * `SendMessage`. The forward carries the row's own path, matches no kind phrase,
 * and arrives with a FRESH `tool_use_id` — so the subject gate passes it, the
 * default classifies it, and idempotency cannot collapse it. It published as a
 * second row, deliverable and forwardable again.
 *
 * Measured on the shipped `HEADLINE_FALLBACK` strings: five of the six match no
 * pattern in {@link KIND_PATTERNS}, so before the default existed a forwarded
 * row classified `null` and the cycle could not start. The default removed that
 * accidental brake, which is why the gate is explicit now rather than emergent.
 *
 * Checked BEFORE classification, because an echo must not be mirrored as ANY
 * kind — including the one headline (`blocker`) that always self-matched. It
 * recognizes only shapes this repo itself composes, so a human-authored message
 * that merely names a path is untouched.
 */
function isMeshEcho(text: string): boolean {
  return (
    text.includes(SESSION_MESH_SUBJECT_JOINER) ||
    MESH_CONTEXT_LINE_PATTERN.test(text)
  );
}
const HEADLINE_FALLBACK: Readonly<Record<SessionMeshSendMessageKind, string>> =
  {
    claim: "Sibling session claimed work",
    blocker: "Sibling session reported a blocker",
    discovery: "Sibling session reported a finding",
    decision: "Sibling session recorded a decision",
    handoff: "Sibling session handed work over",
    request: "Sibling session asked for a check",
  };

function textField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function matchAll(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[0]);
}

/**
 * The repository paths and ticket slugs a block of text names, deduplicated in
 * first-seen order and bounded.
 *
 * Exported so any later reader of the tool stream extracts subjects the SAME
 * way a mirror does; two definitions of "subject" would route on one and match
 * on the other.
 */
export function extractSessionMeshSubjects(
  text: string,
  workspaceRoot?: string
): {
  paths: string[];
  tickets: string[];
  subjects: string[];
} {
  // REDACT FIRST. Subjects come out of a sibling-private body and cross into an
  // organization-wide row, and the server's sanitizer cannot recognize a
  // credential whose surrounding URL the extractor already stripped — a
  // `https://user:pw@host/repo/f.ts` body yielded `pw@host/repo/f.ts` verbatim.
  const bounded = redactSecrets(text.slice(0, MAX_CLASSIFIED_TEXT));
  const paths = [
    ...new Set(
      matchAll(bounded, PATH_PATTERN)
        .map((path) => normalizeSubjectPath(path, workspaceRoot))
        .filter((path): path is string => path !== null)
    ),
  ].slice(0, MAX_SUBJECTS);
  const tickets = extractSessionMeshTicketSlugs(bounded);
  return {
    paths,
    tickets,
    subjects: [...new Set([...paths, ...tickets])].slice(0, MAX_SUBJECTS),
  };
}

function classifyKind(text: string): SessionMeshSendMessageKind | null {
  for (const [kind, pattern] of KIND_PATTERNS) {
    if (!pattern.test(text)) {
      continue;
    }
    if (kind === SessionMeshSendMessageKind.Blocker) {
      // Demoted to MIRROR_DEFAULT_KIND, not dropped: operator ruling
      // 2026-10-01 on the asymmetry a terminal veto created — "nothing
      // blocking, ISS-1" was dropped where "task done, ISS-1" published, so a
      // negation phrase silenced a message that otherwise went out.
      // `"Task 3 done, ISS-123" should be the message` — both forms now reach
      // the default. The veto still does its own job: it denies the `blocker`
      // classification, which is all BLOCKER_NEGATION's reason claims. A
      // subject-less negation is still dropped, by the subject gate.
      return BLOCKER_NEGATION.test(text) ? MIRROR_DEFAULT_KIND : kind;
    }
    return kind;
  }
  return MIRROR_DEFAULT_KIND;
}

/**
 * One extracted path as it may be published, or `null` to drop it.
 *
 * The server matches paths EXACTLY against a peer's workspace paths, which are
 * repository-relative, so an absolute path routes to nobody. One under
 * `workspaceRoot` is relativized; one outside it is dropped rather than
 * published, because it names another checkout and carries a home directory and
 * username into an organization-wide row. A traversal or an over-long path is
 * dropped too, so the wire validator cannot reject the whole publication.
 */
function normalizeSubjectPath(
  path: string,
  workspaceRoot?: string
): string | null {
  let value = path.startsWith("./") ? path.slice(2) : path;
  if (value.startsWith("/")) {
    const root = workspaceRoot?.replace(TRAILING_SLASHES, "");
    if (!(root && value.startsWith(`${root}/`))) {
      return null;
    }
    value = value.slice(root.length + 1);
  }
  if (!value || value.includes("../") || value.length > MAX_PATH) {
    return null;
  }
  return value;
}

/**
 * The mirror decision for one `SendMessage` tool input, or `null` to stay silent.
 *
 * A message with no named subject is mirrored only when it reports a BLOCKER:
 * every other kind is placed by the paths and ticket symbols it names, so
 * publishing one without a subject would add a row to every peer's inbox that
 * nothing placed it in. That subject gate is the whole noise floor — the kind
 * table recognizes, it does not filter (see {@link MIRROR_DEFAULT_KIND}).
 *
 * A subject-less blocker is NOT routed by the repository. `relevanceFor`
 * (`apps/api/app/session-mesh/service.ts`) requires path, symbol, branch/PR or
 * artifact overlap and reads repository identity as no evidence at all, so such a
 * blocker reaches peers through its BRANCH — either the lineage branch itself, or
 * the branch's ticket slug, which `resolveSessionMeshWorkspace` now carries as a
 * workspace symbol.
 */
export function classifySessionMeshSendMessage(
  toolInput: unknown,
  workspaceRoot?: string
): SessionMeshSendMessageMirror | null {
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
    return null;
  }
  const source = toolInput as Record<string, unknown>;
  const recap = textField(source, "summary");
  const text = [
    recap,
    textField(source, "message"),
    textField(source, "content"),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_CLASSIFIED_TEXT);
  if (!text || isMeshEcho(text)) {
    return null;
  }
  const kind = classifyKind(text);
  if (!kind) {
    return null;
  }
  const { paths, tickets, subjects } = extractSessionMeshSubjects(
    text,
    workspaceRoot
  );
  if (!subjects.length && kind !== SessionMeshSendMessageKind.Blocker) {
    return null;
  }
  const headline =
    redactSecrets(recap).trim().slice(0, MAX_HEADLINE) ||
    HEADLINE_FALLBACK[kind];
  return { kind, headline, subjects, paths, tickets };
}

/**
 * The identifying fields of one hook tool input, joined and bounded — the text
 * every Mesh observer of the tool stream reads.
 *
 * Deliberately EXCLUDES `new_string`, `old_string` and `content`: nearly every
 * comment in this repo cites a ticket slug, so scanning edited content made a
 * delivery about `ISS-NNNN` read as touched the moment the session wrote any
 * comment mentioning it. These fields identify WHAT is being touched.
 *
 * The SendMessage mirror's own event yields "": a session relaying a delivered
 * summary to a sibling quotes the subject back, which would match its own
 * delivery and let a recipient's forwarding vote for the delivery's usefulness.
 */
export function sessionMeshObservedToolText(
  toolName: unknown,
  toolInput: unknown
): string {
  if (
    toolName === SESSION_MESH_SEND_MESSAGE_TOOL ||
    !toolInput ||
    typeof toolInput !== "object"
  ) {
    return "";
  }
  const source = toolInput as Record<string, unknown>;
  return OBSERVED_TOOL_FIELDS.map((field) => source[field])
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .slice(0, MAX_OBSERVED_TOOL_TEXT);
}

/**
 * The ClosedLoop ticket slugs a block of text names, uppercased, deduplicated in
 * first-seen order and bounded.
 *
 * Exported so presence symbols and message symbols are extracted by ONE pattern.
 * `relevanceFor` (`apps/api/app/session-mesh/service.ts`) matches a message's
 * symbols against a peer's presence symbols EXACTLY, so a second spelling of
 * "ticket slug" on either side routes on one and matches on the other.
 */
export function extractSessionMeshTicketSlugs(text: string): string[] {
  return [
    ...new Set(
      matchAll(text.slice(0, MAX_CLASSIFIED_TEXT), TICKET_PATTERN).map((slug) =>
        slug.toUpperCase()
      )
    ),
  ].slice(0, MAX_SUBJECTS);
}
