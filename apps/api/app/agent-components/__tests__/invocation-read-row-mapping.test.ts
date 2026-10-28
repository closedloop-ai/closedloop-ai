/**
 * ISS-9713 branch coverage for `toInvocationReadRow`, `invocationReadAnchor`,
 * `invocationContractValue`, `requiredAnchorString`, and `requiredAnchorNumber`
 * in invocation-read.ts. Drives the real `loadAgentComponentInvocationReadPage`
 * against a minimal db double returning ONE controlled row per case and
 * asserts the mapped item (or the thrown error), so each assertion pins an
 * observable output rather than merely executing a line.
 */
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it, vi } from "vitest";
import { loadAgentComponentInvocationReadPage } from "../service/invocation-read";

const ORGANIZATION_ID = "org-1";
const KIND = "tool";
const KEY = "my-tool";

type InvocationRowFixture = {
  id: string;
  externalInvocationId: string;
  sourceSessionId: string;
  childSessionId: string | null;
  parentExternalInvocationId: string | null;
  externalAgentId: string | null;
  componentKind: string;
  componentKey: string;
  rawName: string | null;
  normalizedName: string | null;
  relationship: string;
  invokedAt: Date | null;
  sequence: number;
  anchor: unknown;
  providerInvocationId: string | null;
  attributionStatus: string;
  evidenceClass: string;
  definitionHash: string | null;
  normalizerContractVersion: string | null;
  definitionVersionId: string | null;
  sourceOccurrenceId: string | null;
  sourcePath: string | null;
  sourceModifiedAt: Date | null;
  capturedAt: Date | null;
  repositoryFullName: string | null;
  repositoryCommit: string | null;
  packId: string | null;
  branchName: string | null;
  generation: {
    agentSessionId: string;
    session: { externalSessionId: string };
  };
};

function baseInvocationRow(
  overrides: Partial<InvocationRowFixture> = {}
): InvocationRowFixture {
  return {
    id: "invocation-1",
    externalInvocationId: "ext-invocation-1",
    sourceSessionId: "source-session-1",
    childSessionId: null,
    parentExternalInvocationId: null,
    externalAgentId: null,
    componentKind: AgentComponentInvocationKind.Tool,
    componentKey: KEY,
    rawName: null,
    normalizedName: null,
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt: null,
    sequence: 0,
    anchor: { kind: AgentComponentInvocationAnchorKind.Session },
    providerInvocationId: null,
    attributionStatus: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
    definitionHash: null,
    normalizerContractVersion: null,
    definitionVersionId: null,
    sourceOccurrenceId: null,
    sourcePath: null,
    sourceModifiedAt: null,
    capturedAt: null,
    repositoryFullName: null,
    repositoryCommit: null,
    packId: null,
    branchName: null,
    generation: {
      agentSessionId: "session-1",
      session: { externalSessionId: "ext-session-1" },
    },
    ...overrides,
  };
}

async function readSingleRow(row: InvocationRowFixture) {
  const db = {
    agentComponentInvocation: {
      findMany: vi.fn(() => Promise.resolve([row])),
      groupBy: vi.fn(() => Promise.resolve([])),
    },
    sourceOccurrence: { findMany: vi.fn(() => Promise.resolve([])) },
  };
  const page = await loadAgentComponentInvocationReadPage(
    db as unknown as Parameters<typeof loadAgentComponentInvocationReadPage>[0],
    {
      organizationId: ORGANIZATION_ID,
      kind: KIND,
      key: KEY,
      inventoryIds: [],
    }
  );
  return page.items[0];
}

describe("loadAgentComponentInvocationReadPage row mapping", () => {
  // ISS-10714 review (tamsinb): this base row is TOOL kind, and only a subagent
  // invocation ever gets a `parent_external_invocation_id` written for it. Its
  // null parent column therefore means "no linker runs for this kind", not
  // "root", so the read states NO ancestry for it — the `depth: 0` this case
  // expected was a confident false root. The positive `depth: 0` claim is still
  // reachable and is pinned on a subagent row below; the omission contract this
  // case is named for now holds for every optional field without exception.
  it("omits every optional field for a row with no optional data and no source occurrence", async () => {
    const item = await readSingleRow(baseInvocationRow());

    expect(item).toEqual({
      id: "invocation-1",
      externalInvocationId: "ext-invocation-1",
      sessionId: "session-1",
      externalSessionId: "ext-session-1",
      sourceSessionId: "source-session-1",
      kind: AgentComponentInvocationKind.Tool,
      componentKey: KEY,
      relationship: AgentComponentInvocationRelationship.Direct,
      invokedAt: null,
      sequence: 0,
      anchor: { kind: AgentComponentInvocationAnchorKind.Session },
      status: AgentComponentInvocationAttributionStatus.Matched,
      evidenceClass: AgentComponentInvocationEvidenceClass.None,
    });
  });

  it("states a root depth of 0 for a subagent row that records no parent", async () => {
    // The positive claim the contract reserves `depth: 0` for, kept reachable:
    // a subagent IS a kind the parent linker runs for, so its null parent column
    // genuinely means "nothing recorded a call that reached this".
    const item = await readSingleRow(
      baseInvocationRow({
        componentKind: AgentComponentInvocationKind.Subagent,
      })
    );

    expect(item.ancestry).toEqual({ chain: [], depthFromRootInvocation: 0 });
  });

  it("omits ancestry entirely when the recorded parent resolves to no row", async () => {
    // The distinction ISS-10714 exists to keep: a dangling parent pointer is
    // "we could not tell", and must not arrive as the depth 0 that means root.
    // SUBAGENT kind on purpose — on a tool row the omission would come from the
    // kind gate and this case would prove nothing about a dangling pointer.
    const item = await readSingleRow(
      baseInvocationRow({
        componentKind: AgentComponentInvocationKind.Subagent,
        parentExternalInvocationId: "ext-absent-parent",
      })
    );

    expect(item.ancestry).toBeUndefined();
    expect(item.parentExternalInvocationId).toBe("ext-absent-parent");
  });

  it("includes providerToolUseId on an Event anchor when the provider reported one", async () => {
    const item = await readSingleRow(
      baseInvocationRow({
        anchor: {
          kind: AgentComponentInvocationAnchorKind.Event,
          eventId: "event-1",
          providerToolUseId: "tool-use-1",
        },
      })
    );

    expect(item.anchor).toEqual({
      kind: AgentComponentInvocationAnchorKind.Event,
      eventId: "event-1",
      providerToolUseId: "tool-use-1",
    });
  });

  it("omits providerToolUseId on an Event anchor when the provider did not report one", async () => {
    const item = await readSingleRow(
      baseInvocationRow({
        anchor: {
          kind: AgentComponentInvocationAnchorKind.Event,
          eventId: "event-1",
        },
      })
    );

    expect(item.anchor).toEqual({
      kind: AgentComponentInvocationAnchorKind.Event,
      eventId: "event-1",
    });
  });

  it("omits externalAgentId and transcriptFileId on an Agent anchor when neither is reported", async () => {
    const item = await readSingleRow(
      baseInvocationRow({
        anchor: {
          kind: AgentComponentInvocationAnchorKind.Agent,
          agentId: "agent-1",
        },
      })
    );

    expect(item.anchor).toEqual({
      kind: AgentComponentInvocationAnchorKind.Agent,
      agentId: "agent-1",
    });
  });

  it("maps a UserTurn anchor", async () => {
    const item = await readSingleRow(
      baseInvocationRow({
        anchor: {
          kind: AgentComponentInvocationAnchorKind.UserTurn,
          userTurnId: "turn-1",
        },
      })
    );

    expect(item.anchor).toEqual({
      kind: AgentComponentInvocationAnchorKind.UserTurn,
      userTurnId: "turn-1",
    });
  });

  it("maps a Timestamp anchor with a numeric ordinal", async () => {
    const item = await readSingleRow(
      baseInvocationRow({
        anchor: {
          kind: AgentComponentInvocationAnchorKind.Timestamp,
          timestamp: "2026-01-01T00:00:00.000Z",
          ordinal: 3,
        },
      })
    );

    expect(item.anchor).toEqual({
      kind: AgentComponentInvocationAnchorKind.Timestamp,
      timestamp: "2026-01-01T00:00:00.000Z",
      ordinal: 3,
    });
  });

  it("throws when a Timestamp anchor's ordinal is not a number", async () => {
    await expect(
      readSingleRow(
        baseInvocationRow({
          anchor: {
            kind: AgentComponentInvocationAnchorKind.Timestamp,
            timestamp: "2026-01-01T00:00:00.000Z",
            ordinal: "3",
          },
        })
      )
    ).rejects.toThrow("Invalid persisted invocation anchor number");
  });

  it("throws when the anchor kind is not a recognized value", async () => {
    await expect(
      readSingleRow(baseInvocationRow({ anchor: { kind: "bogus" } }))
    ).rejects.toThrow("Invalid persisted invocation anchor kind");
  });

  it("throws when the persisted anchor is not a plain object", async () => {
    await expect(
      readSingleRow(baseInvocationRow({ anchor: "not-an-object" }))
    ).rejects.toThrow("Invalid persisted invocation anchor");
  });

  it("throws when a required anchor string field is missing its string type", async () => {
    await expect(
      readSingleRow(
        baseInvocationRow({
          anchor: {
            kind: AgentComponentInvocationAnchorKind.UserTurn,
            userTurnId: 42,
          },
        })
      )
    ).rejects.toThrow("Invalid persisted invocation anchor string");
  });

  it("throws when a persisted componentKind does not match a known contract value", async () => {
    await expect(
      readSingleRow(baseInvocationRow({ componentKind: "not-a-real-kind" }))
    ).rejects.toThrow("Invalid persisted invocation kind: not-a-real-kind");
  });
});
