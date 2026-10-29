/**
 * @file Fixtures for `DirectoryScopeListWithAdd`, read by its stories, its
 * tests and the `data-controls-add-directory` prototype. No shipped render path
 * imports this module.
 *
 * Every directory is fictional. `DirectoryScopeListCopy` (ISS-12520) still has
 * no approved wording and is outside the ISS-12520 placeholder ruling (Nerys,
 * 2026-10-15), so those slots stay one glyph each, never words.
 * `AddDirectoryControlCopy` (ISS-12521) and the demo's picker legend now carry
 * copy Cosimo Corrigan approved directly on 2026-10-16.
 */

import type {
  AutoExcludedDirectory,
  DirectoryScopeEntry,
  DirectoryScopeListCopy,
} from "./directory-scope-list";
import {
  type AddDirectoryControlCopy,
  AddDirectoryOutcome,
  type PickedDirectory,
} from "./directory-scope-list-with-add";

/** Fills a copy slot that has no approved wording. Not a word in any language. */
export const UNWRITTEN_COPY_GLYPH = "…";

export const UNWRITTEN_SCOPE_LIST_COPY: DirectoryScopeListCopy = {
  autoExcludedHeading: UNWRITTEN_COPY_GLYPH,
  autoExcludedReason: UNWRITTEN_COPY_GLYPH,
  empty: UNWRITTEN_COPY_GLYPH,
  newlyDiscovered: UNWRITTEN_COPY_GLYPH,
  noSelection: UNWRITTEN_COPY_GLYPH,
  treeLabel: UNWRITTEN_COPY_GLYPH,
  unavailable: UNWRITTEN_COPY_GLYPH,
  unavailableReason: UNWRITTEN_COPY_GLYPH,
};

/** Approved by Cosimo Corrigan, 2026-10-16, on the ISS-12521 ticket thread. */
export const ADD_DIRECTORY_CONTROL_COPY: AddDirectoryControlCopy = {
  added: "Directory added",
  duplicate: "Already selected",
  protectedFolder: "This directory is not allowed",
  trigger: "Add directory",
  unreadable: "This directory is currently unreadable",
};

/**
 * Names the prototype's picker stand-in (there is no real picker to label).
 * Approved by Cosimo Corrigan, 2026-10-16.
 */
export const PICK_LEGEND = "Permitted input directories";

export const FIXTURE_SCOPE_ENTRIES: readonly DirectoryScopeEntry[] = [
  {
    id: "~/code",
    label: "~/code",
    children: [
      { id: "~/code/orbit-api", label: "orbit-api" },
      { id: "~/code/orbit-web", label: "orbit-web" },
    ],
  },
  { id: "~/sandbox", label: "~/sandbox" },
];

export const FIXTURE_INCLUDED_IDS: readonly string[] = ["~/code"];

export const FIXTURE_EXPANDED_IDS: readonly string[] = ["~/code"];

export const FIXTURE_AUTO_EXCLUDED: readonly AutoExcludedDirectory[] = [
  { id: "~/Desktop", label: "~/Desktop" },
  { id: "~/Documents", label: "~/Documents" },
  { id: "~/Downloads", label: "~/Downloads" },
];

/** One pick per outcome, each resolving the way its key says. */
export const FIXTURE_PICKS = {
  [AddDirectoryOutcome.Added]: {
    id: "~/oss/tern",
    label: "~/oss/tern",
    tccProtected: false,
    unreadable: false,
  },
  // A nested id, so the duplicate check is shown to walk children.
  [AddDirectoryOutcome.Duplicate]: {
    id: "~/code/orbit-web",
    label: "~/code/orbit-web",
    tccProtected: false,
    unreadable: false,
  },
  [AddDirectoryOutcome.Unreadable]: {
    id: "/Volumes/vault/ledger",
    label: "/Volumes/vault/ledger",
    tccProtected: false,
    unreadable: true,
  },
  // Protected folders also probe as unreadable; protected must still win.
  [AddDirectoryOutcome.Protected]: {
    id: "~/Documents",
    label: "~/Documents",
    tccProtected: true,
    unreadable: true,
  },
} as const satisfies Record<AddDirectoryOutcome, PickedDirectory>;

export type UnwiredPickedDirectoryDatum = {
  /** Where a reader sees the value. */
  surface: string;
  /** What the value claims, so a wrong wiring is recognisable. */
  presentsAs: string;
  /** The ticket that produces the real value. */
  ownedBy: string;
};

/**
 * Every `PickedDirectory` field is still fixture-fed: no host mounts the
 * surface and no IPC channel produces a pick yet (ISS-12521 AC-004).
 */
export const UNWIRED_PICKED_DIRECTORY: Record<
  keyof PickedDirectory,
  UnwiredPickedDirectoryDatum
> = {
  id: {
    surface: "Directory scope list, add control",
    presentsAs: "The picked directory's canonical path",
    ownedBy: "ISS-12521",
  },
  label: {
    surface: "Directory scope list, added row",
    presentsAs: "The picked directory's display path",
    ownedBy: "ISS-12521",
  },
  tccProtected: {
    surface: "Directory scope list, add control outcome",
    presentsAs: "Whether macOS protects the picked folder",
    ownedBy: "ISS-12521",
  },
  unreadable: {
    surface: "Directory scope list, add control outcome",
    presentsAs: "Whether the picked directory can be opened",
    ownedBy: "ISS-12521",
  },
};
