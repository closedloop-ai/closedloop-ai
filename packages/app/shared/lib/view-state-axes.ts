import { z } from "zod";
import { isUsableColumnWidth } from "./column-width";

/**
 * The schema fragments every persisted table view is built from, and the
 * per-axis version envelope recording which one-time repairs a stored view has
 * already taken (ISS-9447 M2).
 *
 * ## Why the fragments live here
 *
 * Four of them were written out once per surface: the string-array cleaning
 * preprocess in four files, the version-marker preprocess in two, the
 * `pageSize` validator in two, and the `Object.values(...) as [T, ...T[]]` sort
 * tuple in four. A fix to any one reached the surface it was made on and left
 * the others exactly as they were, which is how one domain's two Branches
 * stores came to disagree about `columnWidths` and `pageSize`.
 *
 * ## Why the version markers are in the PAYLOAD, never the key
 *
 * A key bump orphans every saved view, which is the opposite of what ISS-9447
 * is for. `use-dashboard-pins.ts` versions the PAYLOAD instead, and a
 * view-state format that must survive its own upgrade is that same case.
 *
 * ## Why PER AXIS rather than one scalar
 *
 * Sessions already proved the single scalar wrong in its own words: it ships
 * two markers because sharing one "would let one repair stamp the other as done
 * without proving it ran". A map keyed by axis is that argument generalized,
 * and it is what lets a surface add a third axis without disturbing the two it
 * has.
 *
 * ## Why the shape is an ADDITIVE SUPERSET
 *
 * {@link resolveViewStateVersions} reads a LEGACY layout — the loose top-level
 * markers a surface wrote before this module, or no marker at all — and a
 * caller writes the envelope ALONGSIDE those same loose fields, both sides
 * derived from the surface's {@link ViewStateLegacyMirrors} table by
 * {@link legacyViewStateVersions} and {@link advanceViewStateVersions}. A build
 * without this change therefore still finds every marker in a record a build
 * with it wrote: no stored view is invalidated, no backfill runs, and two
 * builds can share one record.
 *
 * That mirror is MANDATORY, not a courtesy, and the type makes it so — an
 * already-deployed build strips the envelope on parse and never re-emits it, so
 * an axis living only in the envelope is deleted by a round trip through one.
 * See {@link ViewStateLegacyMirrors}.
 *
 * Legacy field NAMES are mapped by the surface, never here, and the reason is
 * concrete. Sessions stores `savedViewVersion` for its COLUMN-ORDER axis while
 * Agent Components stores a field of the same name for its SORT axis; they do
 * not collide today only because the two surfaces use different storage keys. A
 * name table in this module would map one name to two axes and silently
 * mis-stamp one of them, so each surface names its own at the point it reads.
 */

/** The version a stored axis carries when no migration has stamped it yet. */
export const VIEW_STATE_UNVERSIONED = 0;

/**
 * The highest stamp a stored axis may carry before it is read as corrupt.
 *
 * An axis advances one version per shipped repair — three across this repo's
 * whole history — so a stamp in the thousands is not a build, it is damage: a
 * `Date.now()`-shaped number from a coding slip, or a hand-edited
 * `localStorage`. Without a ceiling such a value parses as a legitimate FUTURE
 * stamp, and a future stamp is kept verbatim rather than lowered (ISS-9447 M3),
 * so it would sit above every version its axis will ever reach and permanently
 * skip that record's one-time repairs. Non-negative and integral are the two
 * halves everyone remembers; magnitude is the one that reaches storage.
 */
export const VIEW_STATE_MAX_VERSION = 1000;

/**
 * The axes a persisted table view is versioned along.
 *
 * Canonical names, unlike the legacy field names above — one axis means the
 * same thing on every surface, so naming them once is what stops two surfaces
 * spelling the same axis differently inside one envelope.
 */
export const ViewStateAxis = {
  ColumnOrder: "columnOrder",
  HiddenColumns: "hiddenColumns",
  Sort: "sort",
} as const;
export type ViewStateAxis = (typeof ViewStateAxis)[keyof typeof ViewStateAxis];

/**
 * The stamps a stored view carries, keyed by axis.
 *
 * Keyed by `string` rather than {@link ViewStateAxis} because an axis a NEWER
 * build named is carried across rather than dropped — the same version-skew
 * rule the column ids follow. Nothing switches on these keys, so the union is
 * the READ vocabulary ({@link viewStateVersionOf}) and not a closed inventory
 * the map has to match.
 */
export type ViewStateVersions = Readonly<Record<string, number>>;

/**
 * Keep only the string entries of a (possibly mixed) array; a missing or
 * non-array value degrades to `[]`.
 *
 * A data-cleaning preprocess, not object-shape validation — that is the
 * schema's job. Degrading rather than failing is the point: a corrupt column
 * list must not cost the reader the sort and window stored beside it.
 */
export const PERSISTED_STRING_ARRAY_SCHEMA = z
  .preprocess(cleanPersistedStringArray, z.array(z.string()))
  .default([]);

/**
 * Per-column widths (px) keyed by column id, keeping only entries `isUsableColumnWidth`
 * accepts; anything else degrades to `{}`.
 *
 * The ceiling is applied HERE, at the parse, and not only downstream. It used
 * to live only in `preserved-column-ids.ts` on the argument that duplicating it
 * would let two ceilings drift — which was right about the hazard and wrong
 * about the remedy: what shipped was two PREDICATES, this one unbounded and
 * that one bounded, and a named Branches view that stored a 10001 therefore
 * kept it while the live table dropped it, reporting itself "Modified" forever
 * (ISS-9447 review). One predicate in `column-width.ts`, read by both, is the
 * remedy that actually holds.
 */
export const PERSISTED_COLUMN_WIDTHS_SCHEMA = z
  .preprocess(cleanPersistedColumnWidths, z.record(z.string(), z.number()))
  .default({});

/**
 * ISS-9692: persisted rows-per-page. A malformed or non-positive value degrades
 * to `undefined` ("nothing stored", so the surface default stands) rather than
 * failing the whole view parse and costing the reader their sort and columns
 * too. Deliberately NOT clamped to a ladder — the ladder moves with a feature
 * flag, so the raw choice is kept and resolved at render.
 */
export const PERSISTED_PAGE_SIZE_SCHEMA = z
  .number()
  .int()
  .positive()
  .optional()
  .catch(undefined);

/**
 * One legacy version marker: an integer in
 * `[VIEW_STATE_UNVERSIONED, VIEW_STATE_MAX_VERSION]`, or
 * {@link VIEW_STATE_UNVERSIONED} for anything else.
 *
 * Absent and malformed both degrade to "never migrated", which is the safe
 * direction — an older or corrupt marker re-runs a repair rather than skipping
 * one. An implausibly LARGE integer is malformed for that purpose too, and is
 * the case that would otherwise skip every repair forever
 * ({@link VIEW_STATE_MAX_VERSION}).
 */
export const PERSISTED_VERSION_MARKER_SCHEMA = z.preprocess(
  cleanPersistedVersionMarker,
  z.number()
);

/**
 * The canonical envelope: axis → stamp, degrading to `{}` rather than failing
 * the whole view parse, so a corrupt envelope costs the reader nothing beyond
 * the repairs being re-run.
 *
 * A key a newer build named is kept (version skew), an entry whose value is not
 * a plausible stamp is dropped (corrupt data, not skew — the same split
 * `partitionPreservedColumnIds` already makes for a malformed width, ceiling
 * included), and `__proto__` never reaches the object.
 */
export const PERSISTED_VIEW_STATE_VERSIONS_SCHEMA = z
  .preprocess(cleanPersistedViewStateVersions, z.record(z.string(), z.number()))
  .default({});

/**
 * A const enum object's values as the non-empty tuple `z.enum` needs.
 *
 * The one place the `as [T, ...T[]]` assertion lives. Every string-enum const
 * object in this repo has at least one member, and none is built at runtime, so
 * the non-emptiness the assertion claims is a property of the declaration
 * rather than of data — there is no reachable input that could falsify it.
 */
export function persistedEnumValues<TValue extends string>(
  enumObject: Readonly<Record<string, TValue>>
): [TValue, ...TValue[]] {
  return Object.values(enumObject) as [TValue, ...TValue[]];
}

/**
 * The stamps in force for a stored view: the surface's LEGACY markers, mapped
 * to axes by the caller, with the canonical envelope laid over them.
 *
 * The envelope wins per axis because the two are written together — a build
 * that writes the envelope writes the mirror from the same value — so a
 * disagreement can only mean the envelope is the newer statement. An axis
 * present in only one of the two survives either way, which is what lets an
 * older build's write (it drops the envelope it never names, keeping the loose
 * fields) round-trip through this reader without losing a stamp.
 */
export function resolveViewStateVersions(
  legacyByAxis: ViewStateVersions,
  envelope: ViewStateVersions
): ViewStateVersions {
  const resolved: Record<string, number> = {};
  for (const source of [legacyByAxis, envelope]) {
    for (const [axis, version] of Object.entries(source)) {
      if (axis !== "__proto__") {
        resolved[axis] = version;
      }
    }
  }
  return resolved;
}

/**
 * The stamp `axis` carries, or {@link VIEW_STATE_UNVERSIONED} when it carries
 * none — which is exactly the never-migrated state every step runs against.
 *
 * Also what {@link advanceViewStateVersions} writes each LEGACY mirror field
 * from, so the envelope and the field beside it cannot drift.
 */
export function viewStateVersionOf(
  versions: ViewStateVersions,
  axis: ViewStateAxis
): number {
  return Object.hasOwn(versions, axis)
    ? versions[axis]
    : VIEW_STATE_UNVERSIONED;
}

/**
 * A surface's answer for an axis it does not version at all.
 *
 * Deliberately a named value rather than a bare `null` at the row: "this
 * surface has no such migration" is a claim, and it should read as one next to
 * the rows that name a real field.
 */
export const VIEW_STATE_AXIS_UNUSED: null = null;

/**
 * A surface's axis → LEGACY-MIRROR field table.
 *
 * WHY every versioned axis MUST have a mirror, and why it is a type rather than
 * a convention: a build deployed before this envelope existed parses a stored
 * view with a plain `z.object`, which STRIPS `viewStateVersions`, and
 * re-serializes a fixed field set that never names it. The envelope is
 * therefore DELETED by any round trip through such a build, and nothing here
 * can change that — those builds are already shipped. The loose mirror field is
 * the only channel that survives them, so an axis living ONLY in the envelope
 * comes back reading as never-migrated and re-runs every one of its steps —
 * ISS-6065's harm (re-hiding a column the reader deliberately showed) arriving
 * by a third route. The two axes that exist today are safe because each already
 * has a mirror; the guarantee is for the next one.
 *
 * A `Record` over the axis union, so adding a {@link ViewStateAxis} member
 * fails `tsc` at every surface until that surface either names the extras field
 * that mirrors it or states {@link VIEW_STATE_AXIS_UNUSED}. Naming a field the
 * surface's extras type does not declare fails too, so "declare a mirror"
 * cannot be satisfied with prose.
 *
 * The field NAMES stay per surface for the reason the module header gives:
 * `savedViewVersion` is the COLUMN-ORDER mirror on Sessions and the SORT mirror
 * on Agent Components, so one table here would mis-stamp one of them.
 */
export type ViewStateLegacyMirrors<TExtras> = Readonly<
  Record<
    ViewStateAxis,
    (keyof TExtras & string) | typeof VIEW_STATE_AXIS_UNUSED
  >
>;

/**
 * A mirror table with its extras type erased — the constraint the derivations
 * below are generic over, so they read any surface's table without needing that
 * surface's extras.
 */
export type ViewStateMirrorTable = Readonly<
  Record<ViewStateAxis, string | typeof VIEW_STATE_AXIS_UNUSED>
>;

/** The axes a given mirror table actually versions — those naming a field. */
export type MirroredViewStateAxis<TMirrors extends ViewStateMirrorTable> = {
  [TAxis in ViewStateAxis]: TMirrors[TAxis] extends string ? TAxis : never;
}[ViewStateAxis];

/** The extras fields a given mirror table writes. */
export type ViewStateMirrorField<TMirrors extends ViewStateMirrorTable> =
  TMirrors[MirroredViewStateAxis<TMirrors>] & string;

/**
 * The surface's LEGACY markers as an axis map, ready for
 * {@link resolveViewStateVersions} — derived from the mirror table so the read
 * side names no field the table has not declared.
 */
export function legacyViewStateVersions<TMirrors extends ViewStateMirrorTable>(
  mirrors: TMirrors,
  storedMirrors: Readonly<Record<ViewStateMirrorField<TMirrors>, number>>
): ViewStateVersions {
  const legacy: Record<string, number> = {};
  for (const [axis, field] of mirroredAxisFields(mirrors)) {
    legacy[axis] = storedMirrors[field];
  }
  return legacy;
}

/**
 * Lay this build's freshly-run stamps over the ones a record arrived with, and
 * hand back the mirror fields to write beside them.
 *
 * `applied` is keyed by {@link MirroredViewStateAxis}, which is the structural
 * half of the guarantee: an axis with no mirror in `mirrors` CANNOT be named
 * here, so it cannot reach the envelope, so there is no such thing as an
 * envelope-only axis. Totality is deliberate too — declaring a mirror obliges
 * the surface to compute that axis's version rather than leave it at whatever
 * was stored.
 */
export function advanceViewStateVersions<TMirrors extends ViewStateMirrorTable>(
  mirrors: TMirrors,
  storedVersions: ViewStateVersions,
  applied: Readonly<Record<MirroredViewStateAxis<TMirrors>, number>>
): {
  mirrors: Record<ViewStateMirrorField<TMirrors>, number>;
  versions: ViewStateVersions;
} {
  // Spread first so an axis only a NEWER build names keeps its stamp.
  const versions: Record<string, number> = { ...storedVersions, ...applied };
  const mirrored: Record<string, number> = {};
  for (const [axis, field] of mirroredAxisFields(mirrors)) {
    mirrored[field] = viewStateVersionOf(versions, axis);
  }
  return {
    mirrors: mirrored as Record<ViewStateMirrorField<TMirrors>, number>,
    versions,
  };
}

function cleanPersistedStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === "string");
}

function cleanPersistedColumnWidths(value: unknown): Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const cleaned: Record<string, number> = {};
  for (const [id, width] of Object.entries(value)) {
    if (
      id !== "__proto__" &&
      typeof width === "number" &&
      isUsableColumnWidth(width)
    ) {
      cleaned[id] = width;
    }
  }
  return cleaned;
}

function cleanPersistedVersionMarker(value: unknown): number {
  return isVersionMarker(value) ? value : VIEW_STATE_UNVERSIONED;
}

function cleanPersistedViewStateVersions(
  value: unknown
): Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const cleaned: Record<string, number> = {};
  for (const [axis, version] of Object.entries(value)) {
    if (axis !== "__proto__" && isVersionMarker(version)) {
      cleaned[axis] = version;
    }
  }
  return cleaned;
}

function isVersionMarker(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= VIEW_STATE_UNVERSIONED &&
    value <= VIEW_STATE_MAX_VERSION
  );
}

/**
 * The (axis, mirror field) pairs a table declares, walked over the canonical
 * axis enum rather than the table's own keys so the walk is exhaustive by
 * construction and not by whatever the table happened to be built with.
 */
function mirroredAxisFields<TMirrors extends ViewStateMirrorTable>(
  mirrors: TMirrors
): readonly [ViewStateAxis, ViewStateMirrorField<TMirrors>][] {
  const pairs: [ViewStateAxis, string][] = [];
  for (const axis of Object.values(ViewStateAxis)) {
    const field = mirrors[axis];
    if (field !== VIEW_STATE_AXIS_UNUSED) {
      pairs.push([axis, field]);
    }
  }
  return pairs as readonly [ViewStateAxis, ViewStateMirrorField<TMirrors>][];
}
