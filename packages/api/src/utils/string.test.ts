import { describe, expect, it } from "vitest";
import { labelize } from "./string.ts";

describe("labelize", () => {
  it("splits on hyphens", () => {
    expect(labelize("pull-request")).toBe("Pull Request");
  });

  it("splits on underscores", () => {
    expect(labelize("in_progress")).toBe("In Progress");
  });

  it("splits on colons", () => {
    expect(labelize("status:open")).toBe("Status Open");
  });

  it("does not split on whitespace", () => {
    expect(labelize("hello world")).toBe("Hello world");
  });

  it("handles empty string", () => {
    expect(labelize("")).toBe("");
  });

  it("capitalizes first letter of each segment", () => {
    expect(labelize("my-cool-feature")).toBe("My Cool Feature");
  });

  it("handles single segment", () => {
    expect(labelize("merged")).toBe("Merged");
  });

  it("handles multiple separators", () => {
    expect(labelize("status:in-progress")).toBe("Status In Progress");
  });
});
