"use client";

// Feature slice -> branches slice: an issue body is GitHub-flavored markdown
// from a person, GitHub or Linear, rendered as the Branch page renders a pull
// request description (untrusted, raw HTML omitted).
import { PrDescriptionMarkdown } from "@repo/app/branches/components/pr-comment-markdown";
import type { ExternalSyncRelationship } from "@repo/app/shared/components/comments/external-sync-contract";
import { ExternalSyncIndicator } from "@repo/app/shared/components/comments/external-sync-indicator";

/**
 * ISS-12576 (DI-07): the issue's text, first on the issue canvas, under the
 * canvas toolbar and above the Sub-issues, Branch and Activity summary
 * sections (Ottilie, 2026-10-21).
 *
 * - "Sub-issue of …" sits above the title (ISS-12570, Nerys 2026-10-19).
 * - No slug and no toolbar: both are on the canvas toolbar above it.
 * - No edited marker and no version: issues have no versions, and an issue's
 *   history, body edits included, is on the Activity tab (Q2, Q7; Ottilie,
 *   2026-10-21).
 * - An issue that came from GitHub or Linear says so with the comments rail's
 *   own sync indicator.
 * - Every comment lives in the rail (Q3). A text-anchored comment marks the
 *   passage it quotes (`highlights`); a comment on the whole issue marks
 *   nothing. The toolbar's Add comment quotes the text selected in the body
 *   ({@link selectedIssueBodyQuote}).
 */
export function IssueCard({
  body,
  highlights,
  parent,
  sync,
  title,
}: Readonly<{
  /** The issue's description, as markdown. */
  body: string;
  /** The passages the issue's open text-anchored comments quote. */
  highlights?: readonly string[];
  /** The issue this one is a sub-issue of. */
  parent?: { slug: string; title: string; href: string | null } | null;
  /** Where the issue is mirrored from, when it came from GitHub or Linear. */
  sync?: ExternalSyncRelationship | null;
  title: string;
}>) {
  return (
    <article aria-label={title} className="space-y-3">
      {sync ? <ExternalSyncIndicator relationship={sync} /> : null}
      {parent ? (
        <p className="text-muted-foreground text-sm">
          Sub-issue of{" "}
          {parent.href ? (
            <a className="hover:underline" href={parent.href}>
              <span className="font-mono text-xs">{parent.slug}</span>{" "}
              <span className="text-foreground">{parent.title}</span>
            </a>
          ) : (
            <span>
              <span className="font-mono text-xs">{parent.slug}</span>{" "}
              <span className="text-foreground">{parent.title}</span>
            </span>
          )}
        </p>
      ) : null}
      <h2 className="font-semibold text-2xl">{title}</h2>
      <div {...{ [ISSUE_BODY_ATTRIBUTE]: "" }}>
        <PrDescriptionMarkdown
          className="text-sm leading-relaxed"
          highlights={highlights}
          text={body}
        />
      </div>
    </article>
  );
}

/** Marks the issue body, the only text a comment can quote. */
const ISSUE_BODY_ATTRIBUTE = "data-issue-body";

/**
 * The text selected inside an issue body under `root`, or `null` when none
 * is: the selection must start and end in the same body.
 */
export function selectedIssueBodyQuote(root: HTMLElement): string | null {
  const selection = globalThis.getSelection?.();
  if (!selection || selection.isCollapsed) {
    return null;
  }
  const { anchorNode, focusNode } = selection;
  const body = issueBodyOf(anchorNode);
  if (!(body && root.contains(body) && issueBodyOf(focusNode) === body)) {
    return null;
  }
  const quote = selection.toString().trim();
  return quote === "" ? null : quote;
}

function issueBodyOf(node: Node | null): Element | null {
  const element =
    node instanceof Element ? node : (node?.parentElement ?? null);
  return element?.closest(`[${ISSUE_BODY_ATTRIBUTE}]`) ?? null;
}
