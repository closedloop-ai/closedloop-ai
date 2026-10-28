import { describe, expect, it } from "vitest";
import {
  commentsOpenAfterTabChange,
  commentsOpenForTab,
  rememberCommentsOpen,
} from "../comments-tab-memory";

type Tab = "artifact" | "sessions" | "details";
const hiddenTabs: readonly Tab[] = ["details"];

function walk(open: boolean, path: readonly Tab[]) {
  let memory = {};
  let current = open;
  const seen: boolean[] = [];
  for (let index = 1; index < path.length; index += 1) {
    const result = commentsOpenAfterTabChange<Tab>({
      from: path[index - 1],
      hiddenTabs,
      memory,
      open: current,
      to: path[index],
    });
    memory = result.memory;
    current = result.open;
    seen.push(current);
  }
  return seen;
}

describe("comments rail per-tab memory", () => {
  it("restores each tab's own open state", () => {
    // Open on Artifact; Sessions has never been opened.
    expect(walk(true, ["artifact", "sessions", "artifact"])).toEqual([
      false,
      true,
    ]);
  });

  it("never opens the rail on Details, and Details never overwrites a tab", () => {
    expect(walk(true, ["artifact", "details", "artifact"])).toEqual([
      false,
      true,
    ]);
  });
});

describe("comments rail hidden tabs", () => {
  it("never reports a hidden tab open, even from a stale entry", () => {
    expect(
      commentsOpenForTab<Tab>({ details: true }, "details", hiddenTabs)
    ).toBe(false);
  });

  it("never records a hidden tab's state", () => {
    expect(rememberCommentsOpen<Tab>({}, "details", true, hiddenTabs)).toEqual(
      {}
    );
  });
});
