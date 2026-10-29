/**
 * @file collector-manager-pass-settle.ts
 * @description The PERSISTED-CACHE teardown of one `CollectorManager` import
 * pass, split out of `collector-manager.ts` (ISS-8346) so the engine file keeps
 * only the import loop.
 *
 * The mirror of `collector-manager-pass-scan.ts`: that module opens a pass, this
 * one closes the two on-disk stores it wrote through. Both prunes are gated on
 * the pass still being the live generation AND on it having enumerated the whole
 * source population — a partial enumeration would prune entries for sources it
 * simply did not look at, and the next launch would re-parse them. The FLUSHES
 * are ungated on purpose: a pass that ended early still wrote entries worth
 * keeping, and dropping them is what makes the next launch redo its work.
 */

import type { HarnessCollector } from "../types.js";
import type { CatchupCache } from "./catchup-cache.js";
import type { ParseQuarantine } from "./parse-quarantine.js";

export type ImportPassSettleDeps = {
  collector: HarnessCollector;
  cache: CatchupCache | undefined;
  quarantine: ParseQuarantine | undefined;
  /** Every source this pass enumerated; the population a prune is valid over. */
  sources: string[];
  /** Whether this pass enumerated the whole population (so a prune is sound). */
  pruneCache: boolean;
  /** Whether this generation is still the live one. */
  isActive: boolean;
};

export function settleImportPassStores(deps: ImportPassSettleDeps): void {
  const { collector, cache, quarantine, sources, pruneCache, isActive } = deps;
  if (cache && !collector.batch) {
    if (isActive && pruneCache) {
      cache.pruneTo(sources);
    }
    cache.flush();
  }
  if (!quarantine) {
    return;
  }
  // ISS-4444: prune quarantine entries for sources no longer present (a deleted
  // transcript never returns), then persist the pass's recorded failures /
  // quarantines so a poison transcript is not re-parsed from scratch next launch.
  if (isActive && pruneCache) {
    quarantine.pruneTo(sources);
  }
  quarantine.flush();
}
