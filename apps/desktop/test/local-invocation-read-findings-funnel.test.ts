/**
 * @file local-invocation-read-findings-funnel.test.ts
 * @description ISS-10727. What the DESKTOP-LOCAL read path puts on the wire for
 * the findings funnel.
 *
 * The reader's row shape is hand-written and its SELECT is raw SQL, so the
 * funnel columns are optional on the row until ISS-10729 adds them to the
 * desktop schema. Both halves are pinned here at the path: a row carrying the
 * columns publishes them, a row without them omits the fields. The prisma
 * double returns controlled rows for exactly that reason — a real SQLite read
 * can only reach the absent half today, and the present half must not wait on a
 * migration to be covered.
 */

import assert from "node:assert/strict";
import { AgentComponentFindingsProvenance } from "@repo/api/src/types/agent-component-findings-provenance";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { readAgentComponentInvocationFindings } from "@repo/api/src/types/agent-component-invocation-findings";
import { test } from "vitest";
import { readAgentComponentInvocationPage } from "../src/main/dashboard/local-invocation-read.js";

const COMPONENT_KEY = "code-review-worker";
const KIND = AgentComponentInvocationKind.Subagent;
const COST_PER_FINDING_KEY = /perFinding|findingCost|costPerFinding/i;

type FindingsColumns = {
  findings_emitted?: bigint | number | null;
  findings_invalidated?: bigint | number | null;
  model?: string | null;
  input_tokens?: bigint | number | null;
  output_tokens?: bigint | number | null;
  cache_read_tokens?: bigint | number | null;
  cache_write_tokens?: bigint | number | null;
  estimated_cost?: number | null;
  footprint_tokens?: bigint | number | null;
  usage_measurement?: string | null;
  succeeded?: boolean | number | null;
};

/** A hook firing: the one kind whose success is a transcript fact. */
function hookRow(id: string, findings: FindingsColumns) {
  return localRow(id, findings, AgentComponentInvocationKind.Hook);
}

function localRow(
  id: string,
  findings: FindingsColumns,
  componentKind: AgentComponentInvocationKind = KIND
) {
  return {
    id,
    session_id: "session-1",
    external_invocation_id: `ext-${id}`,
    child_session_id: null,
    component_kind: componentKind,
    component_key: COMPONENT_KEY,
    raw_name: null,
    normalized_name: null,
    relationship: AgentComponentInvocationRelationship.Direct,
    invoked_at: null,
    sequence: 0,
    anchor_kind: AgentComponentInvocationAnchorKind.Session,
    anchor_value: "session-1",
    provider_tool_use_id: null,
    attribution_status: AgentComponentInvocationAttributionStatus.Matched,
    evidence_class: AgentComponentInvocationEvidenceClass.None,
    evidence_pointer: null,
    definition_hash: null,
    normalizer_contract_version: null,
    local_component_version_id: null,
    git_branch: null,
    repository_full_name: null,
    model: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    estimated_cost: null,
    footprint_tokens: null,
    usage_measurement: null,
    succeeded: null,
    ...findings,
  };
}

async function readRows(rows: ReturnType<typeof localRow>[]) {
  const queryRawUnsafe = (sql: string) => {
    if (sql.includes("SELECT DISTINCT component_key")) {
      return Promise.resolve([{ component_key: COMPONENT_KEY }]);
    }
    if (sql.includes("COUNT(*) AS total")) {
      return Promise.resolve([
        { total: rows.length, unmatched_count: 0, ambiguous_count: 0 },
      ]);
    }
    return Promise.resolve(rows);
  };
  const prisma = { client: { $queryRawUnsafe: queryRawUnsafe } };
  const page = await readAgentComponentInvocationPage(
    prisma as unknown as Parameters<typeof readAgentComponentInvocationPage>[0],
    KIND,
    COMPONENT_KEY,
    []
  );
  if (!page) {
    throw new Error("expected the reader to return a page");
  }
  return page.items;
}

test("desktop local read publishes a stored funnel per row and omits an absent one", async () => {
  // TWO rows with DIFFERENT funnels: one row cannot tell a per-row projection
  // from a page-wide one.
  const [measured, other, absent] = await readRows([
    localRow("a", { findings_emitted: 6, findings_invalidated: 2 }),
    localRow("b", { findings_emitted: 1n, findings_invalidated: 0n }),
    localRow("c", {}),
  ]);

  assert.equal(measured?.findingsState, "measured");
  assert.equal(measured?.findingsEmitted, 6);
  assert.equal(measured?.findingsInvalidated, 2);
  assert.equal(other?.findingsState, "measured");
  assert.equal(other?.findingsEmitted, 1);
  assert.equal(other?.findingsInvalidated, 0);

  assert.ok(absent);
  for (const key of [
    "findingsState",
    "findingsEmitted",
    "findingsInvalidated",
  ]) {
    assert.equal(Object.hasOwn(absent, key), false, `expected ${key} omitted`);
  }
  assert.equal(readAgentComponentInvocationFindings(absent).state, "unknown");
  assert.deepEqual(readAgentComponentInvocationFindings(measured), {
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

test("desktop local read never serializes null or a derived confirmed count", async () => {
  const [nulled, measured] = await readRows([
    localRow("a", { findings_emitted: null, findings_invalidated: null }),
    localRow("b", { findings_emitted: 3, findings_invalidated: 1 }),
  ]);
  assert.equal(JSON.stringify(nulled).includes("findings"), false);
  assert.ok(measured);
  assert.equal(Object.hasOwn(measured, "findingsConfirmed"), false);
});

test("desktop local read drops an unusable or half-populated stored pair", async () => {
  const [half, fractional, negative] = await readRows([
    localRow("a", { findings_emitted: 4 }),
    localRow("b", { findings_emitted: 1.5, findings_invalidated: 0 }),
    localRow("c", { findings_emitted: -1, findings_invalidated: 0 }),
  ]);
  for (const row of [half, fractional, negative]) {
    assert.ok(row);
    assert.equal(Object.hasOwn(row, "findingsEmitted"), false);
    assert.equal(readAgentComponentInvocationFindings(row).state, "unknown");
  }
});

test("desktop local read carries no cost-per-finding value", async () => {
  const [row] = await readRows([
    localRow("a", { findings_emitted: 6, findings_invalidated: 2 }),
  ]);
  assert.ok(row);
  for (const key of Object.keys(row)) {
    assert.equal(
      COST_PER_FINDING_KEY.test(key),
      false,
      `unexpected cost-per-finding key: ${key}`
    );
  }
});

test("desktop local read publishes stored telemetry per row and omits an absent one", async () => {
  // TWO rows with DIFFERENT telemetry, so a page-wide projection cannot pass.
  const [measured, other, absent] = await readRows([
    localRow("a", {
      model: "claude-opus-4",
      input_tokens: 1200n,
      output_tokens: 340,
      cache_read_tokens: 5000n,
      cache_write_tokens: 64n,
      estimated_cost: 0.123_456,
      footprint_tokens: 4096n,
      usage_measurement: "measured",
    }),
    localRow("b", {
      input_tokens: 7n,
      usage_measurement: "estimated",
    }),
    localRow("c", {}),
  ]);

  assert.equal(measured?.model, "claude-opus-4");
  assert.equal(measured?.inputTokens, 1200);
  assert.equal(measured?.outputTokens, 340);
  assert.equal(measured?.cacheReadTokens, 5000);
  assert.equal(measured?.cacheWriteTokens, 64);
  assert.equal(measured?.estimatedCost, 0.123_456);
  assert.equal(measured?.footprintTokens, 4096);
  assert.equal(measured?.usageMeasurement, "measured");

  assert.equal(other?.inputTokens, 7);
  assert.equal(other?.usageMeasurement, "estimated");

  assert.ok(absent);
  for (const key of [
    "model",
    "inputTokens",
    "estimatedCost",
    "footprintTokens",
    "usageMeasurement",
    "succeeded",
  ]) {
    assert.equal(Object.hasOwn(absent, key), false, `expected ${key} omitted`);
  }
  assert.equal(JSON.stringify(absent).includes("estimatedCost"), false);
});

test("desktop local read publishes a hook verdict in both directions", async () => {
  const [passed, failed] = await readRows([
    hookRow("a", { succeeded: 1 }),
    hookRow("b", { succeeded: 0 }),
  ]);
  assert.equal(passed?.succeeded, true);
  assert.equal(failed?.succeeded, false);
});

/**
 * ISS-10718 (@tamsinb review): the local store can hold a token count on a kind
 * the sync projection drops as corruption and the cloud ingest would refuse, so
 * a local read without the kind gate shows a number the web will never have for
 * the same row. Both surfaces now decide it in the same shared projection.
 */
test("desktop local read applies the same kind gates the sync path does", async () => {
  const [hook] = await readRows([
    hookRow("a", {
      model: "claude-opus-4",
      input_tokens: 1200n,
      estimated_cost: 0.5,
      usage_measurement: "measured",
      footprint_tokens: 4096n,
    }),
  ]);
  assert.ok(hook);
  for (const key of [
    "model",
    "inputTokens",
    "estimatedCost",
    "usageMeasurement",
  ]) {
    assert.equal(Object.hasOwn(hook, key), false, `expected ${key} withheld`);
  }
  // footprintTokens is kind-agnostic by design and is NOT withheld.
  assert.equal(hook.footprintTokens, 4096);

  const [subagent] = await readRows([localRow("b", { succeeded: 1 })]);
  assert.ok(subagent);
  assert.equal(Object.hasOwn(subagent, "succeeded"), false);
});

test("desktop local read refuses an out-of-domain succeeded byte", async () => {
  // A closed two-value column holding a 2 is corruption; reading it as `false`
  // would render as a confident verdict nobody reached.
  const [corrupt, unknown] = await readRows([
    hookRow("a", { succeeded: 2 }),
    hookRow("b", { succeeded: null }),
  ]);
  assert.ok(corrupt);
  assert.ok(unknown);
  assert.equal(Object.hasOwn(corrupt, "succeeded"), false);
  assert.equal(Object.hasOwn(unknown, "succeeded"), false);
});

test("desktop local read drops counts a label it cannot read would describe", async () => {
  const [row] = await readRows([
    localRow("a", {
      input_tokens: 10n,
      footprint_tokens: 4096n,
      usage_measurement: "guessed",
    }),
  ]);
  assert.ok(row);
  assert.equal(Object.hasOwn(row, "inputTokens"), false);
  assert.equal(Object.hasOwn(row, "usageMeasurement"), false);
  assert.equal(row.footprintTokens, 4096);
});
