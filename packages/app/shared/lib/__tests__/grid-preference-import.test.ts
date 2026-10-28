import { GRID_PREFERENCE_VALUE_MAX_BYTES } from "@repo/api/src/types/grid-preferences";
import { describe, expect, it } from "vitest";
import {
  canonicalJsonString,
  GridPreferenceImportSkip,
  isWithinGridPreferenceValueCap,
  parseJsonObject,
  planGridPreferenceAdoption,
} from "../grid-preference-import";

const LOCAL_VIEW = JSON.stringify({
  columnOrder: ["b", "a"],
  columnWidths: { a: 220 },
  hiddenColumns: ["c"],
  sortDir: "desc",
  sortKey: "date",
});

describe("planGridPreferenceAdoption", () => {
  it("adopts the server layout whenever the server holds one", () => {
    const plan = planGridPreferenceAdoption({
      localRaw: LOCAL_VIEW,
      remote: { revision: 4, status: "found", value: { sortKey: "name" } },
    });

    expect(plan).toEqual({
      kind: "adopt",
      serialized: JSON.stringify({ sortKey: "name" }),
    });
  });

  it("imports the local layout when the server holds none", () => {
    const plan = planGridPreferenceAdoption({
      localRaw: LOCAL_VIEW,
      remote: { status: "missing" },
    });

    expect(plan).toEqual({ kind: "import", value: JSON.parse(LOCAL_VIEW) });
  });

  /**
   * The idempotency contract, proved on the decision itself rather than on a
   * request count: run one, seed the row, then run two against the row run one
   * produced. The second run reaches `adopt`, which issues no write, and the
   * value it adopts is byte-identical to the value run one imported — the same
   * server state from running the adoption twice.
   *
   * COUNTERFACTUAL: make `planGridPreferenceAdoption` return an `import` plan
   * for a `found` remote (drop the first branch, or answer on `localRaw`
   * presence instead of on the remote state) and the second assertion fails —
   * the second run writes, and every later mount writes again.
   */
  it("is idempotent: the second run adopts what the first imported and writes nothing", () => {
    const first = planGridPreferenceAdoption({
      localRaw: LOCAL_VIEW,
      remote: { status: "missing" },
    });
    expect(first.kind).toBe("import");
    const imported = first.kind === "import" ? first.value : {};

    const second = planGridPreferenceAdoption({
      localRaw: LOCAL_VIEW,
      remote: { revision: 1, status: "found", value: imported },
    });

    expect(second.kind).toBe("adopt");
    expect(second.kind === "adopt" ? second.serialized : null).toBe(
      JSON.stringify(imported)
    );
  });

  it("carries an unknown axis and a future-build field into the import whole", () => {
    const localRaw = JSON.stringify({
      columnPins: { a: "left" },
      sortKey: "date",
      viewStateVersions: { columns: 9 },
    });

    const plan = planGridPreferenceAdoption({
      localRaw,
      remote: { status: "missing" },
    });

    expect(plan).toEqual({ kind: "import", value: JSON.parse(localRaw) });
  });

  it("skips rather than imports when there is nothing stored locally", () => {
    for (const localRaw of [null, ""]) {
      expect(
        planGridPreferenceAdoption({ localRaw, remote: { status: "missing" } })
      ).toEqual({
        kind: "skip",
        reason: GridPreferenceImportSkip.NoLocalView,
      });
    }
  });

  it.each([
    ["not json at all", "{not json"],
    ["a JSON array", "[1,2,3]"],
    ["a JSON scalar", '"just a string"'],
    ["a JSON null", "null"],
  ])("skips malformed local bytes: %s", (_label, localRaw) => {
    expect(
      planGridPreferenceAdoption({ localRaw, remote: { status: "missing" } })
    ).toEqual({
      kind: "skip",
      reason: GridPreferenceImportSkip.MalformedLocalView,
    });
  });

  /**
   * Daveth's 2026-09-11 decision forbids truncating during import, so a record
   * past the shared cap is left whole and local rather than trimmed to fit.
   */
  it("skips an oversize local record instead of truncating it", () => {
    const oversize = JSON.stringify({
      note: "x".repeat(GRID_PREFERENCE_VALUE_MAX_BYTES),
    });

    expect(
      planGridPreferenceAdoption({
        localRaw: oversize,
        remote: { status: "missing" },
      })
    ).toEqual({
      kind: "skip",
      reason: GridPreferenceImportSkip.OversizeLocalView,
    });
  });

  /**
   * The cap belongs to the SERVER, so it is measured on the body the request
   * would carry — `JSON.stringify(value)` — not on the bytes as they sit in
   * `localStorage`. A record written by a build that pretty-printed, or one
   * whose escapes are longer on disk than in a re-serialization, is well past
   * the cap on disk and well inside it on the wire.
   *
   * COUNTERFACTUAL: measure `input.localRaw` instead (how it was first written)
   * and this record is skipped as oversize, so the plan is `skip` and the
   * assertion fails — a layout the server would have accepted, stranded.
   */
  it("imports a record that is oversize on disk but fits the request body", () => {
    // Many short keys, so indentation — not content — is what crosses the cap.
    const value: Record<string, number> = {};
    for (let index = 0; index < 5000; index += 1) {
      value[`k${String(index).padStart(4, "0")}`] = 1;
    }
    const prettyPrinted = JSON.stringify(value, null, 4);

    expect(prettyPrinted.length).toBeGreaterThan(
      GRID_PREFERENCE_VALUE_MAX_BYTES
    );
    expect(JSON.stringify(value).length).toBeLessThan(
      GRID_PREFERENCE_VALUE_MAX_BYTES
    );
    expect(
      planGridPreferenceAdoption({
        localRaw: prettyPrinted,
        remote: { status: "missing" },
      })
    ).toEqual({ kind: "import", value });
  });
});

describe("parseJsonObject", () => {
  it("accepts a plain object and rejects every other JSON root", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject("[]")).toBeNull();
    expect(parseJsonObject("null")).toBeNull();
    expect(parseJsonObject("7")).toBeNull();
    expect(parseJsonObject("{")).toBeNull();
  });
});

describe("isWithinGridPreferenceValueCap", () => {
  it("measures UTF-8 bytes, not UTF-16 code units", () => {
    const multiByte = "é".repeat(GRID_PREFERENCE_VALUE_MAX_BYTES / 2 + 1);

    expect(multiByte.length).toBeLessThan(GRID_PREFERENCE_VALUE_MAX_BYTES);
    expect(isWithinGridPreferenceValueCap(multiByte)).toBe(false);
  });
});

describe("canonicalJsonString", () => {
  it("reports the same layout as the same string whatever the key order", () => {
    const written = JSON.stringify({ a: 1, nested: { x: 1, y: 2 }, z: [3, 4] });
    const echoed = JSON.stringify({ z: [3, 4], nested: { y: 2, x: 1 }, a: 1 });

    expect(written).not.toBe(echoed);
    expect(canonicalJsonString(written)).toBe(canonicalJsonString(echoed));
  });

  it("still distinguishes two different layouts", () => {
    expect(canonicalJsonString('{"sortKey":"date"}')).not.toBe(
      canonicalJsonString('{"sortKey":"name"}')
    );
  });

  it("preserves array order, which is a column order and not a key set", () => {
    expect(canonicalJsonString('{"columnOrder":["b","a"]}')).toBe(
      JSON.stringify({ columnOrder: ["b", "a"] })
    );
  });

  it("is null for bytes that are not a JSON object", () => {
    expect(canonicalJsonString("[1]")).toBeNull();
  });

  /**
   * `localStorage` and a server row are both writable by something other than
   * this hook, and `JSON.parse` turns `"__proto__"` into an OWN property.
   * Rebuilding the record into a plain `{}` hands that key to the prototype
   * setter instead of keeping it, so the field disappears from the canonical
   * form.
   *
   * COUNTERFACTUAL: build the accumulator with `{}` instead of
   * `Object.create(null)` (how it was first written) and both canonical strings
   * are `{"sortKey":"name"}` — two different layouts reported as the same one,
   * which is a write the hook then declines to make.
   */
  it("keeps a top-level __proto__ field instead of collapsing two layouts", () => {
    const first = canonicalJsonString('{"__proto__":{"z":1},"sortKey":"name"}');
    const second = canonicalJsonString(
      '{"__proto__":{"z":2},"sortKey":"name"}'
    );

    expect(first).not.toBe(second);
    expect(first).toContain('"__proto__"');
  });

  it("keeps a nested __proto__ field too", () => {
    // Written out rather than built from an object literal: `__proto__:` in a
    // literal IS the prototype setter, so the expectation would build the very
    // shape this asserts against.
    expect(canonicalJsonString('{"extras":{"__proto__":{"z":1}}}')).toBe(
      '{"extras":{"__proto__":{"z":1}}}'
    );
  });
});
