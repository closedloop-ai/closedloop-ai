import { afterEach, describe, expect, it } from "vitest";
import {
  anchorListQueryWindowBound,
  compareListQueryText,
  LIST_QUERY_COLLATED_LOCALE,
  LIST_QUERY_INSTANT_ANCHOR,
  LIST_QUERY_TEXT_COLLATION,
  ListQueryInstantAnchor,
  ListQueryInstantRole,
  ListQueryTextOrdering,
  listQueryWindowBoundMs,
} from "../list-query-ordering-semantics";

/**
 * Case, accents, the three separators and a digit run — the shapes where the
 * root collation and UTF-16 order actually disagree. Every expectation below
 * spells the resulting sequence out as a literal rather than deriving it from
 * the comparator under test.
 */
const ADVERSARIAL = [
  "Z",
  "a",
  "ä",
  "A",
  "z",
  "b-c",
  "b_c",
  "b/c",
  "item2",
  "item10",
] as const;

const ORIGINAL_TZ = Object.hasOwn(process.env, "TZ") ? process.env.TZ : null;

function restoreTz(): void {
  if (ORIGINAL_TZ === null) {
    Reflect.deleteProperty(process.env, "TZ");
    return;
  }
  process.env.TZ = ORIGINAL_TZ;
}

describe("list query text ordering (ISS-9585)", () => {
  it("collates prose in root order, which UTF-16 order does not reproduce", () => {
    expect(
      [...ADVERSARIAL].sort((left, right) =>
        compareListQueryText(left, right, ListQueryTextOrdering.Collated)
      )
    ).toEqual([
      "a",
      "A",
      "ä",
      "b_c",
      "b-c",
      "b/c",
      "item10",
      "item2",
      "z",
      "Z",
    ]);
    expect(
      [...ADVERSARIAL].sort((left, right) =>
        compareListQueryText(left, right, ListQueryTextOrdering.CodeUnit)
      )
    ).toEqual([
      "A",
      "Z",
      "a",
      "b-c",
      "b/c",
      "b_c",
      "item10",
      "item2",
      "z",
      "ä",
    ]);
  });

  it("separates the two classes on a pair that differs only by case", () => {
    expect(
      compareListQueryText("a", "B", ListQueryTextOrdering.Collated)
    ).toBeLessThan(0);
    expect(
      compareListQueryText("a", "B", ListQueryTextOrdering.CodeUnit)
    ).toBeGreaterThan(0);
  });

  it("separates them again on a pair that differs only by accent", () => {
    expect(
      compareListQueryText("ä", "z", ListQueryTextOrdering.Collated)
    ).toBeLessThan(0);
    expect(
      compareListQueryText("ä", "z", ListQueryTextOrdering.CodeUnit)
    ).toBeGreaterThan(0);
  });

  it("reports equal strings as equal under both classes", () => {
    expect(compareListQueryText("a", "a", ListQueryTextOrdering.Collated)).toBe(
      0
    );
    expect(compareListQueryText("a", "a", ListQueryTextOrdering.CodeUnit)).toBe(
      0
    );
  });

  /**
   * The mutation this kills is swapping the pin to the obvious spelling of
   * "root". `"und"` and `"zxx"` are read as "no preference", so Intl answers
   * with the HOST's locale and the pin silently stops pinning — on an en-US
   * runner every ordering assertion above would still pass.
   */
  it("pins a locale Intl does not replace with the host's", () => {
    expect(
      new Intl.Collator(LIST_QUERY_COLLATED_LOCALE).resolvedOptions().locale
    ).toBe(LIST_QUERY_COLLATED_LOCALE);
    expect(new Intl.Collator("und").resolvedOptions().locale).not.toBe("und");
  });

  it("names one Postgres collation per class", () => {
    expect(LIST_QUERY_TEXT_COLLATION).toEqual({
      [ListQueryTextOrdering.Collated]: "und-x-icu",
      [ListQueryTextOrdering.CodeUnit]: "C",
      [ListQueryTextOrdering.Natural]: "en-u-kn",
    });
  });

  it("reads a digit run as a magnitude under Natural, and as text under CodeUnit", () => {
    // ISS-12636 added this class for the artifact slug, where the surfaces that
    // sort it already compare digit runs numerically. The two sequences are
    // spelled out rather than derived, and they are each other's reverse on the
    // pair that matters, so a class that silently resolved to the other
    // comparator fails here.
    const slugs = ["ISS-10", "ISS-100", "ISS-2", "ISS-9"];

    expect(
      [...slugs].sort((left, right) =>
        compareListQueryText(left, right, ListQueryTextOrdering.Natural)
      )
    ).toEqual(["ISS-2", "ISS-9", "ISS-10", "ISS-100"]);
    expect(
      [...slugs].sort((left, right) =>
        compareListQueryText(left, right, ListQueryTextOrdering.CodeUnit)
      )
    ).toEqual(["ISS-10", "ISS-100", "ISS-2", "ISS-9"]);
  });

  it("pins Natural to a locale Intl does not replace with the host's", () => {
    // Same hazard `LIST_QUERY_COLLATED_LOCALE` records for the collated class:
    // a numeric collator built on "und" resolves to the host locale, so the
    // numeric tailoring alone does not make the ordering host-independent.
    expect(
      new Intl.Collator(LIST_QUERY_COLLATED_LOCALE, {
        numeric: true,
      }).resolvedOptions().locale
    ).toBe(LIST_QUERY_COLLATED_LOCALE);
  });
});

describe("list query instant anchoring (ISS-9585)", () => {
  afterEach(restoreTz);

  it("anchors a window bound absolutely and a bucket label to the viewer", () => {
    expect(LIST_QUERY_INSTANT_ANCHOR).toEqual({
      [ListQueryInstantRole.WindowBound]: ListQueryInstantAnchor.Utc,
      [ListQueryInstantRole.BucketLabel]: ListQueryInstantAnchor.Viewer,
    });
  });

  it("reads a zone-less bound as the same instant on every host", () => {
    const bound = "2026-09-25T00:00:00";
    const raw: number[] = [];
    const anchored: number[] = [];
    for (const zone of ["UTC", "America/Chicago", "Asia/Tokyo"]) {
      process.env.TZ = zone;
      raw.push(Date.parse(bound));
      anchored.push(listQueryWindowBoundMs(bound));
    }
    // The divergence is real on this runner, so the agreement below is a
    // property of the helper rather than of a runner that has only one clock.
    expect(new Set(raw).size).toBe(3);
    expect(anchored).toEqual([
      Date.UTC(2026, 8, 25),
      Date.UTC(2026, 8, 25),
      Date.UTC(2026, 8, 25),
    ]);
  });

  it("leaves every form that already names its own instant alone", () => {
    expect(anchorListQueryWindowBound("2026-09-25")).toBe("2026-09-25");
    expect(anchorListQueryWindowBound("2026-09-25T00:00:00Z")).toBe(
      "2026-09-25T00:00:00Z"
    );
    expect(anchorListQueryWindowBound("2026-09-25T00:00:00+02:00")).toBe(
      "2026-09-25T00:00:00+02:00"
    );
    expect(listQueryWindowBoundMs("2026-09-25T00:00:00+02:00")).toBe(
      Date.UTC(2026, 8, 24, 22)
    );
  });

  it("anchors the zone-less forms a caller can actually send", () => {
    expect(anchorListQueryWindowBound("2026-09-25T00:00")).toBe(
      "2026-09-25T00:00Z"
    );
    expect(anchorListQueryWindowBound("2026-09-25T00:00:00.500")).toBe(
      "2026-09-25T00:00:00.500Z"
    );
    expect(anchorListQueryWindowBound("2026-09-25 00:00:00")).toBe(
      "2026-09-25 00:00:00Z"
    );
  });

  /**
   * tamsinb, PR #7954: the designator V8 reads is not the one the grammar
   * writes. A lowercase `t` reaches the implementation-defined fallback parser,
   * which anchors to the host, so an uppercase-only pattern let a host-dependent
   * bound through the very function that exists to remove the host.
   */
  it("anchors a lowercase-t bound, which Date still reads against the host", () => {
    const bound = "2026-09-25t00:00:00";
    const raw: number[] = [];

    for (const zone of ["UTC", "America/Chicago", "Asia/Tokyo"]) {
      process.env.TZ = zone;
      raw.push(Date.parse(bound));
    }

    expect(new Set(raw).size).toBe(3);
    expect(anchorListQueryWindowBound(bound)).toBe("2026-09-25t00:00:00Z");
    expect(listQueryWindowBoundMs(bound)).toBe(Date.UTC(2026, 8, 25));
  });

  /**
   * The scope this module does NOT cover, pinned as a fact rather than left as a
   * claim in a docstring (ISS-11421). V8's fallback parser reads these against
   * the host too; they are left alone because narrowing what the request
   * boundary ACCEPTS is a contract decision, not an ordering one.
   */
  it("leaves a non-ISO form host-dependent, pending ISS-11421", () => {
    for (const bound of ["2026/09/25", "2026/09/25 00:00", "Sep 25 2026"]) {
      expect(anchorListQueryWindowBound(bound)).toBe(bound);

      const parsed: number[] = [];
      for (const zone of ["UTC", "America/Chicago"]) {
        process.env.TZ = zone;
        parsed.push(listQueryWindowBoundMs(bound));
      }
      expect(new Set(parsed).size).toBe(2);
    }
  });

  it("hands a value it cannot read on untouched, refusing nothing", () => {
    expect(anchorListQueryWindowBound("garbage")).toBe("garbage");
    expect(anchorListQueryWindowBound(undefined)).toBeUndefined();
    expect(listQueryWindowBoundMs("garbage")).toBeNaN();
  });
});
