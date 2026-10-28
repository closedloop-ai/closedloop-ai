/**
 * ISS-8554 Phase 3 — the list-sort shadow's verdict pipeline.
 *
 * The LOG IS THIS MODULE'S ONLY OUTPUT (it cannot change a response and cannot
 * fail a request), so the logged verdict is the contract under test rather than
 * incidental instrumentation.
 *
 * The differ is NOT mocked: the verdict shape is what this file asserts, and a
 * stubbed diff would assert the stub.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListInput } from "./records";
import type { ListSortPageRow } from "./session-list-sort-differ";
import {
  LIST_SQL_SORT_SHADOW_EVENT,
  LIST_SQL_SORT_SHADOW_FAILED_EVENT,
  shadowSessionListCompoundSort,
  shadowSessionListSort,
} from "./session-list-sort-shadow";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  readSessionListPageByCompoundSort: vi.fn(),
  readSessionListPageByDuration: vi.fn(),
  readSessionListPageByUpdated: vi.fn(),
  readSessionListPageByUser: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: mocks.info, warn: mocks.warn },
}));

vi.mock("./session-list-sql-reader", () => ({
  readSessionListPageByCompoundSort: mocks.readSessionListPageByCompoundSort,
  readSessionListPageByDuration: mocks.readSessionListPageByDuration,
  readSessionListPageByUpdated: mocks.readSessionListPageByUpdated,
  readSessionListPageByUser: mocks.readSessionListPageByUser,
}));

const INPUT = { organizationId: "org-1", filters: {} } as SessionListInput;
const PAGE: ListSortPageRow[] = [
  { id: "a", recordUpdatedAtMs: 1 },
  { id: "b", recordUpdatedAtMs: 2 },
];
const REORDERED: ListSortPageRow[] = [
  { id: "b", recordUpdatedAtMs: 2 },
  { id: "a", recordUpdatedAtMs: 1 },
];

describe("shadowSessionListSort / shadowSessionListCompoundSort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs a CLEAN single-rule verdict tagged with the column and direction", async () => {
    mocks.readSessionListPageByUpdated.mockResolvedValue(PAGE);

    await shadowSessionListSort(
      INPUT,
      { column: "updated", dir: "desc" },
      0,
      25,
      PAGE
    );

    expect(mocks.readSessionListPageByUpdated).toHaveBeenCalledWith(
      INPUT,
      "desc",
      0,
      25
    );
    expect(mocks.info).toHaveBeenCalledWith(
      LIST_SQL_SORT_SHADOW_EVENT,
      expect.objectContaining({
        clean: true,
        column: "updated",
        dir: "desc",
        pageSize: 2,
      })
    );
  });

  it("logs a CLEAN compound verdict tagged with the whole rule list", async () => {
    mocks.readSessionListPageByCompoundSort.mockResolvedValue(PAGE);

    const rules = [
      { column: "updated", dir: "desc" },
      { column: "repo", dir: "asc" },
    ] as const;
    await shadowSessionListCompoundSort(INPUT, [...rules], 0, 25, PAGE);

    expect(mocks.readSessionListPageByCompoundSort).toHaveBeenCalledWith(
      INPUT,
      [...rules],
      0,
      25
    );
    expect(mocks.info).toHaveBeenCalledWith(
      LIST_SQL_SORT_SHADOW_EVENT,
      expect.objectContaining({
        clean: true,
        rules: ["updated:desc", "repo:asc"],
        pageSize: 2,
      })
    );
  });

  it("reports a failed read under the same tags, from either entry point", async () => {
    mocks.readSessionListPageByUser.mockRejectedValue(new Error("boom"));
    mocks.readSessionListPageByCompoundSort.mockRejectedValue(
      new Error("boom")
    );

    await shadowSessionListSort(
      INPUT,
      { column: "user", dir: "asc" },
      0,
      25,
      PAGE
    );
    await shadowSessionListCompoundSort(
      INPUT,
      [
        { column: "user", dir: "asc" },
        { column: "repo", dir: "asc" },
      ],
      0,
      25,
      PAGE
    );

    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenNthCalledWith(
      1,
      LIST_SQL_SORT_SHADOW_FAILED_EVENT,
      expect.objectContaining({ column: "user", dir: "asc", message: "boom" })
    );
    expect(mocks.warn).toHaveBeenNthCalledWith(
      2,
      LIST_SQL_SORT_SHADOW_FAILED_EVENT,
      expect.objectContaining({
        message: "boom",
        rules: ["user:asc", "repo:asc"],
      })
    );
  });

  it("emits the SAME divergence fields from both entry points, differing only in the tags", async () => {
    mocks.readSessionListPageByDuration.mockResolvedValue(REORDERED);
    mocks.readSessionListPageByCompoundSort.mockResolvedValue(REORDERED);

    await shadowSessionListSort(
      INPUT,
      { column: "duration", dir: "asc" },
      0,
      25,
      PAGE
    );
    await shadowSessionListCompoundSort(
      INPUT,
      [
        { column: "duration", dir: "asc" },
        { column: "repo", dir: "asc" },
      ],
      0,
      25,
      PAGE
    );

    const [single, compound] = mocks.info.mock.calls.map((call) => call[1]);
    expect(single).toMatchObject({
      candidateLength: 2,
      clean: false,
      firstMismatchIndex: 0,
      liveLength: 2,
    });
    expect(single.divergences.length).toBeGreaterThan(0);
    // FIELD NAMES, not values: a field added to one pipeline and not the other
    // is exactly the drift one pipeline exists to stop, and comparing the key
    // sets is what catches it. Values would drag `durationMs` in.
    expect(verdictFieldNames(compound)).toEqual(verdictFieldNames(single));
    expect(single.column).toBe("duration");
    expect(compound.rules).toEqual(["duration:asc", "repo:asc"]);
  });
});

/** One verdict's field names, with the candidate-identifying tags removed. */
function verdictFieldNames(verdict: Record<string, unknown>): string[] {
  return Object.keys(verdict)
    .filter((key) => key !== "column" && key !== "dir" && key !== "rules")
    .sort();
}
