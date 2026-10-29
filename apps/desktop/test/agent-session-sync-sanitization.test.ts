import assert from "node:assert/strict";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  SessionPrRelationType,
  type SyncedArtifactRef,
  type SyncedSessionPrRef,
} from "@repo/api/src/types/session-artifact-link";
import { AGENT_TURN_TIMESTAMPS_METADATA_KEY } from "@repo/lib/agent-sessions/agent-turn-timestamps.js";
import {
  HUMAN_TURN_TIMESTAMPS_METADATA_KEY,
  MAX_METADATA_HUMAN_TURN_TIMESTAMPS,
} from "@repo/lib/agent-sessions/human-turn-timestamps.js";
import {
  compactMetadataForPreview,
  MetadataContentPolicy,
} from "@repo/lib/agent-sessions/metadata-preview.js";
import { projectAgentSessionTimelineEvents } from "@repo/lib/sessions/agent-session-detail-projection.js";
import { test } from "vitest";
import type {
  AgentSessionSyncBatch,
  SyncedAgentSession,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import { sanitizeSessionForSync } from "../src/main/agent-sync/agent-session-sync-payload.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";

// FEA-2718: every synced event is reconstructed from retained columnar metadata
// only — turn text (`summary`/`data`) never crosses the wire, so the sanitized
// event has exactly these keys and nothing else.
const SLIM_EVENT_KEYS = JSON.stringify(
  [
    "externalEventId",
    "agentExternalId",
    "eventType",
    "toolName",
    "createdAt",
  ].sort()
);

// Boolean-only (no assertions) so callers assert inside their own test() body,
// per Biome's noMisplacedAssertion rule.
function isSlimSyncedEvent(event: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(event, "summary") === false &&
    Object.hasOwn(event, "data") === false &&
    JSON.stringify(Object.keys(event).sort()) === SLIM_EVENT_KEYS
  );
}

test("agent-session sync sends all source sessions with turn-text-free events", async () => {
  const sourceSession = makeSyncedSession();
  const source: AgentSessionSyncSource = {
    listAllSessionCursorRows: () => [
      {
        id: sourceSession.externalSessionId,
        updated_at: sourceSession.updatedAt,
      },
    ],
    listUpdatedSessionCursorRows: () => [],
    loadSyncedSessions: () => [sourceSession],
  };
  const sent: AgentSessionSyncBatch[] = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    sendBatch: async (batch) => {
      sent.push(batch);
      return { accepted: true };
    },
  });

  service.start();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(sent.length, 1);
  const syncedSession = sent[0].sessions[0];
  assert.equal(syncedSession.externalSessionId, "outside-sandbox");
  assert.equal(syncedSession.cwd, "/outside/sandbox/project");
  assert.equal(syncedSession.events.length, 2);
  assert.equal(
    syncedSession.events.every((event) =>
      isSlimSyncedEvent(event as unknown as Record<string, unknown>)
    ),
    true
  );
});

test("sanitizeSessionForSync preserves prRefs and artifactRefs through the spread (ISS-8986 AC 43)", () => {
  const prRefs: SyncedSessionPrRef[] = [
    {
      repositoryFullName: "closedloop-ai/closedloop-ai",
      prNumber: 7,
      prUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/7",
      relationType: SessionPrRelationType.Referenced,
    },
  ];
  const artifactRefs: SyncedArtifactRef[] = [
    {
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      branchName: "feat/iss-8986",
      method: ArtifactRefMethod.McpToolCall,
      relation: ArtifactRefRelation.Created,
    },
  ];
  const session: SyncedAgentSession = {
    ...makeSyncedSession(),
    prRefs,
    artifactRefs,
  };

  const sanitized = sanitizeSessionForSync(
    session,
    MetadataContentPolicy.Retain
  );

  assert.deepEqual(sanitized.prRefs, prRefs);
  assert.deepEqual(sanitized.artifactRefs, artifactRefs);
});

test("sanitizeSessionForSync drops turn text but the desktop-local projection keeps detail", () => {
  const local = makeSyncedSession();
  // ISS-7775: the FEA-2718 event-row strip this asserts is tier-INDEPENDENT, so
  // the widest policy is the strictest test of it — under the withholding policy
  // the metadata half would be empty for a reason this test is not about.
  const sanitized = sanitizeSessionForSync(local, MetadataContentPolicy.Retain);

  assert.equal(
    sanitized.events.every((event) =>
      isSlimSyncedEvent(event as unknown as Record<string, unknown>)
    ),
    true
  );

  // The UNSANITIZED local events still hydrate detail for the local trace...
  const localTimeline = projectAgentSessionTimelineEvents(local.events);
  assert.ok(localTimeline.length > 0);
  assert.equal(
    localTimeline.every((event) => event.detail),
    true
  );
  // ...while the sanitized (cloud) events yield no detail at all.
  assert.equal(
    projectAgentSessionTimelineEvents(sanitized.events).every(
      (event) => event.detail === undefined
    ),
    true
  );
});

// FEAT 019f881c: recognizable secrets in the `metadata.messages[]` text preview
// (the DISPLAY source for the cloud timeline) must be redacted at the producer
// sanitizer boundary so a raw secret never crosses the wire.
test("sanitizeSessionForSync redacts secrets in the metadata.messages mirror", () => {
  const A32 = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
  const session: SyncedAgentSession = {
    ...makeSyncedSession(),
    metadata: {
      messages: [
        {
          role: "user",
          text: `here is my key sk_live_${A32} and token ghp_${A32}0000`,
        },
      ],
    },
  };

  // ISS-7775/ISS-8014: assert redaction where the text is actually RETAINED.
  // Under the withholding policy the preview is absent and "no secret on the
  // wire" would be satisfied by the tier rather than by the redactor.
  const sanitized = sanitizeSessionForSync(
    session,
    MetadataContentPolicy.Retain
  );
  const mirror = JSON.stringify(sanitized.metadata);

  assert.equal(mirror.includes(A32), false);
  assert.equal(mirror.includes("sk_live_"), false);
  assert.equal(mirror.includes("[REDACTED:sk_live]"), true);
  assert.equal(mirror.includes("[REDACTED:ghp]"), true);
});

// FEA-3693: the desktop producer and the cloud persist boundary
// (`sanitizeMetadataForPersist`) must emit byte-identical `metadata` for the same
// normalized transcript. Both now delegate to the ONE shared preview contract
// (`compactMetadataForPreview`), so the desktop `sanitizeSessionForSync` output
// must equal the shared helper's output — including the per-message preview floor
// (a long conversation whose aggregate budget is spent keeps a floor-length
// preview on every later turn rather than dropping `text`, which is what the API
// lane used to do) and the `textTruncation` markers. The API-side half of this
// contract is asserted in
// `apps/api/app/agent-sessions/service/metadata-sanitizer.test.ts`.
//
// ISS-7896 NARROWED that equality to "every key EXCEPT
// `humanTurnTimestamps`", and the exception is a deliberate contract change, not
// a slackened assertion. The producer now DERIVES that key from the session's
// FULL local `messages` array; the persist boundary receives `messages` already
// capped at `MAX_METADATA_MESSAGES` and therefore can only bound the key, never
// recompute it. Equality on the remaining keys is still the FEA-3693 guarantee
// and is still asserted here — the comparison strips exactly one key, so a drift
// in any other key still fails. The derived key's own contract is asserted
// separately below and in `packages/lib/agent-sessions/metadata-preview.test.ts`.
test("sanitizeSessionForSync metadata equals the shared FEA-3693 preview contract on every key except the ISS-7896 derived one (floor + truncation markers)", () => {
  const messages = [
    { role: "user", timestamp: "t0", text: "z".repeat(4096) },
    { role: "assistant", timestamp: "t1" },
    ...Array.from({ length: 100 }, () => ({
      role: "user",
      timestamp: "t2",
      text: "q".repeat(2500),
    })),
  ];
  const session: SyncedAgentSession = {
    ...makeSyncedSession(),
    metadata: { gitBranch: "main", messages } as SyncedAgentSession["metadata"],
  };

  const sanitized = sanitizeSessionForSync(
    session,
    MetadataContentPolicy.Retain
  );
  const {
    [HUMAN_TURN_TIMESTAMPS_METADATA_KEY]: derived,
    [AGENT_TURN_TIMESTAMPS_METADATA_KEY]: derivedAgent,
    ...sharedKeys
  } = sanitized.metadata as Record<string, unknown>;
  assert.deepEqual(
    sharedKeys,
    compactMetadataForPreview(session.metadata, MetadataContentPolicy.Retain)
  );
  // The stripped keys are the TWO the producer derives. This fixture's turns are
  // `role: "user"`, and the human predicate matches `role === "human"` only, so
  // the derivation is legitimately empty here — assert that rather than let the
  // strip above quietly pass over a key that was never produced. The agent key
  // (ISS-9864) is ABSENT: its one assistant row carries `timestamp: "t1"`, which
  // is outside the key grammar, so the whole key is withheld.
  assert.deepEqual(derived, []);
  assert.equal(derivedAgent, undefined);

  // Concretely: every later, budget-exhausted turn keeps the 160-char floor and
  // is truthfully marked `previewed` — never dropped to `undefined`.
  const out = (sanitized.metadata as { messages: Record<string, unknown>[] })
    .messages;
  const last = out.at(-1) as Record<string, unknown>;
  assert.equal(typeof last.text, "string");
  assert.equal((last.text as string).length, 160);
  assert.equal(last.textTruncation, "previewed");
});

function makeSyncedSession(): SyncedAgentSession {
  return {
    externalSessionId: "outside-sandbox",
    status: "completed",
    harness: "codex",
    cwd: "/outside/sandbox/project",
    startedAt: "2026-06-08T12:00:00.000Z",
    updatedAt: "2026-06-08T12:05:00.000Z",
    agents: [],
    events: [
      {
        externalEventId: "event-1",
        eventType: "PostToolUse",
        toolName: "exec_command",
        summary: "raw tool error text",
        createdAt: "2026-06-08T12:01:00.000Z",
        data: {
          arguments: ["-C", "packages/api", "test"],
          command: "pnpm",
          prompt: "run private command",
          content: "file contents",
          new_string: "replacement text",
          old_string: "original text",
          stdout: "command output",
          stderr: "command errors",
          text: "assistant text",
          output: "tool output",
          patch: "diff content",
          reasoning: "hidden reasoning",
          exitCode: 0,
          nested: {
            arguments: ["status", "--short"],
            command: "git",
            prompt: "nested prompt",
            content: "nested content",
            new_string: "nested replacement",
            old_string: "nested original",
            stdout: "nested stdout",
            stderr: "nested stderr",
            text: "nested text",
            output: "nested output",
            patch: "nested diff",
            reasoning: "nested reasoning",
            safe: "preserved",
          },
        },
      },
      {
        externalEventId: "event-2",
        eventType: "PostToolUse",
        toolName: "exec_command",
        summary: "raw command output",
        createdAt: "2026-06-08T12:02:00.000Z",
        data: {
          tool_input: {
            arguments: ["diff", "--stat"],
            executable: "git",
            prompt: "private tool input",
          },
          tool_response: {
            exitCode: 0,
            stdout: "diff output",
          },
        },
      },
    ],
    tokenUsageByModel: [],
  };
}

async function flushAgentSessionSync(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

// ISS-7896 — the producer half of the human-turn fix. `metadata.messages` is
// compacted to the first `MAX_METADATA_MESSAGES` (100), which is why the cloud
// heatmap under-counted; the derived key must carry EVERY human turn past that
// point or the fix does nothing.
function sessionWithHumanTurns(
  humanCount: number,
  extra: Record<string, unknown> = {}
): SyncedAgentSession {
  const messages = [
    ...Array.from({ length: humanCount }, (_, i) => ({
      role: "human",
      timestamp: `2026-06-15T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
    })),
    ...Array.from({ length: 150 }, () => ({
      role: "assistant",
      timestamp: "2026-06-15T23:00:00.000Z",
    })),
  ];
  return {
    ...makeSyncedSession(),
    metadata: {
      gitBranch: "main",
      messages,
      ...extra,
    } as SyncedAgentSession["metadata"],
  };
}

/** A session whose `messages` sits AT the compaction cap. */
function cappedSessionWithHumanTurns(humanCount: number): SyncedAgentSession {
  return sessionWithHumanTurns(humanCount);
}

/** A session whose `messages` sits UNDER the cap, so a derivation is complete. */
function uncappedSessionWithHumanTurns(humanCount: number): SyncedAgentSession {
  return {
    ...makeSyncedSession(),
    metadata: {
      gitBranch: "main",
      messages: Array.from({ length: humanCount }, (_, i) => ({
        role: "human",
        timestamp: `2026-06-15T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
      })),
    } as SyncedAgentSession["metadata"],
  };
}

/** The same session with an array already sitting on the key. */
function withExistingKey(
  session: SyncedAgentSession,
  existing: unknown
): SyncedAgentSession {
  return {
    ...session,
    metadata: {
      ...(session.metadata as Record<string, unknown>),
      [HUMAN_TURN_TIMESTAMPS_METADATA_KEY]: existing,
    } as SyncedAgentSession["metadata"],
  };
}

function derivedTimestamps(session: SyncedAgentSession): unknown {
  const sanitized = sanitizeSessionForSync(
    session,
    MetadataContentPolicy.Retain
  );
  return (sanitized.metadata as Record<string, unknown>)[
    HUMAN_TURN_TIMESTAMPS_METADATA_KEY
  ];
}

test("ISS-7896: derived human timestamps survive past the 100-message compaction cap", () => {
  const humanCount = 250;
  const session = sessionWithHumanTurns(humanCount);

  const sanitized = sanitizeSessionForSync(
    session,
    MetadataContentPolicy.Retain
  );
  const derived = (sanitized.metadata as Record<string, unknown>)[
    HUMAN_TURN_TIMESTAMPS_METADATA_KEY
  ] as string[];

  // The whole point: `messages` is still capped, the derived key is not.
  const compactedMessages = (
    sanitized.metadata as { messages: Record<string, unknown>[] }
  ).messages;
  assert.equal(compactedMessages.length, 100);
  assert.equal(derived.length, humanCount);
  // Chronological head preserved, and these are the real timestamps rather than
  // a count — a reader buckets them by hour.
  assert.equal(derived[0], "2026-06-15T00:00:00.000Z");
  assert.equal(derived.at(-1), "2026-06-15T09:00:00.000Z");
});

test("ISS-7896: a headless session derives no human turns", () => {
  const derived = derivedTimestamps(
    sessionWithHumanTurns(5, { entrypoint: "sdk-python" })
  );
  assert.deepEqual(derived, []);
});

test("ISS-7896: re-sanitizing DROPS the key rather than trusting the prior array", () => {
  // Behavior change (davetho, #6116). This used to assert that a second pass
  // preserved the first pass's 250, which is only satisfiable by trusting an
  // array nothing attributes to this session — the defect below. A second pass
  // sees `messages` already capped, so neither candidate is provable and the
  // key is dropped; the cloud falls back to `$.messages`, this ticket's
  // pre-existing basis. `prepareAgentSessionPayload` sanitizes exactly once, so
  // no production path reaches this.
  const once = sanitizeSessionForSync(
    sessionWithHumanTurns(250),
    MetadataContentPolicy.Retain
  );
  const twice = sanitizeSessionForSync(once, MetadataContentPolicy.Retain);

  assert.equal(
    (twice.metadata as Record<string, unknown>)[
      HUMAN_TURN_TIMESTAMPS_METADATA_KEY
    ],
    undefined
  );
});

test("ISS-7896: a foreign array sharing the real HEAD but not the tail is refused", () => {
  // davetho #6116, the case a prefix comparison cannot catch: the existing
  // array opens with this session's own five normalized timestamps and then
  // carries 45 valid foreign ones. Consistency where two arrays overlap is not
  // provenance, so trusting it would make the cloud authoritative on 50 and
  // over-count by 45.
  const session = cappedSessionWithHumanTurns(5);
  const real = derivedTimestamps(session) as string[] | undefined as string[];
  assert.equal(real.length, 5);

  const derived = derivedTimestamps(
    withExistingKey(session, [
      ...real,
      ...Array.from(
        { length: 45 },
        (_, i) => `2027-03-0${(i % 9) + 1}T08:00:00.000Z`
      ),
    ])
  );

  assert.equal(derived, undefined);
});

test("ISS-7896: any unattributable array over a capped messages drops the key", () => {
  // The general rule the case above is one instance of — a wholly foreign
  // array, and a malformed one, reach the same abstention.
  const session = cappedSessionWithHumanTurns(5);
  for (const existing of [
    Array.from(
      { length: 50 },
      (_, i) => `2026-01-0${(i % 9) + 1}T12:00:00.000Z`
    ),
    Array.from({ length: 50 }, () => "not-a-timestamp"),
    [],
  ]) {
    assert.equal(
      derivedTimestamps(withExistingKey(session, existing)),
      undefined,
      `existing=${JSON.stringify(existing).slice(0, 40)}`
    );
  }
});

test("ISS-7896: an UNCAPPED derivation replaces any existing array outright", () => {
  // Under the compaction cap this pass read `messages` whole, so the derivation
  // is complete by construction and nothing on the blob can beat it — no
  // ambiguity, no abstention.
  const session = uncappedSessionWithHumanTurns(5);
  const foreign = Array.from(
    { length: 50 },
    (_, i) => `2026-01-0${(i % 9) + 1}T12:00:00.000Z`
  );
  const derived = derivedTimestamps(
    withExistingKey(session, foreign)
  ) as string[];

  assert.equal(derived.length, 5);
  assert.equal(
    derived.some((t) => foreign.includes(t)),
    false
  );
});

test("ISS-7896: a first pass over a long session still carries every human turn", () => {
  // The case the ticket exists for, and the one abstention must not touch:
  // `messages` is far over the cap but carries NO prior key, so there is
  // nothing to be ambiguous with and the full derivation is written.
  const derived = derivedTimestamps(sessionWithHumanTurns(250)) as string[];
  assert.equal(derived.length, 250);
});

test("ISS-7896: a session past the entry cap omits the key entirely rather than truncating", () => {
  const derived = derivedTimestamps(
    sessionWithHumanTurns(MAX_METADATA_HUMAN_TURN_TIMESTAMPS + 1)
  );
  // Absent, NOT a 1000-entry prefix: the cloud reads a present array as
  // authoritative, so a truncated one would under-report a session the
  // `$.messages` fallback still counts.
  assert.equal(derived, undefined);
});

test("ISS-7896: an uncarriable unit ALSO strips a pre-existing key", () => {
  // davetho #6116: `deriveHumanTurnTimestamps` returns null for an uncarriable
  // unit, and the early return used to hand the blob back untouched — so the
  // compactor preserved a stale array and the cloud read it as authoritative.
  // This pass has no candidate of its own, so an existing array is the LEAST
  // attributable it can be; it must be dropped, not preserved.
  const stale = Array.from(
    { length: 5 },
    (_, i) => `2026-01-0${i + 1}T12:00:00.000Z`
  );
  const derived = derivedTimestamps({
    ...makeSyncedSession(),
    metadata: {
      gitBranch: "main",
      messages: [
        { role: "human", timestamp: "2026-06-15T10:00:00.000Z" },
        // ISO-basic: PostgreSQL accepts it, the key's grammar does not.
        { role: "human", timestamp: "20260615" },
      ],
      [HUMAN_TURN_TIMESTAMPS_METADATA_KEY]: stale,
    } as SyncedAgentSession["metadata"],
  });
  // Not `stale` (which would report 5) and not a partial — absent, so the cloud
  // falls back to `$.messages` and counts the 2 real turns.
  assert.equal(derived, undefined);
});

test("ISS-7896: a numeric unit ALSO strips a pre-existing key", () => {
  // The other uncarriable form named in the review, on the same null path.
  const derived = derivedTimestamps({
    ...makeSyncedSession(),
    metadata: {
      gitBranch: "main",
      messages: [{ role: "human", timestamp: 1_781_000_000_000 }],
      [HUMAN_TURN_TIMESTAMPS_METADATA_KEY]: [
        "2026-01-01T12:00:00.000Z",
        "2026-01-02T12:00:00.000Z",
      ],
    } as SyncedAgentSession["metadata"],
  });
  assert.equal(derived, undefined);
});

test("ISS-7896: an over-cap derivation ALSO strips a pre-existing key", () => {
  // The second null arm: past MAX_METADATA_HUMAN_TURN_TIMESTAMPS the key is
  // suppressed, and a stale array must not survive in its place.
  const session = sessionWithHumanTurns(MAX_METADATA_HUMAN_TURN_TIMESTAMPS + 1);
  const derived = derivedTimestamps(
    withExistingKey(session, ["2026-01-01T12:00:00.000Z"])
  );
  assert.equal(derived, undefined);
});

test("ISS-7896: a timestamp the key cannot carry suppresses it for the whole session", () => {
  const session = makeSyncedSession();
  const derived = derivedTimestamps({
    ...session,
    metadata: {
      gitBranch: "main",
      messages: [
        { role: "human", timestamp: "2026-06-15T10:00:00.000Z" },
        // PostgreSQL accepts ISO-basic, the key's grammar does not. One
        // uncarryable unit must drop the WHOLE key so the reader falls back to
        // `$.messages`, which still counts it.
        { role: "human", timestamp: "20260615" },
      ],
    } as SyncedAgentSession["metadata"],
  });
  assert.equal(derived, undefined);
});
