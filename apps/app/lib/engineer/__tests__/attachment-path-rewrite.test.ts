/**
 * Tests for the attachment path regex used in PlanViewer and SymphonyChat.
 * Verifies that canonical .closedloop-ai/work paths and relative paths are matched.
 */
import { describe, expect, it } from "vitest";

// Mirror the regex from PlanViewer.tsx / SymphonyChat.tsx
const ATTACHMENTS_REGEX = /(?:\.closedloop-ai\/work\/)?attachments\/(.+)$/;

describe("attachment path regex", () => {
  it("matches canonical .closedloop-ai/work/attachments path", () => {
    const src =
      "/Users/dev/repo-TICKET-1/.closedloop-ai/work/attachments/image.png";
    const match = ATTACHMENTS_REGEX.exec(src);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("image.png");
  });

  it("matches relative attachments/ path", () => {
    const src = "attachments/diagram.svg";
    const match = ATTACHMENTS_REGEX.exec(src);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("diagram.svg");
  });

  it("matches nested attachment filenames", () => {
    const src =
      "/Users/dev/repo-TICKET-1/.closedloop-ai/work/attachments/subdir/deep/file.png";
    const match = ATTACHMENTS_REGEX.exec(src);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("subdir/deep/file.png");
  });

  it("does not match unrelated paths", () => {
    const src = "/Users/dev/repo/src/components/image.png";
    const match = ATTACHMENTS_REGEX.exec(src);
    expect(match).toBeNull();
  });
});
