/**
 * ISS-12552 (PRD-800 "Rollout"): after a flip to on,
 * the sessions an off period stored still carry NULL token-event owners until
 * the flip's rebuild re-derives them, and syncing one with the owner
 * capability on would send the parent marker for every event. So the owner
 * capability stays off until a rebuild that began after the flip, under the
 * attribution policy, completes. Driven through the real controller and the
 * real post-boot maintenance chain over a store double.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { captureAgentSessionSyncCapabilities } from "../src/main/agent-sync/agent-session-sync-capabilities.js";
import type { AgentSessionSyncServiceOptions } from "../src/main/agent-sync/agent-session-sync-service-options.js";
import { createPostBootMaintenance } from "../src/main/dashboard/post-boot-maintenance.js";
import { setEffectiveParsePolicy } from "../src/main/parse-policy/effective-parse-policy.js";
import { PARSE_POLICY_BASE } from "../src/main/parse-policy/parse-policy.js";
import { createParsePolicyController } from "../src/main/parse-policy/parse-policy-resolver.js";

const SERVER_ACCEPTS_OWNERS: AgentSessionSyncServiceOptions = {
  isHttpReady: () => true,
  isSyncTokenEventOwnerSupported: () => true,
  sendBatch: () => Promise.resolve({ accepted: true }),
};

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  setEffectiveParsePolicy(PARSE_POLICY_BASE);
});

function ownersSent(): boolean {
  return captureAgentSessionSyncCapabilities(SERVER_ACCEPTS_OWNERS)
    .tokenEventOwner;
}

/** A controller whose verdict the test sets, flipping with no hold. */
function policyFlag(persisted: boolean) {
  let verdict: boolean | undefined;
  let notify: (() => void) | null = null;
  const controller = createParsePolicyController({
    readPersisted: () => (persisted ? "org-1" : null),
    persist: () => undefined,
    readOrganization: () => "org-1",
    readVerdict: () => verdict,
    subscribe: (listener) => {
      notify = listener;
      return () => {
        notify = null;
      };
    },
    onFlip: () => undefined,
    holdMs: 0,
  });
  controller.start();
  cleanups.push(() => controller.dispose());
  return (next: boolean) => {
    verdict = next;
    notify?.();
  };
}

/**
 * The real maintenance chain over a store whose stale-session read the test
 * releases, so a flip can land while the rebuild is running.
 */
function maintenance(options: { failRebuild?: boolean } = {}) {
  let release = (): void => undefined;
  const listed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = (): void => undefined;
  const listing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const agentDatabase = {
    listStaleRevisionSessions: async () => {
      started();
      await listed;
      if (options.failRebuild) {
        throw new Error("rebuild failed");
      }
      return [];
    },
    sessions: { invalidateHistoricalDetails: () => undefined },
  };
  const chain = createPostBootMaintenance({
    agentDatabase: agentDatabase as never,
    cooperativeDelay: () => Promise.resolve(),
    getCollectors: () => [],
    getHistoricalParseRunner: () => null,
    getWindow: () => null,
    invokeStoreOp: () => Promise.resolve(undefined),
    isDbHostUnderMemoryPressure: () => false,
    isMaintenanceActive: () => true,
    log: () => undefined,
    resolveComputeTargetId: () => null,
    setMaintenancePhase: () => undefined,
  });
  return {
    run: () => chain.runPostBootMaintenance(1),
    /** Resolves once the rebuild has begun. */
    listing,
    release,
  };
}

async function completedRebuild(): Promise<void> {
  const pass = maintenance();
  const done = pass.run();
  pass.release();
  await done;
}

describe("the owner capability after a flip to on", () => {
  // First in the file: nothing in this process has armed owners yet, as at a
  // real boot.
  test("a boot under a persisted on verdict waits for the boot's rebuild", async () => {
    policyFlag(true);
    assert.equal(ownersSent(), false);
    await completedRebuild();
    assert.equal(ownersSent(), true);
  });

  test("stays off from the flip until that flip's rebuild completes", async () => {
    const answer = policyFlag(false);
    answer(true);
    assert.equal(ownersSent(), false, "off-era NULL owners are not sent");

    await completedRebuild();
    assert.equal(ownersSent(), true);
  });

  test("a rebuild that began before the latest flip does not arm it", async () => {
    const answer = policyFlag(true);
    const pass = maintenance();
    const done = pass.run();
    await pass.listing;
    answer(false);
    answer(true);
    pass.release();
    await done;
    assert.equal(ownersSent(), false, "part of it may have run under off");

    await completedRebuild();
    assert.equal(ownersSent(), true);
  });

  test("a failed rebuild does not arm it", async () => {
    const answer = policyFlag(false);
    answer(true);
    const pass = maintenance({ failRebuild: true });
    const done = pass.run();
    pass.release();
    await done;
    assert.equal(ownersSent(), false);
  });

  test("a flip off and back on disarms it until the next rebuild", async () => {
    const answer = policyFlag(true);
    await completedRebuild();
    assert.equal(ownersSent(), true);

    answer(false);
    answer(true);
    assert.equal(ownersSent(), false);
    await completedRebuild();
    assert.equal(ownersSent(), true);
  });
});
