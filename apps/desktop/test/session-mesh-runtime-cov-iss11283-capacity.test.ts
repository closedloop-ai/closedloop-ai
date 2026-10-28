import { afterEach, describe, expect, it } from "vitest";
import type { SessionMeshRuntime } from "../src/main/session-mesh/session-mesh-runtime.js";
import {
  createMeshHarness,
  disposeMeshHarnesses,
  identityB,
  sessionEvent,
  valueAfterOneMacrotask,
} from "./session-mesh-runtime-cov-iss11283-harness.js";

afterEach(() => {
  disposeMeshHarnesses();
});

async function startSessions(
  runtime: SessionMeshRuntime,
  from: number,
  to: number
): Promise<void> {
  for (let batch = from; batch < to; batch += 100) {
    const queued: Promise<unknown>[] = [];
    for (let index = batch; index < Math.min(batch + 100, to); index += 1) {
      queued.push(
        runtime.handle(sessionEvent("SessionStart", `session-${index}`))
      );
    }
    await Promise.all(queued);
    await runtime.whenIdle();
  }
}

function awaitContextFor(runtime: SessionMeshRuntime, index: number) {
  return valueAfterOneMacrotask(
    runtime.handle(sessionEvent("AwaitContext", `session-${index}`))
  );
}

describe("Session Mesh runtime bounded queues", () => {
  it("refuses a new event once 500 are queued, still accepts a repeat of a queued one, and drops the queue on stop", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    const queued: Promise<unknown>[] = [];
    for (let index = 0; index < 500; index += 1) {
      queued.push(
        runtime.handle(
          sessionEvent("PreToolUse", "session-1", {
            tool_use_id: `tool-${index}`,
          })
        )
      );
    }
    // Nothing has been awaited yet, so all 500 are still queued.
    const refused = runtime.handle(
      sessionEvent("PreToolUse", "session-1", { tool_use_id: "tool-500" })
    );
    expect(h.logs).toEqual(["Session Mesh event queue capacity reached"]);
    const repeat = runtime.handle(
      sessionEvent("PreToolUse", "session-1", { tool_use_id: "tool-0" })
    );
    expect(h.logs).toHaveLength(1);
    runtime.stop();
    expect(await refused).toEqual({});
    expect(await repeat).toEqual({});
    expect(await Promise.all(queued)).toHaveLength(500);
    await runtime.whenIdle();
    expect(h.resolveWorkspace).not.toHaveBeenCalled();
    expect(h.requests).toEqual([]);
  });

  it("drops queued events whose account changed before they ran", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    const queued = [
      runtime.handle(sessionEvent("SessionStart", "session-1")),
      runtime.handle(sessionEvent("SessionStart", "session-2")),
    ];
    h.state.identity = identityB;
    expect(await Promise.all(queued)).toEqual([{}, {}]);
    await runtime.whenIdle();
    expect(h.resolveWorkspace).not.toHaveBeenCalled();
    expect(h.requests).toEqual([]);
  });

  it("bounds live sessions, ready context and roster dedupe at 500 agents, evicting the oldest", async () => {
    const h = createMeshHarness();
    h.state.roster = () => [];
    const runtime = h.runtime();
    await startSessions(runtime, 0, 500);
    expect(h.logs).toEqual([]);

    // Ending a session re-publishes its existing ready context: no eviction.
    await runtime.handle(sessionEvent("SessionEnd", "session-0"));
    await runtime.whenIdle();

    // A 501st agent fits the live roster again and evicts the oldest ready
    // context and the oldest remembered roster preview (both session-0).
    await runtime.handle(sessionEvent("SessionStart", "session-500"));
    await runtime.whenIdle();
    const kept = await awaitContextFor(runtime, 1);
    expect(kept).not.toBe("pending");
    expect(kept === "pending" ? "" : kept.additionalContext).toContain(
      "Your canonical Mesh ID: claude:session-1."
    );
    expect(await awaitContextFor(runtime, 500)).not.toBe("pending");
    // session-0's ready context was the one evicted, so its wait parks until
    // session-0 re-registers below. The evicted context and the re-published
    // one carry identical text, so the settle ORDER is what tells a parked
    // waiter from one served the stale context at once.
    const settleOrder: string[] = [];
    const zeroWaiter = runtime
      .handle(sessionEvent("AwaitContext", "session-0"))
      .then((result) => {
        settleOrder.push("zero-waiter");
        return result;
      });

    // The roster is full again, so one more new agent is refused and only
    // gets the empty-await fallback.
    await runtime.handle(sessionEvent("SessionStart", "session-501"));
    await runtime.whenIdle();
    expect(h.logs.filter((line) => line.startsWith("Error:"))).toEqual([
      "Error: Session Mesh live roster capacity reached",
    ]);
    expect(await awaitContextFor(runtime, 501)).toEqual({
      awaitContext: false,
    });

    // session-0's roster preview was forgotten, so re-registering it publishes
    // the identical preview again instead of suppressing it as unchanged.
    await runtime.handle(sessionEvent("SessionEnd", "session-2"));
    await runtime.whenIdle();
    settleOrder.push("session-0-restarted");
    await runtime.handle(sessionEvent("SessionStart", "session-0"));
    await runtime.whenIdle();
    expect((await zeroWaiter).additionalContext).toContain(
      "Your canonical Mesh ID: claude:session-0."
    );
    expect(settleOrder).toEqual(["session-0-restarted", "zero-waiter"]);
  }, 60_000);
});
