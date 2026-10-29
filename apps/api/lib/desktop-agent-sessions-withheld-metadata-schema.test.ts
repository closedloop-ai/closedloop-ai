/**
 * ISS-8641 / ISS-8714: the wire contract accepts `metadataWithheldKeys`, the list
 * a desktop stamps naming the `metadata` keys ISS-7997's degrade held back.
 *
 * Both skew directions matter. An old desktop omits the field, which must keep
 * parsing and must read as "no declaration" — absence is what every installed
 * build sends, so it may never become ambiguous. A new desktop sets it, and the
 * parsed payload must preserve the value or the whole signal dies at the ingress
 * boundary before the merge can ever see it.
 *
 * The third direction is the one this field adds: the array is UNTRUSTED input
 * that feeds a merge which reinstates stored keys, so a violating list must cost
 * the HINT and never the session.
 *
 * DB-free: exercises only `parseDesktopAgentSessionsPayload`.
 */
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import {
  MAX_METADATA_KEYS,
  MAX_METADATA_STRING_CHARS,
} from "@repo/lib/agent-sessions/metadata-preview";
import { describe, expect, it } from "vitest";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  parseDesktopAgentSessionsPayload,
} from "./desktop-agent-sessions-schema";

function buildPayload(session: Record<string, unknown>): unknown {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "00000000-0000-4000-8000-000000000003",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [
      {
        externalSessionId: "sess-withheld",
        status: "active",
        startedAt: "2026-08-10T10:00:00.000Z",
        updatedAt: "2026-08-10T11:00:00.000Z",
        agents: [],
        events: [],
        tokenUsageByModel: [],
        metadata: { entrypoint: "cli" },
        ...session,
      },
    ],
  };
}

/**
 * The single parsed session, THROWING when the payload was rejected.
 *
 * A throw rather than an `expect` here (Biome's `noMisplacedAssertion`), and it
 * is load-bearing, not a workaround for the lint: every case below asserts on the
 * returned session, so a rejected payload fails its case either way — and the
 * message names the rejection, which an assertion on a missing field would not.
 */
function parsedSession(session: Record<string, unknown>) {
  const parsed = parseDesktopAgentSessionsPayload(buildPayload(session));
  if (!parsed.ok) {
    throw new Error(
      "the ingest schema rejected the payload; it must accept the session and drop only the hint"
    );
  }
  return parsed.payload.sessions[0];
}

describe("metadataWithheldKeys on the sync wire (ISS-8641 / ISS-8714)", () => {
  it("preserves a declaration a new desktop sends", () => {
    expect(
      parsedSession({ metadataWithheldKeys: ["usageExtras", "permissionMode"] })
        .metadataWithheldKeys
    ).toEqual(["usageExtras", "permissionMode"]);
  });

  it("parses an older build's payload that omits the field", () => {
    // The field must stay genuinely ABSENT rather than arriving as `null` or
    // `[]`, because the receiver branches on "declared anything at all".
    const session = parsedSession({});
    expect(session.metadataWithheldKeys).toBeUndefined();
    expect(Object.hasOwn(session, "metadataWithheldKeys")).toBe(false);
  });

  it("accepts the session but drops a list past the key cap", () => {
    // Untrusted input feeding a merge. Over-cap could only be noise or an
    // amplification attempt — a persisted blob cannot hold more keys than this —
    // and the safe fallback is today's wholesale replace, not a rejected batch.
    const session = parsedSession({
      metadataWithheldKeys: Array.from(
        { length: MAX_METADATA_KEYS + 1 },
        (_, index) => `k${index}`
      ),
    });

    expect(session.metadataWithheldKeys).toBeUndefined();
    // Positive control: the SESSION survived, which is the half that separates
    // this from a rejection.
    expect(session.externalSessionId).toBe("sess-withheld");
  });

  it("keeps a key name longer than the string-VALUE cap, because the compactor retains one", () => {
    // DELIBERATE REVERSAL of an earlier revision that bounded each element by
    // `MAX_METADATA_STRING_CHARS` (review: chatgpt-codex-connector). That cap
    // bounds string VALUES; `compactMetadataForPreview` never bounds a key NAME,
    // so it retains a 2,000-character key verbatim and the producer can declare
    // it. Because `.catch(undefined)` drops the WHOLE list on any element
    // failure, the old bound cost every withheld key over one long name — and the
    // fallback for a dropped list is the destructive wholesale replace this field
    // exists to prevent. Cardinality is still bounded; length is not.
    const longKey = "a".repeat(MAX_METADATA_STRING_CHARS + 1);
    const session = parsedSession({
      metadataWithheldKeys: [longKey, "usageExtras"],
    });

    expect(session.metadataWithheldKeys).toEqual([longKey, "usageExtras"]);
    expect(session.externalSessionId).toBe("sess-withheld");
  });

  it("keeps an empty-string key, which is a real metadata key the compactor retains", () => {
    // review: whitlockk. `""` survives compaction, so the producer can withhold it
    // and name it. The boundary must not be narrower than what the producer can
    // emit — see `resolveWithheldMetadataKeys` for the receiver's half.
    const session = parsedSession({ metadataWithheldKeys: [""] });

    expect(session.metadataWithheldKeys).toEqual([""]);
  });

  it("accepts the session but drops a list whose elements are not strings", () => {
    // The shape a version-skewed or buggy peer can actually emit. It must not
    // throw, and it must not reach the merge as a half-typed array.
    const session = parsedSession({
      metadataWithheldKeys: [{ key: "usageExtras" }, 7],
    });

    expect(session.metadataWithheldKeys).toBeUndefined();
    expect(session.externalSessionId).toBe("sess-withheld");
  });

  it("accepts the session but drops a value that is not an array at all", () => {
    const session = parsedSession({ metadataWithheldKeys: "usageExtras" });

    expect(session.metadataWithheldKeys).toBeUndefined();
    expect(session.externalSessionId).toBe("sess-withheld");
  });
});
