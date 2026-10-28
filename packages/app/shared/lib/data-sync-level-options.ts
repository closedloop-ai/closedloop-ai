import {
  DATA_SYNC_LEVELS,
  DataSyncLevel,
} from "@repo/api/src/types/data-sync-level";

/**
 * WHICH data-sync levels a surface offers — the subset rule, owned once
 * (PLN-1915 Step 4).
 *
 * `DataSyncLevelPicker` already owns the ORDER, the copy and the radio
 * semantics; this owns the only thing a surface was still deciding for itself,
 * and it was decided in exactly one place before this module existed: the
 * desktop Settings "Data & Sync" tab. Settings v2's Connected Devices panel
 * offers the same choice about the same machine, so a second spelling of the
 * rule would let the two show different options for one profile — with one of
 * them wrong about what a user may pick.
 *
 * TWO WHOLE SHAPES, not one function taking the flag. `showRedactedSyncLevel`
 * is read at each surface's own read site and picks between these two, which is
 * what `no-threaded-feature-flag` asks for: nothing here is handed a boolean to
 * re-derive, and neither module can end up with two answers to one question.
 *
 * Pure and hook-free, so both sets are reachable from a unit test.
 */

/**
 * The set offered when the redaction Labs flag is ON: every canonical level, in
 * canonical order.
 */
export function offeredDataSyncLevelsWithRedaction(): readonly DataSyncLevel[] {
  return DATA_SYNC_LEVELS;
}

/**
 * The set offered when it is OFF (ISS-4779 closed-by-default): `redacted` is
 * withheld, because its lane is not plumbed and offering a level that cannot do
 * what its name implies misstates what leaves the device.
 *
 * The one exception is a profile ALREADY on `redacted`, whose level stays
 * offered whatever the flag says — an option set that cannot express the
 * current selection would orphan it, and the picker would show nothing checked.
 */
export function offeredDataSyncLevelsWithoutRedaction(
  currentLevel: DataSyncLevel | null
): readonly DataSyncLevel[] {
  return DATA_SYNC_LEVELS.filter(
    (level) => level !== DataSyncLevel.Redacted || level === currentLevel
  );
}
