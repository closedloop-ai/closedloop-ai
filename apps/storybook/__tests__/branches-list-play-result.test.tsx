import { describe, expect, it } from "vitest";
import {
  branchesListPlayResult,
  verifyBranchesListStories,
} from "../scripts/branches-list-play-result.mjs";

describe("Branches list play contract", () => {
  it("requires a play function on every exported story", async () => {
    const stories = Object.entries(
      await import("../stories/surfaces-v2/v2-branches-list.stories")
    ).filter(([name]) => name !== "default");
    expect(stories).toHaveLength(25);
    for (const [name, story] of stories) {
      expect(story, name).toHaveProperty("play", expect.any(Function));
    }
  }, 20_000);

  it("rejects a thrown play even after a success completion event", () => {
    expect(
      branchesListPlayResult(
        [
          {
            type: "playFunctionThrewException",
            message: "play failed",
          },
          { type: "storyFinished", storyId: "story-1", status: "success" },
        ],
        "story-1"
      )
    ).toEqual({
      passed: false,
      reason: "playFunctionThrewException: play failed",
    });
  });

  it("requires a success completion event for the exact story", () => {
    expect(
      branchesListPlayResult(
        [{ type: "storyFinished", storyId: "other", status: "success" }],
        "story-1"
      ).passed
    ).toBe(false);
    expect(
      branchesListPlayResult(
        [{ type: "storyFinished", storyId: "story-1", status: "success" }],
        "story-1"
      ).passed
    ).toBe(true);
  });

  it("records a story that never finishes as a FAIL and verifies the rest", async () => {
    const stories = [{ id: "story-1" }, { id: "story-2" }, { id: "story-3" }];
    const reports: [string, { passed: boolean; reason?: string }][] = [];
    const failures = await verifyBranchesListStories(
      stories,
      (story: { id: string }) => {
        if (story.id === "story-2") {
          return Promise.reject(
            new Error("page.waitForFunction: Timeout 45000ms exceeded.\nstack")
          );
        }
        return Promise.resolve({ passed: true });
      },
      (story: { id: string }, result: { passed: boolean; reason?: string }) => {
        reports.push([story.id, result]);
      }
    );
    expect(failures).toEqual(["story-2"]);
    expect(reports).toEqual([
      ["story-1", { passed: true }],
      [
        "story-2",
        {
          passed: false,
          reason: "page.waitForFunction: Timeout 45000ms exceeded.",
        },
      ],
      ["story-3", { passed: true }],
    ]);
  });
});
