import { describe, expect, it } from "vitest";
import { receiptContentChanged } from "./receipt-outcome";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

describe("receiptContentChanged", () => {
  it.each([
    {
      case: "no content before, none after",
      before: null,
      after: null,
      changed: false,
    },
    {
      case: "no content before, content after (a first content save)",
      before: null,
      after: DIGEST_A,
      changed: true,
    },
    {
      case: "content before, none after",
      before: DIGEST_A,
      after: null,
      changed: false,
    },
    {
      case: "equal content before and after",
      before: DIGEST_A,
      after: DIGEST_A,
      changed: false,
    },
    {
      case: "different content before and after",
      before: DIGEST_A,
      after: DIGEST_B,
      changed: true,
    },
  ])("$case is changed: $changed", ({ before, after, changed }) => {
    expect(
      receiptContentChanged({
        contentDigestBefore: before,
        contentDigestAfter: after,
      })
    ).toBe(changed);
  });
});
