import { LEGACY_VIEW_STATE_REVISION } from "./view-state-codec";

/**
 * The URL carrier for the model revision a view was encoded under (ISS-9480).
 *
 * The saved-view carrier is the envelope key in `./view-state-codec`; this is
 * the same vocabulary on a link, and the constants come from there rather than
 * being restated, so a reader cannot end up with two answers for what revision
 * a view is at.
 *
 * Two carriers rather than one because they fail differently. A stored view is
 * a whole JSON object this build wrote and can migrate as a unit; a link is a
 * flat set of params a DIFFERENT build wrote, and the reader has no record of
 * what it meant. Today a link states its facets and nothing else, so a value a
 * newer build respelled is indistinguishable from junk: the Branches grouping
 * parser answers `null` for both and the reader silently lands on their stored
 * view instead of the link they followed. A stated revision is what separates
 * "this link is malformed" from "this link is newer than me".
 *
 * Deliberately domain-free, like the codec beside it: no facet names, no param
 * map, no surface. A caller supplies its own migration over its own params.
 */

/**
 * The query param naming a link's model revision.
 *
 * Spelled out rather than `v`, which reads as a version of the PAGE and is
 * short enough to collide with a facet a surface adds later.
 */
export const VIEW_REVISION_PARAM = "viewRev";

/**
 * The only text {@link readLinkedViewRevision} accepts as a revision.
 *
 * Module level per Ultracite's `useTopLevelRegex`. Deliberately narrower than
 * anything `Number` would take: no sign, no exponent, no hex, no surrounding
 * whitespace, and no empty string.
 */
const VIEW_REVISION_PATTERN = /^\d+$/;

/**
 * How a surface versions the query model it puts in a link.
 *
 * The sibling of `ViewStateRevisionSpec`, and deliberately not the same type:
 * that one repairs a JSON envelope and returns a new one, this one repairs
 * `URLSearchParams` IN PLACE, because every list-URL write in this codebase has
 * to re-assert the whole query in one `replace` and handing back a second
 * params object would invite a caller to write the wrong one.
 */
export type UrlViewRevisionSpec = {
  /** The model revision this build writes into a link. */
  current: number;
  /**
   * Rewrite `params` from the revision `from` states into what `current`
   * expects — renamed params, respelled values, a facet split in two.
   *
   * Throwing is treated as a link this build cannot honour rather than
   * propagating into a render, which is the same degradation the codec applies
   * to a migration that throws over stored JSON.
   */
  migrate: (params: URLSearchParams, from: number) => void;
};

/**
 * The revision a link states, {@link LEGACY_VIEW_STATE_REVISION} when it states
 * none, or `null` when it states something that is not a revision or states
 * more than one.
 *
 * Absent is not corrupt: every link shared before versioning existed carries no
 * param, and reading those as legacy is what lets them be migrated instead of
 * refused. A param that IS present and unreadable is corrupt, and the caller is
 * told so rather than having it quietly treated as legacy — a link that says
 * `viewRev=banana` has been through something, and running a legacy migration
 * over the rest of its params would repair it toward a shape it never had.
 */
export function readLinkedViewRevision(
  params: Pick<URLSearchParams, "getAll">
): number | null {
  const stated = params.getAll(VIEW_REVISION_PARAM);
  const raw = stated.at(0);
  if (raw === undefined) {
    return LEGACY_VIEW_STATE_REVISION;
  }
  // Two stamps are refused rather than one of them believed (whitlockk, #7808):
  // first-wins reads `viewRev=0&viewRev=7` as legacy and re-stamps a newer
  // link as current, and last-wins is the same defect in the other order.
  if (stated.length > 1) {
    return null;
  }
  // The SHAPE is checked before the conversion, because `Number` is far too
  // permissive for untrusted text and every form it accepts fails differently:
  // `""` is `0` and `" 3 "` is `3`, which read a mangled param as a revision it
  // never stated; `"0x10"` is `16` and `"1e3"` is `1000`, which is worse still,
  // because a value ABOVE this build's revision takes the carry-verbatim branch
  // in `applyLinkedViewRevision` and the link is applied UNMIGRATED rather than
  // refused. Digits only — the same strictness `isViewStateRevision` applies to
  // the stored stamp, which is the point of the two carriers sharing one
  // vocabulary.
  if (!VIEW_REVISION_PATTERN.test(raw)) {
    return null;
  }
  const revision = Number(raw);
  return Number.isSafeInteger(revision) ? revision : null;
}

/**
 * Bring a link's params up to `spec.current` in place, reporting which of
 * {@link LinkedViewOutcome}'s three cases the link is.
 *
 * `Refused` means the link states a revision this build cannot read, or its
 * migration failed — the caller then falls back to the reader's stored view,
 * which is what the Branches grouping parser already does for a link it cannot
 * honour, rather than applying half of it.
 *
 * A link ABOVE this build's revision is `Newer`, reported apart from `Current`
 * because the two are not the same to the caller (marisolashgrove, #7808): its
 * params are in a vocabulary this build may not fully read. They are left
 * exactly as they arrived — carried verbatim, stamp not lowered, no migration
 * run — because this build has no step that goes further, and a reader
 * re-sharing the link unedited passes it on intact. A surface that WRITES the
 * link after an edit restamps it with {@link writeViewRevisionParam} at its own
 * revision, as the codec does, because what it wrote is in its own spelling.
 */
export function applyLinkedViewRevision(
  params: URLSearchParams,
  spec: UrlViewRevisionSpec
): LinkedViewOutcome {
  const stated = readLinkedViewRevision(params);
  if (stated === null) {
    return LinkedViewOutcome.Refused;
  }
  if (stated > spec.current) {
    return LinkedViewOutcome.Newer;
  }
  if (stated === spec.current) {
    return LinkedViewOutcome.Current;
  }
  // Snapshot first: `migrate` rewrites `params` IN PLACE and is documented to
  // do it in several steps, so one that renames a facet and then fails on the
  // next has ALREADY edited the caller's object. Without the rewind below the
  // `Refused` return would hand back a half-migrated link while promising an
  // untouched one, and the caller — which falls back to the stored view on
  // `Refused` — would carry those edits into whatever it writes next.
  const snapshot = params.toString();
  try {
    spec.migrate(params, stated);
  } catch {
    restoreSearchParams(params, snapshot);
    return LinkedViewOutcome.Refused;
  }
  writeViewRevisionParam(params, spec.current);
  return LinkedViewOutcome.Current;
}

/**
 * Stamp `revision` onto a link, OMITTING it at the legacy revision.
 *
 * Elided rather than written as `viewRev=0`, for the reason
 * `writeBranchPageParam` omits page 1 and `writeFacetFilterParams` deletes an
 * empty facet: a link describing the default states nothing, and a surface that
 * has never revised its model keeps the clean URL it ships with today. The
 * param appears the first time a surface actually revises — which is the first
 * time a reader on the other side of a deploy needs it.
 */
export function writeViewRevisionParam(
  params: URLSearchParams,
  revision: number
): void {
  params.delete(VIEW_REVISION_PARAM);
  if (revision !== LEGACY_VIEW_STATE_REVISION) {
    params.set(VIEW_REVISION_PARAM, String(revision));
  }
}

/**
 * Rewind `params` in place to the query string `snapshot` recorded.
 *
 * In place rather than by handing back a fresh `URLSearchParams`, because the
 * caller holds this object: every list-URL write in this domain re-asserts the
 * whole query into one params instance, and returning a replacement would leave
 * the caller writing the one that was mutated.
 */
function restoreSearchParams(
  params: URLSearchParams,
  snapshot: string
): void {
  // Keys are collected BEFORE the first delete. `params.keys()` iterates the
  // same object being mutated, so deleting during the walk skips entries and
  // leaves part of the failed migration behind — which is the bug this
  // function exists to undo.
  for (const key of [...new Set(params.keys())]) {
    params.delete(key);
  }
  for (const [key, value] of new URLSearchParams(snapshot)) {
    params.append(key, value);
  }
}

/** What {@link applyLinkedViewRevision} could make of a link. */
export const LinkedViewOutcome = {
  /** The params are in this build's vocabulary: they already were, or were migrated. */
  Current: "current",
  /** The link is from a NEWER build and is carried verbatim, unmigrated. */
  Newer: "newer",
  /** An unreadable or duplicated stamp, or a failed migration; params untouched. */
  Refused: "refused",
} as const;
export type LinkedViewOutcome =
  (typeof LinkedViewOutcome)[keyof typeof LinkedViewOutcome];
