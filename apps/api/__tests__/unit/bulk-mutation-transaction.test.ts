/**
 * ISS-9465 — the mint and the audit-detail stamp.
 *
 * The mint has exactly one production site per bulk route, so the property that
 * matters is that two calls never agree: a constant here would silently merge
 * every batch the process ever served into one "transaction".
 */
import { describe, expect, it } from "vitest";
import {
  newBulkTransactionId,
  withBulkTransaction,
} from "@/lib/bulk-mutation-transaction";

describe("newBulkTransactionId", () => {
  it("never returns the same id twice", () => {
    const ids = new Set(
      Array.from({ length: 256 }, () => newBulkTransactionId())
    );

    expect(ids.size).toBe(256);
  });
});

describe("withBulkTransaction", () => {
  it("stamps the id alongside the domain detail", () => {
    expect(withBulkTransaction({ from: "TODO", to: "DONE" }, "txn-1")).toEqual({
      from: "TODO",
      to: "DONE",
      transactionId: "txn-1",
    });
  });

  it("wins over a `transactionId` the domain detail carried itself", () => {
    // The stamp is applied last on purpose. A detail that reached here holding
    // its own key would otherwise overwrite the real commit id in a row nobody
    // can edit afterwards.
    const stamped = withBulkTransaction(
      { transactionId: "forged", slug: "ISS-1" },
      "txn-1"
    );

    expect(stamped.transactionId).toBe("txn-1");
  });
});
