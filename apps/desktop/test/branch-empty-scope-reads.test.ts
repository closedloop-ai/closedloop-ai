import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readBranchCanonicalActivityRowsForScope,
  readBranchMetricEventEvidenceForScope,
} from "../src/main/branch/branch-empty-scope-reads.js";
import type { BranchCanonicalActivityReadRequest } from "../src/main/database/branch-activity-read.js";
import type { BranchMetricEventEvidenceRequest } from "../src/main/database/branch-metric-event-provenance.js";
import {
  BOUNDED_READ_OP_LIMIT,
  createDbHostOpLanes,
} from "../src/main/database/db-host/db-host-op-lanes.js";

/**
 * ISS-5957 review (T3) — an empty Branch cohort must not queue for admission.
 *
 * Both facades already return early for an empty cohort, but they do it in the
 * worker, INSIDE the method — after `runInvokeOp` has taken a bounded-lane
 * permit. So an empty Branches page could wait behind a corpus-scale Sessions
 * hydration to execute no SQL at all.
 *
 * These tests pin the SATURATED-lane case, which is the only state where the
 * bug is observable: with every permit held by work that never finishes, an
 * empty-scope read still returns. The assertion is on observable behavior — it
 * resolved, with the canonical empty value, having made no proxy call — never on
 * a duration (`no-timing-assertions`). A non-empty cohort is included as the
 * control: it must still be admitted through the lane, and under saturation it
 * must NOT settle.
 */

/** Held-permit ops the lane admits and never releases, one per permit. */
const SATURATING_OP = "syncSource.aggregateUsage";
const PENDING = "pending" as const;

type SaturatedLane = {
  lanes: ReturnType<typeof createDbHostOpLanes>;
  /** Frees every held permit and drains the lane. */
  release: () => Promise<void>;
};

/** A real lane with every permit taken by a task that parks until released. */
async function saturateBoundedLane(): Promise<SaturatedLane> {
  const lanes = createDbHostOpLanes();
  let unpark = (): void => {
    // replaced synchronously below
  };
  const parked = new Promise<void>((resolve) => {
    unpark = resolve;
  });
  const admitted: Promise<void>[] = [];
  const held: Promise<void>[] = [];
  for (let i = 0; i < BOUNDED_READ_OP_LIMIT; i++) {
    let markAdmitted = (): void => {
      // replaced synchronously below
    };
    admitted.push(
      new Promise<void>((resolve) => {
        markAdmitted = resolve;
      })
    );
    held.push(
      lanes.runInvokeOp(SATURATING_OP, async () => {
        markAdmitted();
        await parked;
      })
    );
  }
  // Every permit is genuinely held before the test issues its own read.
  await Promise.all(admitted);
  return {
    lanes,
    release: async () => {
      unpark();
      await Promise.all(held);
    },
  };
}

/** `PENDING` when `promise` has not settled by the time the microtask queue drains. */
function settledOrPending<T>(promise: Promise<T>): Promise<T | typeof PENDING> {
  return Promise.race([promise, Promise.resolve(PENDING)]);
}

describe("Branch empty-scope reads", () => {
  it("returns an empty activity read WITHOUT taking a permit on a saturated lane", async () => {
    const { lanes, release } = await saturateBoundedLane();
    const requests: BranchCanonicalActivityReadRequest[] = [];
    const source = {
      readBranchCanonicalActivityRows: (
        request: BranchCanonicalActivityReadRequest
      ) =>
        lanes.runInvokeOp("readBranchCanonicalActivityRows", () => {
          requests.push(request);
          return Promise.resolve([]);
        }),
    };

    const rows = await settledOrPending(
      readBranchCanonicalActivityRowsForScope(source, { branchKeys: [] })
    );

    // Asserted through `settledOrPending` rather than a bare `await` so the
    // regression FAILS instead of HANGING: without the bypass this read queues
    // behind two permits that never free, and a plain await would sit there
    // until the runner's timeout killed the file.
    assert.notEqual(
      rows,
      PENDING,
      "an empty cohort must not wait for a permit"
    );
    assert.deepEqual(rows, []);
    // The load-bearing half: no proxy call means no permit, which is why it
    // could resolve while both permits are still held.
    assert.deepEqual(requests, []);
    await release();
  });

  it("returns empty evidence WITHOUT taking a permit on a saturated lane", async () => {
    const { lanes, release } = await saturateBoundedLane();
    const requests: BranchMetricEventEvidenceRequest[] = [];
    const source = {
      readBranchMetricEventEvidence: (
        request: BranchMetricEventEvidenceRequest
      ) =>
        lanes.runInvokeOp("readBranchMetricEventEvidence", () => {
          requests.push(request);
          return Promise.resolve({
            activitySegments: { rows: [], capped: false },
            outsideProvenance: [],
          });
        }),
    };

    const read = await settledOrPending(
      readBranchMetricEventEvidenceForScope(source, {
        bounds: { endIso: "2026-01-01T00:00:00.000Z" },
        branchKeys: [],
      })
    );

    assert.notEqual(
      read,
      PENDING,
      "an empty cohort must not wait for a permit"
    );
    assert.deepEqual(read, {
      activitySegments: { rows: [], capped: false },
      outsideProvenance: [],
    });
    assert.deepEqual(requests, []);
    await release();
  });

  it("still admits a NON-empty cohort through the lane, so it waits when saturated", async () => {
    // The control. Without it the tests above would pass just as well against a
    // helper that skipped the proxy unconditionally — which would silently drop
    // every real Branch read.
    const { lanes, release } = await saturateBoundedLane();
    const requests: BranchCanonicalActivityReadRequest[] = [];
    const source = {
      readBranchCanonicalActivityRows: (
        request: BranchCanonicalActivityReadRequest
      ) =>
        lanes.runInvokeOp("readBranchCanonicalActivityRows", () => {
          requests.push(request);
          return Promise.resolve([]);
        }),
    };
    const branchKeys = [{ repoFullName: "acme/app", branchName: "main" }];

    const inFlight = readBranchCanonicalActivityRowsForScope(source, {
      branchKeys,
    });

    assert.equal(await settledOrPending(inFlight), PENDING);
    assert.deepEqual(requests, [], "it must not run before a permit frees up");
    await release();
    assert.deepEqual(await inFlight, []);
    assert.deepEqual(requests, [{ branchKeys }]);
  });

  it("treats an ABSENT branchKeys as the whole corpus, not as empty", async () => {
    // `undefined` means "no cohort scope" on the evidence read — the heaviest
    // shape the op has. Short-circuiting it would skip a real corpus read and
    // return an empty result the caller would render as real data.
    const requests: BranchMetricEventEvidenceRequest[] = [];
    const source = {
      readBranchMetricEventEvidence: (
        request: BranchMetricEventEvidenceRequest
      ) => {
        requests.push(request);
        return Promise.resolve({
          activitySegments: { rows: [], capped: false },
          outsideProvenance: [],
        });
      },
    };
    const bounds = { endIso: "2026-01-01T00:00:00.000Z" };

    await readBranchMetricEventEvidenceForScope(source, { bounds });

    assert.deepEqual(requests, [{ bounds }]);
  });
});
