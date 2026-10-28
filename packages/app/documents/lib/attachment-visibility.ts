import {
  AttachmentPurpose,
  buildInlineAttachmentRef,
  extractInlineImageAttachmentIds,
  type FileAttachment,
  INLINE_ATTACHMENT_REF_PREFIX,
} from "@repo/api/src/types/attachment";

export const INLINE_ATTACHMENT_BADGE_LABEL = "Inline";

/**
 * Loose: does the content mention this attachment at all?
 *
 * Powers the delete warning, where a bare `attachment://<id>` in prose IS a
 * reference that deleting breaks, so over-matching is the safe direction. This
 * is deliberately NOT the predicate {@link selectListedAttachments} uses — see
 * the note there; the safe direction is opposite for the two questions, which is
 * why one shared predicate would be wrong for one of them.
 */
export function isAttachmentReferencedByContent(
  content: string | undefined,
  attachmentId: string
): boolean {
  return Boolean(content?.includes(buildInlineAttachmentRef(attachmentId)));
}

/**
 * The attachments a panel should list: everything except an `inline` row the
 * latest content already renders as an image.
 *
 * Strict, via the canonical extractor, because here over-matching HIDES a file
 * the user then cannot reach — the defect ISS-8036 exists to fix. It inherits
 * that extractor's one bound: a ref inside a fenced code block still counts as
 * rendered, though the body shows it as code. Pinned by a test in
 * `@closedloop-ai/loops-api`, and not a regression — no inline row is listed today.
 *
 * A row with no `purpose` — a version-skewed API that predates the field — is
 * LISTED. Visible is the safe default when the answer is unknown.
 */
export function selectListedAttachments(
  attachments: FileAttachment[],
  latestContent: string | undefined
): FileAttachment[] {
  // The caller passes the LIVE editor draft, so this runs on every keystroke.
  // Most bodies hold no refs at all, and for those this is one `indexOf`
  // instead of a whole-body regex scan.
  if (!latestContent?.includes(INLINE_ATTACHMENT_REF_PREFIX)) {
    return attachments;
  }

  const renderedIds = new Set(extractInlineImageAttachmentIds(latestContent));
  return attachments.filter(
    (attachment) =>
      attachment.purpose !== AttachmentPurpose.Inline ||
      !renderedIds.has(attachment.id)
  );
}
