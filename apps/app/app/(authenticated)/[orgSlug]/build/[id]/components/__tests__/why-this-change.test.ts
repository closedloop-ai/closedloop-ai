import { describe, expect, test } from "vitest";
import {
  deriveChangeRationale,
  fileBasename,
  WhyThisChangeSource,
} from "../why-this-change";

describe("fileBasename", () => {
  test("returns the final path segment", () => {
    expect(fileBasename("apps/app/components/branch-diff-view.tsx")).toBe(
      "branch-diff-view.tsx"
    );
  });

  test("handles bare filenames", () => {
    expect(fileBasename("page.tsx")).toBe("page.tsx");
  });

  test("ignores trailing slashes", () => {
    expect(fileBasename("apps/app/components/")).toBe("components");
  });
});

describe("deriveChangeRationale", () => {
  test("returns null when there is no plan content", () => {
    expect(deriveChangeRationale(null, "a.ts")).toBeNull();
    expect(deriveChangeRationale("", "a.ts")).toBeNull();
    expect(deriveChangeRationale("   \n  \n", "a.ts")).toBeNull();
  });

  test("surfaces the block that mentions the full path", () => {
    const plan = [
      "# Plan",
      "",
      "Add the global command palette.",
      "",
      "Update `apps/app/components/branch-diff-view.tsx` to add the trigger.",
    ].join("\n");

    const rationale = deriveChangeRationale(
      plan,
      "apps/app/components/branch-diff-view.tsx"
    );

    expect(rationale?.source).toBe(WhyThisChangeSource.FileMatch);
    expect(rationale?.excerpt).toContain("add the trigger");
    expect(rationale?.excerpt).not.toContain("global command palette");
  });

  test("falls back to a basename match when the full path is absent", () => {
    const plan = [
      "Introduce the palette.",
      "",
      "Wire branch-diff-view.tsx into the header row.",
    ].join("\n");

    const rationale = deriveChangeRationale(
      plan,
      "apps/app/components/branch-diff-view.tsx"
    );

    expect(rationale?.source).toBe(WhyThisChangeSource.FileMatch);
    expect(rationale?.excerpt).toContain("header row");
  });

  test("prefers full-path blocks over basename-only blocks", () => {
    const plan = [
      "Touch branch-diff-view.tsx generically here.",
      "",
      "Specifically edit apps/app/components/branch-diff-view.tsx now.",
    ].join("\n");

    const rationale = deriveChangeRationale(
      plan,
      "apps/app/components/branch-diff-view.tsx"
    );

    expect(rationale?.source).toBe(WhyThisChangeSource.FileMatch);
    expect(rationale?.excerpt).toContain("Specifically edit");
    expect(rationale?.excerpt).not.toContain("generically");
  });

  test("does not attribute another file's path to a shared basename", () => {
    const plan = [
      "Introduce the palette.",
      "",
      "Update apps/foo/page.tsx to mount the launcher.",
    ].join("\n");

    // Viewing apps/bar/page.tsx: the plan only mentions a different page.tsx,
    // so we must fall back to plan intent rather than mis-attributing it.
    const rationale = deriveChangeRationale(plan, "apps/bar/page.tsx");

    expect(rationale?.source).toBe(WhyThisChangeSource.PlanSummary);
  });

  test("matches a bare basename mention even when a different path shares it", () => {
    const plan = [
      "Update apps/foo/page.tsx for the launcher.",
      "",
      "Also touch page.tsx in the focused area directly.",
    ].join("\n");

    const rationale = deriveChangeRationale(plan, "apps/bar/page.tsx");

    expect(rationale?.source).toBe(WhyThisChangeSource.FileMatch);
    expect(rationale?.excerpt).toContain("focused area");
    expect(rationale?.excerpt).not.toContain("apps/foo/page.tsx");
  });

  test("falls back to the plan intent when nothing references the file", () => {
    const plan = [
      "# Goal",
      "",
      "Ship a reasoning-effort picker in the desktop composer.",
      "",
      "Persist the selection per session.",
    ].join("\n");

    const rationale = deriveChangeRationale(plan, "unrelated/file.ts");

    expect(rationale?.source).toBe(WhyThisChangeSource.PlanSummary);
    expect(rationale?.excerpt).toContain("reasoning-effort picker");
  });

  test("truncates very long excerpts with an ellipsis", () => {
    const longBlock = "x".repeat(900);
    const rationale = deriveChangeRationale(longBlock, "missing.ts");

    expect(rationale?.source).toBe(WhyThisChangeSource.PlanSummary);
    expect(rationale?.excerpt.endsWith("…")).toBe(true);
    expect(rationale?.excerpt.length).toBeLessThanOrEqual(601);
  });
});
