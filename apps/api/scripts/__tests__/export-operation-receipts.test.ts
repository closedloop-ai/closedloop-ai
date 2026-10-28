import { createHash } from "node:crypto";
import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { describe, expect, it } from "vitest";
import {
  buildOperationReceiptExport,
  parseIdList,
  type ReceiptRow,
} from "../export-operation-receipts";

const DOCUMENT = "01a155a2-71c2-74f2-93bc-9f34a4d6ab1d";

function receipt(extra: Partial<ReceiptRow>): ReceiptRow {
  return {
    id: "01a155a2-0000-7000-8000-000000000001",
    source: OperationSource.Mcp,
    operationKind: OperationKind.CreateVersion,
    outcome: OperationReceiptOutcome.Committed,
    targetArtifactId: DOCUMENT,
    createdArtifactId: null,
    versionNumber: 2,
    changedFields: ["content"],
    contentDigestBefore: "a",
    contentDigestAfter: "b",
    clientCallId: "toolu_version",
    requestFingerprint: "fp",
    requestedAt: new Date("2026-10-19T14:00:02.000Z"),
    committedAt: new Date("2026-10-19T14:00:03.000Z"),
    ...extra,
  };
}

describe("buildOperationReceiptExport", () => {
  it("keys receipts by operation id in request order, with each versioned write's before and after", () => {
    const exported = buildOperationReceiptExport(
      [
        receipt({}),
        receipt({
          id: "01a155a2-0000-7000-8000-000000000000",
          operationKind: OperationKind.UpdateFields,
          versionNumber: null,
          changedFields: ["title"],
          clientCallId: "toolu_rename",
          requestedAt: new Date("2026-10-19T14:00:01.000Z"),
        }),
      ],
      [
        {
          documentId: DOCUMENT,
          version: 1,
          content: "one",
          createdAt: new Date("2026-10-19T13:59:00.000Z"),
        },
        {
          documentId: DOCUMENT,
          version: 2,
          content: "two",
          createdAt: new Date("2026-10-19T14:00:03.000Z"),
        },
      ]
    );

    expect(Object.keys(exported.receipts)).toEqual([
      "clop_01a155a2-0000-7000-8000-000000000000",
      "clop_01a155a2-0000-7000-8000-000000000001",
    ]);
    expect(
      exported.receipts["clop_01a155a2-0000-7000-8000-000000000001"]
    ).toMatchObject({
      clientCallId: "toolu_version",
      requestedAt: "2026-10-19T14:00:02.000Z",
    });
    expect(exported.state).toEqual({
      "clop_01a155a2-0000-7000-8000-000000000001": {
        documentId: DOCUMENT,
        before: {
          version: 1,
          contentSha256: createHash("sha256").update("one").digest("hex"),
          createdAt: "2026-10-19T13:59:00.000Z",
        },
        after: {
          version: 2,
          contentSha256: createHash("sha256").update("two").digest("hex"),
          createdAt: "2026-10-19T14:00:03.000Z",
        },
      },
    });
  });

  it("splits harness call ids from receipt operation ids, once each", () => {
    expect(parseIdList("toolu_1\nclop_01a1-x\n\n toolu_1 \nexec-9\n")).toEqual({
      callIds: ["toolu_1", "exec-9"],
      receiptIds: ["01a1-x"],
    });
  });
});
