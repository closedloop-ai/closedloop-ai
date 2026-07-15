import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readSequentially } from "../src/main/shared-branches-api.js";

const READ_FAILED = /read failed/;

/**
 * FEA-3056: the Branches list + analytics handlers stopped `Promise.all`-ing
 * their heavy row-materializing reads (which OOM'd the db-host worker when both
 * handlers' large result sets were resident at once) and now await them through
 * `readSequentially`. These tests pin the two properties the OOM fix depends on:
 *
 *  1. NEVER more than one thunk in flight — that is the whole point (peak heap =
 *     one big result set, not N). A concurrent `Promise.all` would fail (1).
 *  2. The resolved tuple is positional (same order as the thunks) so the call
 *     sites' array destructuring keeps binding the right read to the right name —
 *     i.e. output parity with the previous `Promise.all` tuple.
 */
describe("readSequentially (FEA-3056 branches OOM guard)", () => {
  it("runs at most one thunk at a time (never concurrent)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];

    const makeThunk = (id: number) => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield to the event loop: if two thunks were started together this is
      // where their `inFlight` counts would overlap and push maxInFlight to 2.
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(id);
      inFlight -= 1;
      return id;
    };

    const results = await readSequentially([
      makeThunk(1),
      makeThunk(2),
      makeThunk(3),
    ]);

    assert.equal(maxInFlight, 1, "no two reads may be resident at once");
    // Thunks are invoked and complete strictly in declared order.
    assert.deepEqual(order, [1, 2, 3]);
    assert.deepEqual(results, [1, 2, 3]);
  });

  it("serializes across CONCURRENT readSequentially calls (module-level gate)", async () => {
    // The real OOM path: the Branches screen fires the list and analytics
    // handlers as SEPARATE concurrent IPC calls. Per-call sequencing alone would
    // let each start its first heavy read at once — two big result sets resident
    // together. The module-level gate must keep at most ONE thunk in flight
    // ACROSS both calls.
    let inFlight = 0;
    let maxInFlight = 0;

    const makeThunk = (id: string) => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return id;
    };

    // Two independent invocations kicked off together (list + analytics).
    await Promise.all([
      readSequentially([makeThunk("list-1"), makeThunk("list-2")]),
      readSequentially([makeThunk("analytics-1"), makeThunk("analytics-2")]),
    ]);

    assert.equal(
      maxInFlight,
      1,
      "at most one heavy branch read across ALL handlers"
    );
  });

  it("preserves positional tuple results across mixed types", async () => {
    const [links, prs, tokens] = await readSequentially([
      () => Promise.resolve([{ branchName: "a" }]),
      () => Promise.resolve([{ prNumber: 7 }]),
      () => Promise.resolve({ totalCostUsd: 1.5 }),
    ]);

    // Each element keeps its own type/position — the exact parity the call-site
    // destructuring (`const [linkRows, prRows, tokenRows] = ...`) relies on.
    assert.deepEqual(links, [{ branchName: "a" }]);
    assert.deepEqual(prs, [{ prNumber: 7 }]);
    assert.deepEqual(tokens, { totalCostUsd: 1.5 });
  });

  it("propagates a thunk rejection and stops the sequence", async () => {
    const ran: number[] = [];
    await assert.rejects(
      readSequentially([
        () => {
          ran.push(1);
          return Promise.resolve(1);
        },
        () => {
          ran.push(2);
          return Promise.reject(new Error("read failed"));
        },
        () => {
          ran.push(3);
          return Promise.resolve(3);
        },
      ]),
      READ_FAILED
    );
    // The third thunk must never start once the second rejects — matching the
    // fail-fast semantics the handlers' surrounding try/catch expects.
    assert.deepEqual(ran, [1, 2]);
  });
});
