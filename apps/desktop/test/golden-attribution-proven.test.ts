/**
 * ISS-12552 (PRD-800 "Proving usage"): the oracle derives proven
 * tokens from signed request facts under the pinned policy.
 */
import {
  AttributionRelationshipKind,
  OperationKind,
  UsageTokenCategory,
} from "@repo/api/src/types/attribution-evidence";
import { describe, expect, it } from "vitest";
import type { AttributionBlock } from "./golden/golden-attribution-facts.js";
import { receiptProvenTokens } from "./golden/golden-attribution-proven.js";

const idOf = (target: { slug?: string; uuid?: string } | undefined) =>
  target?.slug;

function write(
  slug: string,
  requestId: string,
  extra: Partial<{
    operation_id: string;
    committed: boolean;
    relationship: AttributionRelationshipKind;
    kind: OperationKind;
  }> = {}
) {
  return {
    operation_id: "clop_01a14224-9b59-77ba-b518-16aaa9880991",
    provider_id: `toolu_${slug}_${requestId}`,
    target: { slug },
    kind: OperationKind.Create,
    committed: true,
    relationship: AttributionRelationshipKind.Creation,
    anchors: { lines: [1] },
    request_id: requestId,
    ...extra,
  };
}

function usage(requestId: string, tokens: number) {
  return {
    source_usage_ids: [requestId],
    categories: [UsageTokenCategory.Output],
    owning_agent: "parent",
    request_id: requestId,
    tokens,
  };
}

function block(
  operations: ReturnType<typeof write>[],
  usages: ReturnType<typeof usage>[]
): AttributionBlock {
  return { operations, usage: usages };
}

describe("receiptProvenTokens", () => {
  it("proves a request's tokens for the one artifact its receipted write names", () => {
    expect(
      receiptProvenTokens(
        block(
          [
            write("PLN-1", "req_1"),
            write("PLN-1", "req_1", {
              relationship: AttributionRelationshipKind.Usage,
              kind: OperationKind.Read,
            }),
          ],
          [usage("req_1", 100), usage("req_2", 40)]
        ),
        idOf
      )
    ).toEqual(new Map([["PLN-1", 100]]));
  });

  it("proves nothing for a request whose receipted writes name two artifacts", () => {
    expect(
      receiptProvenTokens(
        block(
          [write("ISS-1", "req_1"), write("PLN-2", "req_1")],
          [usage("req_1", 100)]
        ),
        idOf
      )
    ).toEqual(new Map());
  });

  it("proves nothing from a write with no receipt, or one that did not commit", () => {
    const { operation_id: _receipt, ...withoutReceipt } = write(
      "PLN-1",
      "req_1"
    );
    expect(
      receiptProvenTokens(
        block(
          [
            withoutReceipt as ReturnType<typeof write>,
            write("PLN-2", "req_2", { committed: false }),
          ],
          [usage("req_1", 100), usage("req_2", 50)]
        ),
        idOf
      )
    ).toEqual(new Map());
  });

  it("proves a join's requests for its branch, and a request also writing a document for neither", () => {
    const joined: AttributionBlock = {
      ...block(
        [write("PLN-1", "req_both")],
        [usage("req_write", 30), usage("req_commit", 20), usage("req_both", 50)]
      ),
      implementation_joins: [
        {
          recipient: { slug: "feat/x" },
          request_ids: ["req_write", "req_commit", "req_both"],
          anchors: { lines: [1] },
        },
      ],
    };

    expect(receiptProvenTokens(joined, idOf)).toEqual(
      new Map([["feat/x", 50]])
    );
  });
});
