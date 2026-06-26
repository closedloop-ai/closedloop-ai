import type { MergedTraceItem } from "@repo/api/src/types/branch";
import { describe, expect, it } from "vitest";
import { deriveEventDots, deriveLifecycleDots } from "../branch-event-dots";

function ev(
  dot: "g" | "b" | "r",
  text: string,
  t = "2026-06-10T10:00:00.000Z"
): MergedTraceItem {
  return { type: "event", sessionId: "s1", t, dot, text };
}

describe("deriveEventDots", () => {
  it("maps g→green and r→red", () => {
    const dots = deriveEventDots([
      ev("g", "Commit pushed", "2026-06-10T10:00:00.000Z"),
      ev("r", "Process failed", "2026-06-10T11:00:00.000Z"),
    ]);
    expect(dots.map((d) => d.color)).toEqual(["green", "red"]);
    expect(dots.map((d) => d.row)).toEqual([0, 1]);
  });

  it("drops the blue autonomy dot and never emits blue", () => {
    const dots = deriveEventDots([
      ev("g", "ok"),
      ev("b", "autonomy step"),
      ev("r", "error"),
    ]);
    expect(dots).toHaveLength(2);
    expect(dots.some((d) => (d.color as string) === "blue")).toBe(false);
    expect(dots.every((d) => d.color === "green" || d.color === "red")).toBe(
      true
    );
  });

  it("classifies error/fail text as red even when not flagged red", () => {
    const [dot] = deriveEventDots([ev("g", "unit tests failed")]);
    expect(dot?.color).toBe("red");
  });

  it("ignores non-event items", () => {
    const items: MergedTraceItem[] = [
      { type: "end", sessionId: "s1", text: "done" },
      ev("g", "merge"),
    ];
    expect(deriveEventDots(items)).toHaveLength(1);
  });
});

describe("deriveLifecycleDots", () => {
  const NO_PR = {
    prNumber: null,
    openedAt: null,
    commits: [] as const,
  };

  it("emits a green merge dot (no trace row) labeled with the PR number", () => {
    const dots = deriveLifecycleDots({
      ...NO_PR,
      mergedAt: "2026-06-10T12:00:00.000Z",
      prNumber: 123,
    });
    expect(dots).toEqual([
      {
        row: null,
        t: "2026-06-10T12:00:00.000Z",
        color: "green",
        label: "Merged #123",
      },
    ]);
  });

  it("labels the merge dot 'Merged' when there is no PR number", () => {
    const [dot] = deriveLifecycleDots({
      ...NO_PR,
      mergedAt: "2026-06-10T12:00:00.000Z",
    });
    expect(dot?.label).toBe("Merged");
  });

  it("emits nothing with no commit or PR-lifecycle signal", () => {
    expect(deriveLifecycleDots({ ...NO_PR, mergedAt: null })).toHaveLength(0);
  });

  it("ignores an unparseable merge timestamp", () => {
    expect(
      deriveLifecycleDots({ ...NO_PR, mergedAt: "not-a-date", prNumber: 1 })
    ).toHaveLength(0);
  });

  it("emits one green dot per commit, positioned by committedAt, subject as label", () => {
    const dots = deriveLifecycleDots({
      ...NO_PR,
      mergedAt: null,
      commits: [
        {
          sha: "abc1234def",
          committedAt: "2026-06-08T08:00:00.000Z",
          message: "First",
        },
        {
          sha: "def5678abc",
          committedAt: "2026-06-09T09:00:00.000Z",
          message: "Second",
        },
      ],
    });
    expect(dots).toEqual([
      {
        row: null,
        t: "2026-06-08T08:00:00.000Z",
        color: "green",
        label: "First",
      },
      {
        row: null,
        t: "2026-06-09T09:00:00.000Z",
        color: "green",
        label: "Second",
      },
    ]);
  });

  it("falls back to the short SHA when a commit has no message, and skips bad times", () => {
    const dots = deriveLifecycleDots({
      ...NO_PR,
      mergedAt: null,
      commits: [
        {
          sha: "abc1234def567",
          committedAt: "2026-06-08T08:00:00.000Z",
          message: "",
        },
        { sha: "zzz", committedAt: "not-a-date", message: "dropped" },
      ],
    });
    expect(dots).toEqual([
      {
        row: null,
        t: "2026-06-08T08:00:00.000Z",
        color: "green",
        label: "abc1234",
      },
    ]);
  });

  it("emits a green PR-opened dot distinct from the merge dot", () => {
    const dots = deriveLifecycleDots({
      ...NO_PR,
      mergedAt: "2026-06-12T10:00:00.000Z",
      openedAt: "2026-06-09T09:00:00.000Z",
      prNumber: 7,
    });
    expect(dots).toEqual([
      {
        row: null,
        t: "2026-06-09T09:00:00.000Z",
        color: "green",
        label: "Opened #7",
      },
      {
        row: null,
        t: "2026-06-12T10:00:00.000Z",
        color: "green",
        label: "Merged #7",
      },
    ]);
  });
});
