import { describe, expect, it } from "vitest";

import {
  buildInlineAttachmentMarkdownImage,
  buildInlineAttachmentRef,
} from "./attachment";

describe("inline attachment Markdown", () => {
  const attachmentRef = buildInlineAttachmentRef("attachment-id");

  it("prefers and sanitizes supplied alt text", () => {
    expect(
      buildInlineAttachmentMarkdownImage(
        attachmentRef,
        "  chart]\nsecond line  ",
        "fallback.png"
      )
    ).toBe(String.raw`![chart\] second line](attachment://attachment-id)`);
  });

  it("falls back through filename and the generic image label", () => {
    expect(
      buildInlineAttachmentMarkdownImage(attachmentRef, "   ", "diagram.png")
    ).toBe("![diagram.png](attachment://attachment-id)");
    expect(
      buildInlineAttachmentMarkdownImage(attachmentRef, undefined, "")
    ).toBe("![image](attachment://attachment-id)");
    expect(
      buildInlineAttachmentMarkdownImage(attachmentRef, undefined, "\n")
    ).toBe("![image](attachment://attachment-id)");
  });
});
