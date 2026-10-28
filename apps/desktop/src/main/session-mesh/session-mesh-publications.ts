import { createHash } from "node:crypto";
import {
  type SessionMeshPublishInput,
  type SessionMeshWorkspace,
  sessionMeshPublishValidator,
} from "@repo/api/src/types/session-mesh";
import {
  SessionMeshArtifactInteraction,
  type SessionMeshTraceSubjects,
} from "./session-mesh-artifact-trace.js";
import type { SessionMeshHookEvent } from "./session-mesh-hook-contract.js";
import type { messageKind } from "./session-mesh-hook-event-fields.js";
import {
  classifySessionMeshSendMessage,
  SESSION_MESH_SEND_MESSAGE_TOOL,
  SESSION_MESH_SUBJECT_JOINER,
  SessionMeshSendMessageKind,
} from "./session-mesh-send-message-relevance.js";

/**
 * Every automatic Mesh publication the native hook runtime produces, and the
 * idempotency key each one is retried under.
 *
 * Split out of `session-mesh-runtime.ts` (ISS-11434): the runtime decides WHEN
 * to enqueue and this module decides WHAT is published, so a new trigger adds a
 * builder here instead of another branch in a 1,000-line file.
 */
export type SessionMeshPublication = {
  idempotencyKey: string;
  publication: SessionMeshPublishInput;
};
type PublicationLineage = SessionMeshPublishInput["lineage"];
const MAX_PUBLISHED_PATHS = 200;
const MAX_PUBLISHED_SYMBOLS = 200;
/** `sessionMeshPublishValidator`'s own bound. Composed here so a long body is
 * trimmed rather than throwing a `ZodError` on the hook path and losing the
 * mirror entirely. */
const MAX_SUMMARY = 4000;

function idempotencyKeyFor(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * The lifecycle publication for a `work_started` / `claim` / `session_ended`
 * event.
 *
 * Published with NO workspace symbols, which is load-bearing. `messageKind`
 * returns `claim` for every `PreToolUse` edit, so this builder runs on each file
 * write, and `relevanceFor` ranks any symbol overlap `overlap` — which the server
 * queues rather than holds. A branch-derived symbol here would make two worktrees
 * on the same ticket (`fix/iss-N-a` and `fix/iss-N-b`) interrupt each other on
 * every single write with disjoint files. A lifecycle fact is placed by the PATHS
 * it names; a subject-level symbol belongs on the subject-level mirror below.
 */
export function sessionMeshLifecyclePublication(input: {
  agentId: string;
  kind: "work_started" | "claim" | "session_ended";
  event: SessionMeshHookEvent;
  file?: string;
  workspace: SessionMeshWorkspace;
  lineage: PublicationLineage;
}): SessionMeshPublication {
  const { agentId, kind, event, file, workspace, lineage } = input;
  const idempotencyKey = idempotencyKeyFor([
    agentId,
    kind,
    event.data.tool_use_id ?? event.data.turn_id ?? workspace.revision,
    file,
  ]);
  return {
    idempotencyKey,
    publication: sessionMeshPublishValidator.parse({
      authorAgentId: agentId,
      idempotencyKey,
      kind,
      workspace: { ...workspace, symbols: [] },
      lineage,
      summary:
        kind === "claim"
          ? `Editing ${workspace.paths.join(", ")}`
          : `${agentId} ${kind === "session_ended" ? "ended" : "started"}`,
    }),
  };
}

/**
 * The Mesh mirror of a native sibling `SendMessage`, or `null` when this event
 * is not one or does not clear the relevance gate.
 *
 * Deliberately UNADDRESSED: a `SendMessage` recipient is a provider-owned agent
 * id and a Mesh recipient is a Mesh id. The namespaces are disjoint, so
 * translating one into the other would address a stranger; omitting recipients
 * hands placement to the server's relevance routing, which is what the named
 * subjects below are for.
 */
export function sessionMeshSendMessagePublication(input: {
  agentId: string;
  event: SessionMeshHookEvent;
  workspace: SessionMeshWorkspace;
  lineage: PublicationLineage;
  /** The session's checkout root, so an absolute path is relativized or dropped
   * instead of publishing a home directory and username organization-wide. */
  workspaceRoot?: string;
}): SessionMeshPublication | null {
  const { agentId, event, workspace, lineage, workspaceRoot } = input;
  if (
    event.hookType !== "PreToolUse" ||
    event.data.tool_name !== SESSION_MESH_SEND_MESSAGE_TOOL
  ) {
    return null;
  }
  const mirror = classifySessionMeshSendMessage(
    event.data.tool_input,
    workspaceRoot
  );
  if (!mirror) {
    return null;
  }
  // The tool-call id makes a retried or duplicated hook delivery one publish.
  // Its absence falls back to the classified content, which still collapses a
  // repeat of the same message rather than publishing it twice.
  const idempotencyKey = idempotencyKeyFor([
    "send_message",
    agentId,
    event.data.tool_use_id ?? [mirror.kind, mirror.headline, mirror.subjects],
  ]);
  return {
    idempotencyKey,
    publication: sessionMeshPublishValidator.parse({
      authorAgentId: agentId,
      idempotencyKey,
      kind: mirror.kind,
      workspace: {
        ...workspace,
        paths: [...new Set([...workspace.paths, ...mirror.paths])].slice(
          -MAX_PUBLISHED_PATHS
        ),
        // Ticket slugs are SYMBOLS, not prose. `relevanceFor` routes on exact
        // path or symbol overlap and never reads the summary, so a slug left in
        // the sentence alone reaches nobody — the message would be stored with
        // no recipients at all.
        symbols: [...new Set([...workspace.symbols, ...mirror.tickets])].slice(
          -MAX_PUBLISHED_SYMBOLS
        ),
      },
      lineage,
      summary: (mirror.subjects.length
        ? `${mirror.headline}${SESSION_MESH_SUBJECT_JOINER}${mirror.subjects.join(", ")}`
        : mirror.headline
      ).slice(0, MAX_SUMMARY),
      // Provenance, so a stored Mesh row identifies where it came from rather
      // than looking like a message the session composed for the Mesh. The
      // sibling recipient is recorded as ORIGIN only; it is a provider-owned id
      // and is never used for Mesh routing.
      context: {
        origin: "native_send_message",
        harness: event.harness,
        ...(typeof event.data.tool_use_id === "string"
          ? { toolUseId: event.data.tool_use_id }
          : {}),
        ...(typeof event.data.session_id === "string"
          ? { originSessionId: event.data.session_id }
          : {}),
        ...(siblingRecipient(event.data.tool_input)
          ? { originSiblingRecipient: siblingRecipient(event.data.tool_input) }
          : {}),
        originSubjects: mirror.subjects,
      },
    }),
  };
}

/** The `to` of the mirrored sibling message, for provenance only. */
function siblingRecipient(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== "object") {
    return undefined;
  }
  const to = (toolInput as Record<string, unknown>).to;
  return typeof to === "string" && to ? to.slice(0, 200) : undefined;
}

/**
 * The closed-enum kind each artifact interaction publishes as.
 *
 * The specific interaction rides in `context`, not in `kind`. That is what makes
 * this instrumentation additive under the Cross-Repo Compatibility
 * Requirements: an API or Desktop build that predates it reads a plain `claim`
 * or `discovery` and ignores an unknown context key, where a new wire kind would
 * have been rejected by `sessionMeshPublishValidator`'s own enum on every retry.
 *
 * Values reuse `SessionMeshSendMessageKind` rather than restating two members of
 * `SESSION_MESH_MESSAGE_KIND`: that const is already the typed subset a
 * desktop-side builder may produce, so a member renamed there fails `tsc` here.
 */
const INTERACTION_KIND = {
  [SessionMeshArtifactInteraction.Reviewing]: SessionMeshSendMessageKind.Claim,
  [SessionMeshArtifactInteraction.Implementing]:
    SessionMeshSendMessageKind.Claim,
  [SessionMeshArtifactInteraction.Planning]: SessionMeshSendMessageKind.Claim,
  [SessionMeshArtifactInteraction.DependencyFound]:
    SessionMeshSendMessageKind.Discovery,
} as const satisfies Record<
  SessionMeshArtifactInteraction,
  SessionMeshSendMessageKind
>;
/**
 * The operator's own four words for these interactions (instruction 2026-10-08:
 * "reviewing, implementing, planning, found dependencies"), in the register the
 * sibling builders above already use — `Editing <paths>`, `<agent> started`.
 */
const INTERACTION_SUMMARY = {
  [SessionMeshArtifactInteraction.Reviewing]: "Reviewing",
  [SessionMeshArtifactInteraction.Implementing]: "Implementing",
  [SessionMeshArtifactInteraction.Planning]: "Planning",
  [SessionMeshArtifactInteraction.DependencyFound]: "Found dependencies:",
} as const satisfies Record<SessionMeshArtifactInteraction, string>;

/**
 * The publication for one meaningful artifact interaction — the trigger the Mesh
 * was missing (operator instruction 2026-10-08).
 *
 * Unlike `sessionMeshLifecyclePublication` this one IS subject-bearing, and the
 * difference is the whole point: a lifecycle fact is placed by the paths it
 * names, which is why a reviewing session placed nothing. The symbol storm that
 * builder's docstring warns about is not reachable from here — it fires per file
 * WRITE, where this fires once per session per (interaction, subject set), which
 * is what the idempotency key is over.
 */
export function sessionMeshArtifactInteractionPublication(input: {
  agentId: string;
  interaction: SessionMeshArtifactInteraction;
  symbols: readonly string[];
  workspace: SessionMeshWorkspace;
  lineage: PublicationLineage;
}): SessionMeshPublication {
  const { agentId, interaction, symbols, workspace, lineage } = input;
  const subjects = [...symbols].sort();
  const idempotencyKey = idempotencyKeyFor([
    agentId,
    "artifact_interaction",
    interaction,
    subjects,
    // The caller passes this event's lineage, so these are the trace's own ids
    // and an unrelated id retained from another turn cannot re-key the row.
    lineage.artifactIds,
  ]);
  return {
    idempotencyKey,
    publication: sessionMeshPublishValidator.parse({
      authorAgentId: agentId,
      idempotencyKey,
      kind: INTERACTION_KIND[interaction],
      workspace: {
        ...workspace,
        symbols: [...symbols].slice(0, MAX_PUBLISHED_SYMBOLS),
      },
      lineage,
      context: { interaction },
      summary: `${INTERACTION_SUMMARY[interaction]} ${
        subjects.join(", ") || lineage.artifactIds.join(", ")
      }`.slice(0, MAX_SUMMARY),
    }),
  };
}

/**
 * Every publication one hook event produces, in the order they are enqueued.
 *
 * Each is independently idempotency-keyed and each is refused by the runtime's
 * `enqueue` while the denial latch stands. Assembled here rather than in
 * `handleSerial` so that adding a trigger does not add a branch to the
 * runtime's one serialized hook path.
 */
export function sessionMeshEventPublications(input: {
  agentId: string;
  event: SessionMeshHookEvent;
  file?: string;
  kind: ReturnType<typeof messageKind>;
  trace: SessionMeshTraceSubjects;
  /** This event's resolved workspace. */
  workspace: SessionMeshWorkspace;
  /** The session's retained paths, which the lifecycle and mirror rows carry. */
  retainedPaths: readonly string[];
  lineage: PublicationLineage;
  workspaceRoot?: string;
}): Array<SessionMeshPublication | null> {
  const { agentId, event, file, kind, trace, lineage, workspaceRoot } = input;
  // An interaction is about this event's subjects only: the retained paths
  // would route "Reviewing PR-N" to anyone who touched any file it ever edited.
  const workspace = { ...input.workspace, paths: [...input.retainedPaths] };
  return [
    kind
      ? sessionMeshLifecyclePublication({
          agentId,
          kind,
          event,
          file,
          workspace,
          lineage,
        })
      : null,
    trace.interaction
      ? sessionMeshArtifactInteractionPublication({
          agentId,
          interaction: trace.interaction,
          symbols: trace.symbols,
          workspace: input.workspace,
          lineage,
        })
      : null,
    sessionMeshSendMessagePublication({
      agentId,
      event,
      workspace,
      lineage,
      workspaceRoot,
    }),
  ];
}
