/**
 * ISS-4773 — the parity comparison helper's own contract.
 *
 * The seeded-SQLite scenarios in
 * `shared-agent-sessions-usage-aggregation.test.ts` are only as strong as
 * `normalizeUsage`, and the ISS-4773 failure was IN the helper: two new cost
 * fields were published on the summary but never added to it, so the two fold
 * orders' ~1 ULP drift stopped being absorbed and parity failed on a difference
 * of 3.5e-18 — 3.5e-16 of a cent. These pin both halves of what the helper owes:
 * it must absorb fold-order noise on EVERY cost field, and it must still fail on
 * a difference a reader could actually see.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionCostSplitFields } from "@repo/api/src/types/agent-session-cost-split";
import { emptySharedAgentSessionsUsageSummary } from "../src/shared/shared-agent-sessions-contract.js";
import {
  COST_SPLIT_FIELDS,
  normalizeUsage,
} from "./shared-agent-sessions-usage-parity-normalize.js";

// ISS-4773: the parity helper must epsilon-normalize EVERY cost field on the
// contract, not just the ones that existed when it was written.
//
// This is the failure that actually shipped: `meteredEstimatedCost` and
// `unknownEstimatedCost` were added to the summary but not to `normalizeUsage`,
// so the two fold orders' ~1 ULP drift stopped being absorbed and the parity
// test failed on a difference of 3.5e-18 — 3.5e-16 of a cent. Driving the
// assertion off `COST_SPLIT_FIELDS` (typed against the contract) means a cost
// field added later fails `tsc` at that const, and this test proves the const is
// actually wired to the helper rather than sitting there decoratively.
test("every contract cost field is epsilon-normalized by the parity helper (ISS-4773)", () => {
  const base = emptySharedAgentSessionsUsageSummary();

  for (const field of Object.keys(
    COST_SPLIT_FIELDS
  ) as (keyof AgentSessionCostSplitFields)[]) {
    // One ULP below a representable figure — the exact shape the two fold orders
    // produce for the same corpus.
    const drifted = normalizeUsage({
      ...base,
      [field]: 0.027_442_499_999_999_998,
    });
    const clean = normalizeUsage({ ...base, [field]: 0.027_442_5 });

    assert.deepEqual(
      drifted,
      clean,
      `${field} must be epsilon-normalized, or 1-ULP fold-order drift fails parity`
    );
  }
});

// The other half of the contract: normalization must NOT flatten a difference a
// reader could see. A cent apart is a real divergence and must still fail.
test("the parity helper still fails on a difference of one cent (ISS-4773)", () => {
  const base = emptySharedAgentSessionsUsageSummary();

  assert.notDeepEqual(
    normalizeUsage({ ...base, apiEstimatedCost: 1.0 }),
    normalizeUsage({ ...base, apiEstimatedCost: 1.01 })
  );
});
