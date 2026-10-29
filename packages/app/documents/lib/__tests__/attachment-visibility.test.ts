import {
  AttachmentPurpose,
  buildInlineAttachmentMarkdownImage,
  buildInlineAttachmentRef,
  type FileAttachment,
} from "@repo/api/src/types/attachment";
import { describe, expect, test } from "vitest";
import {
  isAttachmentReferencedByContent,
  selectListedAttachments,
} from "../attachment-visibility";

const INLINE_ID = "00000000-0000-4000-8000-000000000001";
const CONTEXT_ID = "00000000-0000-4000-8000-000000000002";

function makeAttachment(
  overrides: Partial<FileAttachment> = {}
): FileAttachment {
  return {
    id: INLINE_ID,
    artifactId: "artifact-1",
    filename: "diagram.png",
    mimeType: "image/png",
    sizeBytes: 2048,
    createdAt: "2026-08-01T00:00:00.000Z",
    createdById: "user-1",
    purpose: AttachmentPurpose.Inline,
    ...overrides,
  };
}

function imageRef(id: string): string {
  return `![diagram](${buildInlineAttachmentRef(id)})`;
}

describe("selectListedAttachments", () => {
  test("hides an inline attachment the latest content renders as an image", () => {
    const inline = makeAttachment();

    expect(selectListedAttachments([inline], imageRef(INLINE_ID))).toEqual([]);
  });

  test("hides an inline row the body renders with an escaped ] in its alt text", () => {
    // The writer escapes a `]` in alt text, and the body still renders the
    // image, so the row must stay hidden. ISS-8036 acceptance: "one referenced
    // from the body does not appear in the list."
    const inline = makeAttachment();
    const rendered = buildInlineAttachmentMarkdownImage(
      buildInlineAttachmentRef(INLINE_ID),
      "square] bracket",
      "diagram.png"
    );

    expect(rendered).toContain(String.raw`\]`);
    expect(selectListedAttachments([inline], rendered)).toEqual([]);
  });

  test("lists an inline attachment nothing in the content points at", () => {
    const inline = makeAttachment();

    expect(
      selectListedAttachments([inline], "No images referenced here.")
    ).toEqual([inline]);
  });

  test("lists an inline attachment when there is no content at all", () => {
    const inline = makeAttachment();

    expect(selectListedAttachments([inline], undefined)).toEqual([inline]);
  });

  test("keeps a context attachment even when an image ref points at it", () => {
    // Only `inline` rows are ever hidden: a `context` upload is a file the owner
    // added on purpose, and it stays listed however the body references it.
    const context = makeAttachment({
      id: CONTEXT_ID,
      purpose: AttachmentPurpose.Context,
    });

    expect(selectListedAttachments([context], imageRef(CONTEXT_ID))).toEqual([
      context,
    ]);
  });

  test("keeps a row whose purpose is absent, as a version-skewed API sends", () => {
    const unknownPurpose = makeAttachment({ purpose: undefined });

    expect(
      selectListedAttachments([unknownPurpose], imageRef(INLINE_ID))
    ).toEqual([unknownPurpose]);
  });

  test("keeps an inline row a markdown link — not an image — points at", () => {
    const inline = makeAttachment();

    expect(
      selectListedAttachments(
        [inline],
        `[the diagram](${buildInlineAttachmentRef(INLINE_ID)})`
      )
    ).toEqual([inline]);
  });

  test("keeps an inline row mentioned only as bare prose", () => {
    const inline = makeAttachment();

    expect(
      selectListedAttachments(
        [inline],
        `See ${buildInlineAttachmentRef(INLINE_ID)} for the diagram.`
      )
    ).toEqual([inline]);
  });

  test("hides only the referenced row, keeping its unreferenced siblings", () => {
    const referenced = makeAttachment();
    const unreferenced = makeAttachment({
      id: CONTEXT_ID,
      filename: "orphan.png",
    });

    expect(
      selectListedAttachments([referenced, unreferenced], imageRef(INLINE_ID))
    ).toEqual([unreferenced]);
  });
});

describe("isAttachmentReferencedByContent", () => {
  test("matches a bare prose reference the strict image predicate ignores", () => {
    // The asymmetry is the point: deleting a file the body mentions in prose
    // still breaks that mention, so the delete warning errs toward warning
    // while the visibility filter errs toward showing.
    const content = `See ${buildInlineAttachmentRef(INLINE_ID)}.`;

    expect(isAttachmentReferencedByContent(content, INLINE_ID)).toBe(true);
    expect(selectListedAttachments([makeAttachment()], content)).toEqual([
      makeAttachment(),
    ]);
  });

  test("is false when the content omits the ref, and when there is no content", () => {
    expect(isAttachmentReferencedByContent("nothing here", INLINE_ID)).toBe(
      false
    );
    expect(isAttachmentReferencedByContent(undefined, INLINE_ID)).toBe(false);
  });
});
