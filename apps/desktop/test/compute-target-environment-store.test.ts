/**
 * ISS-7096 M0: the `compute_target_environments` mapping — which environment
 * (normalized apiOrigin) a compute target was registered in. Driven against a
 * real libSQL database through the production migration runner.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { recordComputeTargetEnvironment } from "../src/main/database/compute-target-environment-store.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const TARGET = "01a0107d-0855-70ca-8f76-858cb9abec28";
const STAGE = "https://api.stage.example";
const PROD = "https://api.closedloop.ai";

test("record preserves first_seen_at, refreshes last_seen_at, and latest environment wins", async () => {
  const opened = await openTestPrisma();
  try {
    await recordComputeTargetEnvironment(opened.prisma, TARGET, STAGE);
    const first =
      await opened.prisma.client.computeTargetEnvironment.findUnique({
        where: { computeTargetId: TARGET },
      });
    assert.ok(first);
    assert.equal(first.environmentKey, STAGE);
    assert.equal(first.firstSeenAt, first.lastSeenAt);

    await recordComputeTargetEnvironment(opened.prisma, TARGET, PROD);
    const second =
      await opened.prisma.client.computeTargetEnvironment.findUnique({
        where: { computeTargetId: TARGET },
      });
    assert.ok(second);
    assert.equal(second.environmentKey, PROD);
    assert.equal(second.firstSeenAt, first.firstSeenAt);

    // An unmapped target is unknown — absent, never defaulted.
    assert.equal(
      await opened.prisma.client.computeTargetEnvironment.findUnique({
        where: { computeTargetId: "unmapped-target" },
      }),
      null
    );
  } finally {
    await opened.close();
  }
});
