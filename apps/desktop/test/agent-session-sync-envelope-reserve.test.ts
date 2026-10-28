/**
 * ISS-8327 — the sync batch envelope reserve, measured against the envelope the
 * production builder actually emits.
 *
 * Every case here fails against the pre-fix arithmetic (a hand-written literal
 * that reserved 126 bytes for a 200-byte envelope), which is the point: the
 * defect was silent because nothing on the desktop side ever compared the two.
 */
import assert from "node:assert/strict";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import {
  DATA_SYNC_LEVELS,
  type DataSyncLevel,
} from "@repo/api/src/types/data-sync-level";
import { describe, test } from "vitest";
import {
  SESSION_PAYLOAD_BYTE_CAP,
  SESSION_PAYLOAD_CONTENT_BYTE_CAP,
} from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import {
  type AgentSessionSyncBatchInput,
  buildAgentSessionSyncBatch,
  type SyncedAgentSession,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  AGENT_SESSION_SYNC_BATCH_ENVELOPE_BYTES,
  maxSessionPayloadBytesForBatch,
} from "../src/main/agent-sync/agent-session-sync-envelope-reserve.js";
import {
  estimateAgentSessionSyncBatchBytes,
  estimateSessionPayloadBytes,
  prepareAgentSessionPayload,
} from "../src/main/agent-sync/agent-session-sync-payload.js";

const BATCH_ID = "11111111-2222-4333-8444-555555555555";
/** Enough tool-use events that the session cannot ship in one part. */
const EVENT_HEAVY_COUNT = 4000;

describe("ISS-8327: the reserve is derived from the emitted envelope", () => {
  test("no envelope the builder can emit exceeds the reserve", () => {
    const oversized = everyEnvelopeShape()
      .map((input) => ({
        input,
        bytes: estimateAgentSessionSyncBatchBytes(
          buildAgentSessionSyncBatch(input)
        ),
      }))
      .filter(({ bytes }) => bytes > AGENT_SESSION_SYNC_BATCH_ENVELOPE_BYTES)
      .map(
        ({ input, bytes }) =>
          `${input.syncMode}/compress=${input.compress}/level=${String(input.dataSyncLevel)}: ${bytes}B`
      );
    assert.deepEqual(
      oversized,
      [],
      `these envelope shapes are wider than the ${AGENT_SESSION_SYNC_BATCH_ENVELOPE_BYTES}-byte reserve, so a part packed to the remaining budget crosses the route cap once wrapped`
    );
  });

  test("the reserve is the WIDEST such envelope, not a padded guess", () => {
    // Without this the case above is satisfied by any arbitrarily large reserve,
    // which would silently spend session budget nothing needs.
    const widest = Math.max(
      ...everyEnvelopeShape().map((input) =>
        estimateAgentSessionSyncBatchBytes(buildAgentSessionSyncBatch(input))
      )
    );
    assert.equal(widest, AGENT_SESSION_SYNC_BATCH_ENVELOPE_BYTES);
  });

  test("a legacy-shaped envelope — no encoding, no level — is covered too", () => {
    // Version skew: an older desktop omits `encoding` and `dataSyncLevel`
    // entirely, and this build still emits that exact shape whenever gzip was not
    // negotiated and no level is wired. The reserve is a MAX over the domain, so
    // the narrow shape under-fills rather than over-fills — and the absent fields
    // stay OMITTED rather than serialized as `null`, which is what a server
    // predating them expects.
    const legacy = buildAgentSessionSyncBatch({
      batchId: BATCH_ID,
      syncMode: AgentSessionSyncMode.Incremental,
      sessions: [],
      compress: false,
      dataSyncLevel: undefined,
    });
    assert.equal(Object.hasOwn(legacy, "encoding"), false);
    assert.equal(Object.hasOwn(legacy, "dataSyncLevel"), false);
    assert.ok(
      estimateAgentSessionSyncBatchBytes(legacy) <=
        AGENT_SESSION_SYNC_BATCH_ENVELOPE_BYTES
    );
  });
});

describe("ISS-8327: the content budget is exact at the route cap", () => {
  test("a session filling the budget exactly lands ON the route cap", () => {
    const session = sessionOfExactBytes(SESSION_PAYLOAD_CONTENT_BYTE_CAP);
    assert.equal(
      estimateSessionPayloadBytes(session),
      SESSION_PAYLOAD_CONTENT_BYTE_CAP,
      "the fixture must sit ON the budget or this proves nothing about the boundary"
    );
    assert.equal(
      widestWrappedBytes(session),
      SESSION_PAYLOAD_BYTE_CAP,
      `a session sized to exactly the ${SESSION_PAYLOAD_CONTENT_BYTE_CAP}-byte budget must wrap to exactly the ${SESSION_PAYLOAD_BYTE_CAP}-byte route cap: over means the reserve is short, under means it spends session budget nothing needs`
    );
  });

  test("one byte past the budget crosses the route cap", () => {
    const session = sessionOfExactBytes(SESSION_PAYLOAD_CONTENT_BYTE_CAP + 1);
    assert.equal(
      widestWrappedBytes(session),
      SESSION_PAYLOAD_BYTE_CAP + 1,
      "the budget is not the true boundary — a one-byte-oversize session still fits, so the reserve is padded"
    );
  });

  test("a cap narrower than the envelope yields no budget rather than a negative one", () => {
    assert.equal(
      maxSessionPayloadBytesForBatch(
        AGENT_SESSION_SYNC_BATCH_ENVELOPE_BYTES - 1
      ),
      0
    );
  });
});

describe("ISS-8327: the session sync lane's parts fit the route cap", () => {
  /**
   * Lane wiring, NOT the boundary proof. A packer fills to within one event of
   * its budget, so where the last part lands inside that ~79-byte granularity is
   * a property of the fixture — an under-reserve narrower than one event can
   * escape this case. The deterministic proof that the budget is right is the
   * exact-bytes pair above; this pins that the lane packs against that budget
   * and that what it emits is wrappable.
   */
  test("every chunk of an oversized session fits once wrapped", () => {
    const prepared = prepareAgentSessionPayload(
      eventHeavySession(),
      SESSION_PAYLOAD_CONTENT_BYTE_CAP
    );
    assert.ok(
      prepared.kind === "chunked",
      `the fixture prepared as "${prepared.kind}", so it no longer exercises the packed-to-budget parts this guards`
    );
    const parts = [prepared.firstChunk, ...prepared.remainingChunks];

    // POSITIVE CONTROL. Without it a packer emitting tiny parts would satisfy
    // "everything fits" while proving nothing about the boundary.
    const partContentBytes = parts.map((part) =>
      estimateSessionPayloadBytes(part)
    );
    assert.ok(
      Math.max(...partContentBytes) >
        SESSION_PAYLOAD_CONTENT_BYTE_CAP -
          2 * AGENT_SESSION_SYNC_BATCH_ENVELOPE_BYTES,
      `the largest part (${Math.max(...partContentBytes)} bytes) does not approach the ${SESSION_PAYLOAD_CONTENT_BYTE_CAP}-byte budget, so this test would pass against a lane that still over-packs`
    );

    const overCap = parts
      .map((part) => widestWrappedBytes(part))
      .filter((bytes) => bytes > SESSION_PAYLOAD_BYTE_CAP);
    assert.deepEqual(
      overCap,
      [],
      `chunks exceeded the ${SESSION_PAYLOAD_BYTE_CAP}-byte route cap once wrapped in their batch envelope, so the split is sized against a reserve narrower than the envelope \`buildAgentSessionSyncBatch\` actually emits`
    );
  });

  test("the shared content cap is what the reserve leaves behind", () => {
    // Production wiring: `SESSION_PAYLOAD_CONTENT_BYTE_CAP` is the number both
    // the bulk lane and the trace-comment recovery lane pack against, so a fix
    // that only corrected the local constant would leave it wrong.
    assert.equal(
      SESSION_PAYLOAD_CONTENT_BYTE_CAP,
      SESSION_PAYLOAD_BYTE_CAP - AGENT_SESSION_SYNC_BATCH_ENVELOPE_BYTES
    );
  });
});

/**
 * The widest serialized batch `session` can produce, over every envelope shape —
 * the number the route actually judges.
 */
function widestWrappedBytes(session: SyncedAgentSession): number {
  return Math.max(
    ...everyEnvelopeShape().map((input) =>
      estimateAgentSessionSyncBatchBytes(
        buildAgentSessionSyncBatch({ ...input, sessions: [session] })
      )
    )
  );
}

/** Every envelope shape the builder can emit, with no sessions inside. */
function everyEnvelopeShape(): AgentSessionSyncBatchInput[] {
  const levels: (DataSyncLevel | undefined)[] = [
    undefined,
    ...DATA_SYNC_LEVELS,
  ];
  return Object.values(AgentSessionSyncMode).flatMap((syncMode) =>
    [false, true].flatMap((compress) =>
      levels.map((dataSyncLevel) => ({
        batchId: BATCH_ID,
        syncMode,
        sessions: [],
        compress,
        dataSyncLevel,
      }))
    )
  );
}

function baseSession(): SyncedAgentSession {
  return {
    externalSessionId: "envelope-reserve-session",
    status: "completed",
    harness: "codex",
    cwd: "/workspace/envelope-reserve",
    startedAt: "2026-06-08T12:00:00.000Z",
    updatedAt: "2026-06-08T12:01:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
  };
}

function eventHeavySession(): SyncedAgentSession {
  return {
    ...baseSession(),
    events: Array.from({ length: EVENT_HEAVY_COUNT }, (_, index) => ({
      externalEventId: `envelope-reserve-event-${String(index).padStart(6, "0")}`,
      eventType: "ToolUse",
      toolName: "Read",
      createdAt: "2026-06-08T12:00:30.000Z",
    })),
  };
}

/**
 * A session whose serialized size is EXACTLY `targetBytes`, grown by padding
 * `name` — one ASCII character is one serialized byte, so the padding length is
 * the shortfall.
 */
function sessionOfExactBytes(targetBytes: number): SyncedAgentSession {
  const withName: SyncedAgentSession = { ...baseSession(), name: "" };
  const shortfall = targetBytes - estimateSessionPayloadBytes(withName);
  if (shortfall < 0) {
    throw new Error(
      `base session is ${-shortfall} bytes past the ${targetBytes}-byte target, so it cannot be padded to it`
    );
  }
  return { ...withName, name: "n".repeat(shortfall) };
}
