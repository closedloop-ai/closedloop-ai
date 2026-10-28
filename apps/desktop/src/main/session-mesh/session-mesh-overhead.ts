import { randomUUID } from "node:crypto";
import { sessionMeshFeedbackValidator } from "@repo/api/src/types/session-mesh";

type Measurement = {
  sourceKey: string;
  agentId: string;
  elapsedMs: number;
  since: number;
  report?: { id: string; elapsedMs: number };
};

/** Observed background wall time, not CPU usage or model-turn latency. */
export class SessionMeshOverhead {
  private readonly pending = new Map<string, Measurement>();
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly log: (message: string) => void;

  constructor(options: {
    now: () => number;
    monotonicNow: () => number;
    log: (message: string) => void;
  }) {
    this.now = options.now;
    this.monotonicNow = options.monotonicNow;
    this.log = options.log;
  }

  async measure<T>(
    sourceKey: string,
    agentId: string,
    work: () => Promise<T>
  ): Promise<T> {
    const started = this.monotonicNow();
    try {
      return await work();
    } finally {
      const elapsedMs = this.monotonicNow() - started;
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
        this.log("Session Mesh invalid background wall-time measurement");
      } else {
        const key = JSON.stringify([sourceKey, agentId]);
        const prior = this.pending.get(key);
        if (!prior && this.pending.size >= 500) {
          this.log("Session Mesh overhead aggregation capacity reached");
        } else {
          this.pending.set(key, {
            sourceKey,
            agentId,
            elapsedMs: (prior?.elapsedMs ?? 0) + elapsedMs,
            since: prior?.since ?? this.now(),
            ...(prior?.report ? { report: prior.report } : {}),
          });
        }
      }
    }
  }

  /**
   * `flush`, with the guarantee its callers need: optional reporting must never
   * suppress delivery of ready peer context, so an enqueue failure is logged and
   * swallowed rather than propagated into the hook path.
   */
  flushSafely(
    sourceKey: string,
    enqueue: (
      body: ReturnType<typeof sessionMeshFeedbackValidator.parse>
    ) => void
  ): void {
    try {
      this.flush(sourceKey, enqueue);
    } catch (error) {
      this.log(`Session Mesh overhead enqueue failed: ${String(error)}`);
    }
  }

  flush(
    sourceKey: string,
    enqueue: (
      body: ReturnType<typeof sessionMeshFeedbackValidator.parse>
    ) => void
  ): void {
    for (const [key, item] of this.pending) {
      if (item.sourceKey !== sourceKey || this.now() - item.since < 60_000) {
        continue;
      }
      // One bounded report per agent/minute. Preserve any overflow for a later
      // window rather than clamp away measured work or exceed the API bound.
      const elapsedMs =
        item.report?.elapsedMs ?? Math.min(600_000, Math.floor(item.elapsedMs));
      if (elapsedMs > 0) {
        item.report ??= { id: randomUUID(), elapsedMs };
        enqueue(
          sessionMeshFeedbackValidator.parse({
            idempotencyKey: item.report.id,
            agentId: item.agentId,
            kind: "coordination_overhead",
            coordinationOverheadMs: elapsedMs,
            rationale:
              "Observed Electron background lifecycle/poll-task wall time, including workspace/git, authentication, network, outbox retries and processing waits within those tasks. Excludes queue wait, idle timer intervals, native hook subprocess startup and work outside the measured tasks. Not CPU time or model-turn awaited latency. In-memory samples are coalesced; an app exit before enqueue can lose the current window.",
          })
        );
      }
      item.elapsedMs -= elapsedMs;
      item.report = undefined;
      item.since = this.now();
      if (item.elapsedMs === 0) {
        this.pending.delete(key);
      }
    }
  }
}
