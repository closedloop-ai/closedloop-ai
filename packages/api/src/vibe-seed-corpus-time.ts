import { z } from "zod";

/**
 * ISS-12135: how far each instant of the golden corpus moves in a vibe
 * environment, shared by the vibe store build (which shifts the store's
 * columns and session JSON) and the web seed (which shifts the transcripts it
 * uploads), so a session's transcript reads on the same clock as its row.
 *
 * Every instant moves by `shiftMs`, and further forward by the `closeMs` of
 * each idle gap after it, so each gap closes and the newest session lands on
 * the run's `now`. Instants at or after `importStartedAt` were stamped by the
 * store's import, not recorded in the corpus, and do not move.
 */

export const vibeCorpusIdleGapSchema = z.object({
  /** The start of the session that ends the gap; every earlier instant moves `closeMs` further. */
  beforeIso: z.iso.datetime(),
  closeMs: z.number().int().nonnegative(),
});
export type VibeCorpusIdleGap = z.infer<typeof vibeCorpusIdleGapSchema>;

export const vibeCorpusTimeMapSchema = z.object({
  shiftMs: z.number().int(),
  importStartedAt: z.iso.datetime(),
  idleGaps: z.array(vibeCorpusIdleGapSchema),
});
export type VibeCorpusTimeMap = z.infer<typeof vibeCorpusTimeMapSchema>;

/** The file beside a vibe store that records the time map its build applied. */
export function vibeCorpusTimeMapPath(storePath: string): string {
  return `${storePath}.time-map.json`;
}

export type VibeCorpusOffsets = {
  /** The offset of every instant before `beforeIso`, oldest boundary first. */
  readonly boundaries: readonly {
    readonly beforeIso: string;
    readonly offsetMs: number;
  }[];
  /** The offset of every instant after the last boundary. */
  readonly lastMs: number;
};

export function vibeCorpusOffsets(
  shiftMs: number,
  idleGaps: readonly VibeCorpusIdleGap[]
): VibeCorpusOffsets {
  const ordered = [...idleGaps].sort(
    (a, b) => Date.parse(a.beforeIso) - Date.parse(b.beforeIso)
  );
  let remaining = ordered.reduce((sum, gap) => sum + gap.closeMs, 0);
  const boundaries = ordered.map((gap) => {
    const boundary = {
      beforeIso: gap.beforeIso,
      offsetMs: shiftMs + remaining,
    };
    remaining -= gap.closeMs;
    return boundary;
  });
  return { boundaries, lastMs: shiftMs };
}

export function vibeCorpusOffsetAt(
  offsets: VibeCorpusOffsets,
  ms: number
): number {
  const boundary = offsets.boundaries.find(
    (candidate) => ms < Date.parse(candidate.beforeIso)
  );
  return boundary === undefined ? offsets.lastMs : boundary.offsetMs;
}

/** Every ISO-8601 instant written into `text` (a JSON value, a JSONL transcript), shifted by the map. */
export function shiftVibeCorpusInstants(
  text: string,
  map: VibeCorpusTimeMap
): string {
  const importStartedMs = Date.parse(map.importStartedAt);
  const offsets = vibeCorpusOffsets(map.shiftMs, map.idleGaps);
  return text.replace(EMBEDDED_INSTANT, (instant) => {
    const ms = Date.parse(instant);
    return Number.isFinite(ms) && ms < importStartedMs
      ? new Date(ms + vibeCorpusOffsetAt(offsets, ms)).toISOString()
      : instant;
  });
}

const EMBEDDED_INSTANT =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})/g;
