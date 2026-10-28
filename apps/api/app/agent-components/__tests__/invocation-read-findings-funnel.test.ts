/**
 * ISS-10727: what the CLOUD read path puts on the wire for the findings funnel.
 *
 * Drives the real `loadAgentComponentInvocationReadPage` against a db double so
 * both halves are covered at the path itself: a row carrying the funnel columns
 * publishes them, and a row without them omits the fields rather than
 * serializing a zero or a `null`. The columns are not in the cloud schema yet
 * (ISS-10729 adds them), which is exactly why the absent half is the one a real
 * read hits today and why the present half must be pinned here rather than
 * waiting for the migration.
 */

import { AgentComponentFindingsProvenance } from "@repo/api/src/types/agent-component-findings-provenance";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { readAgentComponentInvocationFindings } from "@repo/api/src/types/agent-component-invocation-findings";
import { describe, expect, it, vi } from "vitest";
import { loadAgentComponentInvocationReadPage } from "../service/invocation-read";

const ORGANIZATION_ID = "org-1";
const KIND = "subagent";
const KEY = "code-review-worker";
const COST_PER_FINDING_KEY = /perFinding|findingCost|costPerFinding/i;

type FindingsColumns = {
  findingsEmitted?: number | null;
  findingsInvalidated?: number | null;
  model?: string | null;
  inputTokens?: bigint | null;
  outputTokens?: bigint | null;
  cacheReadTokens?: bigint | null;
  cacheWriteTokens?: bigint | null;
  estimatedCost?: { toNumber: () => number } | null;
  footprintTokens?: bigint | null;
  usageMeasurement?: string | null;
  succeeded?: boolean | null;
};

function invocationRow(
  id: string,
  findings: FindingsColumns,
  componentKind: AgentComponentInvocationKind = AgentComponentInvocationKind.Subagent
) {
  return {
    id,
    externalInvocationId: `ext-${id}`,
    sourceSessionId: "source-session-1",
    childSessionId: null,
    parentExternalInvocationId: null,
    externalAgentId: null,
    componentKind,
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
    model: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    estimatedCost: null,
    footprintTokens: null,
    usageMeasurement: null,
    succeeded: null,
    generation: {
      agentSessionId: "session-1",
      session: { externalSessionId: "ext-session-1" },
    },
    ...findings,
  };
}

/** A hook firing: the one kind whose success is a transcript fact. */
function hookRow(id: string, findings: FindingsColumns) {
  return invocationRow(id, findings, AgentComponentInvocationKind.Hook);
}

type InvocationRow = ReturnType<typeof invocationRow>;

/** The telemetry columns a select can decline to name. */
const TELEMETRY_COLUMNS = [
  "model",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "estimatedCost",
  "footprintTokens",
  "usageMeasurement",
  "succeeded",
] as const satisfies readonly (keyof InvocationRow)[];

type BareInvocationRow = Omit<
  InvocationRow,
  (typeof TELEMETRY_COLUMNS)[number]
>;

/**
 * A row from a select that never named the telemetry columns: the keys are
 * genuinely ABSENT. Spelling it `model: undefined` would be a different row
 * shape — `Object.hasOwn` is true for it — and would not pin the case that
 * threw.
 */
function invocationRowWithoutTelemetry(id: string): BareInvocationRow {
  const absent = new Set<string>(TELEMETRY_COLUMNS);
  return Object.fromEntries(
    Object.entries(invocationRow(id, {})).filter(([key]) => !absent.has(key))
  ) as BareInvocationRow;
}

async function readRows(rows: (InvocationRow | BareInvocationRow)[]) {
  const db = {
    agentComponentInvocation: {
      findMany: vi.fn(() => Promise.resolve(rows)),
      groupBy: vi.fn(() => Promise.resolve([])),
    },
    sourceOccurrence: { findMany: vi.fn(() => Promise.resolve([])) },
  };
  const page = await loadAgentComponentInvocationReadPage(
    db as unknown as Parameters<typeof loadAgentComponentInvocationReadPage>[0],
    { organizationId: ORGANIZATION_ID, kind: KIND, key: KEY, inventoryIds: [] }
  );
  return page.items;
}

describe("cloud invocation read — findings funnel", () => {
  it("publishes a stored funnel and omits it for a row that has none", async () => {
    // TWO rows, with DIFFERENT funnels, because one row cannot tell a per-row
    // projection from a page-wide one.
    const [measured, other, absent] = await readRows([
      invocationRow("a", { findingsEmitted: 6, findingsInvalidated: 2 }),
      invocationRow("b", { findingsEmitted: 1, findingsInvalidated: 0 }),
      invocationRow("c", {}),
    ]);

    expect(measured).toMatchObject({
      findingsState: "measured",
      findingsEmitted: 6,
      findingsInvalidated: 2,
    });
    expect(other).toMatchObject({
      findingsState: "measured",
      findingsEmitted: 1,
      findingsInvalidated: 0,
    });
    for (const key of [
      "findingsState",
      "findingsEmitted",
      "findingsInvalidated",
    ]) {
      expect(Object.hasOwn(absent, key)).toBe(false);
    }
    expect(readAgentComponentInvocationFindings(absent).state).toBe("unknown");
    expect(readAgentComponentInvocationFindings(measured)).toEqual({
      state: "measured",
      findingsEmitted: 6,
      findingsInvalidated: 2,
      findingsConfirmed: 4,
      // ISS-10739: every Measured reading carries how the count was obtained.
      // This row carries no label, which reads `Unresolved` — a distinct fact
      // from either real source, not a default onto the stronger one.
      findingsProvenance: AgentComponentFindingsProvenance.Unresolved,
    });
  });

  it("never serializes a null, and never derives findingsConfirmed onto the row", async () => {
    const [nulled, measured] = await readRows([
      invocationRow("a", { findingsEmitted: null, findingsInvalidated: null }),
      invocationRow("b", { findingsEmitted: 3, findingsInvalidated: 1 }),
    ]);
    expect(JSON.stringify(nulled)).not.toContain("findings");
    expect(Object.hasOwn(measured, "findingsConfirmed")).toBe(false);
    expect(JSON.stringify(measured)).not.toContain("findingsConfirmed");
  });

  it("drops a half-populated pair rather than completing it with a zero", async () => {
    const [half] = await readRows([invocationRow("a", { findingsEmitted: 4 })]);
    expect(Object.hasOwn(half, "findingsEmitted")).toBe(false);
    expect(readAgentComponentInvocationFindings(half).state).toBe("unknown");
  });

  it("carries no cost-per-finding value on the read row", async () => {
    const [row] = await readRows([
      invocationRow("a", { findingsEmitted: 6, findingsInvalidated: 2 }),
    ]);
    for (const key of Object.keys(row)) {
      expect(key).not.toMatch(COST_PER_FINDING_KEY);
    }
  });
});

describe("cloud invocation read — per-invocation telemetry (ISS-10718)", () => {
  it("publishes stored telemetry per row and omits it for a row with none", async () => {
    // TWO rows with DIFFERENT telemetry: one row cannot tell a per-row
    // projection from a page-wide one.
    const [measured, other, absent] = await readRows([
      invocationRow("a", {
        model: "claude-opus-4",
        inputTokens: 1200n,
        outputTokens: 340n,
        cacheReadTokens: 5000n,
        cacheWriteTokens: 64n,
        estimatedCost: { toNumber: () => 0.123_456 },
        footprintTokens: 4096n,
        usageMeasurement: "measured",
      }),
      invocationRow("b", {
        inputTokens: 7n,
        usageMeasurement: "estimated",
      }),
      invocationRow("c", {}),
    ]);

    expect(measured).toMatchObject({
      model: "claude-opus-4",
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 5000,
      cacheWriteTokens: 64,
      estimatedCost: 0.123_456,
      footprintTokens: 4096,
      usageMeasurement: "measured",
    });
    expect(other).toMatchObject({
      inputTokens: 7,
      usageMeasurement: "estimated",
    });
    for (const key of [
      "model",
      "inputTokens",
      "estimatedCost",
      "footprintTokens",
      "usageMeasurement",
      "succeeded",
    ]) {
      expect(Object.hasOwn(absent, key)).toBe(false);
    }
    expect(JSON.stringify(absent)).not.toContain("estimatedCost");
  });

  it("keeps succeeded three-valued rather than coercing an unknown to false", async () => {
    const [unknown, failed] = await readRows([
      hookRow("a", { succeeded: null }),
      hookRow("b", { succeeded: false }),
    ]);
    expect(Object.hasOwn(unknown, "succeeded")).toBe(false);
    expect(failed).toMatchObject({ succeeded: false });
  });

  // ISS-10718 (@whitlockk, @tamsinb review): the read applies the SAME two kind
  // gates the write side does, so a stored value on a kind nothing measures or
  // adjudicates cannot reach one surface while the other refuses it.
  it("withholds labelled usage from a kind nothing measures", async () => {
    const [hook] = await readRows([
      hookRow("a", {
        model: "claude-opus-4",
        inputTokens: 1200n,
        estimatedCost: { toNumber: () => 0.5 },
        usageMeasurement: "measured",
        footprintTokens: 4096n,
      }),
    ]);
    for (const key of [
      "model",
      "inputTokens",
      "estimatedCost",
      "usageMeasurement",
    ]) {
      expect(Object.hasOwn(hook, key)).toBe(false);
    }
    // footprintTokens is kind-agnostic by design and is NOT withheld.
    expect(hook).toMatchObject({ footprintTokens: 4096 });
  });

  it("withholds succeeded from a kind nothing adjudicates", async () => {
    const [subagent] = await readRows([
      invocationRow("a", { succeeded: true }),
    ]);
    expect(Object.hasOwn(subagent, "succeeded")).toBe(false);
  });
});

describe("cloud invocation read — a row that never selected the columns", () => {
  it("omits telemetry when the columns are ABSENT, not null", async () => {
    // Not the same fixture as the null case above: a row from a select that
    // never named the column carries `undefined`, and reading `.toNumber()` off
    // an absent Decimal THREW rather than degrading. Both spellings of "no
    // value" must land on the same omission.
    const bare = invocationRowWithoutTelemetry("a");
    // The fixture itself is the contract here: if these keys were merely
    // holding `undefined`, the case would not be the one that threw.
    for (const key of TELEMETRY_COLUMNS) {
      expect(Object.hasOwn(bare, key)).toBe(false);
    }
    const [row] = await readRows([bare]);
    for (const key of [
      "model",
      "inputTokens",
      "estimatedCost",
      "footprintTokens",
      "usageMeasurement",
      "succeeded",
    ]) {
      expect(Object.hasOwn(row, key)).toBe(false);
    }
  });
});
