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
