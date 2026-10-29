/**
 * electron-builder's `beforePack` hook (wired at `electron-builder.yml`).
 *
 * Appends dmgbuild `position` entries to `dmg.contents` that park the DMG's
 * hidden support files below the installer window. Throws when
 * `dmg.contents` is not declared.
 */
export type DmgContentEntry = {
  x: number;
  y: number;
  type?: string;
  path?: string;
};

export default function parkDmgHiddenFiles(context: {
  packager: {
    config: { dmg?: { contents?: DmgContentEntry[] | null } | null };
  };
}): void;
