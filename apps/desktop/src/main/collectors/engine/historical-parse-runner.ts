import type { Harness, NormalizedSession } from "../types.js";

/** Off-main-process parser used for automatic historical maintenance sweeps. */
export type HistoricalParseRunner = {
  parseSource(
    collectorKey: Harness,
    source: string
  ): Promise<NormalizedSession[]>;
  /**
   * Stop any active worker and reject in-flight parser jobs. The runner remains
   * reusable so collector restarts can spawn a fresh worker lazily.
   */
  stop(): void;
};
