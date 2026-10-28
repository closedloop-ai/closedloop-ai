// ISS-12185: parks the DMG's hidden support files below the installer window, so a user
// whose Finder shows hidden files does not see them beside the app and the
// Applications link. Same fix as jgraph/drawio-desktop@06152ce.
//
// electron-builder's schema only accepts file/link/dir in `dmg.contents`, but
// the dmgbuild it hands the list to also accepts "position", which records an
// icon location in .DS_Store without copying anything. Schema validation runs
// before hooks, so appending the entries from `beforePack` gets them through.
//
// The window is 540x380 (the size of build/background.png), so y=500 is below
// it. Positions are icon centers: .fseventsd wraps to a second row because a
// fifth icon in the first would cross the 540 width and add a horizontal
// scrollbar. dmgbuild deletes .Trashes and Finder never lists .DS_Store; both
// are covered anyway, as in the upstream fix.
const HIDDEN_FILE_POSITIONS = [
  { x: 130, y: 500, type: "position", path: ".background.tiff" },
  { x: 240, y: 500, type: "position", path: ".VolumeIcon.icns" },
  { x: 350, y: 500, type: "position", path: ".DS_Store" },
  { x: 460, y: 500, type: "position", path: ".Trashes" },
  { x: 130, y: 620, type: "position", path: ".fseventsd" },
];

export default function parkDmgHiddenFiles(context) {
  const contents = context.packager.config.dmg?.contents;
  if (contents == null) {
    throw new Error(
      "dmg-hidden-files.mjs appends to dmg.contents, which electron-builder.yml must declare"
    );
  }
  // A universal build runs beforePack once per architecture.
  for (const entry of HIDDEN_FILE_POSITIONS) {
    if (!contents.some((existing) => existing.path === entry.path)) {
      contents.push(entry);
    }
  }
}
