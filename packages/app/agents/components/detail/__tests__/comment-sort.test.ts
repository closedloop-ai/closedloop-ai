import { describe, expect, it } from "vitest";
import { parseTimestampMs, sortByCreatedAtThenId } from "../comment-sort";

type SortableItem = { id: string; createdAt: string };

const A: SortableItem = { id: "a", createdAt: "2026-06-26T15:00:00.000Z" };
const B: SortableItem = { id: "b", createdAt: "2026-06-26T16:00:00.000Z" };
const C: SortableItem = { id: "c", createdAt: "2026-06-26T17:00:00.000Z" };

describe("parseTimestampMs", () => {
  it("returns the epoch-ms for a valid timestamp string", () => {
    expect(parseTimestampMs("2026-06-26T15:00:00.000Z")).toBe(
      Date.parse("2026-06-26T15:00:00.000Z")
    );
  });

  it("accepts a Date and returns its epoch-ms", () => {
    const date = new Date("2026-06-26T15:00:00.000Z");
    expect(parseTimestampMs(date)).toBe(date.getTime());
  });

  it("falls back to 0 for an invalid date string", () => {
    expect(parseTimestampMs("not-a-date")).toBe(0);
  });

  it("falls back to 0 for null or undefined", () => {
    expect(parseTimestampMs(null)).toBe(0);
    expect(parseTimestampMs(undefined)).toBe(0);
  });
});

describe("sortByCreatedAtThenId", () => {
  it("orders ascending by createdAt by default", () => {
    const sorted = sortByCreatedAtThenId([C, A, B]);
    expect(sorted.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("orders descending when dir is 'desc'", () => {
    const sorted = sortByCreatedAtThenId([A, C, B], "desc");
    expect(sorted.map((item) => item.id)).toEqual(["c", "b", "a"]);
  });

  it("breaks ties on the id via localeCompare (ascending)", () => {
    const shared = "2026-06-26T15:00:00.000Z";
    const items: SortableItem[] = [
      { id: "z", createdAt: shared },
      { id: "m", createdAt: shared },
      { id: "a", createdAt: shared },
    ];
    expect(sortByCreatedAtThenId(items).map((item) => item.id)).toEqual([
      "a",
      "m",
      "z",
    ]);
  });

  it("reverses the id tiebreak under a descending sort", () => {
    const shared = "2026-06-26T15:00:00.000Z";
    const items: SortableItem[] = [
      { id: "a", createdAt: shared },
      { id: "m", createdAt: shared },
      { id: "z", createdAt: shared },
    ];
    expect(sortByCreatedAtThenId(items, "desc").map((item) => item.id)).toEqual(
      ["z", "m", "a"]
    );
  });

  it("treats an invalid createdAt as epoch 0 so it sorts first ascending", () => {
    const bad: SortableItem = { id: "bad", createdAt: "not-a-date" };
    const sorted = sortByCreatedAtThenId([A, bad, B]);
    expect(sorted.map((item) => item.id)).toEqual(["bad", "a", "b"]);
  });

  it("does not mutate the input array", () => {
    const input: readonly SortableItem[] = [C, A, B];
    const snapshot = [...input];
    sortByCreatedAtThenId(input);
    expect(input).toEqual(snapshot);
  });

  it("works generically for any { id; createdAt } shape", () => {
    type Reply = { id: string; createdAt: string; body: string };
    const replies: Reply[] = [
      { id: "r2", createdAt: "2026-06-26T16:00:00.000Z", body: "second" },
      { id: "r1", createdAt: "2026-06-26T15:00:00.000Z", body: "first" },
    ];
    const sorted = sortByCreatedAtThenId(replies);
    expect(sorted.map((reply) => reply.body)).toEqual(["first", "second"]);
  });
});
