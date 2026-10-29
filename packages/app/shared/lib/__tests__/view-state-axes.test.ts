import { describe, expect, it } from "vitest";
import {
  advanceViewStateVersions,
  legacyViewStateVersions,
  PERSISTED_VERSION_MARKER_SCHEMA,
  PERSISTED_VIEW_STATE_VERSIONS_SCHEMA,
  resolveViewStateVersions,
  VIEW_STATE_AXIS_UNUSED,
  VIEW_STATE_MAX_VERSION,
  VIEW_STATE_UNVERSIONED,
  ViewStateAxis,
  type ViewStateLegacyMirrors,
  viewStateVersionOf,
} from "../view-state-axes";

type TestExtras = { sortVersion: number };

const TEST_MIRRORS = {
  [ViewStateAxis.ColumnOrder]: VIEW_STATE_AXIS_UNUSED,
  [ViewStateAxis.HiddenColumns]: VIEW_STATE_AXIS_UNUSED,
  [ViewStateAxis.Sort]: "sortVersion",
} as const satisfies ViewStateLegacyMirrors<TestExtras>;

/**
 * ISS-9447 M2 — the per-axis version envelope.
 *
 * Division of labour: this lane owns the envelope's own rules. The four schema
 * fragments this module also holds are covered where they are consumed — the
 * Sessions, Agent Components and Branches suites each already drive their own
 * parser over malformed input — so only the fragment whose contract is NEW here
 * (the version marker) is pinned directly.
 */

describe("resolveViewStateVersions", () => {
  it("reads a legacy layout that carries no envelope at all", () => {
    // Every view stored before M2. The whole additive-superset claim rests on
    // this: the loose markers are still the only thing such a record carries.
    const resolved = resolveViewStateVersions(
      { [ViewStateAxis.ColumnOrder]: 1, [ViewStateAxis.HiddenColumns]: 3 },
      {}
    );

    expect(viewStateVersionOf(resolved, ViewStateAxis.ColumnOrder)).toBe(1);
    expect(viewStateVersionOf(resolved, ViewStateAxis.HiddenColumns)).toBe(3);
  });

  it("takes the envelope's answer where the two disagree", () => {
    // They are written together from one value, so a disagreement can only mean
    // the envelope is the newer statement.
    const resolved = resolveViewStateVersions(
      { [ViewStateAxis.HiddenColumns]: 3 },
      { [ViewStateAxis.HiddenColumns]: 7 }
    );

    expect(viewStateVersionOf(resolved, ViewStateAxis.HiddenColumns)).toBe(7);
  });

  it("carries a stamp for an axis this build does not name", () => {
    // Version skew, the same rule the column ids follow: an axis only a newer
    // build knows about must survive an older build's read so the older build's
    // write can put it back.
    const resolved = resolveViewStateVersions(
      { [ViewStateAxis.Sort]: 1 },
      { axisFromANewerBuild: 4 }
    );

    expect(resolved).toEqual({ axisFromANewerBuild: 4, sort: 1 });
  });

  it("never lets a stored __proto__ key reach the resolved map", () => {
    // `JSON.parse` makes `__proto__` an OWN data property, so the key really
    // does reach the merge loop.
    const stored: unknown = JSON.parse('{"__proto__":{"polluted":7},"sort":1}');
    const resolved = resolveViewStateVersions(
      {},
      stored as Record<string, number>
    );

    expect(Object.hasOwn(resolved, "__proto__")).toBe(false);
    expect(
      Reflect.get(Object.getPrototypeOf(resolved) as object, "polluted")
    ).toBeUndefined();
    expect(viewStateVersionOf(resolved, ViewStateAxis.Sort)).toBe(1);
  });
});

describe("viewStateVersionOf", () => {
  it("answers UNVERSIONED for an axis the view carries no stamp for", () => {
    // "Never migrated" is the safe direction: an absent stamp re-runs a repair
    // rather than skipping one.
    expect(viewStateVersionOf({}, ViewStateAxis.HiddenColumns)).toBe(
      VIEW_STATE_UNVERSIONED
    );
  });
});

describe("PERSISTED_VIEW_STATE_VERSIONS_SCHEMA", () => {
  it("drops a corrupt entry without costing the stamps beside it", () => {
    const parsed = PERSISTED_VIEW_STATE_VERSIONS_SCHEMA.parse({
      columnOrder: 1,
      hiddenColumns: "three",
      sort: -1,
    });

    expect(parsed).toEqual({ columnOrder: 1 });
  });

  it("degrades a non-object envelope to no stamps rather than failing", () => {
    // Losing the reader's whole saved view over a corrupt envelope would cost
    // far more than re-running a repair that is idempotent by construction.
    expect(PERSISTED_VIEW_STATE_VERSIONS_SCHEMA.parse("nope")).toEqual({});
    expect(PERSISTED_VIEW_STATE_VERSIONS_SCHEMA.parse(undefined)).toEqual({});
  });
});

describe("PERSISTED_VERSION_MARKER_SCHEMA", () => {
  it("keeps a non-negative integer and degrades anything else to UNVERSIONED", () => {
    expect(PERSISTED_VERSION_MARKER_SCHEMA.parse(3)).toBe(3);
    expect(PERSISTED_VERSION_MARKER_SCHEMA.parse(0)).toBe(0);
    expect(PERSISTED_VERSION_MARKER_SCHEMA.parse(-1)).toBe(
      VIEW_STATE_UNVERSIONED
    );
    expect(PERSISTED_VERSION_MARKER_SCHEMA.parse(1.5)).toBe(
      VIEW_STATE_UNVERSIONED
    );
    expect(PERSISTED_VERSION_MARKER_SCHEMA.parse("3")).toBe(
      VIEW_STATE_UNVERSIONED
    );
  });

  it("degrades an implausibly LARGE integer to UNVERSIONED", () => {
    // The half of the impossible set that actually reaches storage: negative
    // and fractional are caught above, but a `Date.now()`-shaped stamp is a
    // valid non-negative integer. A future stamp is kept verbatim rather than
    // lowered (ISS-9447 M3), so without the ceiling that value would sit above
    // every version its axis will ever reach and permanently skip that record's
    // one-time repairs.
    expect(PERSISTED_VERSION_MARKER_SCHEMA.parse(Date.now())).toBe(
      VIEW_STATE_UNVERSIONED
    );
    expect(
      PERSISTED_VERSION_MARKER_SCHEMA.parse(VIEW_STATE_MAX_VERSION + 1)
    ).toBe(VIEW_STATE_UNVERSIONED);
    expect(PERSISTED_VERSION_MARKER_SCHEMA.parse(Number.MAX_SAFE_INTEGER)).toBe(
      VIEW_STATE_UNVERSIONED
    );
    // The bound itself is still a stamp — a ceiling that rejected its own limit
    // would be a different (off-by-one) contract than the one documented.
    expect(PERSISTED_VERSION_MARKER_SCHEMA.parse(VIEW_STATE_MAX_VERSION)).toBe(
      VIEW_STATE_MAX_VERSION
    );
  });

  it("drops an over-ceiling envelope entry without costing the stamps beside it", () => {
    // The envelope reads the same predicate, so the ceiling has to reach it too
    // — the loose marker and the canonical entry describe the same axis.
    const parsed = PERSISTED_VIEW_STATE_VERSIONS_SCHEMA.parse({
      columnOrder: 1,
      hiddenColumns: VIEW_STATE_MAX_VERSION + 1,
    });

    expect(parsed).toEqual({ columnOrder: 1 });
  });
});

describe("legacyViewStateVersions", () => {
  it("maps only the axes the table gives a mirror field", () => {
    const legacy = legacyViewStateVersions(TEST_MIRRORS, { sortVersion: 4 });

    expect(legacy).toEqual({ [ViewStateAxis.Sort]: 4 });
  });
});

describe("advanceViewStateVersions", () => {
  it("lays this build's stamps over the record's and mirrors the result", () => {
    const advanced = advanceViewStateVersions(
      TEST_MIRRORS,
      { [ViewStateAxis.Sort]: 1 },
      { [ViewStateAxis.Sort]: 2 }
    );

    expect(advanced.versions).toEqual({ [ViewStateAxis.Sort]: 2 });
    // Derived from the envelope that was just built, which is what stops the
    // mirror and the envelope drifting apart.
    expect(advanced.mirrors).toEqual({ sortVersion: 2 });
  });

  it("carries a stamp for an axis only a NEWER build names", () => {
    const advanced = advanceViewStateVersions(
      TEST_MIRRORS,
      { [ViewStateAxis.Sort]: 1, rowDensity: 3 },
      { [ViewStateAxis.Sort]: 2 }
    );

    expect(advanced.versions).toEqual({
      [ViewStateAxis.Sort]: 2,
      rowDensity: 3,
    });
    // An axis this build cannot name has no mirror field to write it to, which
    // is exactly why an older build drops it — see the compile-time cases below.
    expect(advanced.mirrors).toEqual({ sortVersion: 2 });
  });
});

/**
 * ISS-9447: the mirror contract is a TYPE contract, so these three cases assert
 * with `@ts-expect-error` and the typecheck lane is what runs them. Each
 * directive sits on the line the compiler actually reports the error on;
 * removing any one of them fails `tsc` as an unused directive, which is what
 * makes a green typecheck evidence rather than a no-op.
 *
 * What they pin together: an axis cannot reach the persisted envelope unless
 * this surface has declared a legacy mirror field for it. That matters because
 * a build deployed before the envelope existed strips `viewStateVersions` on
 * parse and never re-emits it, so the mirror is the only channel that survives
 * a round trip through one — and an envelope-only axis would come back reading
 * as never-migrated and re-run every step.
 */
describe("ViewStateLegacyMirrors", () => {
  it("refuses a table that leaves an axis unanswered", () => {
    const incomplete = {
      [ViewStateAxis.Sort]: "sortVersion",
      // @ts-expect-error — every ViewStateAxis member must be answered here, so
      // adding an axis fails this typecheck until it names a mirror field or
      // states VIEW_STATE_AXIS_UNUSED.
    } as const satisfies ViewStateLegacyMirrors<TestExtras>;

    expect(incomplete[ViewStateAxis.Sort]).toBe("sortVersion");
  });

  it("refuses a mirror naming a field the extras type does not declare", () => {
    const misnamed = {
      [ViewStateAxis.ColumnOrder]: VIEW_STATE_AXIS_UNUSED,
      [ViewStateAxis.HiddenColumns]: VIEW_STATE_AXIS_UNUSED,
      // @ts-expect-error — the mirror has to be a real persisted field, so
      // "declare a mirror" cannot be satisfied with a name that is only prose.
      [ViewStateAxis.Sort]: "notAPersistedField",
    } as const satisfies ViewStateLegacyMirrors<TestExtras>;

    expect(misnamed[ViewStateAxis.Sort]).toBe("notAPersistedField");
  });

  it("refuses a stamp for an axis the table leaves unused", () => {
    const advanced = advanceViewStateVersions(
      TEST_MIRRORS,
      {},
      {
        [ViewStateAxis.Sort]: 2,
        // @ts-expect-error — ColumnOrder has no mirror on this table, so it cannot
        // be stamped: this is the step that makes an envelope-only axis
        // unshippable rather than merely discouraged.
        [ViewStateAxis.ColumnOrder]: 2,
      }
    );

    expect(advanced.mirrors).toEqual({ sortVersion: 2 });
  });
});
