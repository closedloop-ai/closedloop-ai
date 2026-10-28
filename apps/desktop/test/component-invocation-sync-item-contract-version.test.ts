/**
 * @file component-invocation-sync-item-contract-version.test.ts
 * @description ISS-7580 (@whitlockk review): the SYNC-WIRE producer's reading of
 * `normalizer_contract_version`, checked against the strict boundary schema that
 * actually consumes it.
 *
 * The dashboard read row was not the only producer of this column.
 * `storedRowToSyncItem` mapped it with a bare `Number(...)`, so a corrupt TEXT
 * cell became `NaN` and a blank one became `0` — and `normalizerContractVersion`
 * is `z.number().int().positive().optional()` on the wire, which rejects both.
 * A `.strict()` boundary rejects the WHOLE part, not the one field, so a single
 * unreadable cell dropped every invocation batched with it and re-dropped them
 * on every retry. Both producers now read the column through one function, so
 * they cannot disagree about what a version is.
 *
 * These cases parse against the real schema rather than a copy of its rules, so
 * they follow the constraint if it ever moves.
 *
 * WHAT THIS DOES NOT CLAIM. The same schema separately requires that a MATCHED
 * invocation carry both a definition hash and a version
 * (`matched_invocation_missing_version`). A matched row whose version cell is
 * corrupt therefore still fails — omitting the field cannot conjure the
 * attribution evidence the status asserts, and downgrading the status to fit
 * would be inventing an attribution claim. The last case pins that honestly: the
 * gain there is a truthful rejection reason instead of a NaN type error, not
 * delivery.
 */

import assert from "node:assert/strict";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { agentComponentInvocationSyncItemSchema } from "@repo/api/src/types/agent-component-invocation-schema";
import { PR_INT_MAX } from "@repo/api/src/types/session-artifact-link";
import { describe, it } from "vitest";
import {
  type StoredInvocationRow,
  storedRowToSyncItem,
} from "../src/main/database/component-invocation-sync-item.js";

/** Every spelling of "this cell is not a version", per the wire constraint. */
const NOT_A_VERSION = [
  ["corrupt text", "n/a"],
  ["blank", ""],
  ["whitespace", "   "],
  ["zero", 0],
  ["negative", -1],
  ["fractional", 1.5],
  ["not a number", Number.NaN],
  ["overflowed", Number.POSITIVE_INFINITY],
  // ISS-8329 (@whitlockk review): the column is int4. Above that ceiling the value
  // is wire-invalid for the same reason as the rest of this table — it cannot
  // reach the column — so it degrades to omission here rather than dead-lettering
  // the generation at the write.
  ["an int4 overflow", PR_INT_MAX + 1],
  ["an int4 overflow as TEXT", String(PR_INT_MAX + 1)],
] as const;

describe("ISS-7580 sync item normalizer contract version", () => {
  it("emits a real version unchanged", () => {
    const item = storedRowToSyncItem(storedRow(4));

    assert.equal(item.normalizerContractVersion, 4);
    assert.deepEqual(parseIssues(item), []);
  });

  it("omits the key for a NULL cell, the shape absence has always had", () => {
    const item = storedRowToSyncItem(storedRow(null));

    assert.equal("normalizerContractVersion" in item, false);
    assert.deepEqual(parseIssues(item), []);
  });

  for (const [label, cell] of NOT_A_VERSION) {
    it(`omits the key for a ${label} cell instead of failing the part`, () => {
      const item = storedRowToSyncItem(storedRow(cell));

      assert.equal(
        "normalizerContractVersion" in item,
        false,
        `a ${label} cell must not reach the wire as a version`
      );
      // The point of the fix: the part still parses, so the unreadable cell
      // costs its own field and not every invocation batched beside it.
      assert.deepEqual(parseIssues(item), []);
    });
  }

  it("still rejects a MATCHED row with an unreadable version, by the honest rule", () => {
    const item = storedRowToSyncItem({
      ...storedRow("n/a"),
      attribution_status: AgentComponentInvocationAttributionStatus.Matched,
      definition_hash: "a".repeat(64),
    });

    assert.deepEqual(parseIssues(item), ["matched_invocation_missing_version"]);
  });
});

/** The boundary's own verdict, as messages — `[]` means the part would ship. */
function parseIssues(item: unknown): string[] {
  const parsed = agentComponentInvocationSyncItemSchema.safeParse(item);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => issue.message);
}

/**
 * The declared column type is `number | null`, but it does not constrain what
 * SQLite hands back through `$queryRawUnsafe` — a corrupt cell arrives as TEXT.
 * That gap is the subject here, so the fixture takes the runtime union and
 * narrows once, deliberately.
 */
function storedRow(
  normalizerContractVersion: number | string | null
): StoredInvocationRow {
  return {
    session_id: "session-contract-version",
    external_invocation_id: "inv-1",
    external_source_id: null,
    child_session_id: null,
    agent_id: null,
    parent_agent_id: null,
    component_kind: AgentComponentInvocationKind.Skill,
    component_key: "contract-version-check",
    raw_name: null,
    normalized_name: null,
    relationship: AgentComponentInvocationRelationship.Direct,
    invoked_at: null,
    sequence: 0,
    anchor_kind: AgentComponentInvocationAnchorKind.Session,
    anchor_value: "session-contract-version",
    provider_tool_use_id: null,
    attribution_status: AgentComponentInvocationAttributionStatus.Unmatched,
    evidence_class: AgentComponentInvocationEvidenceClass.None,
    evidence_pointer: null,
    definition_hash: null,
    normalizer_contract_version: normalizerContractVersion as number | null,
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
    usage_measurement: null,
    lines_added: null,
    lines_removed: null,
    succeeded: null,
    findings_emitted: null,
    findings_invalidated: null,
    // ISS-11325: no disposition recorded on a fixture the findings ingest never reached.
    findings_disposition: null,
    attribution_source: null,
  };
}
