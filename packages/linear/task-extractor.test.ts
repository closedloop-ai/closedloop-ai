import { describe, expect, it } from "vitest";
import { formatTaskForLinear } from "./task-extractor";

describe("formatTaskForLinear", () => {
  it("formats task with title only", () => {
    const result = formatTaskForLinear({
      title: "Setup database",
      isCompleted: false,
    });

    expect(result).toEqual({
      title: "Setup database",
      description: undefined,
    });
  });

  it("formats task with section context", () => {
    const result = formatTaskForLinear({
      title: "Setup database",
      sectionContext: "Phase 1: Backend",
      isCompleted: false,
    });

    expect(result).toEqual({
      title: "Setup database",
      description: "**Section:** Phase 1: Backend",
    });
  });

  it("formats task with description", () => {
    const result = formatTaskForLinear({
      title: "Setup database",
      description: "Configure PostgreSQL with proper indexes",
      isCompleted: false,
    });

    expect(result).toEqual({
      title: "Setup database",
      description: "Configure PostgreSQL with proper indexes",
    });
  });

  it("formats task with both section context and description", () => {
    const result = formatTaskForLinear({
      title: "Setup database",
      sectionContext: "Phase 1: Backend",
      description: "Configure PostgreSQL with proper indexes",
      isCompleted: false,
    });

    expect(result).toEqual({
      title: "Setup database",
      description:
        "**Section:** Phase 1: Backend\n\nConfigure PostgreSQL with proper indexes",
    });
  });
});
