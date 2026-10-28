import { describe, expect, it, vi } from "vitest";
import { SessionMeshOverhead } from "../src/main/session-mesh/session-mesh-overhead.js";

function fixture() {
  let now = 0;
  let monotonic = 0;
  const log = vi.fn();
  const enqueue = vi.fn();
  const overhead = new SessionMeshOverhead({
    now: () => now,
    monotonicNow: () => monotonic,
    log,
  });
  return {
    overhead,
    log,
    enqueue,
    advanceWindow: () => {
      now += 60_000;
    },
    work: (duration: number) => () => {
      monotonic += duration;
      return Promise.resolve("result");
    },
  };
}

describe("Session Mesh measured background overhead", () => {
  it("coalesces actual work, excluding idle window time, by source and agent", async () => {
    const f = fixture();
    await f.overhead.measure("account-a", "claude:a", f.work(12.5));
    await f.overhead.measure("account-a", "claude:a", f.work(7.5));
    await f.overhead.measure("account-b", "claude:a", f.work(40));
    f.overhead.flush("account-a", f.enqueue);
    expect(f.enqueue).not.toHaveBeenCalled();
    f.advanceWindow();
    f.overhead.flush("account-a", f.enqueue);
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agentId: "claude:a",
        kind: "coordination_overhead",
        coordinationOverheadMs: 20,
        idempotencyKey: expect.any(String),
        rationale: expect.stringContaining("Not CPU time or model-turn"),
      })
    );
    f.overhead.flush("account-a", f.enqueue);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    f.overhead.flush("account-b", f.enqueue);
    expect(f.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ coordinationOverheadMs: 40 })
    );
  });

  it("measures failed work without swallowing its failure", async () => {
    const f = fixture();
    await expect(
      f.overhead.measure("account-a", "codex:a", async () => {
        await f.work(91)();
        throw new Error("cloud offline");
      })
    ).rejects.toThrow("cloud offline");
    f.advanceWindow();
    f.overhead.flush("account-a", f.enqueue);
    expect(f.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ coordinationOverheadMs: 91 })
    );
  });

  it("retains samples when durable enqueue fails", async () => {
    const f = fixture();
    await f.overhead.measure("account-a", "codex:a", f.work(45));
    f.advanceWindow();
    let failedId: string | undefined;
    expect(() =>
      f.overhead.flush("account-a", (body) => {
        failedId = body.idempotencyKey;
        throw new Error("disk unavailable");
      })
    ).toThrow("disk unavailable");
    await f.overhead.measure("account-a", "codex:a", f.work(5));
    f.overhead.flush("account-a", f.enqueue);
    expect(f.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        coordinationOverheadMs: 45,
        idempotencyKey: failedId,
      })
    );
    f.advanceWindow();
    f.overhead.flush("account-a", f.enqueue);
    expect(f.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ coordinationOverheadMs: 5 })
    );
  });

  it("splits oversized measurements across bounded windows without discarding work", async () => {
    const f = fixture();
    await f.overhead.measure("account-a", "codex:a", f.work(700_001));
    f.advanceWindow();
    f.overhead.flush("account-a", f.enqueue);
    expect(f.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ coordinationOverheadMs: 600_000 })
    );
    f.overhead.flush("account-a", f.enqueue);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    f.advanceWindow();
    f.overhead.flush("account-a", f.enqueue);
    expect(f.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ coordinationOverheadMs: 100_001 })
    );
  });

  it("reports invalid clock measurements instead of recording plausible zero", async () => {
    const f = fixture();
    await f.overhead.measure("account-a", "codex:a", f.work(Number.NaN));
    f.advanceWindow();
    f.overhead.flush("account-a", f.enqueue);
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining("invalid"));
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it("bounds aggregation cardinality and reports overflow without evicting measurements", async () => {
    const f = fixture();
    for (let index = 0; index < 501; index += 1) {
      await f.overhead.measure("account-a", `codex:${index}`, f.work(1));
    }
    expect(f.log).toHaveBeenCalledExactlyOnceWith(
      "Session Mesh overhead aggregation capacity reached"
    );
    f.advanceWindow();
    f.overhead.flush("account-a", f.enqueue);
    expect(f.enqueue).toHaveBeenCalledTimes(500);
  });
});
