import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { SESSION_MESH_V1_FEATURE_FLAG_KEY } from "@repo/api/src/types/session-mesh-flag";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createDesktopMainFeatureFlagAssignmentStore,
  publishDesktopMainFeatureFlagAssignmentStore,
} from "../src/main/auth/desktop-feature-flag-assignment.js";
import { sessionMeshDenialValidator } from "../src/main/session-mesh/session-mesh-delivery-ledger.js";
import {
  escalateSessionMeshDenial,
  isSessionMeshProbeDue,
  rearmSessionMeshDenial,
  restoreSessionMeshDenial,
  SESSION_MESH_DENIAL_BACKOFF_STEPS_MS,
  SESSION_MESH_DENIAL_JITTER_RATIO,
  SESSION_MESH_DENIAL_MAX_WAIT_MS,
  SESSION_MESH_DENIAL_UNCONFIRMED_LAST_STEP,
  sessionMeshDenialMaxWaitMs,
} from "../src/main/session-mesh/session-mesh-denial-policy.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import {
  createMeshHarness,
  disposeMeshHarnesses,
  identityA,
  isPresencePost,
  sessionEvent,
  sourceKeyOf,
} from "./session-mesh-runtime-cov-iss11283-harness.js";

const DISABLED_BODY = JSON.stringify({
  success: false,
  code: "session_mesh_disabled",
});
const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const SOURCE_A = sourceKeyOf(identityA);

// Unconditional: a case that throws between an enable and a restore would
// otherwise leave a frozen clock — and a published assignment — to every later
// case in this worker.
afterEach(() => {
  vi.useRealTimers();
  publishDesktopMainFeatureFlagAssignmentStore(null);
  disposeMeshHarnesses();
});

function denied(): Response {
  return new Response(DISABLED_BODY, { status: 403 });
}

/** A runtime on the fake clock: `now` follows `vi.setSystemTime`, as production's does. */
function deniedRuntime(harness: ReturnType<typeof createMeshHarness>) {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  harness.state.respond = () => denied();
  return harness.runtime({ now: () => Date.now() });
}

async function advance(
  ms: number,
  runtime: { whenIdle: () => Promise<unknown> }
) {
  await vi.advanceTimersByTimeAsync(ms);
  await runtime.whenIdle();
}

/** The denial this runtime persisted, which the harness ledger view does not type. */
function persistedDenial(
  harness: ReturnType<typeof createMeshHarness>
): unknown {
  return z
    .object({ denial: sessionMeshDenialValidator.optional() })
    .parse(JSON.parse(readFileSync(harness.ledgerFile, "utf8"))).denial;
}

/** Resolve a main-process assignment for `user-a`, the account identityA names. */
async function publishAssignment(payload: unknown): Promise<void> {
  const store = createDesktopMainFeatureFlagAssignmentStore({
    fetchAssignment: () => Promise.resolve(payload),
    retryDelaysMs: [],
  });
  publishDesktopMainFeatureFlagAssignmentStore(store);
  await store.resolveFor(identityA.userId);
}

describe("Session Mesh denial backoff policy", () => {
  function escalateRepeatedly(times: number): number[] {
    const steps: number[] = [];
    let denial = null as ReturnType<typeof escalateSessionMeshDenial> | null;
    for (let index = 0; index < times; index += 1) {
      denial = escalateSessionMeshDenial(denial, SOURCE_A, {
        now: T0,
        random: () => 0.5,
      });
      steps.push(denial.retryAt - T0);
    }
    return steps;
  }

  it("escalates minutes to hours and caps at the last step for a verdict the account answered", async () => {
    await publishAssignment({
      userId: identityA.userId,
      resolved: true,
      flags: { [SESSION_MESH_V1_FEATURE_FLAG_KEY]: false },
    });
    expect(
      escalateRepeatedly(SESSION_MESH_DENIAL_BACKOFF_STEPS_MS.length + 2)
    ).toEqual([
      ...SESSION_MESH_DENIAL_BACKOFF_STEPS_MS,
      12 * HOUR_MS,
      12 * HOUR_MS,
    ]);
  });

  it("caps an unconfirmed denial at an hour, so a cloud that cannot evaluate cannot black out for twelve", () => {
    // No assignment published: a bare 403 cannot tell "not in the rollout" from
    // "the gate could not read the flag", so it does not earn the long tail.
    const ceiling =
      SESSION_MESH_DENIAL_BACKOFF_STEPS_MS[
        SESSION_MESH_DENIAL_UNCONFIRMED_LAST_STEP
      ];
    expect(
      escalateRepeatedly(SESSION_MESH_DENIAL_BACKOFF_STEPS_MS.length + 2)
    ).toEqual([
      ...SESSION_MESH_DENIAL_BACKOFF_STEPS_MS.slice(
        0,
        SESSION_MESH_DENIAL_UNCONFIRMED_LAST_STEP + 1
      ),
      ceiling,
      ceiling,
      ceiling,
      ceiling,
    ]);
  });

  it("restarts the escalation for a different source rather than inheriting a wait", () => {
    const first = escalateSessionMeshDenial(
      { sourceKey: SOURCE_A, step: 4, retryAt: T0 },
      "other-source",
      { now: T0, random: () => 0.5 }
    );
    expect(first).toEqual({
      sourceKey: "other-source",
      step: 0,
      retryAt: T0 + MINUTE_MS,
    });
  });

  it("spreads every step past the first, and leaves the first deterministic", () => {
    const low = escalateSessionMeshDenial(
      { sourceKey: SOURCE_A, step: 0, retryAt: T0 },
      SOURCE_A,
      { now: T0, random: () => 0 }
    );
    const high = escalateSessionMeshDenial(
      { sourceKey: SOURCE_A, step: 0, retryAt: T0 },
      SOURCE_A,
      { now: T0, random: () => 1 }
    );
    const nominal = 5 * MINUTE_MS;
    expect(low.retryAt - T0).toBe(
      nominal * (1 - SESSION_MESH_DENIAL_JITTER_RATIO)
    );
    expect(high.retryAt - T0).toBe(
      nominal * (1 + SESSION_MESH_DENIAL_JITTER_RATIO)
    );
    for (const random of [() => 0, () => 1]) {
      expect(
        escalateSessionMeshDenial(null, SOURCE_A, { now: T0, random }).retryAt -
          T0
      ).toBe(MINUTE_MS);
    }
  });

  it("re-arms the same step without escalating it, so a failed probe cannot spin", () => {
    const rearmed = rearmSessionMeshDenial(
      { sourceKey: SOURCE_A, step: 3, retryAt: T0 - 1 },
      { now: T0, random: () => 0.5 }
    );
    expect(rearmed.step).toBe(3);
    expect(rearmed.retryAt).toBe(T0 + HOUR_MS);
    expect(isSessionMeshProbeDue(rearmed, SOURCE_A, T0)).toBe(false);
    expect(isSessionMeshProbeDue(rearmed, SOURCE_A, T0 + HOUR_MS)).toBe(true);
    expect(isSessionMeshProbeDue(rearmed, "other-source", T0)).toBe(true);
    expect(isSessionMeshProbeDue(null, SOURCE_A, T0)).toBe(true);
  });

  it("treats a wait no clock could have produced as due, so a backward clock jump cannot park it", () => {
    expect(
      isSessionMeshProbeDue(
        {
          sourceKey: SOURCE_A,
          step: 5,
          retryAt: T0 + SESSION_MESH_DENIAL_MAX_WAIT_MS + MINUTE_MS,
        },
        SOURCE_A,
        T0
      )
    ).toBe(true);
    // A legitimately jittered last step sits above the bare step and must NOT
    // read as impossible — treating it that way re-probed every 5s tick.
    expect(
      isSessionMeshProbeDue(
        { sourceKey: SOURCE_A, step: 5, retryAt: T0 + 13 * HOUR_MS },
        SOURCE_A,
        T0
      )
    ).toBe(false);
  });

  it("clamps a persisted wait against the denial's OWN step, not the deepest one", () => {
    // A step-0 denial can only ever have been 60 s out. Restoring it to the
    // global ceiling turned a minute into fourteen hours and broke the header's
    // promise that a transient outage costs at most an hour.
    expect(
      restoreSessionMeshDenial(
        { sourceKey: SOURCE_A, step: 0, retryAt: T0 + 10 * 24 * HOUR_MS },
        T0
      )
    ).toEqual({ sourceKey: SOURCE_A, step: 0, retryAt: T0 + MINUTE_MS });
    expect(
      restoreSessionMeshDenial(
        {
          sourceKey: SOURCE_A,
          step: SESSION_MESH_DENIAL_UNCONFIRMED_LAST_STEP,
          retryAt: T0 + 10 * 24 * HOUR_MS,
        },
        T0
      )?.retryAt
    ).toBe(T0 + HOUR_MS * (1 + SESSION_MESH_DENIAL_JITTER_RATIO));
    // The mid-session clock-jump check reads the same per-step bound.
    expect(
      isSessionMeshProbeDue(
        { sourceKey: SOURCE_A, step: 0, retryAt: T0 + 2 * MINUTE_MS },
        SOURCE_A,
        T0
      )
    ).toBe(true);
    expect(
      isSessionMeshProbeDue(
        { sourceKey: SOURCE_A, step: 0, retryAt: T0 + MINUTE_MS },
        SOURCE_A,
        T0
      )
    ).toBe(false);
    expect(sessionMeshDenialMaxWaitMs(0)).toBe(MINUTE_MS);
  });

  it("clamps a persisted wait that no clock could reach back to the last step", () => {
    expect(
      restoreSessionMeshDenial(
        { sourceKey: SOURCE_A, step: 5, retryAt: T0 + 10 * 24 * HOUR_MS },
        T0
      )
    ).toEqual({
      sourceKey: SOURCE_A,
      step: 5,
      retryAt: T0 + SESSION_MESH_DENIAL_MAX_WAIT_MS,
    });
    expect(restoreSessionMeshDenial(undefined, T0)).toBeNull();
  });
});

describe("Session Mesh runtime denial backoff", () => {
  it("stops probing once a minute forever: the second wait is minutes, not 60s", async () => {
    const h = createMeshHarness();
    const runtime = deniedRuntime(h);
    runtime.start();
    await runtime.whenIdle();
    expect(h.requests).toHaveLength(1);
    await advance(59 * 1000, runtime);
    expect(h.requests).toHaveLength(1);
    await advance(2000, runtime);
    // Second probe at ~60s, which is the wait this runtime always had.
    expect(h.requests).toHaveLength(2);
    // The escalated wait is 5 min ± 20%, so its floor is 4 min. The pre-change
    // runtime re-probed every 60s: it would stand at 5 requests here.
    await advance(3 * MINUTE_MS, runtime);
    expect(h.requests).toHaveLength(2);
    await advance(3 * MINUTE_MS + 5000, runtime);
    expect(h.requests).toHaveLength(3);
    runtime.stop();
  });

  it("does not re-attempt the outbox while denied, and keeps it through a denial no local verdict confirms", async () => {
    const h = createMeshHarness();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    let offline = true;
    h.state.respond = () =>
      offline ? new Response("offline", { status: 503 }) : denied();
    const runtime = h.runtime({ now: () => Date.now() });
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    const queued = h
      .ledger()
      .operations.filter((row) => row.sourceKey === SOURCE_A);
    expect(queued.length).toBeGreaterThan(0);
    offline = false;
    runtime.start();
    await runtime.whenIdle();
    const afterFirstDenial = h.requests.length;
    // First denial keeps the queue: one flag-service blip must not discard a
    // live announcement.
    expect(h.ledger().operations.map((row) => row.id)).toEqual(
      queued.map((row) => row.id)
    );
    // Every queued item's 30s retry window lapses inside this span; a drain
    // would both spend the attempt and churn `lastError`.
    await advance(45 * 1000, runtime);
    expect(h.requests).toHaveLength(afterFirstDenial);
    expect(h.ledger().operations).toEqual(
      queued.map((row) =>
        expect.objectContaining({
          id: row.id,
          attemptCount: row.attemptCount,
          lastError: row.lastError,
        })
      )
    );
    await advance(20 * 1000, runtime);
    // A SECOND 403 with no local verdict behind it still does not spend the
    // queue. The cloud answers this same body when its PostHog read fails, so
    // two of them are as consistent with a flag-service outage as with a
    // rollout verdict, and a claim's drop is permanent. The queue is spent only
    // where the account's own assignment agrees — pinned by "keeps the queue on
    // a local verdict alone and spends it once the cloud confirms".
    expect(h.requests.length).toBeGreaterThan(afterFirstDenial);
    expect(h.ledger().operations.map((row) => row.id)).toEqual(
      queued.map((row) => row.id)
    );
    expect(
      h.logs.some(
        (line) => line.includes("dropped") && line.includes("disabled")
      )
    ).toBe(false);
    runtime.stop();
  });

  // Pins behavior this change did not introduce: `drain` stops at the first
  // rejection rather than spending the whole queue on one denial. It is the
  // sibling of the escalation below — a drain that continued past a 403 would
  // re-open the storm from the outbox side — so it is guarded here.
  it("stops a denied drain at the first rejection instead of spending the queue", async () => {
    const h = createMeshHarness();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    writeFileSync(
      h.ledgerFile,
      JSON.stringify({
        version: 1,
        operations: ["one", "two", "three"].map((id) => ({
          id,
          sourceKey: SOURCE_A,
          path: "/session-mesh/messages",
          method: "POST",
          body: { summary: id },
          status: OutboxStatus.Pending,
          attemptCount: 0,
          nextAttemptAt: null,
          lastError: null,
          updatedAt: new Date(T0).toISOString(),
        })),
        receipts: {},
      })
    );
    // The production sequence this ticket measured: the probe is allowed (a GET),
    // and the queued messages behind it are each denied.
    h.state.respond = (request) =>
      request.method === "POST" && request.path === "/session-mesh/messages"
        ? denied()
        : undefined;
    const runtime = h.runtime({ now: () => Date.now() });
    runtime.start();
    await runtime.whenIdle();
    expect(
      h.requests.filter((request) => request.path === "/session-mesh/messages")
    ).toHaveLength(1);
    const untouched = h.ledger().operations.filter((row) => row.id !== "one");
    expect(untouched).toHaveLength(2);
    for (const row of untouched) {
      expect(row).toMatchObject({
        attemptCount: 0,
        lastError: null,
        nextAttemptAt: null,
      });
    }
    runtime.stop();
  });

  it("handles hooks for a denied install without queuing work or calling the cloud", async () => {
    const h = createMeshHarness();
    const runtime = deniedRuntime(h);
    runtime.start();
    await runtime.whenIdle();
    const afterDenial = h.requests.length;
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_name: "Edit",
        tool_input: { file_path: "src/a.ts" },
      })
    );
    await runtime.whenIdle();
    expect(h.ledger().operations).toEqual([]);
    expect(h.requests).toHaveLength(afterDenial);
    runtime.stop();
  });

  it("resumes a persisted escalation after a restart instead of probing again", async () => {
    const h = createMeshHarness();
    writeFileSync(
      h.ledgerFile,
      JSON.stringify({
        version: 1,
        operations: [],
        receipts: {},
        denial: {
          sourceKey: SOURCE_A,
          step: 5,
          retryAt: T0 + 10 * 24 * HOUR_MS,
        },
      })
    );
    const runtime = deniedRuntime(h);
    runtime.start();
    await runtime.whenIdle();
    expect(h.requests).toEqual([]);
    await advance(SESSION_MESH_DENIAL_MAX_WAIT_MS - MINUTE_MS, runtime);
    expect(h.requests).toEqual([]);
    // Clamped to the longest wait this policy can produce, so an unreachable
    // persisted wait can never disable Mesh for an account enrolled again.
    await advance(2 * MINUTE_MS, runtime);
    expect(h.requests).toHaveLength(1);
    runtime.stop();
  });

  it("reads a ledger written before the denial field as not denied", async () => {
    const h = createMeshHarness();
    writeFileSync(
      h.ledgerFile,
      JSON.stringify({ version: 1, operations: [], receipts: {} })
    );
    const runtime = deniedRuntime(h);
    runtime.start();
    await runtime.whenIdle();
    expect(h.requests).toHaveLength(1);
    runtime.stop();
  });

  it("latches a denial body that carries fields this build does not know", async () => {
    const h = createMeshHarness();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    h.state.respond = () =>
      new Response(
        JSON.stringify({
          success: false,
          code: "session_mesh_disabled",
          error: "Forbidden",
          retryAfterSeconds: 3600,
        }),
        { status: 403 }
      );
    const runtime = h.runtime({ now: () => Date.now() });
    runtime.start();
    await runtime.whenIdle();
    expect(h.requests).toHaveLength(1);
    // The latch itself, not a request count: `probedSource` is already set
    // before the probe is awaited, so a body this build failed to recognize
    // would also leave the count at 1 while leaving the client unlatched.
    expect(persistedDenial(h)).toEqual({
      sourceKey: SOURCE_A,
      step: 0,
      retryAt: T0 + MINUTE_MS,
    });
    expect(h.markerExists()).toBe(false);
    await advance(55 * 1000, runtime);
    expect(h.requests).toHaveLength(1);
    runtime.stop();
  });
});

describe("Session Mesh runtime feature-flag assignment", () => {
  it("asks the cloud nothing on a closed verdict, and does no local mesh work either", async () => {
    const h = createMeshHarness();
    await publishAssignment({
      userId: identityA.userId,
      resolved: true,
      flags: { [SESSION_MESH_V1_FEATURE_FLAG_KEY]: false, "other-flag": true },
    });
    const runtime = deniedRuntime(h);
    runtime.start();
    await runtime.whenIdle();
    // The verdict alone latches the wait: no 403 was needed to discover it.
    expect(h.requests).toEqual([]);
    expect(persistedDenial(h)).toMatchObject({ sourceKey: SOURCE_A, step: 0 });
    expect(h.markerExists()).toBe(false);
    expect(await runtime.handle(sessionEvent("SessionStart"))).toEqual({
      awaitContext: false,
    });
    await runtime.whenIdle();
    expect(h.ledger().operations).toEqual([]);
    await advance(55 * 1000, runtime);
    expect(h.requests).toEqual([]);
    runtime.stop();
  });

  it("keeps a keepalive probe on the schedule, so a closed verdict resolved at sign-in cannot mute it forever", async () => {
    const h = createMeshHarness();
    await publishAssignment({
      userId: identityA.userId,
      resolved: true,
      flags: { [SESSION_MESH_V1_FEATURE_FLAG_KEY]: false },
    });
    const runtime = deniedRuntime(h);
    runtime.start();
    await runtime.whenIdle();
    expect(h.requests).toEqual([]);
    // The assignment is resolved once per account and never refreshed, so an
    // enrollment landing mid-session is only ever found by asking the cloud.
    await advance(MINUTE_MS + 5000, runtime);
    expect(h.requests).toHaveLength(1);
    runtime.stop();
  });

  it("keeps the queue on a local verdict alone and spends it once the cloud confirms", async () => {
    const h = createMeshHarness();
    const queued = {
      id: "claim-1",
      sourceKey: SOURCE_A,
      path: "/session-mesh/messages",
      method: "POST",
      body: { summary: "claim-1" },
      status: OutboxStatus.Pending,
      attemptCount: 0,
      nextAttemptAt: null,
      lastError: null,
      updatedAt: new Date(T0).toISOString(),
    };
    writeFileSync(
      h.ledgerFile,
      JSON.stringify({ version: 1, operations: [queued], receipts: {} })
    );
    await publishAssignment({
      userId: identityA.userId,
      resolved: true,
      flags: { [SESSION_MESH_V1_FEATURE_FLAG_KEY]: false },
    });
    const runtime = deniedRuntime(h);
    runtime.start();
    await runtime.whenIdle();
    // A verdict resolved at sign-in can be stale against a flag that just
    // flipped, and a claim is a one-shot event, so the verdict alone — with no
    // request sent and nothing from the cloud — never spends it.
    expect(h.requests).toEqual([]);
    expect(h.ledger().operations.map((row) => row.id)).toEqual(["claim-1"]);
    await advance(MINUTE_MS + 5000, runtime);
    // Two independent authorities now agree, so the queue is spent.
    expect(h.requests).toHaveLength(1);
    expect(h.ledger().operations).toEqual([]);
    runtime.stop();
  });

  it("probes as before when the assignment carries the key", async () => {
    const h = createMeshHarness();
    await publishAssignment({
      userId: identityA.userId,
      resolved: true,
      flags: { [SESSION_MESH_V1_FEATURE_FLAG_KEY]: true },
    });
    const runtime = deniedRuntime(h);
    runtime.start();
    await runtime.whenIdle();
    expect(h.requests).toHaveLength(1);
    runtime.stop();
  });

  it("probes when the assignment could not be evaluated, leaving the server the authority", async () => {
    const h = createMeshHarness();
    await publishAssignment({
      userId: identityA.userId,
      resolved: false,
      flags: { [SESSION_MESH_V1_FEATURE_FLAG_KEY]: false },
    });
    const runtime = deniedRuntime(h);
    runtime.start();
    await runtime.whenIdle();
    expect(h.requests).toHaveLength(1);
    runtime.stop();
  });

  it("probes when the assignment answered for no keys at all, which a failed PostHog read looks like", async () => {
    const h = createMeshHarness();
    await publishAssignment({
      userId: identityA.userId,
      resolved: true,
      flags: {},
    });
    const runtime = deniedRuntime(h);
    runtime.start();
    await runtime.whenIdle();
    expect(h.requests).toHaveLength(1);
    runtime.stop();
  });

  it("reopens Mesh on a successful probe, so an enrollment landing mid-session recovers without a restart", async () => {
    const h = createMeshHarness();
    await publishAssignment({
      userId: identityA.userId,
      resolved: true,
      flags: { [SESSION_MESH_V1_FEATURE_FLAG_KEY]: false },
    });
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const runtime = h.runtime({ now: () => Date.now() });
    runtime.start();
    await runtime.whenIdle();
    // The sign-in snapshot latches the wait with no request sent.
    expect(h.requests).toEqual([]);
    expect(persistedDenial(h)).toMatchObject({ sourceKey: SOURCE_A, step: 0 });
    // The rollout opens. Nothing refreshes the snapshot mid-session, so the
    // keepalive probe is the only thing that can find it, and the 200 it gets
    // has to outrank the stale local `false` for every OTHER path too.
    await advance(MINUTE_MS + 5000, runtime);
    expect(h.requests).toHaveLength(1);
    expect(persistedDenial(h)).toBeUndefined();
    expect(h.markerExists()).toBe(true);
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    expect(h.requests.filter(isPresencePost).length).toBeGreaterThan(0);
    expect(h.ledger().operations).toEqual([]);
    // And the next tick does not re-latch the denial off the same snapshot.
    await advance(10 * 1000, runtime);
    expect(persistedDenial(h)).toBeUndefined();
    runtime.stop();
  });

  it("rejects a publish a mid-command denial refused, instead of reporting it accepted", async () => {
    const h = createMeshHarness();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const runtime = h.runtime({ now: () => Date.now() });
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    h.state.respond = () => denied();
    // `start()` queues the tick AHEAD of the publish's serialized callback:
    // `runCommand`'s gate passes, the tick records the denial, and the callback
    // then finds Mesh closed. Absence from the ledger must not read as sent.
    runtime.start();
    const publish = runtime.handle(
      sessionEvent("MeshCommand", "session-1", {
        operation: "publish",
        agentId: "claude:session-1",
        payload: {
          kind: "claim",
          summary: "Editing src/a.ts",
          idempotencyKey: randomUUID(),
        },
      })
    );
    await expect(publish).rejects.toThrow(
      "Session Mesh disabled by server assignment"
    );
    await runtime.whenIdle();
    expect(
      h.ledger().operations.some((row) => row.path === "/session-mesh/messages")
    ).toBe(false);
    runtime.stop();
  });

  it("probes when the assignment was evaluated for a different account", async () => {
    const h = createMeshHarness();
    await publishAssignment({
      userId: "someone-else",
      resolved: true,
      flags: { [SESSION_MESH_V1_FEATURE_FLAG_KEY]: false },
    });
    const runtime = deniedRuntime(h);
    runtime.start();
    await runtime.whenIdle();
    expect(h.requests).toHaveLength(1);
    runtime.stop();
  });
});
