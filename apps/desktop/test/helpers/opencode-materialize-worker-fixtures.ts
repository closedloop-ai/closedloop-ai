/**
 * @file opencode-materialize-worker-fixtures.ts
 * @description The fake `utilityProcess` child that a real
 * `UtilityProcessOpencodeMaterializeRunner` forks, plus the `forkWorker` seam
 * that hands them out in fork order.
 *
 * Shared because two suites now drive the REAL runner rather than a stand-in
 * for it: its own boundary suite, and the discovery sweep's outcome-reporting
 * cases, whose whole subject is the runner's single-flight (one pass joined by
 * two sweeps owes exactly one import-health record), which a hand-rolled
 * `materialize` seam cannot reproduce.
 */
import { EventEmitter } from "node:events";
import type {
  OpencodeMaterializeWorkerFork,
  OpencodeMaterializeWorkerProcess,
} from "../../src/main/transcript-sync/utility-process-opencode-materialize-runner.js";

export class FakeOpencodeMaterializeWorker extends EventEmitter {
  readonly messages: Array<{ type: string; stateDir: string }> = [];
  killed = false;
  private readonly postMessageError: unknown;

  constructor(postMessageError?: unknown) {
    super();
    this.postMessageError = postMessageError;
  }

  postMessage(message: { type: string; stateDir: string }): void {
    if (this.postMessageError !== undefined) {
      throw this.postMessageError;
    }
    this.messages.push(message);
  }
  kill(): void {
    this.killed = true;
  }
}

/** A `forkWorker` seam plus the children it handed back, in fork order. */
export function fakeOpencodeMaterializeWorkerFork(postMessageError?: unknown): {
  forkWorker: OpencodeMaterializeWorkerFork;
  children: FakeOpencodeMaterializeWorker[];
} {
  const children: FakeOpencodeMaterializeWorker[] = [];
  return {
    children,
    forkWorker: (): OpencodeMaterializeWorkerProcess => {
      const child = new FakeOpencodeMaterializeWorker(postMessageError);
      children.push(child);
      return child;
    },
  };
}
