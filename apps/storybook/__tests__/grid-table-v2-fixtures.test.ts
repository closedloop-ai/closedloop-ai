import { describe, expect, it } from "vitest";
import {
  tagChoice,
  tagOptions,
} from "../../../packages/app/shared/components/generic-artifact-surface/fixtures";

describe("tagChoice", () => {
  it("returns the matching tagOption when the label exists", () => {
    const result = tagChoice("Governance");
    const expected = tagOptions.find((o) => o.label === "Governance");
    expect(result).toBe(expected);
    expect(result).toEqual({
      className:
        "border-green-500/25 bg-green-500/15 text-green-700 dark:text-green-300",
      id: "governance",
      label: "Governance",
    });
  });

  it("returns a generic muted fallback when the label is not in tagOptions", () => {
    const result = tagChoice("Unmapped Tag");
    expect(result).toEqual({
      className: "border-border bg-muted text-muted-foreground",
      id: "unmapped-tag",
      label: "Unmapped Tag",
    });
  });

  it("derives the fallback id by lowercasing and replacing spaces with hyphens", () => {
    const result = tagChoice("A Brand New Tag");
    expect(result.id).toBe("a-brand-new-tag");
    expect(result.label).toBe("A Brand New Tag");
  });
});
