import { compareCountValues } from "@repo/design-system/components/ui/count-cell";
import { compareMonoIds } from "@repo/design-system/components/ui/mono-id-cell";
import { describe, expect, test } from "vitest";
import { type SortConfig, sortItems, sortTableData } from "../table-utils";

type Item = {
  id: string;
  name: string;
  count: number;
  updatedAt: string | Date;
};

const makeItems = (): Item[] => [
  {
    id: "1",
    name: "Banana",
    count: 3,
    updatedAt: "2024-06-01T10:00:00.000Z",
  },
  {
    id: "2",
    name: "apple",
    count: 1,
    updatedAt: "2024-01-15T08:00:00.000Z",
  },
  {
    id: "3",
    name: "Cherry",
    count: 2,
    updatedAt: "2024-03-20T12:00:00.000Z",
  },
];

describe("sortItems", () => {
  describe("string column type", () => {
    const config: SortConfig<Item> = { key: "name", columnType: "string" };

    test("sorts strings ascending (localeCompare order)", () => {
      const sorted = sortItems(makeItems(), config, "asc");
      expect(sorted.map((i) => i.id)).toEqual(["2", "1", "3"]);
    });

    test("sorts strings descending (reverse localeCompare order)", () => {
      const sorted = sortItems(makeItems(), config, "desc");
      expect(sorted.map((i) => i.id)).toEqual(["3", "1", "2"]);
    });
  });

  describe("number column type", () => {
    const config: SortConfig<Item> = { key: "count", columnType: "number" };

    test("sorts numbers ascending (smallest first)", () => {
      const sorted = sortItems(makeItems(), config, "asc");
      expect(sorted.map((i) => i.count)).toEqual([1, 2, 3]);
    });

    test("sorts numbers descending (largest first)", () => {
      const sorted = sortItems(makeItems(), config, "desc");
      expect(sorted.map((i) => i.count)).toEqual([3, 2, 1]);
    });
  });

  describe("date column type with ISO string values", () => {
    const config: SortConfig<Item> = { key: "updatedAt", columnType: "date" };

    test("sorts dates ascending (oldest first)", () => {
      const sorted = sortItems(makeItems(), config, "asc");
      expect(sorted.map((i) => i.id)).toEqual(["2", "3", "1"]);
    });

    test("sorts dates descending (newest first)", () => {
      const sorted = sortItems(makeItems(), config, "desc");
      expect(sorted.map((i) => i.id)).toEqual(["1", "3", "2"]);
    });
  });

  describe("date column type with Date object values", () => {
    type ItemWithDateObj = { id: string; ts: Date };
    const config: SortConfig<ItemWithDateObj> = {
      key: "ts",
      columnType: "date",
    };

    test("sorts Date objects ascending (oldest first)", () => {
      const items: ItemWithDateObj[] = [
        { id: "a", ts: new Date("2024-06-01") },
        { id: "b", ts: new Date("2024-01-01") },
        { id: "c", ts: new Date("2024-03-01") },
      ];
      const sorted = sortItems(items, config, "asc");
      expect(sorted.map((i) => i.id)).toEqual(["b", "c", "a"]);
    });

    test("sorts Date objects descending (newest first)", () => {
      const items: ItemWithDateObj[] = [
        { id: "a", ts: new Date("2024-06-01") },
        { id: "b", ts: new Date("2024-01-01") },
        { id: "c", ts: new Date("2024-03-01") },
      ];
      const sorted = sortItems(items, config, "desc");
      expect(sorted.map((i) => i.id)).toEqual(["a", "c", "b"]);
    });
  });

  describe("default (string fallback) when columnType is absent", () => {
    const config: SortConfig<Item> = { key: "name" };

    test("falls back to string comparison ascending", () => {
      const sorted = sortItems(makeItems(), config, "asc");
      expect(sorted.map((i) => i.id)).toEqual(["2", "1", "3"]);
    });
  });

  describe("null and undefined values (nulls-last)", () => {
    type NullableItem = { id: string; label: string | null | undefined };

    test("sorts null values to the end in ascending order", () => {
      const items: NullableItem[] = [
        { id: "a", label: "zebra" },
        { id: "b", label: null },
        { id: "c", label: "apple" },
      ];
      const config: SortConfig<NullableItem> = {
        key: "label",
        columnType: "string",
      };
      const sorted = sortItems(items, config, "asc");
      expect(sorted.map((i) => i.id)).toEqual(["c", "a", "b"]);
    });

    test("sorts null values to the end in descending order", () => {
      const items: NullableItem[] = [
        { id: "a", label: "zebra" },
        { id: "b", label: null },
        { id: "c", label: "apple" },
      ];
      const config: SortConfig<NullableItem> = {
        key: "label",
        columnType: "string",
      };
      const sorted = sortItems(items, config, "desc");
      expect(sorted.map((i) => i.id)).toEqual(["a", "c", "b"]);
    });

    test("sorts undefined values to the end", () => {
      const items: NullableItem[] = [
        { id: "a", label: "zebra" },
        { id: "b", label: undefined },
        { id: "c", label: "apple" },
      ];
      const config: SortConfig<NullableItem> = {
        key: "label",
        columnType: "string",
      };
      const sorted = sortItems(items, config, "asc");
      expect(sorted.map((i) => i.id)).toEqual(["c", "a", "b"]);
    });

    test("sorts null date values to the end", () => {
      type NullableDateItem = { id: string; date: Date | null };
      const items: NullableDateItem[] = [
        { id: "a", date: new Date("2024-06-01") },
        { id: "b", date: null },
        { id: "c", date: new Date("2024-01-01") },
      ];
      const config: SortConfig<NullableDateItem> = {
        key: "date",
        columnType: "date",
      };
      const sorted = sortItems(items, config, "asc");
      expect(sorted.map((i) => i.id)).toEqual(["c", "a", "b"]);
    });

    test("keeps both-null items in original order", () => {
      const items: NullableItem[] = [
        { id: "a", label: null },
        { id: "b", label: null },
        { id: "c", label: "apple" },
      ];
      const config: SortConfig<NullableItem> = {
        key: "label",
        columnType: "string",
      };
      const sorted = sortItems(items, config, "asc");
      expect(sorted.map((i) => i.id)).toEqual(["c", "a", "b"]);
    });
  });

  describe("custom comparator", () => {
    test("uses custom comparator and respects ascending direction", () => {
      // Sort by name length ascending
      const config: SortConfig<Item> = {
        key: "name",
        comparator: (a, b) => a.name.length - b.name.length,
      };
      const sorted = sortItems(makeItems(), config, "asc");
      // "apple"=5, "Banana"=6, "Cherry"=6 — apple first
      expect(sorted[0].id).toBe("2");
    });

    test("uses custom comparator and reverses for descending direction", () => {
      const config: SortConfig<Item> = {
        key: "name",
        comparator: (a, b) => a.name.length - b.name.length,
      };
      const sorted = sortItems(makeItems(), config, "desc");
      // Longest name first (Banana=6 or Cherry=6), apple last
      expect(sorted.at(-1)?.id).toBe("2");
    });
  });

  test("does not mutate the original array", () => {
    const items = makeItems();
    const original = items.map((i) => i.id);
    const config: SortConfig<Item> = { key: "count", columnType: "number" };
    sortItems(items, config, "asc");
    expect(items.map((i) => i.id)).toEqual(original);
  });

  test("returns empty array when given empty input", () => {
    const config: SortConfig<Item> = { key: "name", columnType: "string" };
    expect(sortItems([], config, "asc")).toEqual([]);
  });
});

describe("sortTableData", () => {
  type Row = { id: string; title: string; score: number };

  const configs: Record<string, SortConfig<Row>> = {
    title: { key: "title", columnType: "string" },
    score: { key: "score", columnType: "number" },
  };

  const rows: Row[] = [
    { id: "1", title: "Zebra", score: 10 },
    { id: "2", title: "Alpha", score: 5 },
    { id: "3", title: "Mango", score: 8 },
  ];

  test("returns original items unchanged when sortBy is null", () => {
    const result = sortTableData(rows, null, configs, "asc");
    expect(result).toBe(rows);
  });

  test("returns original items unchanged when sortBy key is not in configs", () => {
    const result = sortTableData(rows, "nonexistent", configs, "asc");
    expect(result).toBe(rows);
  });

  test("sorts by a valid string column ascending", () => {
    const result = sortTableData(rows, "title", configs, "asc");
    expect(result.map((r) => r.id)).toEqual(["2", "3", "1"]);
  });

  test("sorts by a valid string column descending", () => {
    const result = sortTableData(rows, "title", configs, "desc");
    expect(result.map((r) => r.id)).toEqual(["1", "3", "2"]);
  });

  test("sorts by a valid number column ascending", () => {
    const result = sortTableData(rows, "score", configs, "asc");
    expect(result.map((r) => r.score)).toEqual([5, 8, 10]);
  });

  test("sorts by a valid number column descending", () => {
    const result = sortTableData(rows, "score", configs, "desc");
    expect(result.map((r) => r.score)).toEqual([10, 8, 5]);
  });

  test("does not mutate the original array", () => {
    const original = rows.map((r) => r.id);
    sortTableData(rows, "score", configs, "asc");
    expect(rows.map((r) => r.id)).toEqual(original);
  });
});

/**
 * ISS-6384. `comparator` results are negated wholesale for a descending sort,
 * which flips a comparator's null placement along with its ordering. These
 * cover the escape hatch that lets a column pin unknown values to the bottom in
 * BOTH directions, and they drive the design-system cell comparators through
 * `sortTableData` — the path production actually takes — rather than calling
 * them directly with a direction the table never passes.
 */
describe("directed comparators through sortTableData", () => {
  type CountRow = { id: string; comments: number | null };
  type IdRow = { id: string; version: string | null };

  const countRows: CountRow[] = [
    { id: "unknown", comments: null },
    { id: "ten", comments: 10 },
    { id: "zero", comments: 0 },
    { id: "three", comments: 3 },
  ];

  const idRows: IdRow[] = [
    { id: "missing", version: null },
    { id: "patch", version: "v1.10" },
    { id: "older", version: "v1.9" },
  ];

  const countConfigs: Record<string, SortConfig<CountRow>> = {
    comments: {
      key: "comments",
      directedComparator: (a, b, direction) =>
        compareCountValues(a.comments, b.comments, direction),
    },
  };

  const idConfigs: Record<string, SortConfig<IdRow>> = {
    version: {
      key: "version",
      directedComparator: (a, b, direction) =>
        compareMonoIds(a.version, b.version, direction),
    },
  };

  test("keeps unknown counts at the bottom ascending AND descending", () => {
    expect(
      sortTableData(countRows, "comments", countConfigs, "asc").map((r) => r.id)
    ).toEqual(["zero", "three", "ten", "unknown"]);
    // The regression: a plain `comparator` reaches here negated, so "we don't
    // know" outranks the largest real count on the descending sort.
    expect(
      sortTableData(countRows, "comments", countConfigs, "desc").map(
        (r) => r.id
      )
    ).toEqual(["ten", "three", "zero", "unknown"]);
  });

  test("keeps missing identifiers at the bottom ascending AND descending", () => {
    expect(
      sortTableData(idRows, "version", idConfigs, "asc").map((r) => r.id)
    ).toEqual(["older", "patch", "missing"]);
    expect(
      sortTableData(idRows, "version", idConfigs, "desc").map((r) => r.id)
    ).toEqual(["patch", "older", "missing"]);
  });

  test("passes the live direction through instead of a default", () => {
    const seen: string[] = [];
    const configs: Record<string, SortConfig<CountRow>> = {
      comments: {
        key: "comments",
        directedComparator: (a, b, direction) => {
          seen.push(direction);
          return compareCountValues(a.comments, b.comments, direction);
        },
      },
    };

    sortTableData(countRows, "comments", configs, "desc");

    // A comparator that silently received "asc" would still produce a
    // plausible-looking order, so the direction itself is asserted.
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["desc"]));
  });

  test("takes precedence over an ascending comparator on the same config", () => {
    const config: Record<string, SortConfig<CountRow>> = {
      comparator: {
        key: "comments",
        comparator: () => 0,
        directedComparator: (a, b, direction) =>
          compareCountValues(a.comments, b.comments, direction),
      },
    };

    // The stub `comparator` would leave the input order untouched, so any
    // reordering here proves the directed branch ran instead of it.
    expect(
      sortTableData(countRows, "comparator", config, "asc").map((r) => r.id)
    ).toEqual(["zero", "three", "ten", "unknown"]);
  });
});

/**
 * ISS-9345. `SortConfig.tieBreak` — the deterministic order inside a tie. Every
 * fixture below ties three rows on the sorted column and arrives in a DIFFERENT
 * order than the assertion, so a stable sort with no tie-break hands the input
 * order straight back and the expectation fails.
 */
describe("tieBreak", () => {
  type Tied = { id: string; group: string };

  const TIED_ROWS: Tied[] = [
    { id: "carol", group: "a" },
    { id: "alice", group: "a" },
    { id: "bob", group: "a" },
  ];

  const BY_ID: SortConfig<Tied> = {
    key: "group",
    columnType: "string",
    tieBreak: (left, right) => left.id.localeCompare(right.id),
  };

  const ids = (rows: readonly Tied[]): string[] => rows.map((row) => row.id);

  test("orders rows that tie on the sorted column", () => {
    expect(ids(sortItems(TIED_ROWS, BY_ID, "asc"))).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
  });

  test("is not negated by a descending sort", () => {
    expect(ids(sortItems(TIED_ROWS, BY_ID, "desc"))).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
  });

  test("does not reorder rows the primary comparison already separates", () => {
    const rows: Tied[] = [
      { id: "zoe", group: "a" },
      { id: "ada", group: "b" },
    ];

    expect(ids(sortItems(rows, BY_ID, "asc"))).toEqual(["zoe", "ada"]);
  });

  test("leaves the input order alone when no tieBreak is declared", () => {
    const untied: SortConfig<Tied> = { key: "group", columnType: "string" };

    expect(ids(sortItems(TIED_ROWS, untied, "asc"))).toEqual(ids(TIED_ROWS));
  });

  test("breaks a tie a directedComparator produced", () => {
    const directed: SortConfig<Tied> = {
      key: "group",
      directedComparator: () => 0,
      tieBreak: (left, right) => left.id.localeCompare(right.id),
    };

    expect(ids(sortItems(TIED_ROWS, directed, "desc"))).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
  });
});

/**
 * ISS-9345 (tamsinb review). `Invalid Date.getTime()` is NaN and `NaN - NaN`
 * is NaN, which `Array#sort` reads as 0 while `primary === 0` is false — so a
 * malformed date used to skip the tie-break and leave the pair in input order,
 * losing the determinism the config promises exactly where bad data needs it.
 * Each fixture arrives in a DIFFERENT order than its assertion.
 */
describe("date columns carrying a value that cannot be parsed", () => {
  type DateRow = { id: string; due: string | null };

  const config: SortConfig<DateRow> = {
    key: "due",
    columnType: "date",
    tieBreak: (left, right) => left.id.localeCompare(right.id),
  };

  const ids = (rows: readonly DateRow[]): string[] => rows.map((row) => row.id);

  test("keeps an unparseable date at the bottom ascending AND descending", () => {
    const rows: DateRow[] = [
      { id: "junk", due: "not a date" },
      { id: "late", due: "2026-09-30" },
      { id: "early", due: "2026-01-02" },
    ];

    expect(ids(sortItems(rows, config, "asc"))).toEqual([
      "early",
      "late",
      "junk",
    ]);
    expect(ids(sortItems(rows, config, "desc"))).toEqual([
      "late",
      "early",
      "junk",
    ]);
  });

  test("still breaks the tie between two unparseable dates", () => {
    const rows: DateRow[] = [
      { id: "c", due: "not a date" },
      { id: "a", due: "also not a date" },
      { id: "b", due: "still not a date" },
    ];

    // The regression: NaN reached `compareSortValues` as a non-zero primary, so
    // the tie-break never ran and these came back in input order.
    expect(ids(sortItems(rows, config, "asc"))).toEqual(["a", "b", "c"]);
    expect(ids(sortItems(rows, config, "desc"))).toEqual(["a", "b", "c"]);
  });

  test("ranks both kinds of unknown below every real date", () => {
    const rows: DateRow[] = [
      { id: "absent", due: null },
      { id: "junk", due: "not a date" },
      { id: "real", due: "2026-05-05" },
    ];

    // The two unknowns are not interchangeable, and the order is not the input
    // order either: `null` is answered by the nulls-last block ABOVE the date
    // branch, so an absent value ranks below an unreadable one. What matters is
    // that neither reaches the real date, in either direction.
    expect(ids(sortItems(rows, config, "desc"))).toEqual([
      "real",
      "junk",
      "absent",
    ]);
    expect(ids(sortItems(rows, config, "asc"))).toEqual([
      "real",
      "junk",
      "absent",
    ]);
  });
});
