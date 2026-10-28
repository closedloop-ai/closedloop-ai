import { describe, expect, it } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  type AgentComponentInvocationSyncItem,
} from "../agent-component-invocation.ts";
import {
  item,
  part,
} from "../agent-component-invocation-schema.test-helpers.ts";
import {
  agentComponentInvocationSyncBatchSchema,
  canonicalizeAgentComponentInvocationSyncItem,
} from "../agent-component-invocation-schema.ts";
import { PG_TIMESTAMP_MIN_MS } from "../pg-timestamp-floor.ts";
import { NUL_CHARACTER, PostgresTextRejection } from "../postgres-text.ts";
import { TimestampRejection } from "../sync-timestamp.ts";
import { findIssue } from "../zod-issue.test-helpers.ts";

// ISS-9174. Every value Postgres refuses at the invocation write used to clear
// this schema, throw inside the ingest transaction, and come back to the desktop
// as a TRANSIENT `ingestion_failed` that retried forever and blocked the session.
// The boundary now REJECTS those values — and only rejects, never rewrites, so
// the bytes the producer hashed are the bytes the server rehashes.
const LONE_HIGH_SURROGATE = String.fromCharCode(0xd8_3d);
const AT_FLOOR = new Date(PG_TIMESTAMP_MIN_MS).toISOString();
const BELOW_FLOOR = new Date(PG_TIMESTAMP_MIN_MS - 1).toISOString();
const ITEM_PATH = ["parts", 0, "items", 0] as const;

describe("invocation sync schema — Postgres text bounds (ISS-9174)", () => {
  it.each([
    ["rawName", { rawName: `code-rev${NUL_CHARACTER}iewer` }, ["rawName"]],
    [
      "definitionContent",
      { definitionContent: `---${NUL_CHARACTER}name: x` },
      ["definitionContent"],
    ],
    [
      "anchor.eventId",
      {
        anchor: {
          kind: AgentComponentInvocationAnchorKind.Event,
          eventId: `ev${NUL_CHARACTER}1`,
        },
      },
      ["anchor", "eventId"],
    ],
  ])(
    "rejects a NUL in %s at the item path with contains_nul and nothing else",
    (_label, overrides, subPath) => {
      const issues = issuesFor(
        batch([{ ...item("invocation-1"), ...overrides }])
      );

      expect(messagesAt(issues, [...ITEM_PATH, ...subPath])).toEqual([
        PostgresTextRejection.ContainsNul,
      ]);
    }
  );

  // `toContain`, not `toEqual`: whether `invalid_date` ALSO fires on a
  // NUL-bearing date string is the engine's call (V8 tolerates a trailing NUL
  // today), and this contract is only that the NUL is named.
  it.each([
    [
      "a NUL-suffixed invokedAt",
      { invokedAt: `2026-07-22T16:00:00.000Z${NUL_CHARACTER}` },
      ["invokedAt"],
    ],
    [
      "a NUL-suffixed anchor.timestamp, which lands in jsonb",
      {
        anchor: {
          kind: AgentComponentInvocationAnchorKind.Timestamp,
          timestamp: `2026-07-22T16:00:00.000Z${NUL_CHARACTER}`,
          ordinal: 0,
        },
      },
      ["anchor", "timestamp"],
    ],
  ])(
    "rejects %s at the item path with contains_nul",
    (_label, overrides, subPath) => {
      const issues = issuesFor(
        batch([{ ...item("invocation-1"), ...overrides }])
      );

      expect(messagesAt(issues, [...ITEM_PATH, ...subPath])).toContain(
        PostgresTextRejection.ContainsNul
      );
    }
  );

  it("rejects a NUL in the part-level externalSessionId with contains_nul", () => {
    // `sourceSessionId` carries the same NUL because the part cross-checks the
    // two for equality; this case is about the part-level field.
    const nulSessionId = `session${NUL_CHARACTER}1`;
    const issues = issuesFor(
      batch([{ ...item("invocation-1"), sourceSessionId: nulSessionId }], {
        externalSessionId: nulSessionId,
      })
    );

    expect(findIssue(issues, ["parts", 0, "externalSessionId"])?.message).toBe(
      PostgresTextRejection.ContainsNul
    );
  });

  it("rejects a NUL-suffixed part-level sourceUpdatedAt with contains_nul", () => {
    const issues = issuesFor(
      batch([item("invocation-1")], {
        sourceUpdatedAt: `2026-07-22T16:00:00.000Z${NUL_CHARACTER}`,
      })
    );

    expect(messagesAt(issues, ["parts", 0, "sourceUpdatedAt"])).toContain(
      PostgresTextRejection.ContainsNul
    );
  });

  it.each([
    ["rawName", { rawName: `code${LONE_HIGH_SURROGATE}` }, ["rawName"]],
    [
      "definitionContent",
      { definitionContent: `body ${LONE_HIGH_SURROGATE}` },
      ["definitionContent"],
    ],
  ])(
    "rejects a lone surrogate in %s with contains_lone_surrogate",
    (_label, overrides, subPath) => {
      const issues = issuesFor(
        batch([{ ...item("invocation-1"), ...overrides }])
      );

      expect(findIssue(issues, [...ITEM_PATH, ...subPath])?.message).toBe(
        PostgresTextRejection.ContainsLoneSurrogate
      );
    }
  );

  it("rejects a below-floor part sourceUpdatedAt at the part path", () => {
    const issues = issuesFor(
      batch([item("invocation-1")], { sourceUpdatedAt: BELOW_FLOOR })
    );

    expect(messagesAt(issues, ["parts", 0, "sourceUpdatedAt"])).toEqual([
      TimestampRejection.BelowTimestampFloor,
    ]);
  });

  it("rejects a below-floor invokedAt at the item path", () => {
    const issues = issuesFor(
      batch([{ ...item("invocation-1"), invokedAt: BELOW_FLOOR }])
    );

    expect(messagesAt(issues, [...ITEM_PATH, "invokedAt"])).toEqual([
      TimestampRejection.BelowTimestampFloor,
    ]);
  });

  it.each(["sourceModifiedAt", "capturedAt"] as const)(
    "rejects a below-floor %s at the item path",
    (field) => {
      // Provenance timestamps ride only definition-bearing kinds, so the
      // fixture is a skill; the kind rules are pinned by the main schema suite.
      const issues = issuesFor(
        batch([{ ...skillItem("invocation-1"), [field]: BELOW_FLOOR }])
      );

      expect(messagesAt(issues, [...ITEM_PATH, field])).toEqual([
        TimestampRejection.BelowTimestampFloor,
      ]);
    }
  );

  it("accepts the floor instant itself on every timestamp column", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse(
      batch(
        [
          {
            ...skillItem("invocation-1"),
            invokedAt: AT_FLOOR,
            sourceModifiedAt: AT_FLOOR,
            capturedAt: AT_FLOOR,
          },
        ],
        { sourceUpdatedAt: AT_FLOOR }
      )
    );

    expect(parsed.success).toBe(true);
  });

  it("does NOT apply the floor to anchor.timestamp, which lands in jsonb", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse(
      batch([
        {
          ...item("invocation-1"),
          anchor: {
            kind: AgentComponentInvocationAnchorKind.Timestamp,
            timestamp: BELOW_FLOOR,
            ordinal: 0,
          },
        },
      ])
    );

    expect(parsed.success).toBe(true);
  });

  it("reports a malformed timestamp as invalid_date only, never as below the floor", () => {
    const issues = issuesFor(
      batch([{ ...item("invocation-1"), invokedAt: "not-a-date" }])
    );

    expect(messagesAt(issues, [...ITEM_PATH, "invokedAt"])).toEqual([
      TimestampRejection.InvalidDate,
    ]);
  });

  it("returns an accepted part deep-equal to its input — refines rewrite nothing", () => {
    const payload = batch([
      {
        ...skillItem("invocation-1"),
        invokedAt: AT_FLOOR,
        sourceModifiedAt: "2026-07-22T15:00:00.000Z",
        capturedAt: "2026-07-22T16:00:00.000Z",
      },
    ]);

    const parsed = agentComponentInvocationSyncBatchSchema.safeParse(payload);

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(payload);
  });

  it("still trims an ACCEPTED padded string — the text refines sit on top of the base, not instead of it", () => {
    const canonical = canonicalizeAgentComponentInvocationSyncItem({
      ...item("invocation-1"),
      componentKey: "  Read  ",
    });

    expect(canonical.componentKey).toBe("Read");
  });

  it("hands a rejected item back from the canonicalizer untouched, padding included", () => {
    // The documented reject-path contract: a rejected item comes back RAW so the
    // producer's contract check names the real failing field, and the repair
    // sweep classifies the generation `unrepairable` instead of rehashing it.
    const rejected: AgentComponentInvocationSyncItem = {
      ...item("invocation-1"),
      rawName: `code-rev${NUL_CHARACTER}iewer`,
      componentKey: "  Read  ",
    };

    const canonical = canonicalizeAgentComponentInvocationSyncItem(rejected);

    expect(canonical).toBe(rejected);
    expect(canonical.componentKey).toBe("  Read  ");
  });
});

/** A skill-kind item, the shape allowed to carry provenance timestamps. */
function skillItem(externalInvocationId: string) {
  return {
    ...item(externalInvocationId),
    kind: AgentComponentInvocationKind.Skill,
    componentKey: "commit",
    status: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
    definitionHash: "d".repeat(64),
    normalizerContractVersion: 1,
  };
}

function batch(items: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
    parts: [{ ...part(items), ...overrides }],
  };
}

function issuesFor(payload: unknown) {
  const parsed = agentComponentInvocationSyncBatchSchema.safeParse(payload);
  if (parsed.success) {
    throw new Error("expected the boundary to reject this payload");
  }
  return parsed.error.issues;
}

/**
 * Every message raised at one exact path, where {@link findIssue} returns only
 * the first — the assertions below turn on WHICH rules fired, and how many.
 */
function messagesAt(
  issues: { path: PropertyKey[]; message: string }[],
  path: PropertyKey[]
) {
  return issues
    .filter((issue) => JSON.stringify(issue.path) === JSON.stringify(path))
    .map((issue) => issue.message);
}
