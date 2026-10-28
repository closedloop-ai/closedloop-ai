import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { SyncedAgentSession } from "../../../../main/agent-sync/agent-session-sync-contract";
import { DESKTOP_AGENT_STATUS } from "../../../../main/database/db-constants";

/**
 * The ONE probe session the data-sync egress guards run the real producer over,
 * plus the sentinels planted in it.
 *
 * Extracted (ISS-7775) so `data-sync-egress-honesty.test.ts` — which pins the
 * consent CARD against runtime egress — and `data-sync-tier-egress.test.ts` —
 * which pins what each data-sync LEVEL is allowed to put on the wire — probe the
 * identical session. A second hand-built fixture would let the two files
 * disagree about what "planted" means, and a sentinel that exists in only one of
 * them is a channel only one of them can see.
 *
 * NOTHING HERE IS OR EVER WAS A LIVE CREDENTIAL. The secret-shaped values are
 * synthetic tokens in an issued key's SHAPE, which is all the redactor matches
 * on.
 */

/**
 * One sentinel per content class the consent card names, planted at the field
 * that class actually travels in. A class counts as egressing when ANY of its
 * sentinels survives the producer, because any one channel leaking is enough to
 * make a "stays on this device" line false.
 */
export const EGRESS_PROBE_SENTINELS: Record<string, readonly string[]> = {
  "Session shape, timing & cost": ["clsentinel-session-model"],
  "Tool-call activity (names & counts)": ["clsentinel-tool-name"],
  "Tool inputs & file contents": [
    "clsentinel-tool-input",
    "clsentinel-file-content",
    // ISS-7775 (security-privacy critic on the ISS-7775 PR): slash-command
    // DEFINITION FILE TEXT, riding in the session-metadata payload rather than
    // on either component lane — so `PARTIALLY_OBSERVED_CLASSES`, which is
    // scoped to those lanes, does not describe it. This one the probe CAN see.
    "clsentinel-definition-content",
  ],
  "Prompts & completions": [
    "clsentinel-user-prompt",
    "clsentinel-assistant-completion",
    "clsentinel-event-summary",
    "clsentinel-plan-prose",
    "clsentinel-delegation-prompt",
    "clsentinel-agent-task",
    "clsentinel-unenumerated-metadata",
    // ISS-8014: `agents[].metadata` is a SECOND open metadata blob. The desktop
    // shipped it verbatim off the SQLite column and left the strip to the cloud,
    // so a parser-supplied subagent key crossed the wire raw.
    "clsentinel-agent-metadata",
    // ISS-7775 (davetho review): the same blob, but planted under a key the
    // SESSION allow-list declares structural. See
    // `AGENT_METADATA_COLLIDING_STRUCTURAL_KEY`.
    "clsentinel-agent-path-collision",
    // ISS-7775 (security-privacy critic): the session's own `name`. FEA-3578
    // made it the harness-authored AI TITLE — Claude's `ai-title` record, "the
    // label users recognize from the Claude Code UI" — which the harness writes
    // BY SUMMARIZING THE CONVERSATION, falling back to a cwd-derived name only
    // when no title was emitted. It is a session-ROW field, so it never enters
    // `compactMetadataForPreview` and no metadata policy can reach it.
    "clsentinel-session-name",
  ],
};

/**
 * The metadata key the probe plants under a name NO policy in this repo
 * mentions — not in `OMITTED_METADATA_KEYS`, not special-cased by
 * `compactMetadataForPreview`, not read by any consumer.
 *
 * It is the counter-example that makes the channel list falsifiable: a fix that
 * closes the named channels and leaves the retained key set OPEN still ships
 * this one.
 */
export const UNENUMERATED_METADATA_KEY = "clsentinelUnenumeratedChannel";

/** Sentinel planted under the sole `OMITTED_METADATA_KEYS` member. */
export const OMITTED_METADATA_SENTINEL = "clsentinel-omitted-metadata";

/**
 * Secret-shaped sentinels, one per metadata channel under test.
 *
 * DISTINCT VALUES ON PURPOSE: the question each answers is WHERE it ended up, and
 * a single shared literal could not tell a channel that redacts from one that
 * does not. Synthetic tokens in a real credential's SHAPE — nothing here is, or
 * ever was, a live key.
 */
export const SECRET_IN_MESSAGE_TEXT =
  "sk-ant-api03-clsentinelmessageAAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
export const SECRET_IN_DEFINITION_CONTENT =
  "sk-ant-api03-clsentineldefinitionAAAABBBBCCCCDDDDEEEEFFFFGGGG";
/**
 * ISS-8014's decisive plant: a secret under a key NOTHING in this repo names.
 * An enumerated-channel assertion cannot catch the open set, so this is the one
 * that distinguishes "redaction was extended to the channels someone listed"
 * from "redaction is reachable from every string that leaves".
 */
export const SECRET_IN_UNENUMERATED_METADATA =
  "sk-ant-api03-clsentinelunenumeratedAAAABBBBCCCCDDDDEEEEFFFF";
/** ISS-8014: the same question asked of the agent-row metadata blob. */
export const SECRET_IN_AGENT_METADATA =
  "sk-ant-api03-clsentinelagentmetaAAAABBBBCCCCDDDDEEEEFFFFGGGG";
/**
 * Planted under a NESTED `messages` key (`metadata.<unenumerated>.messages[]`),
 * carried over from #5933 where whitlockk asked for the depth behaviour to be pinned
 * rather than asserted in prose: `compactMetadataObject` routes on the key NAME
 * at every depth, not just at the metadata root.
 *
 * It answers a second question now that ISS-7775 has landed on top. The holder
 * key is undeclared, so under the path-scoped allow-list NOTHING inside it may
 * survive below `full` — not the turn text, and not the `role`/`timestamp` an
 * undeclared shape would have inherited from `messages.role` under the old
 * leaf-key match. That makes it the nested twin of the unenumerated-key plant.
 */
export const SECRET_IN_NESTED_MESSAGE_TEXT =
  "sk-ant-api03-clsentinelnestedAAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
/** The undeclared object the nested `messages` array above is planted under. */
export const NESTED_MESSAGES_HOLDER_KEY = "clsentinelNestedMessagesHolder";

/**
 * ISS-7775 (davetho review): a SESSION-root structural path, planted as the
 * root key of an `agents[].metadata` blob.
 *
 * `agents[].metadata` is compacted as its OWN root, so its paths are judged
 * against the same session-rooted `STRUCTURAL_METADATA_STRING_PATHS`. Before the
 * namespacing fix, an agent blob could therefore borrow a session slot's
 * permission simply by naming its root key `gitBranch` (or `slug`, `version`,
 * `entrypoint`, `permissionMode`, `messages`) — the identical
 * borrow-by-collision defect the PATH allow-list replaced the leaf-key one to
 * close, one container down. `agents[].metadata` is a free-form blob
 * (`buildSubagentMetadata` spreads the parser's own keys into it), so the
 * colliding word is reachable, not hypothetical.
 *
 * `gitBranch` is used because it is also the session blob's redaction control,
 * which makes the two lanes' divergence the point: the SAME key must be retained
 * at the session root and denied under an agent.
 */
export const AGENT_METADATA_COLLIDING_STRUCTURAL_KEY = "gitBranch";

/**
 * POSITIVE CONTROL for the redactor: prose that LOOKS like the tokens above —
 * same alphabet, same length class, an `sk`-ish prefix broken by a hyphen the
 * real patterns do not accept — and must survive byte-identical.
 *
 * Without it, "no secret reached the wire" is equally satisfied by a redactor
 * that blanks every string it is handed, and the widening this ticket performs
 * is exactly the change that could do that. Planted under an ALLOW-LISTED key
 * (`gitBranch`) so it is retained at every level and the assertion is about
 * redaction rather than about the tier policy.
 */
export const BENIGN_SECRET_LOOKALIKE =
  "release-sk-branch-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";

/**
 * A session carrying one sentinel per content class, shaped like what the
 * hydrator hands the sync producer.
 */
export function buildEgressProbeSession(): SyncedAgentSession {
  const at = "2026-01-01T00:00:00.000Z";
  return {
    externalSessionId: "probe-session",
    // ISS-7775: the AI title. Planted so the channel cannot change silently
    // while the decision about it is open — see `KNOWN_UNRECONCILED_EGRESS`.
    name: "clsentinel-session-name",
    status: SESSION_STATUS.ACTIVE,
    startedAt: at,
    updatedAt: at,
    model: "clsentinel-session-model",
    tokenUsageByModel: [],
    metadata: {
      messages: [
        {
          role: "user",
          text: `clsentinel-user-prompt ${SECRET_IN_MESSAGE_TEXT}`,
        },
        { role: "assistant", text: "clsentinel-assistant-completion" },
      ],
      plans: [{ source: "ExitPlanMode", content: "clsentinel-plan-prose" }],
      // ISS-7775: definition FILE TEXT on the session-metadata payload, carrying
      // a secret-shaped sentinel.
      slashCommands: [
        {
          name: "/probe",
          timestamp: at,
          definitionSnapshot: {
            kind: "command",
            rawName: "/probe",
            normalizedName: "probe",
            content: `clsentinel-definition-content ${SECRET_IN_DEFINITION_CONTENT}`,
            capturedAt: at,
          },
        },
      ],
      // ISS-7775 / ISS-8014: the unenumerated key, carrying BOTH a prose
      // sentinel and a secret-shaped one. Whether it egresses answers the
      // open-set question; whether its secret survives answers the redaction one.
      [UNENUMERATED_METADATA_KEY]: `clsentinel-unenumerated-metadata ${SECRET_IN_UNENUMERATED_METADATA}`,
      // A `messages` array BELOW the root, under a key with no policy (#5933,
      // whitlockk). `compactMetadataObject` routes on the key NAME at every depth,
      // so redaction reaches here too; and since ISS-7775 matches the whole
      // PATH, nothing inside this holder is structural, so the shape itself must
      // vanish below `full` rather than inheriting `messages.role`'s permission.
      [NESTED_MESSAGES_HOLDER_KEY]: {
        messages: [
          {
            role: "user",
            timestamp: at,
            text: `clsentinel-nested-message ${SECRET_IN_NESTED_MESSAGE_TEXT}`,
          },
        ],
      },
      // The redactor's positive control, under an allow-listed structural key so
      // it is retained at every level (see `BENIGN_SECRET_LOOKALIKE`).
      gitBranch: BENIGN_SECRET_LOOKALIKE,
      // The sole `OMITTED_METADATA_KEYS` member, planted so the deny/allow tests
      // have a NEGATIVE control on the same mechanism — proving the probe can
      // observe a key being removed, so "survived" is a real observation rather
      // than a producer that never drops anything.
      tokenSeries: [OMITTED_METADATA_SENTINEL],
    },
    agents: [
      {
        externalAgentId: "probe-agent",
        // ISS-7554: `subagentName()` falls back to the first 60 chars of the RAW
        // DELEGATION PROMPT, and the producer ships `name` verbatim — so the
        // agent row is a prompt-class channel. ISS-6894 removed the sibling
        // `task` field from the wire entirely; `name` is what still carries it.
        name: "clsentinel-delegation-prompt",
        type: "subagent",
        // whitlockk review: the AGENT axis, not the session lifecycle one. The
        // hydrator copies `agentRow.status` verbatim (`sync-source.ts`), and
        // that column speaks `DESKTOP_AGENT_STATUS` — working/waiting/running/
        // completed/error. `SyncedAgentSessionAgent.status` is typed bare
        // `string`, so a session-lifecycle `active` here typechecked while
        // giving the probe a value production can never emit.
        status: DESKTOP_AGENT_STATUS.WORKING,
        task: "clsentinel-agent-task",
        // ISS-8014: `buildSubagentMetadata` spreads the parser's own
        // `subagent.metadata` into this blob, so its key set is open exactly the
        // way the session blob's is.
        metadata: {
          clsentinelAgentChannel: `clsentinel-agent-metadata ${SECRET_IN_AGENT_METADATA}`,
          // ISS-7775 (davetho): the root-key collision with a SESSION
          // structural path — see `AGENT_METADATA_COLLIDING_STRUCTURAL_KEY`.
          [AGENT_METADATA_COLLIDING_STRUCTURAL_KEY]:
            "clsentinel-agent-path-collision",
        },
      },
    ],
    events: [
      {
        externalEventId: "probe-event",
        agentExternalId: "probe-agent",
        eventType: "tool_use",
        toolName: "clsentinel-tool-name",
        createdAt: at,
        summary: "clsentinel-event-summary",
        data: {
          input: "clsentinel-tool-input",
          content: "clsentinel-file-content",
        },
      },
    ],
  };
}
