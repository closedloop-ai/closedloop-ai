import {
  createViewStateCodec,
  LEGACY_VIEW_STATE_REVISION,
  type ViewStateAxisSpecs,
  type ViewStateRevisionSpec,
} from "@closedloop-ai/design-system/lib/view-state-codec";
import { beforeEach, describe, expect, it } from "vitest";
import type { ZodType } from "zod";

/**
 * ISS-9447 M1 — the domain-free view-state codec engine.
 *
 * Division of labour: this lane owns the ENGINE's own behavior (tagging, the
 * decode-against-declared-kind rule, required-axis handling, forward
 * compatibility) and its compile-time completeness guarantee. The engine meeting
 * real Zod schemas over a real axis table is already covered from the consumer
 * side by
 * `packages/app/agents/components/sessions/__tests__/sessions-list-view-state-serialization.test.ts`,
 * which is what proves the extraction changed no behavior.
 */

/**
 * A stand-in for a caller's schema.
 *
 * The engine is generic over schemas and declares none — it only ever calls
 * `safeParse` — so injecting a validator exercises the real contract rather
 * than mocking the subject. It also keeps this package free of a RUNTIME Zod
 * import: `packages/design-system` declares `zod` as a dependency but no module
 * in it imports one, and the codec's type-only import is what preserves that.
 */
function schemaAccepting<TValue>(
  isValid: (value: unknown) => boolean
): ZodType<TValue> {
  const stub: unknown = {
    safeParse: (value: unknown) =>
      isValid(value)
        ? { success: true, data: value }
        : { success: false, error: new Error("invalid") },
  };
  return stub as ZodType<TValue>;
}

type ExampleViewState = {
  columnIds: ReadonlySet<string>;
  page: number;
  widths: ReadonlyMap<string, number>;
  /**
   * A `set` axis whose schema (below) accepts anything. Every other axis here
   * is strictly validated, and a strict schema BACKSTOPS the declared-kind
   * rule — reject the kind and the schema would have rejected the value
   * anyway. This axis is the one place the kind rule stands alone, so the case
   * that pins it can fail on that rule and nothing else.
   */
  pinned?: ReadonlySet<string>;
  search?: string;
};

const EXAMPLE_AXES = {
  columnIds: {
    kind: "set",
    required: true,
    schema: schemaAccepting<ReadonlySet<string>>(
      (value) => value instanceof Set
    ),
  },
  page: {
    kind: "json",
    required: true,
    schema: schemaAccepting<number>((value) => typeof value === "number"),
  },
  pinned: {
    kind: "set",
    required: false,
    schema: schemaAccepting<ReadonlySet<string>>(() => true),
  },
  search: {
    kind: "json",
    required: false,
    schema: schemaAccepting<string>((value) => typeof value === "string"),
  },
  widths: {
    kind: "map",
    required: true,
    schema: schemaAccepting<ReadonlyMap<string, number>>(
      (value) => value instanceof Map
    ),
  },
} as const satisfies ViewStateAxisSpecs<ExampleViewState>;

const codec = createViewStateCodec<ExampleViewState>(EXAMPLE_AXES);

function exampleView(): ExampleViewState {
  return {
    columnIds: new Set(["name", "owner"]),
    page: 2,
    widths: new Map([["name", 240]]),
  };
}

describe("createViewStateCodec — the compile-time completeness guard", () => {
  it("refuses an axis table that does not name every field of the state", () => {
    // The single property ISS-9447 D2 adopted this module for, and the one M1
    // had to carry across the generalization. The `@ts-expect-error` below IS
    // the assertion: if an axis table missing a field ever compiles, the
    // directive has nothing to suppress and `tsc` fails on it. Checked by
    // `pnpm turbo typecheck --filter=@closedloop-ai/design-system` (this package's
    // tsconfig includes `**/*.ts`), never by the runtime assertion below.
    //
    // The directive sits on the closing line because that is where a
    // `satisfies` mismatch is reported — put it above the opening brace and it
    // suppresses nothing, which reads as a passing proof of the wrong thing.
    const incomplete = {
      columnIds: {
        kind: "set",
        required: true,
        schema: schemaAccepting<ReadonlySet<string>>(
          (value) => value instanceof Set
        ),
      },
      page: {
        kind: "json",
        required: true,
        schema: schemaAccepting<number>((value) => typeof value === "number"),
      },
      // @ts-expect-error — `widths` and `search` are undeclared.
    } as const satisfies ViewStateAxisSpecs<ExampleViewState>;

    // Keeps the binding used, so the case fails on the type directive above
    // rather than on an unused-variable rule that would pass for the wrong
    // reason.
    expect(Object.keys(incomplete)).toEqual(["columnIds", "page"]);
  });
});

describe("createViewStateCodec — the round trip", () => {
  it("carries Set and Map axes through JSON, which a raw stringify does not", () => {
    const view = exampleView();

    const restored = codec.deserialize(
      JSON.parse(JSON.stringify(codec.serialize(view)))
    );

    expect(restored?.columnIds).toEqual(new Set(["name", "owner"]));
    expect(restored?.widths).toEqual(new Map([["name", 240]]));
    // The defect the codec exists for: the same state stringified directly
    // loses both collections to `{}` and nothing throws.
    const raw = JSON.parse(JSON.stringify(view));
    expect(raw.columnIds).toEqual({});
    expect(raw.widths).toEqual({});
  });

  it("omits an axis the state carries as undefined rather than writing it", () => {
    // Absent, empty and applied are three different answers on an optional
    // axis, so writing the key at all would collapse two of them. Carried as an
    // EXPLICIT `undefined`: a state that simply lacks the key has no key to
    // omit, so asserting on that would pass under any implementation.
    const serialized = codec.serialize({ ...exampleView(), search: undefined });

    expect(Object.hasOwn(serialized, "search")).toBe(false);
  });
});

describe("PRD-721 AC-5 / DT-FS-11 view-state untrusted input", () => {
  it("refuses a Set axis stored as the plain {} a raw stringify wrote, on the declared kind alone", () => {
    // Decoded against the DECLARED kind, never the stored shape. Inferred by
    // shape, `{}` is a perfectly good object and would restore as "nothing
    // selected" — a silently wrong view instead of the null the contract
    // promises.
    //
    // Driven through `pinned`, whose schema accepts anything, because every
    // other axis's schema would reject `{}` on its own and the case would then
    // pass with the kind rule deleted.
    const stored = { ...codec.serialize(exampleView()), pinned: {} };

    expect(codec.deserialize(stored)).toBeNull();
  });

  it("refuses a payload missing a required axis, but restores one missing an optional axis", () => {
    const complete = codec.serialize(exampleView());
    const { page, ...missingRequired } = complete;

    expect(codec.deserialize(missingRequired)).toBeNull();
    // Paired deliberately: alone, the first assertion is satisfied by a codec
    // that refuses every incomplete payload, which would discard every view
    // saved before an optional axis existed.
    expect(codec.deserialize(complete)?.page).toBe(page);
  });

  it("refuses a declared axis whose value its schema rejects", () => {
    expect(
      codec.deserialize({ ...codec.serialize(exampleView()), page: "two" })
    ).toBeNull();
  });

  it("carries an axis this build does not name across the round trip", () => {
    // Version skew: two shells ship the same state on different cadences, so
    // stripping the axes only the newer build names would delete a reader's
    // saved filter the first time the older build re-saved their view.
    const restored = codec.deserialize({
      ...codec.serialize(exampleView()),
      groupBy: { field: "repo" },
    });

    expect(restored).not.toBeNull();
    expect(Reflect.get(restored as object, "groupBy")).toEqual({
      field: "repo",
    });
  });

  it("drops a malformed tag on an axis this build does not name, restoring every declared axis", () => {
    // DELIBERATE BEHAVIOUR CHANGE (ISS-9447 M2): this asserted `toBeNull()`.
    // M1 pinned that as CURRENT behaviour rather than endorsing it, and named
    // M2 as the owner of whether nulling was right under the criterion that
    // malformed, missing, unknown and version-skewed values degrade to
    // deterministic defaults without discarding a layout the reader never
    // chose. Nulling failed that criterion outright: an older shell reading a
    // newer shell's record threw away the reader's whole saved layout over a
    // field it does not even know exists.
    //
    // Dropped rather than carried, for the reason `partitionPreservedColumnIds`
    // already gives for a malformed width: a well-formed unknown value is
    // version skew and rides across (the case above), a malformed one is
    // corrupt data, and carrying it would hand the corruption straight back to
    // the build that DOES name the axis.
    const restored = codec.deserialize({
      ...codec.serialize(exampleView()),
      axisFromANewerBuild: { "@@map": "not-an-array" },
    });

    expect(restored).not.toBeNull();
    // Not vacuous: the declared axes really are restored, not merely non-null.
    expect(restored?.page).toBe(2);
    expect(restored?.columnIds).toEqual(new Set(["name", "owner"]));
    // The corrupt axis is gone rather than round-tripped back to storage.
    expect(Object.hasOwn(restored as object, "axisFromANewerBuild")).toBe(
      false
    );
  });

  it("still refuses a malformed tag on an axis this build DOES declare", () => {
    // The other side of the split, and what stops the case above from reading
    // as "malformed input is tolerated". A declared axis is one the caller
    // asked for and will use, so half-restoring it hands back a silently wrong
    // view; only an axis this build cannot name, cannot judge and cannot use is
    // dropped.
    expect(
      codec.deserialize({
        ...codec.serialize(exampleView()),
        widths: { "@@map": "not-an-array" },
      })
    ).toBeNull();
  });

  it("never lets a stored __proto__ key reach the restored object", () => {
    // `JSON.parse` makes `__proto__` an OWN data property (an object literal
    // would not), so the key really does reach the restore loop.
    const restored = codec.deserialize(
      JSON.parse(
        '{"__proto__":{"polluted":true},"page":1,"columnIds":{"@@set":[]},"widths":{"@@map":[]}}'
      )
    );

    expect(restored).not.toBeNull();
    // Asserted through what a CALLER would see: a plain assignment under that
    // key sets the restored object's prototype, so an axis nobody stored comes
    // back with a value. Checking only for an own `__proto__` key would pass
    // either way and prove nothing.
    expect(Reflect.get(restored as object, "polluted")).toBeUndefined();
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
  });
});

/**
 * ISS-9480 — the model revision stamped on the envelope.
 *
 * A separate state from `ExampleViewState` on purpose: the point of a revision
 * is that an axis's VALUE VOCABULARY changed, so the fixture needs an axis whose
 * current schema genuinely rejects what the older build wrote. Reusing the
 * permissive example axes would let every case pass with the migration removed.
 */
type RevisionedViewState = {
  dateRange: string;
  page: number;
  search?: string;
};

/** The spellings revision 1 accepts. Revision 0 wrote `7d` / `30d`; `all` is shared. */
const V1_DATE_RANGES = ["last7Days", "last30Days", "all"];

const REVISIONED_AXES = {
  dateRange: {
    kind: "json",
    required: true,
    schema: schemaAccepting<string>(
      (value) => typeof value === "string" && V1_DATE_RANGES.includes(value)
    ),
  },
  page: {
    kind: "json",
    required: true,
    schema: schemaAccepting<number>((value) => typeof value === "number"),
  },
  search: {
    kind: "json",
    required: false,
    schema: schemaAccepting<string>((value) => typeof value === "string"),
  },
} as const satisfies ViewStateAxisSpecs<RevisionedViewState>;

const CURRENT_REVISION = 1;

const LEGACY_DATE_RANGE_SPELLINGS: Record<string, string> = {
  "7d": "last7Days",
  "30d": "last30Days",
};

/** Counts migration runs, so a case can assert one did NOT happen. */
let migrateCalls: { from: number }[] = [];

function revisionedCodec(migrate?: ViewStateRevisionSpec["migrate"]) {
  return createViewStateCodec<RevisionedViewState>(REVISIONED_AXES, {
    current: CURRENT_REVISION,
    migrate:
      migrate ??
      ((payload, from) => {
        migrateCalls.push({ from });
        const stored = payload.dateRange;
        const respelled =
          typeof stored === "string"
            ? LEGACY_DATE_RANGE_SPELLINGS[stored]
            : undefined;
        return respelled === undefined
          ? payload
          : { ...payload, dateRange: respelled };
      }),
  });
}

/** The same axes with NO revision spec — the build this ticket is fixing. */
const unversionedCodec =
  createViewStateCodec<RevisionedViewState>(REVISIONED_AXES);

/** Revision 2 respells revision 1's `last7Days` as `past7Days`; `all` is shared. */
const V2_DATE_RANGES = ["past7Days", "past30Days", "all"];

const V2_DATE_RANGE_SPELLINGS: Record<string, string> = {
  last7Days: "past7Days",
  last30Days: "past30Days",
};

/** A build one revision NEWER than `revisionedCodec`. */
const newerBuild = createViewStateCodec<RevisionedViewState>(
  {
    ...REVISIONED_AXES,
    dateRange: {
      kind: "json",
      required: true,
      schema: schemaAccepting<string>(
        (value) => typeof value === "string" && V2_DATE_RANGES.includes(value)
      ),
    },
  },
  {
    current: CURRENT_REVISION + 1,
    migrate: (payload) => {
      const stored = payload.dateRange;
      const respelled =
        typeof stored === "string"
          ? V2_DATE_RANGE_SPELLINGS[stored]
          : undefined;
      return respelled === undefined
        ? payload
        : { ...payload, dateRange: respelled };
    },
  }
);

/** A view as revision 0 stored it: no stamp, and the old date spelling. */
const LEGACY_PAYLOAD = { dateRange: "7d", page: 3 };

describe("PRD-721 AC-5 / DT-FS-11 model revisions (ISS-9480)", () => {
  beforeEach(() => {
    migrateCalls = [];
  });

  it("restores a view written under an older revision that the unversioned codec loses whole", () => {
    // The defect, and its own positive control in one case. The unversioned
    // codec is not a second implementation — it is what ships today, and it
    // refuses the ENTIRE payload (not just the respelled axis) because a
    // declared axis whose schema rejects its value fails the whole restore. So
    // the reader loses `page` too, which is the "a stored view survives a model
    // revision" claim failing.
    expect(unversionedCodec.deserialize(LEGACY_PAYLOAD)).toBeNull();

    const restored = revisionedCodec().deserialize(LEGACY_PAYLOAD);

    expect(restored).toEqual({ dateRange: "last7Days", page: 3 });
    expect(migrateCalls).toEqual([{ from: 0 }]);
  });

  it("stamps this build's revision when it serializes", () => {
    const serialized = revisionedCodec().serialize({
      dateRange: "last7Days",
      page: 1,
    });

    expect(serialized["@@rev"]).toBe(CURRENT_REVISION);
  });

  it("passes a valid newer revision through without migration", () => {
    const fromNewerBuild = { "@@rev": 5, dateRange: "last7Days", page: 1 };

    expect(revisionedCodec().deserialize(fromNewerBuild)).not.toBeNull();
    expect(migrateCalls).toEqual([]);
  });

  it("stamps its own revision over a newer build's view, so an edit it writes is migrated rather than refused", () => {
    // tamsinb, #7808. Carried verbatim, the newer stamp vouched for a value
    // this build wrote in ITS spelling: the newer build skipped the migration,
    // refused `last7Days`, and restored the whole view as null.
    const fromNewerBuild = newerBuild.serialize({ dateRange: "all", page: 1 });

    const restored = revisionedCodec().deserialize(fromNewerBuild);
    const edited = revisionedCodec().serialize({
      ...(restored as RevisionedViewState),
      dateRange: "last7Days",
    });

    expect(newerBuild.deserialize(edited)).toEqual({
      dateRange: "past7Days",
      page: 1,
    });
    expect(edited["@@rev"]).toBe(CURRENT_REVISION);
    expect(restored).toEqual({ dateRange: "all", page: 1 });
  });

  it("refuses a payload whose stamp is not a revision, rather than reading it as legacy", () => {
    // Each of these would otherwise be coerced toward 0 and "migrated" into a
    // shape the payload never had — fabricated data from corrupt state.
    for (const stamp of ["banana", -1, 1.5, null, Number.NaN]) {
      expect(
        revisionedCodec().deserialize({ ...LEGACY_PAYLOAD, "@@rev": stamp })
      ).toBeNull();
    }
  });

  it("restores as no-saved-view when a migration throws, rather than into a render", () => {
    const throwing = revisionedCodec(() => {
      throw new Error("bad stored shape");
    });

    expect(throwing.deserialize(LEGACY_PAYLOAD)).toBeNull();
  });

  it("leaves the caller's payload untouched when a migration rewrites it and then throws", () => {
    // Mutates BEFORE it throws: a side-effect-free throw could not tell a
    // cloned input from the caller's own object.
    const payload = { dateRange: "7d", page: 3 };
    const throwing = revisionedCodec((migrating) => {
      migrating.dateRange = "last7Days";
      throw new Error("bad stored shape");
    });

    expect(throwing.deserialize(payload)).toBeNull();
    expect(payload).toEqual({ dateRange: "7d", page: 3 });
  });

  it("writes no stamp at the legacy revision, as the link carrier elides it", () => {
    const atLegacy = createViewStateCodec<RevisionedViewState>(
      REVISIONED_AXES,
      { current: LEGACY_VIEW_STATE_REVISION, migrate: (payload) => payload }
    );

    expect(
      Object.hasOwn(atLegacy.serialize({ dateRange: "all", page: 1 }), "@@rev")
    ).toBe(false);
  });

  it("never hands the stamp back in the restored state, at this build's revision or above it", () => {
    for (const stamp of [CURRENT_REVISION, 5]) {
      const restored = revisionedCodec().deserialize({
        "@@rev": stamp,
        dateRange: "last7Days",
        page: 1,
      });

      expect(Object.hasOwn(restored as object, "@@rev")).toBe(false);
    }
  });

  it("omits an absent optional axis from the versioned envelope rather than writing null", () => {
    // Root `AGENTS.md`: an absent optional field is OMITTED across a versioned
    // boundary, never serialized as `null` — a receiving build reads `null` as
    // "explicitly nothing", which is a different answer from "not stored".
    const serialized = revisionedCodec().serialize({
      dateRange: "last7Days",
      page: 1,
      search: undefined,
    });

    expect(Object.hasOwn(serialized, "search")).toBe(false);
    expect(serialized["@@rev"]).toBe(CURRENT_REVISION);
  });

  it("writes no stamp from a build that does not version, even over a stamped view", () => {
    // It writes revision-0 spellings, so the build that versions has to read
    // the result as legacy and migrate it, not trust a stamp it never wrote.
    const restored = unversionedCodec.deserialize({
      "@@rev": CURRENT_REVISION,
      dateRange: "all",
      page: 1,
    });
    const reserialized = unversionedCodec.serialize(
      restored as RevisionedViewState
    );

    expect(Object.hasOwn(reserialized, "@@rev")).toBe(false);
    expect(revisionedCodec().deserialize(reserialized)).toEqual({
      dateRange: "all",
      page: 1,
    });
    expect(migrateCalls).toEqual([{ from: 0 }]);
  });
});
