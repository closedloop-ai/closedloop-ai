/**
 * @file soak-support.ts
 * @description Process-level utilities shared by every soak-harness module:
 * timestamped logging, sleeping, and the cycle-start load gate.
 */

import os from "node:os";

const LOAD_GATE_WAIT_MS = 30_000;

export function log(message: string): void {
  process.stdout.write(`[soak ${new Date().toISOString()}] ${message}\n`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function loadAvg1(): number {
  return os.loadavg()[0];
}

/**
 * Block until the box's 1-minute load average is at or below `maxLoad`, then
 * return the load the cycle actually started at (recorded in the cycle's row).
 */
export async function loadGate(maxLoad: number): Promise<number> {
  for (;;) {
    const load = loadAvg1();
    if (load <= maxLoad) {
      return load;
    }
    log(`load-gate: 1-min load ${load.toFixed(1)} > ${maxLoad}, waiting 30s`);
    await sleep(LOAD_GATE_WAIT_MS);
  }
}
