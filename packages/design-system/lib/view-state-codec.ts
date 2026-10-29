import type { ZodType } from "zod";

/**
 * A domain-free codec for persisted table view state (ISS-9447 M1, generalized
 * from the Sessions codec ISS-8693 landed).
 *
 * `Set` and `Map` both `JSON.stringify` to `{}` with no error, so a view state
 * persisted raw round-trips as "no filters" and silently shows everything. This
 * module is the one transform between a live view state and its JSON form, and
 * it is generic over BOTH the state and the schemas that validate it: it
 * declares no axes, no schema, no storage key and no storage access. A caller
 * supplies an axis table describing its own state; everything domain-specific —
 * which axes exist, what they mean, how they are versioned and where they are
 * stored — stays with that caller.
 *
 * The `satisfies` on a caller's axis table is the guard, not documentation.
 * {@link ViewStateAxisSpecs} is mapped over the state with `-?`, so a new axis
 * with no entry fails `tsc` on the missing property; an axis whose type this
 * codec cannot round-trip — a `Date`, a class instance, an object with a nested
 * `Set` — resolves {@link AxisKindFor} to `never`, so no `kind` is assignable
 * and it fails `tsc` too; and a `schema` looser than the axis it guards fails
 * `tsc` on the value type. None can reach the wire unnoticed.
 *
 * Zod appears here as a TYPE ONLY. The engine calls `safeParse` on whatever the
 * caller passes and declares no schema of its own, so this package — which
 * declares `zod` but has no module importing it at runtime — keeps that
 * property, and a bundle-sensitive consumer of the design system does not pull
 * Zod in by reaching for a codec.
 */

type JsonPrimitive = string | number | boolean | null;

/** Whether `TValue` survives `JSON.stringify` as itself. */
type IsJsonNative<TValue> = [TValue] extends [JsonPrimitive | undefined]
  ? true
  : [TValue] extends [readonly (infer TElement)[]]
    ? IsJsonNative<TElement>
    : [TValue] extends [(...args: never[]) => unknown]
      ? false
      : [TValue] extends [object]
        ? true extends {
            [K in keyof TValue]: IsJsonNative<TValue[K]> extends true
              ? never
              : true;
          }[keyof TValue]
          ? false
          : true
        : false;

/** How one axis crosses JSON: unchanged, or under a tag that restores it. */
export type ViewStateAxisKind = "json" | "set" | "map";

/**
 * `never` for a value this codec cannot round-trip, which is what makes a
 * caller's axis table refuse to compile for it.
 *
 * `ReadonlyMap` is tested before `ReadonlySet` because a `Map` structurally
 * satisfies `ReadonlySet`'s members while a `Set` has no `get`.
 *
 * A collection's ELEMENTS have to survive JSON too, and only the outer
 * collection is tagged (whitlockk, #6363). A `ReadonlyMap<string,
 * ReadonlySet<string>>` encodes to `{"@@map":[["k",{}]]}` — the inner `Set` is
 * gone and nothing threw — so a `map`/`set` whose keys, values or elements are
 * not JSON-native resolves to `never` here rather than compiling into a
 * silently lossy axis.
 */
export type AxisKindFor<TValue> = [TValue] extends [
  ReadonlyMap<infer TKey, infer TMapValue>,
]
  ? IsJsonNative<TKey> extends true
    ? IsJsonNative<TMapValue> extends true
      ? "map"
      : never
    : never
  : [TValue] extends [ReadonlySet<infer TElement>]
    ? IsJsonNative<TElement> extends true
      ? "set"
      : never
    : IsJsonNative<TValue> extends true
      ? "json"
      : never;

export type ViewStateAxisSpec<TValue> = {
  kind: AxisKindFor<Exclude<TValue, undefined>>;
  /** Whether a payload missing this axis is malformed rather than merely absent. */
  required: undefined extends TValue ? false : true;
  /**
   * Validates the DECODED value, so a `set` axis's schema sees a real `Set`.
   * Typed against the axis, so a schema looser than the axis it guards — a
   * `z.string()` under a `"asc" | "desc"` axis, a `z.unknown()` under a
   * structured one — fails `tsc` here rather than passing a bad value through
   * to a caller.
   */
  schema: ZodType<Exclude<TValue, undefined>>;
};

/**
 * Every axis of `TState`, how it survives JSON, and what a restored value has
 * to look like. Mapped with `-?` so an optional axis still owes an entry.
 */
export type ViewStateAxisSpecs<TState> = {
  [K in keyof TState]-?: ViewStateAxisSpec<TState[K]>;
};

/** A view state in its JSON-native form. Opaque: read it only through a codec. */
export type SerializedViewState = Record<string, unknown>;

export type ViewStateCodec<TState> = {
  /**
   * An axis the state does not carry is OMITTED rather than written as `null`:
   * absent, empty and applied are three different answers on the optional axes,
   * and a caller may read them that way.
   *
   * An axis this build does not know is carried across rather than dropped. Two
   * shells ship the same state on different cadences, so stripping the axes
   * only the newer build names would silently delete a reader's saved filter
   * the first time the older build re-saved their view.
   */
  serialize: (view: TState) => SerializedViewState;
  /**
   * The inverse, over untrusted input: the payload comes from storage, so it
   * may be malformed, hand-edited, or written by a build whose axes differ.
   * `null` means it could not be restored, which callers read as "no saved
   * view" rather than a half-restored one.
   *
   * A declared axis is VALIDATED, not merely untagged (codex/whitlockk, #6363).
   * Tags and key presence alone would let a `null`, an `{}` or a wrong-typed
   * scalar through under the advertised return type, so a caller that trusted
   * it would throw.
   *
   * A malformed UNDECLARED axis costs only itself (ISS-9447 M2): it is dropped
   * and the rest of the payload restores. See {@link AXIS_DROPPED}.
   */
  deserialize: (raw: unknown) => TState | null;
};

/**
 * A `Set`/`Map` axis on the wire. The `@@` prefix is load-bearing: other axes
 * are plain JSON objects, and an untagged key would make an ordinary object
 * indistinguishable from a tagged one on the way back.
 */
const SET_TAG = "@@set";
const MAP_TAG = "@@map";

/**
 * The model revision a payload was written under (ISS-9480).
 *
 * Reserved: it names the ENVELOPE, never an axis, so the axis loop always skips
 * it and it is never decoded, validated, counted as a required axis, or handed
 * back in a restored state.
 *
 * It names the build that WROTE the envelope, so every write stamps that build's
 * own revision (or none, unversioned) — including over a payload a newer build
 * stamped higher. Carrying the higher stamp through a write is what loses a
 * view: every declared axis this build writes passed this build's schema, so it
 * is in this build's spelling, and a newer build trusting the carried stamp
 * skips the migration that would have respelled it (tamsinb, #7808).
 */
const REVISION_KEY = "@@rev";

/**
 * The revision an UNSTAMPED payload is read as — every view persisted or linked
 * before versioning existed.
 *
 * `0` rather than a refusal, because a stored view that predates the stamp is
 * not corrupt, it is old: refusing it would discard exactly the population a
 * migration exists to carry forward.
 */
export const LEGACY_VIEW_STATE_REVISION = 0;

/** Distinguishes "this axis is malformed" from an axis whose value is `null`. */
const DECODE_FAILED = Symbol("decode-failed");

/**
 * A malformed axis this build does not DECLARE: dropped from the restored
 * state rather than taken as a reason to refuse the whole payload (ISS-9447
 * M2).
 *
 * A declared axis that will not decode still refuses everything, because the
 * caller asked for that axis and half-restoring it would hand back a silently
 * wrong view. An UNDECLARED one is the opposite case: this build cannot use the
 * value, cannot judge it, and cannot even name the axis — so refusing throws
 * away every axis it COULD have restored over a field it does not know exists,
 * which is the loss ISS-9447 is about rather than an instance of safety.
 *
 * Dropped rather than carried, for the reason `partitionPreservedColumnIds`
 * gives for a malformed width: a well-formed unknown value is version skew and
 * is carried across, a malformed one is corrupt data, and writing it back would
 * persist a bad value under the pretense of forward compatibility — here it
 * would also hand the corruption to the very build that names the axis, which
 * would then refuse the whole record itself.
 */
const AXIS_DROPPED = Symbol("axis-dropped");

/** One axis spec with its type parameter erased, for the by-name lookup. */
type ErasedViewStateAxisSpec = {
  kind: ViewStateAxisKind;
  required: boolean;
  schema: ZodType;
};

/**
 * Build the codec for one axis table.
 *
 * `TState` is supplied by the caller and is NOT inferred from `axes` — that is
 * the whole compile-time guarantee. Inferred, any object would produce a
 * `TState` it happens to match, and an axis table missing a field would compile
 * cleanly.
 */
export function createViewStateCodec<TState extends object>(
  axes: ViewStateAxisSpecs<TState>,
  revision?: ViewStateRevisionSpec
): ViewStateCodec<TState> {
  // A `Map` rather than the literal, so a prototype key resolves no spec.
  const specByAxis = new Map<string, ErasedViewStateAxisSpec>(
    Object.entries(axes as Record<string, ErasedViewStateAxisSpec>)
  );

  /**
   * One stored axis, decoded against its declared kind and then validated
   * against its declared schema, or {@link DECODE_FAILED}.
   *
   * An axis this build does not name has neither, so it is read by shape and
   * carried across unvalidated — this build has no schema to judge it by, and
   * refusing would delete a newer build's axis on every older-build save. One
   * that will not even decode by shape is {@link AXIS_DROPPED} rather than
   * DECODE_FAILED, so it costs its own axis and not the payload.
   */
  function restoreAxisValue(axis: string, stored: unknown): unknown {
    const spec = specByAxis.get(axis);
    const decoded = decodeAxisValue(spec?.kind, stored);
    if (spec === undefined) {
      return decoded === DECODE_FAILED ? AXIS_DROPPED : decoded;
    }
    if (decoded === DECODE_FAILED) {
      return DECODE_FAILED;
    }
    const parsed = spec.schema.safeParse(decoded);
    return parsed.success ? parsed.data : DECODE_FAILED;
  }

  function deserialize(raw: unknown): TState | null {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }
    const payload = raw as Record<string, unknown>;
    const stored = readStoredRevision(payload);
    if (stored === DECODE_FAILED) {
      return null;
    }
    const source = migratePayload(revision, payload, stored);
    if (source === DECODE_FAILED) {
      return null;
    }
    const restored: Record<string, unknown> = {};
    for (const axis of Object.keys(source)) {
      // A stored key named `__proto__` would set the prototype rather than an
      // axis, so it never reaches the assignment below. The revision names the
      // envelope, not an axis.
      if (axis === "__proto__" || axis === REVISION_KEY) {
        continue;
      }
      const value = restoreAxisValue(axis, Reflect.get(source, axis));
      if (value === DECODE_FAILED) {
        return null;
      }
      if (value === AXIS_DROPPED) {
        continue;
      }
      restored[axis] = value;
    }
    for (const [axis, spec] of specByAxis) {
      if (spec.required && !Object.hasOwn(restored, axis)) {
        return null;
      }
    }
    return restored as TState;
  }

  function serialize(view: TState): SerializedViewState {
    const serialized: SerializedViewState = {};
    for (const [axis, value] of Object.entries(view)) {
      if (value === undefined) {
        continue;
      }
      serialized[axis] = encodeAxisValue(value);
    }
    // Elided at the legacy revision, as `writeViewRevisionParam` elides it on
    // a link: absent already reads as legacy, so the two carriers agree.
    if (
      revision !== undefined &&
      revision.current !== LEGACY_VIEW_STATE_REVISION
    ) {
      serialized[REVISION_KEY] = revision.current;
    }
    return serialized;
  }

  return { deserialize, serialize };
}

function encodeAxisValue(value: unknown): unknown {
  if (value instanceof Set) {
    return { [SET_TAG]: [...value] };
  }
  if (value instanceof Map) {
    return { [MAP_TAG]: [...value] };
  }
  return value;
}

/** The tag and payload `value` carries, or `null` when it carries no tag. */
function readAxisTag(
  value: unknown
): { entries: unknown; tag: typeof SET_TAG | typeof MAP_TAG } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const keys = Object.keys(value);
  const tag = keys[0];
  if (keys.length !== 1 || !(tag === SET_TAG || tag === MAP_TAG)) {
    return null;
  }
  return { entries: Reflect.get(value, tag), tag };
}

function decodeMapEntries(entries: unknown[]): Map<unknown, unknown> | symbol {
  const pairs: [unknown, unknown][] = [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return DECODE_FAILED;
    }
    pairs.push([entry[0], entry[1]]);
  }
  return new Map(pairs);
}

/**
 * A declared axis is decoded against the `kind` it was declared with, never
 * against the shape that happens to have been stored.
 *
 * Shape alone cannot tell a restorable payload from the very one this codec is
 * about: a view written by a build that called `JSON.stringify` directly stores
 * a `Set` axis as `{}`, which is a perfectly good plain object. Inferred, it
 * restores as "empty" — a silently wrong view rather than the `null` the
 * contract promises. An axis this build does not name has no declared kind, so
 * it is still read by shape.
 */
function decodeAxisValue(
  kind: ViewStateAxisKind | undefined,
  value: unknown
): unknown {
  const tagged = readAxisTag(value);
  if (kind === "json") {
    return tagged === null ? value : DECODE_FAILED;
  }
  if (tagged === null) {
    return kind === undefined ? value : DECODE_FAILED;
  }
  const { entries, tag } = tagged;
  if (!Array.isArray(entries)) {
    return DECODE_FAILED;
  }
  if (tag === SET_TAG) {
    return kind === "map" ? DECODE_FAILED : new Set(entries);
  }
  return kind === "set" ? DECODE_FAILED : decodeMapEntries(entries);
}

/**
 * How a caller versions its own model (ISS-9480).
 *
 * Optional, and a codec built without one behaves exactly as it did before
 * versioning existed — the envelope it writes is byte-identical, so no stored
 * view has to be rewritten to adopt this.
 *
 * The axis table answers what a view MAY hold; this answers what the values in
 * it MEAN. The two are genuinely different questions, and only the second is a
 * reason to migrate: adding an axis is already survivable (a missing optional
 * axis restores absent, an unknown one is carried), whereas RESPELLING what an
 * existing axis holds is not. A revision whose `dateRange` becomes
 * `"last7Days"` where v0 wrote `"7d"` makes the current schema reject the
 * stored value, and a rejected DECLARED axis refuses the entire payload — so
 * without this the reader loses every other axis too, which is the whole of
 * "a stored view survives a model revision".
 */
export type ViewStateRevisionSpec = {
  /** The model revision this build writes. */
  current: number;
  /**
   * Repair a payload written at `from` into the shape `current` expects.
   *
   * Runs on the RAW payload and BEFORE any axis is decoded or validated, which
   * is the ordering the whole mechanism rests on: after validation the older
   * spelling has already been refused and there is nothing left to repair.
   *
   * Receives the envelope as stored, revision key included; return value and
   * input are both plain JSON. Throwing is treated as unrecoverable corruption
   * (the payload restores as "no saved view") rather than propagating into a
   * render.
   *
   * Must leave unchanged every value it does not recognise as a `from`-era
   * spelling, and a revision must never give an older spelling a new meaning.
   * An older build re-saving a newer view stamps its OWN revision (see
   * `REVISION_KEY`) while still carrying axes only the newer build declares, so
   * this runs again over a payload that is already partly current and has to
   * be a no-op on that part. A step that is not a respelling — a new default,
   * a column hidden once — cannot meet that, and belongs on a per-axis stamp
   * (`runViewStateMigration` in `packages/app`).
   */
  migrate: (payload: SerializedViewState, from: number) => SerializedViewState;
};

/** Whether a stored stamp is a revision at all. */
function isViewStateRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The revision `payload` claims, or {@link DECODE_FAILED} when it claims one
 * that is not a revision.
 *
 * Validated whether or not THIS codec versions, because the key is reserved
 * either way and a stamp that is not a revision means the payload has been
 * through something no build wrote.
 */
function readStoredRevision(
  payload: Record<string, unknown>
): number | typeof DECODE_FAILED {
  if (!Object.hasOwn(payload, REVISION_KEY)) {
    return LEGACY_VIEW_STATE_REVISION;
  }
  const stored = Reflect.get(payload, REVISION_KEY);
  return isViewStateRevision(stored) ? stored : DECODE_FAILED;
}

/**
 * `payload` brought up to this build's revision, or {@link DECODE_FAILED} when
 * the caller's migration could not do it.
 *
 * A payload at or ABOVE this build's revision is returned untouched: this build
 * has no step that goes further, and no step that goes back.
 */
function migratePayload(
  revision: ViewStateRevisionSpec | undefined,
  payload: Record<string, unknown>,
  stored: number
): Record<string, unknown> | typeof DECODE_FAILED {
  if (revision === undefined || stored >= revision.current) {
    return payload;
  }
  try {
    // A clone, because `migrate` may rewrite in steps and throw part way:
    // handed the caller's object, a failure would leave it half-rewritten
    // behind a "no saved view" answer (marisolashgrove, #7808).
    return revision.migrate(structuredClone(payload), stored);
  } catch {
    return DECODE_FAILED;
  }
}
