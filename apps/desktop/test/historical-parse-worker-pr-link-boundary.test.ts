import assert from "node:assert/strict";
import { PR_INT_MAX } from "@repo/api/src/types/session-artifact-link";
import { describe, test } from "vitest";
import {
  HistoricalParseWorkerResponseType,
  historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import { makeSession } from "./historical-parse-worker-response-support.js";

const PR_URL = "https://github.com/closedloop-ai/closedloop-ai/pull/12";

describe("historical parse worker pr-link number boundary (ISS-7970)", () => {
  test("accepts prNumber: 12", () => {
    assert.equal(parseResponseWithPrNumber("12").success, true);
  });

  test("keeps the pending heuristic artifact placeholder", () => {
    const session = makeSession("worker-artifact-pr-pending");
    const response = historicalParseWorkerResponseSchema.safeParse({
      type: HistoricalParseWorkerResponseType.Parsed,
      requestId: "historical-parse-artifact-pr-pending",
      sessions: [
        {
          ...session,
          artifacts: {
            ...session.artifacts,
            prs: [{ number: "pending" }],
          },
        },
      ],
    });

    assert.equal(response.success, true);
  });

  test("rejects the pending sentinel when it appears in harness prLinks", () => {
    assert.equal(parseResponseWithPrNumber("pending").success, false);
  });

  test("rejects prNumber: 1.5", () => {
    assert.equal(parseResponseWithPrNumber("1.5").success, false);
  });

  test("rejects prNumber: 0", () => {
    assert.equal(parseResponseWithPrNumber("0").success, false);
  });

  test("rejects prNumber: -1", () => {
    assert.equal(parseResponseWithPrNumber("-1").success, false);
  });

  test("rejects a prNumber outside the persisted Prisma Int domain", () => {
    assert.equal(
      parseResponseWithPrNumber(String(PR_INT_MAX + 1)).success,
      false
    );
  });

  test("carries the malformedPrLinkNumbers parse-quality counter across the boundary", () => {
    const session = makeSession("worker-pr-link-parse-quality");
    const response = historicalParseWorkerResponseSchema.safeParse({
      type: HistoricalParseWorkerResponseType.Parsed,
      requestId: "historical-parse-pr-link-parse-quality",
      sessions: [
        {
          ...session,
          parseQuality: {
            totalLines: 2,
            malformedLines: 0,
            truncatedFinalLine: false,
            malformedPrLinkNumbers: 1,
          },
        },
      ],
    });

    // This boundary is `.strict()`: a field the producer emits but the schema
    // does not know rejects the WHOLE payload, silently dropping the session on
    // every retry. Assert the counter survives, not merely that the parse ran.
    assert.equal(response.success, true);
    assert.equal(
      response.success &&
        response.data.type === HistoricalParseWorkerResponseType.Parsed
        ? response.data.sessions[0]?.parseQuality?.malformedPrLinkNumbers
        : undefined,
      1
    );
  });
});

function parseResponseWithPrNumber(number: string) {
  const session = {
    ...makeSession(`worker-pr-link-${number}`),
    prLinks: [{ number, url: PR_URL }],
  };
  return historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-pr-link-boundary",
    sessions: [session],
  });
}
