/**
 * ISS-10720 — the join from Claude Code's own OTel component attribution
 * (ISS-7352 item E) onto this device's invocation rows.
 *
 * Every fixture below carries TWO components whose outcomes DIFFER, because a
 * single-component fixture cannot tell a scoped join from one that stamps
 * everything it is handed.
 */

import assert from "node:assert/strict";
import {
  AgentComponentInvocationAttributionSource,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { test } from "vitest";
import { ClaudeCodeAttributionSource } from "../src/main/otel/claude-code-otel-attribution.js";
import {
  applyOtelInvocationAttribution,
  type OtelAttributableInvocation,
  type OtelCostAttributionRow,
  otelInvocationAttributionReport,
} from "../src/main/otel/claude-code-otel-invocation-attribution.js";

const UNMATCHED_COUNT_PATTERN = /unmatched=1/;
const NO_STAMPS_PATTERN = /stamped 0 invocation\(s\)/;

function invocation(
  componentKind: string,
  normalizedName: string,
  evidenceClass: AgentComponentInvocationEvidenceClass = AgentComponentInvocationEvidenceClass.TranscriptSnapshot
): OtelAttributableInvocation {
  return {
    componentKind,
    normalizedName,
    evidenceClass,
    attributionSource: null,
  };
}

function costRow(
  overrides: Partial<OtelCostAttributionRow>
): OtelCostAttributionRow {
  return {
    attribution_source: ClaudeCodeAttributionSource.HarnessOtel,
    agent_name: null,
    skill_name: null,
    plugin_name: null,
    marketplace_name: null,
    mcp_server_name: null,
    mcp_tool_name: null,
    query_source: null,
    ...overrides,
  };
}

test("stamps every invocation of an attributed component and leaves an unattributed sibling alone", () => {
  // `alpha` runs twice, `beta` once; only `alpha` is named by a counter.
  const alphaFirst = invocation(AgentComponentInvocationKind.Subagent, "alpha");
  const alphaSecond = invocation(
    AgentComponentInvocationKind.Subagent,
    "alpha"
  );
  const beta = invocation(AgentComponentInvocationKind.Subagent, "beta");

  const tally = applyOtelInvocationAttribution(
    [alphaFirst, alphaSecond, beta],
    [
      costRow({ agent_name: "Alpha" }),
      costRow({ agent_name: "alpha" }),
      costRow({ agent_name: "gamma" }),
    ]
  );

  assert.equal(
    alphaFirst.attributionSource,
    AgentComponentInvocationAttributionSource.HarnessOtel
  );
  assert.equal(
    alphaSecond.attributionSource,
    AgentComponentInvocationAttributionSource.HarnessOtel
  );
  // Both alpha rows already held transcript evidence, so the DEFINITION axis
  // is untouched — recording who attributed a row must not restate where its
  // definition came from.
  assert.equal(
    alphaFirst.evidenceClass,
    AgentComponentInvocationEvidenceClass.TranscriptSnapshot
  );
  // The sibling keeps both axes: the join is scoped to the names the harness
  // actually stamped, not applied to the session wholesale.
  assert.equal(beta.attributionSource, null);
  assert.equal(
    beta.evidenceClass,
    AgentComponentInvocationEvidenceClass.TranscriptSnapshot
  );
  assert.equal(tally.matchedAttributions, 1);
  assert.equal(tally.stampedInvocations, 2);
  // `gamma` is attribution with no invocation behind it — the unresolved half
  // of the figure, counted rather than dropped.
  assert.equal(tally.unmatchedAttributions, 1);
  assert.equal(tally.ambiguousAttributions, 0);
  assert.equal(tally.attributedCostEventRows, 3);
});

test("refuses a name two invocation kinds claim, and counts it ambiguous", () => {
  // `skill.name` is one key space for skills and slash commands, so a session
  // running both a `foo` skill and a `/foo` command gives the harness's tuple
  // two different components to mean.
  const skill = invocation(AgentComponentInvocationKind.Skill, "foo");
  const command = invocation(AgentComponentInvocationKind.Command, "/foo");
  const unambiguous = invocation(AgentComponentInvocationKind.Skill, "bar");

  const tally = applyOtelInvocationAttribution(
    [skill, command, unambiguous],
    [costRow({ skill_name: "foo" }), costRow({ skill_name: "bar" })]
  );

  assert.equal(skill.attributionSource, null);
  assert.equal(command.attributionSource, null);
  // The unambiguous name in the SAME pass still lands, so the refusal above is
  // the collision being detected rather than the whole pass giving up.
  assert.equal(
    unambiguous.attributionSource,
    AgentComponentInvocationAttributionSource.HarnessOtel
  );
  assert.equal(tally.ambiguousAttributions, 1);
  assert.equal(tally.matchedAttributions, 1);
  assert.equal(tally.stampedInvocations, 1);
});

test("counts attribution on dimensions no invocation kind may carry evidence for", () => {
  // An MCP tool invocation is pinned to `none` by the wire boundary
  // (`non_definition_kind_has_provenance_evidence`), so this attribution is
  // real and unseatable — a different fact from an unmatched name.
  const mcp = invocation(
    AgentComponentInvocationKind.Mcp,
    "search",
    AgentComponentInvocationEvidenceClass.None
  );
  const subagent = invocation(AgentComponentInvocationKind.Subagent, "alpha");

  const tally = applyOtelInvocationAttribution(
    [mcp, subagent],
    [
      costRow({ mcp_server_name: "ctx", mcp_tool_name: "search" }),
      costRow({ plugin_name: "pack" }),
      costRow({ agent_name: "alpha" }),
    ]
  );

  assert.equal(mcp.evidenceClass, AgentComponentInvocationEvidenceClass.None);
  assert.equal(mcp.attributionSource, null);
  assert.equal(
    subagent.attributionSource,
    AgentComponentInvocationAttributionSource.HarnessOtel
  );
  assert.equal(tally.unjoinableAttributions, 3);
  assert.equal(tally.unmatchedAttributions, 0);
  assert.equal(tally.matchedAttributions, 1);
});

test("an unattributed counter stamps nothing and reports nothing", () => {
  const subagent = invocation(AgentComponentInvocationKind.Subagent, "alpha");

  const tally = applyOtelInvocationAttribution(
    [subagent],
    [
      costRow({
        attribution_source: ClaudeCodeAttributionSource.None,
        agent_name: "alpha",
      }),
    ]
  );

  // The source column decides, not the presence of a name: a row the harness
  // did not attribute cannot become evidence just because a column is filled.
  assert.equal(subagent.attributionSource, null);
  assert.equal(tally.attributedCostEventRows, 0);
  assert.equal(tally.costEventRows, 1);
  assert.equal(tally.matchedAttributions, 0);
  assert.equal(otelInvocationAttributionReport("s-1", tally), undefined);
});

test("recording the harness attribution does not delete the row's definition provenance", () => {
  // THE GUARD AGAINST RE-COLLAPSING THE TWO AXES. `genuineSourceOccurrence`
  // (apps/api/.../component-invocation-helpers.ts) emits the component-detail
  // surface's on-disk `local` source pointer ONLY when evidenceClass is
  // `collectorSnapshot`. The first cut of this change wrote `otelCounter` into
  // that column on every joined row and silently deleted the pointer — a
  // capability nobody would have filed a bug about, because a pointer that is
  // no longer rendered leaves no trace.
  const collector = invocation(
    AgentComponentInvocationKind.Skill,
    "alpha",
    AgentComponentInvocationEvidenceClass.CollectorSnapshot
  );
  // A row with NO definition evidence is the one place the class may move —
  // there is nothing to displace, so the enum member the ticket asks for is
  // genuinely emitted.
  const bare = invocation(
    AgentComponentInvocationKind.Subagent,
    "beta",
    AgentComponentInvocationEvidenceClass.None
  );

  applyOtelInvocationAttribution(
    [collector, bare],
    [costRow({ skill_name: "alpha" }), costRow({ agent_name: "beta" })]
  );

  assert.equal(
    collector.evidenceClass,
    AgentComponentInvocationEvidenceClass.CollectorSnapshot,
    "the definition provenance the source pointer is keyed off must survive"
  );
  assert.equal(
    collector.attributionSource,
    AgentComponentInvocationAttributionSource.HarnessOtel
  );
  assert.equal(
    bare.evidenceClass,
    AgentComponentInvocationEvidenceClass.OtelCounter
  );
  assert.equal(
    bare.attributionSource,
    AgentComponentInvocationAttributionSource.HarnessOtel
  );
});

test("a query_source-only row is attributed but names no component", () => {
  // `attributionSourceOf` stamps `harness_otel` for ANY identity field, and
  // `query_source` is one of them while naming no component — the ordinary
  // main-loop point. Counting it as component attribution made every tuple
  // counter read 0 on a report that still fired.
  const subagent = invocation(AgentComponentInvocationKind.Subagent, "alpha");

  const tally = applyOtelInvocationAttribution(
    [subagent],
    [costRow({ query_source: "user" }), costRow({ agent_name: "alpha" })]
  );

  assert.equal(tally.attributedCostEventRows, 1);
  assert.equal(tally.nonComponentAttributedRows, 1);
  assert.equal(tally.costEventRows, 2);
  // The tuple counters are drawn from the component-attributed population, so
  // the two halves reconcile instead of one inflating the other.
  assert.equal(
    tally.matchedAttributions +
      tally.ambiguousAttributions +
      tally.unmatchedAttributions +
      tally.unjoinableAttributions,
    1
  );
});

test("reports the unresolved half even when nothing matched", () => {
  const tally = applyOtelInvocationAttribution(
    [invocation(AgentComponentInvocationKind.Subagent, "beta")],
    [costRow({ agent_name: "alpha" })]
  );

  const report = otelInvocationAttributionReport("s-2", tally);
  assert.ok(report, "a pass that saw attribution must report it");
  assert.match(report, UNMATCHED_COUNT_PATTERN);
  assert.match(report, NO_STAMPS_PATTERN);
});

test("SEATS an invocation for a component the transcript missed, and records that OTel is why the row exists", () => {
  // `alpha` the transcript found; `gamma` it never saw. Two components whose
  // outcomes differ, so a seat that fired on everything would fail here.
  const alpha = invocation(AgentComponentInvocationKind.Subagent, "alpha");
  const invocations: OtelAttributableInvocation[] = [alpha];

  const tally = applyOtelInvocationAttribution(
    invocations,
    [costRow({ agent_name: "alpha" }), costRow({ agent_name: "Gamma" })],
    ({ componentKind, name }) => ({
      componentKind,
      normalizedName: name,
      evidenceClass: AgentComponentInvocationEvidenceClass.OtelCounter,
      attributionSource: AgentComponentInvocationAttributionSource.HarnessOtel,
    })
  );

  assert.equal(tally.seatedInvocations, 1);
  // The whole point of the branch: `gamma` was NOT merely counted.
  assert.equal(tally.unmatchedAttributions, 0);
  assert.equal(invocations.length, 2);
  const seated = invocations[1];
  assert.equal(seated.componentKind, AgentComponentInvocationKind.Subagent);
  // Folded, so the seat carries the name this join compares on, not the
  // harness's casing.
  assert.equal(seated.normalizedName, "gamma");
  assert.equal(
    seated.attributionSource,
    AgentComponentInvocationAttributionSource.HarnessOtel
  );
  // Both the seated row and the corroborated one count as stamped.
  assert.equal(tally.stampedInvocations, 2);
  assert.equal(
    alpha.attributionSource,
    AgentComponentInvocationAttributionSource.HarnessOtel
  );
});

test("refuses to seat a skill tuple, because one harness key names both a skill and a /command", () => {
  // The transcript found neither `deploy` nor anything else, so nothing is
  // corroborated; the skill tuple must stay a counter rather than guess a kind.
  const invocations: OtelAttributableInvocation[] = [];
  let seatCalls = 0;

  const tally = applyOtelInvocationAttribution(
    invocations,
    [costRow({ skill_name: "deploy" })],
    ({ componentKind, name }) => {
      seatCalls += 1;
      return {
        componentKind,
        normalizedName: name,
        evidenceClass: AgentComponentInvocationEvidenceClass.OtelCounter,
        attributionSource:
          AgentComponentInvocationAttributionSource.HarnessOtel,
      };
    }
  );

  assert.equal(seatCalls, 0);
  assert.equal(tally.seatedInvocations, 0);
  assert.equal(tally.unmatchedAttributions, 1);
  assert.equal(invocations.length, 0);
});

test("counts a tuple the caller declines to seat as unmatched rather than silently dropping it", () => {
  const invocations: OtelAttributableInvocation[] = [];

  const tally = applyOtelInvocationAttribution(
    invocations,
    [costRow({ agent_name: "gamma" })],
    () => undefined
  );

  assert.equal(tally.seatedInvocations, 0);
  assert.equal(tally.unmatchedAttributions, 1);
  assert.equal(invocations.length, 0);
});
