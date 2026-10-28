import { describe, expect, it } from "vitest";

import {
  buildInlineAttachmentMarkdownImage,
  buildInlineAttachmentRef,
  chunkInlineImageAttachmentIds,
  extractInlineImageAttachmentIds,
  MAX_ATTACHMENT_FILE_SIZE_BYTES,
  MAX_INLINE_IMAGE_RESOLVE_BATCH_SIZE,
  MAX_MEDIA_FILE_SIZE_BYTES,
  maxAttachmentSizeBytesForMimeType,
  replaceInlineImageAttachmentRefs,
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

describe("extractInlineImageAttachmentIds", () => {
  const FIRST_ID = "00000000-0000-4000-8000-000000000001";
  const SECOND_ID = "00000000-0000-4000-8000-000000000002";

  it("extracts unique attachment:// inline image references in document order", () => {
    expect(
      extractInlineImageAttachmentIds(
        [
          `![diagram](attachment://${FIRST_ID})`,
          `![duplicate](attachment://${FIRST_ID} "same")`,
          `![second](attachment://${SECOND_ID})`,
          "![external](https://example.com/image.png)",
        ].join("\n")
      )
    ).toEqual([FIRST_ID, SECOND_ID]);
  });

  it("ignores a bare prose reference and a markdown link, matching only image tokens", () => {
    expect(
      extractInlineImageAttachmentIds(
        [
          `See attachment://${FIRST_ID} for the diagram.`,
          `[the diagram](attachment://${SECOND_ID})`,
        ].join("\n")
      )
    ).toEqual([]);
  });

  it("does not match an id that is not a 36-character attachment id", () => {
    expect(
      extractInlineImageAttachmentIds("![short](attachment://attachment-1)")
    ).toEqual([]);
  });

  // The one bound this parser does NOT have. Pinned to ACTUAL behaviour so a
  // reader cannot take the suite as promising a markdown-aware predicate: a
  // caller that gates VISIBILITY on this must tolerate it.
  it("BOUND: still matches a ref inside a fenced code block (no fence awareness)", () => {
    expect(
      extractInlineImageAttachmentIds(
        ["```md", `![example](attachment://${FIRST_ID})`, "```"].join("\n")
      )
    ).toEqual([FIRST_ID]);
  });

  it("reads back an alt text the writer escaped a close bracket into", () => {
    const markdown = buildInlineAttachmentMarkdownImage(
      buildInlineAttachmentRef(FIRST_ID),
      "square] bracket",
      "diagram.png"
    );

    expect(markdown).toContain(String.raw`\]`);
    expect(extractInlineImageAttachmentIds(markdown)).toEqual([FIRST_ID]);
  });

  it("does not match an alt text left unterminated by an escaped close bracket", () => {
    // `![a\](ref)` never closes its alt text, so CommonMark renders no image and
    // the id must not be reported as one the body already shows.
    const unterminated = String.raw`![a\](attachment://${FIRST_ID})`;

    expect(extractInlineImageAttachmentIds(unterminated)).toEqual([]);
  });
});

describe("replaceInlineImageAttachmentRefs", () => {
  const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000003";

  it("rewrites only refs the resolver maps and leaves the rest byte-identical", () => {
    const unresolved = "00000000-0000-4000-8000-000000000004";
    const content = [
      `![one](attachment://${ATTACHMENT_ID})`,
      `![two](attachment://${unresolved})`,
    ].join("\n");

    expect(
      replaceInlineImageAttachmentRefs(content, (id) =>
        id === ATTACHMENT_ID ? "https://cdn.example/one.png" : undefined
      )
    ).toBe(
      [
        "![one](https://cdn.example/one.png)",
        `![two](attachment://${unresolved})`,
      ].join("\n")
    );
  });

  it("preserves a title suffix on a rewritten ref", () => {
    expect(
      replaceInlineImageAttachmentRefs(
        `![one](attachment://${ATTACHMENT_ID} "caption")`,
        () => "https://cdn.example/one.png"
      )
    ).toBe('![one](https://cdn.example/one.png "caption")');
  });
});

describe("inline image resolve batching", () => {
  function ids(count: number): string[] {
    return Array.from({ length: count }, (_, index) => `attachment-${index}`);
  }

  it("keeps a request at the cap whole", () => {
    const atCap = ids(MAX_INLINE_IMAGE_RESOLVE_BATCH_SIZE);

    expect(chunkInlineImageAttachmentIds(atCap)).toEqual([atCap]);
  });

  it("splits one past the cap without dropping or duplicating a ref", () => {
    const pastCap = ids(MAX_INLINE_IMAGE_RESOLVE_BATCH_SIZE + 1);

    const chunks = chunkInlineImageAttachmentIds(pastCap);

    expect(chunks).toEqual([
      pastCap.slice(0, MAX_INLINE_IMAGE_RESOLVE_BATCH_SIZE),
      [pastCap.at(-1)],
    ]);
    // The endpoint rejects the whole request over the cap, so a chunk that
    // exceeds it takes every ref in that chunk down with it.
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(
        MAX_INLINE_IMAGE_RESOLVE_BATCH_SIZE
      );
    }
    expect(chunks.flat()).toEqual(pastCap);
  });

  it("asks for nothing when there are no refs", () => {
    expect(chunkInlineImageAttachmentIds([])).toEqual([]);
  });
});

describe("maxAttachmentSizeBytesForMimeType", () => {
  it("applies the media ceiling to every media type", () => {
    expect(maxAttachmentSizeBytesForMimeType("video/quicktime")).toBe(
      MAX_MEDIA_FILE_SIZE_BYTES
    );
    expect(maxAttachmentSizeBytesForMimeType("video/mp4")).toBe(
      MAX_MEDIA_FILE_SIZE_BYTES
    );
    expect(maxAttachmentSizeBytesForMimeType("audio/mpeg")).toBe(
      MAX_MEDIA_FILE_SIZE_BYTES
    );
  });

  it("applies the attachment ceiling to images, documents and unknown types", () => {
    expect(maxAttachmentSizeBytesForMimeType("image/png")).toBe(
      MAX_ATTACHMENT_FILE_SIZE_BYTES
    );
    expect(maxAttachmentSizeBytesForMimeType("application/pdf")).toBe(
      MAX_ATTACHMENT_FILE_SIZE_BYTES
    );
    expect(maxAttachmentSizeBytesForMimeType("application/zip")).toBe(
      MAX_ATTACHMENT_FILE_SIZE_BYTES
    );
  });

  it("keeps the two ceilings distinct, so the branch is observable", () => {
    expect(MAX_MEDIA_FILE_SIZE_BYTES).toBeGreaterThan(
      MAX_ATTACHMENT_FILE_SIZE_BYTES
    );
  });
});
