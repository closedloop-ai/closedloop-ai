import { describe, expect, it } from "vitest";
import { documentsService } from "@/app/documents/service";

describe("buildContextBase", () => {
  const assumeDefaults = "Assume defaults for any questions.";

  it("returns sourceContent + assume defaults when no instructions", () => {
    const result = documentsService.buildContextBase(
      "# My PRD",
      null,
      assumeDefaults
    );
    expect(result).toContain("# My PRD");
    expect(result).toContain(assumeDefaults);
    expect(result).not.toContain("Additional Instructions");
  });

  it("returns sourceContent + assume defaults when instructions are empty", () => {
    const result = documentsService.buildContextBase(
      "# My PRD",
      "  ",
      assumeDefaults
    );
    expect(result).not.toContain("Additional Instructions");
    expect(result).toContain(assumeDefaults);
  });

  it("appends instructions when provided", () => {
    const result = documentsService.buildContextBase(
      "# My PRD",
      "Focus on performance",
      assumeDefaults
    );
    expect(result).toContain("## Additional Instructions");
    expect(result).toContain("Focus on performance");
    expect(result).toContain(assumeDefaults);
  });

  it("skips instructions that start with plan generation failure message", () => {
    const result = documentsService.buildContextBase(
      "# My PRD",
      "# Plan Generation Failed\nSome error details",
      assumeDefaults
    );
    expect(result).not.toContain("Additional Instructions");
    expect(result).not.toContain("Plan Generation Failed");
    expect(result).toContain(assumeDefaults);
  });

  it("handles empty sourceContent", () => {
    const result = documentsService.buildContextBase("", null, assumeDefaults);
    expect(result).toContain(assumeDefaults);
  });
});

describe("buildPlanContext", () => {
  it("includes plan-specific assume-defaults message", () => {
    const result = documentsService.buildPlanContext("# PRD Content", null);
    expect(result).toContain("implementation plan");
    expect(result).toContain("assume reasonable defaults");
  });

  it("includes initial instructions when provided", () => {
    const result = documentsService.buildPlanContext(
      "# PRD Content",
      "## Existing plan content"
    );
    expect(result).toContain("## Additional Instructions");
    expect(result).toContain("## Existing plan content");
  });
});

describe("buildPRDContext", () => {
  it("includes PRD-specific assume-defaults message", () => {
    const result = documentsService.buildPRDContext("# Content", null, null);
    expect(result).toContain("PRD");
    expect(result).toContain("assume reasonable defaults");
  });

  it("does not include reverse synthesis section when link is null", () => {
    const result = documentsService.buildPRDContext("# Content", null, null);
    expect(result).not.toContain("Reverse Synthesis Link");
  });

  it("does not include reverse synthesis section when link is empty", () => {
    const result = documentsService.buildPRDContext("# Content", null, "  ");
    expect(result).not.toContain("Reverse Synthesis Link");
  });

  it("includes reverse synthesis section when link is valid", () => {
    const result = documentsService.buildPRDContext(
      "# Content",
      null,
      "https://example.com/repo"
    );
    expect(result).toContain(
      "**Reverse Synthesis Link:** https://example.com/repo"
    );
    expect(result).toContain("Analyze the content at this link");
  });
});
