/**
 * Per-component desktop install-state derivation (FEA-4071).
 *
 * The pack-level install signal (`installedByMe` / `installedHarnesses`) answers
 * "is this pack on the machine?"; it can't answer the finer question the Contents
 * tab asks — "which of the pack's bundled components are actually installed on
 * THIS machine?". A pack a member installs on one harness may only pull a subset
 * of its components into place (a harness that supports skills but not hooks, a
 * partial convert-install, an interrupted run), so a component-agnostic "the pack
 * is installed" reading would LIE about a component that never landed.
 *
 * This module derives one honest `PackInstallState` per `PackContentEntry` from
 * the machine's real installed-component set. That set is the DESKTOP truth: the
 * `getPackDetail(packId)` read (`InstalledPackDetail.skills[]`) lists the
 * components actually detected on disk for the pack, by name. The desktop adapter
 * feeds those names in; this module matches each content entry against them.
 *
 * Honesty over optimism (the FEA-4088 / FEA-4083 Parker principle):
 *  - A component the machine reports installed → `Installed`.
 *  - A component NOT in the installed set, on a pack that IS installed → an
 *    explicit `NotInstalled` (the pack is here but this piece isn't — the member
 *    sees the gap, not a silent success).
 *  - Every component on a pack that is NOT installed at all → `NotInstalled`.
 *  - When the machine's installed-component set is UNKNOWN (the web catalog read
 *    with no local filesystem, or an older desktop that can't report it) the
 *    derivation is SKIPPED entirely — `deriveContentInstallStates` returns the
 *    contents untouched (no `installState`), so the Contents tab shows no
 *    per-component indicator rather than fabricating "not installed" for a
 *    machine it can't see.
 *
 * The result reuses the canonical FEA-4083 vocabulary, so the Contents tab draws
 * each component through the same `InstallStateStatus` treatment (icon SHAPE +
 * label, never color alone) every other packs surface uses.
 */

import { PackInstallState } from "./install-state";
import type { PackContentEntry, PackContentKind } from "./pack-view";

/**
 * Normalize a component name for install-set matching. The installed-set names
 * (`InstalledPackDetail.skills[].name`) and the catalog contents names
 * (`PackContentEntry.name`) come from different reads of the same authored files,
 * so trivial casing / surrounding-whitespace differences must not read as "not
 * installed". Internal spacing is preserved (component names are not slugs here).
 */
function normalizeComponentName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The machine's per-component install truth for one pack, as the desktop detail
 * read supplies it. `installedComponentNames` is the set of component names the
 * machine reports installed on disk (from `InstalledPackDetail.skills[].name`);
 * `packInstalled` is whether the pack itself is installed at all (so a component
 * absent from the set on a not-installed pack reads `NotInstalled`, same as on an
 * installed pack — both are honestly "not on this machine").
 *
 * `resolvableKinds` names the content KINDS the installed set actually covers.
 * The desktop detail read only enumerates one kind of installed component
 * (`InstalledPackDetail.skills[]` — skills), so it can only speak to skill-kind
 * entries; it has no installed inventory for a pack's `command`/`agent`/`hook`
 * entries. Deriving those kinds' state from the skill set would LIE twice: an
 * installed command/agent would read "not installed" (it's simply not in the
 * skill set), and a command whose name collides with a skill would read a false
 * "installed". So the derivation only assigns a state to entries whose kind is in
 * this set; every other kind is left UNKNOWN (no per-component indicator), the
 * same honest-absence the `known: false` surface gets.
 *
 * `known: false` is the escape hatch for a surface that CANNOT see the machine
 * (web, or a version-skewed desktop): the derivation is skipped and contents are
 * returned untouched, so no component is mislabelled "not installed".
 */
export type MachineComponentInstallState =
  | {
      readonly known: true;
      /** Component names the machine reports installed (case/space-insensitive match). */
      readonly installedComponentNames: readonly string[];
      /** Whether the pack itself is installed on this machine. */
      readonly packInstalled: boolean;
      /**
       * Content kinds the installed set covers. Only entries of these kinds get a
       * resolved install state; entries of any other kind stay UNKNOWN so a
       * kind the desktop read can't enumerate is never mislabelled.
       */
      readonly resolvableKinds: readonly PackContentKind[];
    }
  | { readonly known: false };

/**
 * Resolve one content entry's install state against the machine's installed
 * set. Only ever returns `Installed` or `NotInstalled` — the Contents tab's
 * per-component question is binary ("is this piece on the machine?"); the richer
 * states (updatable / converting / offline / failed) are per-(machine × harness)
 * facts the pack-level `MemberTargetsBlock` and admin install matrix already own,
 * not per-component-on-this-machine facts.
 *
 * `packInstalled` is the honesty backstop: when the pack itself is NOT installed
 * on the machine, no component can be — every entry is `NotInstalled` regardless
 * of what the installed-name set says, so a stale or cross-pack name match can
 * never paint a component `Installed` under a pack that isn't there.
 */
function resolveContentInstallState(
  entry: PackContentEntry,
  installedNameSet: ReadonlySet<string>,
  packInstalled: boolean
): PackInstallState {
  if (
    packInstalled &&
    installedNameSet.has(normalizeComponentName(entry.name))
  ) {
    return PackInstallState.Installed;
  }
  return PackInstallState.NotInstalled;
}

/**
 * Derive a per-component `installState` for every content entry from the
 * machine's installed-component truth. Returns a NEW array (never mutates the
 * input); each entry is `{ ...entry, installState }`.
 *
 * When `machine.known` is `false` the contents are returned UNTOUCHED (no
 * `installState` set) — the surface can't see the machine, so it must not assert
 * a per-component fact it doesn't have. This is what keeps the web surface honest:
 * it passes `{ known: false }` and the Contents tab simply renders no indicator.
 *
 * An entry whose kind is NOT in `machine.resolvableKinds` is likewise left
 * untouched: the installed set only enumerates certain kinds, so a kind it can't
 * speak to stays UNKNOWN rather than being derived (and mislabelled) from an
 * inventory that never contained it.
 */
export function deriveContentInstallStates(
  contents: readonly PackContentEntry[],
  machine: MachineComponentInstallState
): PackContentEntry[] {
  if (!machine.known) {
    return [...contents];
  }
  const resolvableKinds = new Set(machine.resolvableKinds);
  const installedNameSet = new Set(
    machine.installedComponentNames.map(normalizeComponentName)
  );
  return contents.map((entry) => {
    if (!resolvableKinds.has(entry.kind)) {
      return { ...entry };
    }
    return {
      ...entry,
      installState: resolveContentInstallState(
        entry,
        installedNameSet,
        machine.packInstalled
      ),
    };
  });
}
