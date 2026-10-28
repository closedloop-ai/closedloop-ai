/**
 * ISS-12552: the expectations schema version 3 attribution
 * block is strict, and only version 3 may carry it.
 */
import assert from "node:assert/strict";
import {
  AttributionRelationshipKind,
  OperationKind,
  UsageTokenCategory,
} from "@repo/api/src/types/attribution-evidence";
import { describe, test } from "vitest";
import {
  ASSERTED_EMPTY,
  NonContributionReason,
  parseAttributionExpectations,
} from "./golden/golden-attribution-facts.js";

const ANCHORS = {
  lines: [12, 13],
  receipt_ids: ["01a155a2-0000-7000-8000-000000000001"],
};

const FULL_BLOCK = {
  derived_by: "ISS-12552 intake, from raw",
  candidate_artifacts: [{ slug: "PRD-1" }, { slug: "feat/x" }],
  operations: [
    {
      operation_id: "clop_01a155a2-0000-7000-8000-000000000001",
      provider_id: "toolu_01",
      target: { slug: "PRD-1" },
      kind: OperationKind.UpdateFields,
      committed: true,
      relationship: AttributionRelationshipKind.Revision,
      anchors: ANCHORS,
      request_id: "req_01",
    },
  ],
  implementation_joins: [
    {
      recipient: { slug: "feat/x", artifact_type: "BRANCH" },
      request_ids: ["req_01", "req_02"],
      anchors: { lines: [30, 31] },
    },
  ],
  non_contributions: [
    {
      provider_id: "toolu_02",
      target: { slug: "PRD-1" },
      reason: NonContributionReason.Read,
      anchors: { lines: [20] },
    },
  ],
  usage: [
    {
      source_usage_ids: ["msg_01"],
      categories: [UsageTokenCategory.Input],
      owning_agent: "parent",
      request_id: "req_01",
      tokens: 120,
    },
  ],
  unresolved_usage: ASSERTED_EMPTY,
  coverage_limitations: [{ limitation: "search results are summarized" }],
};

describe("parseAttributionExpectations", () => {
  test("reads an earlier schema version as not annotated", () => {
    for (const schema_version of [1, 2]) {
      assert.deepEqual(
        parseAttributionExpectations({ schema_version, harness: "claude" }),
        {
          ok: true,
          attribution: undefined,
        }
      );
    }
  });

  test("accepts a full version 3 block, with asserted_empty lists", () => {
    const parsed = parseAttributionExpectations({
      schema_version: 3,
      attribution: FULL_BLOCK,
    });

    assert.equal(parsed.ok, true);
    assert.equal(
      parsed.ok && parsed.attribution?.unresolved_usage,
      ASSERTED_EMPTY
    );
  });

  test("rejects an unknown schema version", () => {
    assert.equal(parseAttributionExpectations({ schema_version: 4 }).ok, false);
  });

  test("rejects an attribution block outside version 3", () => {
    assert.equal(
      parseAttributionExpectations({
        schema_version: 2,
        attribution: FULL_BLOCK,
      }).ok,
      false
    );
  });

  test("rejects an unknown key, an empty list, a target with no identity, and an unknown relationship", () => {
    for (const attribution of [
      { ...FULL_BLOCK, extra: [] },
      { ...FULL_BLOCK, usage: [] },
      { ...FULL_BLOCK, candidate_artifacts: [{ artifact_type: "PRD" }] },
      {
        ...FULL_BLOCK,
        operations: [{ ...FULL_BLOCK.operations[0], relationship: "authored" }],
      },
    ]) {
      assert.equal(
        parseAttributionExpectations({ schema_version: 3, attribution }).ok,
        false
      );
    }
  });

  test("rejects a signed proven total, and an operation or usage that names no request", () => {
    const [usage] = FULL_BLOCK.usage;
    const { request_id: _opRequest, ...withoutOperationRequest } =
      FULL_BLOCK.operations[0];
    const { request_id: _request, ...withoutRequest } = usage;
    const { tokens: _tokens, ...withoutTokens } = usage;
    for (const attribution of [
      {
        ...FULL_BLOCK,
        proven_allocations: [
          {
            recipient: { slug: "PRD-1" },
            source_usage_ids: ["msg_01"],
            tokens: 120,
          },
        ],
      },
      {
        ...FULL_BLOCK,
        operations: [withoutOperationRequest],
      },
      { ...FULL_BLOCK, usage: [withoutRequest] },
      { ...FULL_BLOCK, usage: [withoutTokens] },
    ]) {
      assert.equal(
        parseAttributionExpectations({ schema_version: 3, attribution }).ok,
        false
      );
    }
  });
});
