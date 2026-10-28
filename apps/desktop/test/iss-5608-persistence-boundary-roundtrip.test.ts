/**
 * @file iss-5608-persistence-boundary-roundtrip.test.ts
 * @description ISS-5608 — round-trip coverage for the persistence-class boundary
 * schemas in `src/main/database/` that had none.
 *
 * Malformed and version-skewed input IS reachable at each of these: they read
 * back rows and JSON columns this build did not necessarily write. Per the root
 * `AGENTS.md` trust-boundary carve-out that makes these reachable cases, not
 * type-forbidden ones.
 *
 * Each `describe` below pins the ONE outcome that distinguishes silent data loss
 * from a loud failure — whether an unknown key is STRIPPED or REJECTED — because
 * that is the whole difference the schemas encode and nothing asserted it.
 *
 * Deliberately NOT here: `invocation-telemetry-integrity.ts`, the fourth schema
 * ISS-5608 names. Its round-trip behaviour (partial tally, unreadable shape, and
 * absent method all degrading to "not evaluated" rather than "clean") is already
 * covered by `store-integrity-probe.test.ts`; what it actually lacked was the
 * compile-time keys-covered guard, which this change adds to the module instead.
 */
import assert from "node:assert/strict";
import { AgentComponentFindingsDisposition } from "@repo/api/src/types/agent-component-findings-disposition";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  AgentComponentInvocationUsageMeasurement,
} from "@repo/api/src/types/agent-component-invocation";
import { agentComponentInvocationSyncItemSchema } from "@repo/api/src/types/agent-component-invocation-schema";
import {
  TokenCostCompleteness,
  TokenCostCompletenessReason,
} from "@repo/api/src/types/token-cost-provenance";
import { describe, test } from "vitest";
import type { EvidencePointer } from "../src/main/database/component-invocation-row-writer.js";
import {
  type StoredInvocationRow,
  storedRowToSyncItem,
} from "../src/main/database/component-invocation-sync-item.js";
import {
  isLocallyDerivedStoredTokenCostSummary,
  parseStoredTokenCostSummary,
  StoredTokenCostSummaryOrigin,
} from "../src/main/database/token-event-contract.js";

/**
 * The desktop projection and the cloud ingest boundary are a byte-exact
 * producer/consumer pair, and until now NOTHING crossed between them: the
 * producer is covered by `component-invocation-sync-item-telemetry.test.ts`, the
 * boundary by `packages/api`'s own suite, and neither ever fed one to the other.
 *
 * What that gap hides is the worst failure this repo has a name for. The item
 * schema is `.strict()`, so a key the projection emits but the boundary was
 * never taught is not stripped — it is a 400 the client maps to
 * `validation_failed`, which is PERMANENT: the part dead-letters after five
 * attempts and the whole generation is dropped for good, re-dropped on every
 * retry (see the protocol-version note on
 * `AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION`).
 */
describe("ISS-5608: stored invocation row -> cloud .strict() ingest boundary", () => {
  test("a maximal projected item is ACCEPTED by the cloud item schema", () => {
    const item = storedRowToSyncItem(maximalSubagentRow());

    const result = agentComponentInvocationSyncItemSchema.safeParse(item);

    // Not `assert.ok(result.success)`: on a rejection the issue list is the
    // whole diagnostic, and an opaque "expected true" would send the next reader
    // back to reproduce it by hand.
    assert.deepEqual(
      result.success ? [] : result.error.issues.map((issue) => issue.message),
      []
    );
  });

  test("a projected item survives JSON transport unchanged", () => {
    // The item is serialized before it reaches the boundary and its bytes are
    // the generation-hash preimage, so a value that does not survive
    // `JSON.stringify` -> `JSON.parse` identically would reconcile as a
    // different generation even when the boundary accepts it.
    const item = storedRowToSyncItem(maximalSubagentRow());

    assert.deepEqual(JSON.parse(JSON.stringify(item)), item);
  });

  test("absent optionals stay OMITTED rather than serializing as null", () => {
    // `invokedAt` is the ONE deliberately nullable field on the contract; every
    // other absent optional must be an omitted key, because a stray `null`
    // changes the hash preimage and an older build that computes nothing new
    // would stop being byte-identical on the wire.
    const item = storedRowToSyncItem(minimalToolRow());

    const nulled = Object.entries(item)
      .filter(([, value]) => value === null)
      .map(([key]) => key);
    assert.deepEqual(nulled, ["invokedAt"]);
    assert.equal(
      agentComponentInvocationSyncItemSchema.safeParse(item).success,
      true
    );
  });
});

/**
 * `storedLocalTokenCostSummarySchema` WAS `.strict()` on a PERSISTED envelope, so
 * it was the same trap one level down: an envelope key a later build adds made
 * every older build fail the strict parse, fall through both fallbacks, and
 * report the cost UNAVAILABLE — discarding a cost that is sitting right there in
 * the envelope's own `summary`.
 *
 * ISS-7822 reversed that. The envelope is self-authored local cache rather than a
 * trust boundary, so it now tolerates an unknown key and yields the cost it
 * carries; the expectation below changed with it, which is the point of that
 * ticket rather than test drift. The inner `tokenCostSummarySchema` — a real
 * cross-process wire contract — is still strict, and the two cases below prove
 * exactly that split by moving ONE untaught key across the boundary and nothing
 * else: outside the summary it is tolerated and the cost survives, inside it the
 * parse is refused and the read degrades.
 *
 * The existing suite covers malformed JSON and an unknown `completeness`
 * discriminant. Neither reaches the envelope, because both fail before it.
 */
describe("ISS-5608: stored local token cost envelope, untaught key", () => {
  const summary = {
    completeness: TokenCostCompleteness.Unavailable,
    reason: TokenCostCompletenessReason.LegacyRecord,
  } as const;

  /**
   * A REAL computed cost, not the `Unavailable` sentinel the first case uses:
   * the defect ISS-7822 fixes is a dollar figure being thrown away, so a fixture
   * whose "cost" is itself an unavailability marker could not tell a preserved
   * cost from a preserved absence.
   *
   * Shared by the two cases that place an unknown key on either side of the
   * boundary, so each one's "otherwise valid" premise is the very summary the
   * case above round-trips rather than a claim made in a comment.
   */
  const pricedSummary = {
    completeness: TokenCostCompleteness.Complete,
    subtotalUsd: 0.047_536_25,
  } as const;

  test("a valid envelope yields the summary it carries", () => {
    // The positive sibling. Without it the rejection below is satisfied by any
    // envelope this parser dislikes for any reason at all.
    const stored = JSON.stringify({
      origin: StoredTokenCostSummaryOrigin.Local,
      summary,
    });

    assert.deepEqual(parseStoredTokenCostSummary(stored), summary);
    assert.equal(isLocallyDerivedStoredTokenCostSummary(stored), true);
  });

  test("an envelope key from a newer build still yields the cost it carries", () => {
    const stored = JSON.stringify({
      origin: StoredTokenCostSummaryOrigin.Local,
      summary: pricedSummary,
      // The envelope field a later build would add. Named literally rather than
      // derived from the schema: a fixture that asks the schema what it does not
      // know can never fail.
      pricingContractVersion: 2,
    });

    // ISS-7822: the envelope is self-authored local cache, so an unknown key no
    // longer costs the reader the cost. Both halves matter and they fail
    // independently. The first is what `token-event-sync.ts` feeds into the
    // agent-session metadata lane, so a degraded value here is what the cloud
    // stores for the event on every re-sync. The second is what
    // `producerCostSummary` (`token-cost-maintenance.ts`) reads: a `false` there
    // makes the sweep treat this row as authoritative PRODUCER evidence and
    // preserve it, so the one mechanism built to reheal stale local estimates
    // goes blind to exactly the rows that need it.
    assert.deepEqual(parseStoredTokenCostSummary(stored), pricedSummary);
    assert.equal(isLocallyDerivedStoredTokenCostSummary(stored), true);
  });

  test("the same unknown key INSIDE the summary is still rejected", () => {
    // The negative half of the boundary, and it is deliberately the SAME
    // otherwise-valid priced summary the case above round-trips, carrying an
    // unknown key one level deeper. That is what makes the pair prove "outer
    // envelope tolerant / inner summary strict" and not merely "some blobs are
    // rejected": the only difference between the two fixtures is which side of
    // the boundary the untaught key sits on.
    //
    // An invalid `completeness` discriminant would NOT prove this — a
    // discriminated union rejects an unknown discriminant whether or not its
    // members are `.strict()`, so that fixture stays red even if the inner
    // schema were widened, and cannot fail when the boundary is lost. (That
    // degradation path is covered on its own in
    // `token-event-provenance-roundtrip.test.ts`.)
    const stored = JSON.stringify({
      origin: StoredTokenCostSummaryOrigin.Local,
      summary: {
        ...pricedSummary,
        pricingModelRevision: "2026-09-cache-tiers",
      },
    });

    assert.deepEqual(parseStoredTokenCostSummary(stored), {
      completeness: TokenCostCompleteness.Unavailable,
      reason: TokenCostCompletenessReason.Unknown,
    });
    assert.equal(isLocallyDerivedStoredTokenCostSummary(stored), false);
  });
});

/**
 * Every column the projection can read, populated. A minimal row would clear the
 * boundary on the strength of the fields it omits, which is exactly the item
 * that never exercises the `.strict()` key set.
 */
function maximalSubagentRow(): StoredInvocationRow {
  return {
    session_id: "session-max",
    external_invocation_id: "invocation-max",
    external_source_id: "source-max",
    child_session_id: "child-session-max",
    agent_id: "agent-max",
    parent_agent_id: "parent-agent-max",
    component_kind: AgentComponentInvocationKind.Subagent,
    component_key: "reviewer",
    raw_name: "Reviewer",
    normalized_name: "reviewer",
    relationship: AgentComponentInvocationRelationship.Direct,
    invoked_at: "2026-08-23T16:00:00.000Z",
    sequence: 4,
    anchor_kind: AgentComponentInvocationAnchorKind.Agent,
    anchor_value: "agent-max",
    provider_tool_use_id: "toolu_max",
    attribution_status: AgentComponentInvocationAttributionStatus.Matched,
    evidence_class: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
    // `Required<EvidencePointer>`, not a bare `satisfies EvidencePointer`:
    // every member of the pointer is optional, so only `Required` makes a
    // dropped or renamed member fail `tsc`. Seven of the projected item's
    // optional keys come out of this blob, and the `StoredInvocationRow.
    // evidence_pointer` column is typed `string | EvidencePointer | null` — the
    // `string` arm this fixture uses is checked against nothing on its own, so
    // without the annotation the row could silently stop being maximal.
    evidence_pointer: JSON.stringify({
      definitionFormat: "markdown",
      sourcePath: ".claude/agents/reviewer.md",
      sourceModifiedAt: "2026-08-20T09:00:00.000Z",
      capturedAt: "2026-08-23T15:59:00.000Z",
      externalAgentId: "external-agent-max",
      transcriptFileId: "transcript-max",
      parentExternalInvocationId: "invocation-parent",
    } satisfies Required<EvidencePointer>),
    definition_hash: "a".repeat(64),
    normalizer_contract_version: 3,
    definition_content: "# Reviewer\n",
    git_branch: "feature/max",
    repository_full_name: "acme/web",
    model: "claude-opus-5",
    input_tokens: 12_345n,
    output_tokens: 678n,
    cache_read_tokens: 90_123n,
    cache_write_tokens: 45n,
    estimated_cost: 1.234_567,
    footprint_tokens: 4096n,
    // The label the writer pairs with counts: `storedUsageRow` emits
    // `Measured` on exactly the branch that emits the five values above, and
    // `null` on the branch that nulls them. A label without telemetry is
    // rejected as `usage_measurement_requires_telemetry`, so a populated row
    // cannot carry `null` here.
    usage_measurement: AgentComponentInvocationUsageMeasurement.Measured,
    // ISS-10730: a subagent row is outside LINE_BEARING_INVOCATION_KINDS, so
    // line attribution is NULL here by contract, not by omission.
    lines_added: null,
    lines_removed: null,
    succeeded: null,
    // ISS-10725: the maximal row carries the findings pair too, so the `.strict()`
    // key set this fixture exists to exercise includes the v5 keys.
    findings_emitted: 10n,
    findings_invalidated: 3n,
    // ISS-11325: and the statement about that pair, so the `.strict()` key set
    // this fixture exists to exercise includes the v8 key. A value CONSISTENT
    // with the counts, because the projection refuses a contradicting one and
    // the row would then stop being maximal without going red.
    findings_disposition: AgentComponentFindingsDisposition.CarriedForward,
    attribution_source: null,
  };
}

/** The narrowest row the projection can be handed: every optional column NULL. */
function minimalToolRow(): StoredInvocationRow {
  return {
    ...maximalSubagentRow(),
    external_source_id: null,
    child_session_id: null,
    agent_id: null,
    parent_agent_id: null,
    component_kind: AgentComponentInvocationKind.Tool,
    component_key: "Read",
    raw_name: null,
    normalized_name: null,
    invoked_at: null,
    anchor_kind: AgentComponentInvocationAnchorKind.Session,
    anchor_value: "session-max",
    provider_tool_use_id: null,
    attribution_status: AgentComponentInvocationAttributionStatus.Unresolved,
    evidence_class: AgentComponentInvocationEvidenceClass.None,
    evidence_pointer: null,
    definition_hash: null,
    normalizer_contract_version: null,
    definition_content: null,
    git_branch: null,
    repository_full_name: null,
    model: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    estimated_cost: null,
    footprint_tokens: null,
    // Without this the spread would inherit the maximal row's `Measured` and
    // leave the fixture claiming a measurement for counts it just nulled —
    // which `tsc` cannot catch, the column being `string | null`.
    usage_measurement: null,
    lines_added: null,
    lines_removed: null,
    findings_emitted: null,
    findings_invalidated: null,
    // ISS-11325: no disposition recorded on a fixture the findings ingest never reached.
    findings_disposition: null,
    attribution_source: null,
  };
}
