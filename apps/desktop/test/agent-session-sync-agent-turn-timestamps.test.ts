/**
 * @file agent-session-sync-agent-turn-timestamps.test.ts
 * @description ISS-9864 — the producer half of the agent-turn fix, the twin of
 * the ISS-7896 block in agent-session-sync-sanitization.test.ts (split out
 * because that file is already past the 500-line smell).
 *
 * `metadata.messages` is compacted to the first `MAX_METADATA_MESSAGES` (100),
 * which is why the cloud heatmap's legacy Agent arm under-counted; the derived
 * key must carry EVERY agent turn past that point or the fix does nothing. Every
 * case here goes through `sanitizeSessionForSync`, the production entry point,
 * so the D2 token-event gate is exercised where it is actually wired.
 */
import assert from "node:assert/strict";
import { SESSION_STATUS } from "@repo/api/src/types/session-status.js";
import {
  AGENT_TURN_TIMESTAMPS_METADATA_KEY,
  MAX_METADATA_AGENT_TURN_TIMESTAMPS,
} from "@repo/lib/agent-sessions/agent-turn-timestamps.js";
import { HUMAN_TURN_TIMESTAMPS_METADATA_KEY } from "@repo/lib/agent-sessions/human-turn-timestamps.js";
import {
  MAX_METADATA_KEYS,
  MetadataContentPolicy,
} from "@repo/lib/agent-sessions/metadata-preview.js";
import { test } from "vitest";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { sanitizeSessionForSync } from "../src/main/agent-sync/agent-session-sync-payload.js";

const CANONICAL_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STAMP = (i: number) =>
  `2026-06-15T${String(i % 24).padStart(2, "0")}:${String(Math.floor(i / 24) % 60).padStart(2, "0")}:00.000Z`;

function baseSession(): SyncedAgentSession {
  return {
    externalSessionId: "legacy-agent-turns",
    status: SESSION_STATUS.INACTIVE,
    harness: "codex",
    cwd: "/project",
    startedAt: "2026-06-15T00:00:00.000Z",
    updatedAt: "2026-06-15T12:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
  };
}

/**
 * A token-event-less session with `assistantCount` assistant rows — the shape
 * the cloud counts on its `$.messages` fallback — plus 150 human rows so the
 * array sits well past the compaction cap.
 */
function sessionWithAgentTurns(
  assistantCount: number,
  extra: Record<string, unknown> = {}
): SyncedAgentSession {
  return {
    ...baseSession(),
    metadata: {
      gitBranch: "main",
      messages: [
        ...Array.from({ length: assistantCount }, (_, i) => ({
          role: "assistant",
          timestamp: STAMP(i),
        })),
        ...Array.from({ length: 150 }, () => ({
          role: "human",
          timestamp: "2026-06-15T23:00:00.000Z",
        })),
      ],
      ...extra,
    } as SyncedAgentSession["metadata"],
  };
}

/** The same session with an array already sitting on the agent key. */
function withExistingAgentKey(
  session: SyncedAgentSession,
  existing: unknown
): SyncedAgentSession {
  return {
    ...session,
    metadata: {
      ...(session.metadata as Record<string, unknown>),
      [AGENT_TURN_TIMESTAMPS_METADATA_KEY]: existing,
    } as SyncedAgentSession["metadata"],
  };
}

function derivedAgentTimestamps(session: SyncedAgentSession): unknown {
  const sanitized = sanitizeSessionForSync(
    session,
    MetadataContentPolicy.Retain
  );
  return (sanitized.metadata as Record<string, unknown>)[
    AGENT_TURN_TIMESTAMPS_METADATA_KEY
  ];
}

test("ISS-9864: derived agent timestamps survive past the 100-message compaction cap", () => {
  const assistantCount = 250;
  const sanitized = sanitizeSessionForSync(
    sessionWithAgentTurns(assistantCount),
    MetadataContentPolicy.Retain
  );
  const metadata = sanitized.metadata as Record<string, unknown>;
  const derived = metadata[AGENT_TURN_TIMESTAMPS_METADATA_KEY] as string[];

  // The whole point: `messages` is still capped, the derived key is not.
  assert.equal((metadata.messages as unknown[]).length, 100);
  assert.equal(derived.length, assistantCount);
  assert.equal(derived[0], STAMP(0));
  assert.equal(derived.at(-1), STAMP(assistantCount - 1));
  // Every unit is a real instant a reader buckets by hour, in the UTC form
  // both surfaces agree on.
  for (const unit of derived) {
    assert.match(unit, CANONICAL_INSTANT_RE);
  }
});

test("ISS-9864: the key is OMITTED, and a stale array stripped, when the session synced token events (D2)", () => {
  // The cloud splits its Agent half on `NOT EXISTS (agent_session_token_events)`
  // and reads this key only on the fallback side, so on a round-trip session
  // the key would be bytes replicated into every chunk that nothing reads.
  const withTokenEvents: SyncedAgentSession = {
    ...withExistingAgentKey(sessionWithAgentTurns(250), [STAMP(0)]),
    tokenEvents: [
      {
        externalEventId: "te-1",
        model: "m",
        createdAt: "2026-06-15T01:00:00.000Z",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ],
  };
  assert.equal(derivedAgentTimestamps(withTokenEvents), undefined);
  // The human key is untouched by the gate — it has no such split.
  const humanKey = (
    sanitizeSessionForSync(withTokenEvents, MetadataContentPolicy.Retain)
      .metadata as Record<string, unknown>
  )[HUMAN_TURN_TIMESTAMPS_METADATA_KEY];
  assert.ok(Array.isArray(humanKey));
  assert.equal(humanKey.length, 150);
  // An EMPTY `tokenEvents` is the same fact as an absent one (the hydration
  // omits the field when the table has no rows).
  assert.equal(
    (
      derivedAgentTimestamps({
        ...sessionWithAgentTurns(5),
        tokenEvents: [],
      }) as string[]
    ).length,
    5
  );
});

test("ISS-9864: an interactive session with no assistant rows derives an EMPTY key, not none", () => {
  // `[]` is authoritative on the cloud (zero agent cells, matching the desktop);
  // absence would fall back to `$.messages`, which also has none — but the
  // distinction is the contract, and a headless session below shows why.
  assert.deepEqual(derivedAgentTimestamps(sessionWithAgentTurns(0)), []);
});

test("ISS-9864: a headless session's injected prompts ride the agent key", () => {
  // FEA-2641 promotion, preserved: `collectHumanTurnUnits` suppresses these on
  // the human side, so this key is the only thing that homes them.
  const sanitized = sanitizeSessionForSync(
    sessionWithAgentTurns(3, { entrypoint: "codex exec" }),
    MetadataContentPolicy.Retain
  );
  const metadata = sanitized.metadata as Record<string, unknown>;
  assert.equal(
    (metadata[AGENT_TURN_TIMESTAMPS_METADATA_KEY] as string[]).length,
    3 + 150
  );
  assert.deepEqual(metadata[HUMAN_TURN_TIMESTAMPS_METADATA_KEY], []);
});

test("ISS-9864: re-sanitizing DROPS the key rather than trusting the prior array", () => {
  // Same abstention as the human key (davetho, #6116): a second pass sees
  // `messages` already capped, so neither candidate is provable.
  const once = sanitizeSessionForSync(
    sessionWithAgentTurns(250),
    MetadataContentPolicy.Retain
  );
  const twice = sanitizeSessionForSync(once, MetadataContentPolicy.Retain);
  assert.equal(
    (twice.metadata as Record<string, unknown>)[
      AGENT_TURN_TIMESTAMPS_METADATA_KEY
    ],
    undefined
  );
});

test("ISS-9864: any unattributable array over a capped messages drops the key", () => {
  const session = sessionWithAgentTurns(5);
  const real = derivedAgentTimestamps(session) as string[];
  assert.equal(real.length, 5);
  for (const existing of [
    [...real, ...Array.from({ length: 45 }, (_, i) => STAMP(100 + i))],
    Array.from({ length: 50 }, () => "not-a-timestamp"),
    [],
  ]) {
    assert.equal(
      derivedAgentTimestamps(withExistingAgentKey(session, existing)),
      undefined,
      `existing=${JSON.stringify(existing).slice(0, 40)}`
    );
  }
});

test("ISS-9864: an UNCAPPED derivation replaces any existing array outright", () => {
  const session: SyncedAgentSession = {
    ...baseSession(),
    metadata: {
      gitBranch: "main",
      messages: Array.from({ length: 5 }, (_, i) => ({
        role: "assistant",
        timestamp: STAMP(i),
      })),
    } as SyncedAgentSession["metadata"],
  };
  const foreign = Array.from({ length: 50 }, (_, i) => STAMP(100 + i));
  const derived = derivedAgentTimestamps(
    withExistingAgentKey(session, foreign)
  ) as string[];
  assert.equal(derived.length, 5);
  assert.equal(
    derived.some((t) => foreign.includes(t)),
    false
  );
});

test("ISS-9864: a session past the entry cap omits the key entirely rather than truncating", () => {
  const session = sessionWithAgentTurns(MAX_METADATA_AGENT_TURN_TIMESTAMPS + 1);
  assert.equal(derivedAgentTimestamps(session), undefined);
  // ...and a stale array does not survive in its place.
  assert.equal(
    derivedAgentTimestamps(withExistingAgentKey(session, [STAMP(0)])),
    undefined
  );
});

test("ISS-9864: a timestamp the key cannot carry suppresses it for the whole session, stripping any stale array", () => {
  const derived = derivedAgentTimestamps({
    ...baseSession(),
    metadata: {
      gitBranch: "main",
      messages: [
        { role: "assistant", timestamp: STAMP(0) },
        // PostgreSQL accepts ISO-basic, the key's grammar does not.
        { role: "assistant", timestamp: "20260615" },
      ],
      [AGENT_TURN_TIMESTAMPS_METADATA_KEY]: [STAMP(1), STAMP(2)],
    } as SyncedAgentSession["metadata"],
  });
  assert.equal(derived, undefined);
});

test("ISS-9864: on a blob one short of the key window, the human key survives and the agent key falls off", () => {
  // The producer appends human first, agent last. On a blob
  // that already carries MAX_METADATA_KEYS - 1 keys, exactly one derived key
  // fits: the human one. The agent key drops and the cloud reads
  // `$.messages` for agent turns, exactly as today — never a REAL key.
  const filler = Object.fromEntries(
    Array.from({ length: MAX_METADATA_KEYS - 2 }, (_, i) => [`k${i}`, i])
  );
  // 78 filler keys + `messages` = 79: room for exactly one derived key.
  const sanitized = sanitizeSessionForSync(
    {
      ...baseSession(),
      metadata: {
        ...filler,
        messages: [
          { role: "human", timestamp: STAMP(0) },
          { role: "assistant", timestamp: STAMP(1) },
        ],
      } as SyncedAgentSession["metadata"],
    },
    MetadataContentPolicy.Retain
  );
  const metadata = sanitized.metadata as Record<string, unknown>;
  assert.equal(Object.keys(metadata).length, MAX_METADATA_KEYS);
  assert.deepEqual(metadata[HUMAN_TURN_TIMESTAMPS_METADATA_KEY], [STAMP(0)]);
  assert.equal(metadata[AGENT_TURN_TIMESTAMPS_METADATA_KEY], undefined);
  assert.equal(metadata.k77, 77);
});
