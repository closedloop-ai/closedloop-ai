import { defaultRangeExtractor, type Range } from "@tanstack/react-virtual";

/**
 * ISS-9594, measured 2026-10-19 with one warmup plus six server-render samples.
 * Static control stayed 0.34→0.33 ms. At the boundary, 16 lanes stayed within
 * noise (9.49→8.87 ms; 10.88 ms baseline spread) and 40 cards did too
 * (7.82→8.55 ms; 0.78 ms spread). Past it, 40 lanes fell 17.94→3.36 ms and
 * 160 cards 32.46→2.56 ms by painting only the virtual range. Re-check when
 * card geometry, the API page size, or the canonical status-lane set changes.
 */
export const ARTIFACT_BOARD_LANE_VIRTUALIZATION_THRESHOLD = 16;
export const ARTIFACT_BOARD_CARD_VIRTUALIZATION_THRESHOLD = 40;

export const ARTIFACT_BOARD_LANE_OVERSCAN = 2;
export const ARTIFACT_BOARD_CARD_OVERSCAN = 4;

/** Estimate from the shipped card minimum plus its before/after drop slots. */
export const ARTIFACT_BOARD_CARD_ESTIMATE_PX = 152;

/** Every interaction identity that must outlive its current viewport window. */
export function artifactBoardPinnedIds(input: {
  activeRootId: string | null;
  destinationRootId: string | undefined;
  focusedRootId: string | null;
  selectedIds: readonly string[];
}): ReadonlySet<string> {
  const pinned = new Set(input.selectedIds);
  if (input.activeRootId) {
    pinned.add(input.activeRootId);
  }
  if (input.focusedRootId) {
    pinned.add(input.focusedRootId);
  }
  if (input.destinationRootId) {
    pinned.add(input.destinationRootId);
  }
  return pinned;
}

export function shouldVirtualizeArtifactBoardLanes(count: number): boolean {
  return count > ARTIFACT_BOARD_LANE_VIRTUALIZATION_THRESHOLD;
}

export function shouldVirtualizeArtifactBoardCards(count: number): boolean {
  return count > ARTIFACT_BOARD_CARD_VIRTUALIZATION_THRESHOLD;
}

/** Resolve stable population indexes for focus, selection, drag, and destination pins. */
export function artifactBoardPinnedIndexes(
  ids: readonly string[],
  pinnedIds: ReadonlySet<string>
): number[] {
  const indexes: number[] = [];
  for (const [index, id] of ids.entries()) {
    if (pinnedIds.has(id)) {
      indexes.push(index);
    }
  }
  return indexes;
}

/** Merge interaction pins into TanStack's visible+overscan range. */
export function artifactBoardPinnedRange(
  range: Range,
  pinnedIndexes: readonly number[]
): number[] {
  const indexes = new Set(defaultRangeExtractor(range));
  for (const index of pinnedIndexes) {
    if (index >= 0 && index < range.count) {
      indexes.add(index);
    }
  }
  return [...indexes].sort((left, right) => left - right);
}
