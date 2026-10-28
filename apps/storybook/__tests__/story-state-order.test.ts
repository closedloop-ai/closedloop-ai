// ISS-12332: every entry in the page tree lists Default, then the shared
// states in one fixed order, then page-specific states, then variants.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkStateOrder,
  expectedStateOrder,
  sharedStateRank,
  stateOrderExemptTitles,
} from "../scripts/story-state-order.mjs";
import { storybookSharedStateOrder } from "../story-group-order";

function storyFile(title: string, exportNames: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "state-order-"));
  const file = path.join(dir, "page.stories.tsx");
  writeFileSync(
    file,
    [
      `const meta = { title: "${title}" };`,
      "export default meta;",
      ...exportNames.map((name) => `export const ${name} = {};`),
    ].join("\n")
  );
  return file;
}

describe("sharedStateRank", () => {
  it("places a state and its suffixed variants with that state", () => {
    expect(sharedStateRank("Loading")).toBe(0);
    expect(sharedStateRank("Loading Dark")).toBe(0);
    expect(sharedStateRank("Error With Retry")).toBe(
      storybookSharedStateOrder.indexOf("Error")
    );
  });

  it("orders an older name in the synonym map as its shared state", () => {
    expect(sharedStateRank("Permission Dark")).toBe(
      storybookSharedStateOrder.indexOf("No Permission")
    );
    expect(sharedStateRank("No Sessions")).toBe(
      storybookSharedStateOrder.indexOf("Empty")
    );
    expect(sharedStateRank("Failed Retrieval Narrow")).toBe(
      storybookSharedStateOrder.indexOf("Error")
    );
    // Comments Pane's error story (tamsinb, #8653).
    expect(sharedStateRank("Failed Load With Retry")).toBe(
      storybookSharedStateOrder.indexOf("Error")
    );
  });

  it("does not match a different word that shares a prefix", () => {
    expect(sharedStateRank("Errors Only On")).toBe(-1);
    expect(sharedStateRank("Stalled")).toBe(-1);
    expect(sharedStateRank("Default")).toBe(-1);
  });
});

describe("expectedStateOrder", () => {
  it("puts Default first, the shared states in order, then the rest as written", () => {
    expect(
      expectedStateOrder([
        "Default",
        "Not Connected",
        "Error",
        "Dark",
        "Loading",
        "Empty",
      ])
    ).toEqual([
      "Default",
      "Loading",
      "Empty",
      "Error",
      "Not Connected",
      "Dark",
    ]);
  });

  it("treats the first story as the default when none is named Default", () => {
    expect(expectedStateOrder(["Session", "Branch", "No Permission"])).toEqual([
      "Session",
      "No Permission",
      "Branch",
    ]);
  });

  it("keeps the first story first when it is a shared state and none is named Default", () => {
    // TAXONOMY.md: the first story plays Default (whitlockk, #8653).
    expect(expectedStateOrder(["Error", "Loading"])).toEqual([
      "Error",
      "Loading",
    ]);
    expect(expectedStateOrder(["Error", "Dark", "Loading"])).toEqual([
      "Error",
      "Loading",
      "Dark",
    ]);
  });

  it("leaves an entry that already follows the order unchanged", () => {
    const names = ["Default", "Loading", "Not Found", "Running", "Dark"];
    expect(expectedStateOrder(names)).toEqual(names);
  });
});

describe("checkStateOrder", () => {
  it("fails a v2.0 entry whose shared state comes after a variant", () => {
    const file = storyFile("Surfaces/Labs/Inbox", [
      "Default",
      "Dark",
      "Loading",
    ]);
    const { checked, errors } = checkStateOrder([file]);
    expect(checked).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Default | Loading | Dark");
  });

  it("passes the same entry once it is reordered", () => {
    const file = storyFile("Patterns/Artifacts/Sessions/Session Detail", [
      "Default",
      "Loading",
      "Dark",
    ]);
    expect(checkStateOrder([file]).errors).toEqual([]);
  });

  it("fails the real Sessions List order this PR fixed", () => {
    // Copied from origin/main before ISS-12332: Not Connected sat between
    // Loading and Empty, and Error came after two variants.
    const fixture = path.join(
      import.meta.dirname,
      "fixtures",
      "v2-sessions-list-before-iss-12332.stories.tsx.txt"
    );
    const { checked, errors } = checkStateOrder([fixture]);
    expect(checked).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      "Default | Loading | Loading Summary | Empty | No Matches | Error | Not Connected"
    );
  });

  it("fails a renamed state that sits after a page-specific one", () => {
    const file = storyFile(
      "Composites/Artifacts/Branches/Branch Detail/Panel",
      ["Default", "PartialRetrieval", "FailedRetrieval"]
    );
    expect(checkStateOrder([file]).errors).toHaveLength(1);
  });

  it("does not check v1.0 entries", () => {
    const file = storyFile("Surfaces v1.0/Sessions/Listing", [
      "Dark",
      "Default",
    ]);
    expect(checkStateOrder([file])).toEqual({ checked: 0, errors: [] });
  });

  it("every real exemption gives its reason", () => {
    for (const [, reason] of stateOrderExemptTitles) {
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  const exempt = new Map([
    ["Surfaces/Fixture/Exempt", "ISS-0000 (fixture) reorders these."],
  ]);

  it("skips an exempt entry that is still out of order", () => {
    const file = storyFile("Surfaces/Fixture/Exempt", [
      "Default",
      "Dark",
      "Loading",
    ]);
    expect(checkStateOrder([file], exempt)).toEqual({ checked: 0, errors: [] });
  });

  it("fails an exempt entry that is already in order: the exemption is stale", () => {
    // marisolashgrove, #8653: the list must clean itself up.
    const file = storyFile("Surfaces/Fixture/Exempt", [
      "Default",
      "Loading",
      "Dark",
    ]);
    const result = checkStateOrder([file], exempt);
    expect(result.checked).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("exemption no longer needed");
  });
});
