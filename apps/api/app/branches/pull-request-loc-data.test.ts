import { describe, expect, it } from "vitest";

import { pullRequestLocData } from "./pull-request-loc-data";

describe("pullRequestLocData", () => {
  it("omits fields whose input is undefined so persisted values are preserved", () => {
    const result = pullRequestLocData({});

    expect(result).toEqual({});
    expect(result).not.toHaveProperty("additions");
    expect(result).not.toHaveProperty("deletions");
    expect(result).not.toHaveProperty("changedFiles");
  });

  it("treats explicitly omitted keys the same as undefined values", () => {
    const result = pullRequestLocData({
      additions: undefined,
      deletions: undefined,
      changedFiles: undefined,
    });

    expect(result).toEqual({});
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("stores null as an explicit unknown value rather than omitting it", () => {
    const result = pullRequestLocData({
      additions: null,
      deletions: null,
      changedFiles: null,
    });

    expect(result).toEqual({
      additions: null,
      deletions: null,
      changedFiles: null,
    });
  });

  it("passes numeric values through unchanged", () => {
    const result = pullRequestLocData({
      additions: 12,
      deletions: 3,
      changedFiles: 4,
    });

    expect(result).toEqual({ additions: 12, deletions: 3, changedFiles: 4 });
  });

  it("preserves zero values instead of treating them as omissions", () => {
    const result = pullRequestLocData({
      additions: 0,
      deletions: 0,
      changedFiles: 0,
    });

    expect(result).toEqual({ additions: 0, deletions: 0, changedFiles: 0 });
  });

  it("handles mixed inputs per-field: undefined omitted, null stored, number passed through", () => {
    const result = pullRequestLocData({
      additions: 7,
      deletions: null,
      // changedFiles intentionally omitted (undefined)
    });

    expect(result).toEqual({ additions: 7, deletions: null });
    expect(result).not.toHaveProperty("changedFiles");
  });
});
