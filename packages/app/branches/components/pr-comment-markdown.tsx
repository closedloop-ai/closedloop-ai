"use client";

import { MarkdownContent } from "@repo/design-system/components/ui/primitives/markdown-content";
import { ImageIcon } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";
import remarkBreaks from "remark-breaks";

/**
 * Renders an untrusted GitHub PR/review comment body as markdown.
 *
 * Composes the design-system `MarkdownContent` primitive (react-markdown, no
 * `rehype-raw` — raw HTML in the body remains inert text, never injected
 * markup) and layers comment-specific concerns on top:
 *
 * - A remark transform removes only the four exact, attribute-free `<sub>` and
 *   `<sup>` wrapper tokens GitHub supports in comment fields. Their inner text
 *   remains ordinary markdown text; every other raw HTML spelling stays inert.
 * - `remark-breaks` so a single newline renders as a line break, matching how
 *   GitHub renders human comments typed as short lines (remark-gfm alone eats
 *   soft breaks and runs them into one paragraph).
 * - Heading overrides so a comment's own `##`/`###` headings render at body
 *   weight instead of tying visually with the panel's section title.
 * - Anchor + image overrides that keep the surface safe on both web and the
 *   desktop renderer: links open in an external target (Electron cancels
 *   in-renderer navigation, so a default same-window link silently does
 *   nothing), and author-controlled markdown images are rendered as an explicit
 *   external link rather than an `<img>` so the web surface never fetches from
 *   an untrusted host and the desktop CSP does not silently block a broken
 *   image.
 */

const REMARK_PLUGINS = [normalizeGithubInlineWrapperTags, remarkBreaks];
const PR_DESCRIPTION_REMARK_PLUGINS = [
  remarkBreaks,
  remarkPrDescriptionHtmlImages,
];
const EXTERNAL_HTTP_HREF = /^https?:\/\//i;
const HTML_IMAGE_SEQUENCE_REGEX = /^(?:\s*<img\b[^>]*>\s*)+$/i;
const HTML_IMAGE_TAG_REGEX = /<img\b[^>]*>/gi;
const HTML_IMAGE_SRC_REGEX =
  /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
const HTML_IMAGE_ALT_REGEX =
  /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

// Comment bodies open with their own `##`/`###` headings (bot reviews start
// with "## Code Review Summary"). Render them as a real heading element for
// semantics/a11y, but demoted to h4 and body size/weight so a comment's heading
// never ties visually with the panel's own section title.
function CommentHeading({ children }: ComponentPropsWithoutRef<"h4">) {
  return <h4 className="mt-2 mb-1 font-semibold text-sm">{children}</h4>;
}

function CommentLink({ href, children }: ComponentPropsWithoutRef<"a">) {
  return (
    <a
      className="text-[var(--link)] underline underline-offset-2"
      href={href}
      rel="noreferrer noopener"
      target="_blank"
    >
      {children}
    </a>
  );
}

function CommentImage({ src, alt }: ComponentPropsWithoutRef<"img">) {
  const href = typeof src === "string" ? src : undefined;
  const label = alt?.trim() ? alt : "Open image";
  if (!href) {
    return null;
  }
  return (
    <a
      className="inline-flex items-center gap-1 text-[var(--link)] underline underline-offset-2"
      href={href}
      rel="noreferrer noopener"
      target="_blank"
    >
      <ImageIcon aria-hidden className="size-3.5" />
      {label}
    </a>
  );
}

function DescriptionHeading4({ children }: ComponentPropsWithoutRef<"h4">) {
  return <h4 className="mt-3 mb-1.5 font-semibold text-sm">{children}</h4>;
}

function DescriptionHeading5({ children }: ComponentPropsWithoutRef<"h5">) {
  return <h5 className="mt-2.5 mb-1 font-medium text-[13px]">{children}</h5>;
}

function DescriptionHeading6({ children }: ComponentPropsWithoutRef<"h6">) {
  return (
    <h6 className="mt-2 mb-1 font-medium text-muted-foreground text-xs">
      {children}
    </h6>
  );
}

function DescriptionLink({
  href,
  children,
  node,
}: ComponentPropsWithoutRef<"a"> & ExtraProps) {
  if (!(href && EXTERNAL_HTTP_HREF.test(href))) {
    return <span>{children}</span>;
  }
  const linkedImageAlt = getLinkedImageAlt(node);
  if (linkedImageAlt !== null) {
    return (
      <CommentLink href={href}>
        <span className="inline-flex items-center gap-1">
          <ImageIcon aria-hidden className="size-3.5" />
          {linkedImageAlt}
        </span>
      </CommentLink>
    );
  }
  return <CommentLink href={href}>{children}</CommentLink>;
}

function DescriptionImage({ src, alt }: ComponentPropsWithoutRef<"img">) {
  const href = typeof src === "string" ? src : undefined;
  if (!(href && EXTERNAL_HTTP_HREF.test(href))) {
    return <span>{alt?.trim() ? alt : "Image omitted"}</span>;
  }
  return <CommentImage alt={alt} src={href} />;
}

function DescriptionTaskCheckbox({
  checked,
  className,
  type,
}: ComponentPropsWithoutRef<"input">) {
  return (
    <input
      aria-label={checked ? "Completed task" : "Incomplete task"}
      checked={checked}
      className={className}
      readOnly
      type={type}
    />
  );
}

const PR_COMMENT_MARKDOWN_COMPONENTS = {
  a: CommentLink,
  img: CommentImage,
  h1: CommentHeading,
  h2: CommentHeading,
  h3: CommentHeading,
  h4: CommentHeading,
  h5: CommentHeading,
  h6: CommentHeading,
};

const PR_DESCRIPTION_MARKDOWN_COMPONENTS = {
  a: DescriptionLink,
  img: DescriptionImage,
  h1: DescriptionHeading4,
  h2: DescriptionHeading5,
  h3: DescriptionHeading6,
  h4: DescriptionHeading6,
  h5: DescriptionHeading6,
  h6: DescriptionHeading6,
  input: DescriptionTaskCheckbox,
};

export function PrCommentMarkdown({
  text,
  className,
}: Readonly<{ text: string; className?: string }>) {
  return (
    <MarkdownContent
      className={className}
      components={PR_COMMENT_MARKDOWN_COMPONENTS}
      remarkPlugins={REMARK_PLUGINS}
      text={text}
    />
  );
}

const GITHUB_INLINE_WRAPPER_TAGS = new Set([
  "<sub>",
  "</sub>",
  "<sup>",
  "</sup>",
]);

/**
 * Removes only GitHub's exact subscript/superscript wrapper tokens from remark
 * HTML nodes. This deliberately does not parse HTML or convert it into DOM.
 */
function normalizeGithubInlineWrapperTags() {
  return (tree: MarkdownAstNode) => removeGithubInlineWrapperTags(tree);
}

function removeGithubInlineWrapperTags(node: MarkdownAstNode): void {
  if (
    node.type === "html" &&
    node.value !== undefined &&
    GITHUB_INLINE_WRAPPER_TAGS.has(node.value)
  ) {
    node.value = "";
  }

  for (const child of node.children ?? []) {
    removeGithubInlineWrapperTags(child);
  }
}

/**
 * Renders an untrusted PR description with relative heading depth preserved,
 * raw HTML omitted, and only HTTP(S) author links exposed as actions.
 */
export function PrDescriptionMarkdown({
  text,
  className,
}: Readonly<{ text: string; className?: string }>) {
  return (
    <MarkdownContent
      className={className}
      components={PR_DESCRIPTION_MARKDOWN_COMPONENTS}
      remarkPlugins={PR_DESCRIPTION_REMARK_PLUGINS}
      skipHtml
      text={text}
    />
  );
}

function getLinkedImageAlt(
  node: MarkdownElementNode | undefined
): string | null {
  const image = node?.children.find(
    (child) => child.type === "element" && child.tagName === "img"
  );
  if (!(image && image.type === "element")) {
    return null;
  }
  const alt = image.properties?.alt;
  return typeof alt === "string" && alt.trim() ? alt : "Open image";
}

function remarkPrDescriptionHtmlImages() {
  return (tree: MarkdownAstNode) => replaceHtmlImages(tree);
}

function replaceHtmlImages(node: MarkdownAstNode): void {
  if (!node.children) {
    return;
  }
  node.children = node.children.flatMap((child) => {
    if (
      child.type === "html" &&
      child.value &&
      HTML_IMAGE_SEQUENCE_REGEX.test(child.value)
    ) {
      return (child.value.match(HTML_IMAGE_TAG_REGEX) ?? []).map(
        htmlImageToMarkdownNode
      );
    }
    replaceHtmlImages(child);
    return [child];
  });
}

function htmlImageToMarkdownNode(tag: string): MarkdownAstNode {
  const href = getHtmlAttribute(tag, HTML_IMAGE_SRC_REGEX);
  const alt = getHtmlAttribute(tag, HTML_IMAGE_ALT_REGEX)?.trim();
  if (!(href && EXTERNAL_HTTP_HREF.test(href))) {
    return {
      type: "text",
      value: alt ? `Image omitted: ${alt}` : "Image omitted",
    };
  }
  return {
    type: "image",
    url: href,
    alt: alt || "Open image",
  };
}

function getHtmlAttribute(tag: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

type ExtraProps = {
  node?: MarkdownElementNode;
};

type MarkdownElementNode = {
  children: MarkdownElementChild[];
};

type MarkdownElementChild = {
  type: string;
  tagName?: string;
  properties?: { alt?: unknown };
};

type MarkdownAstNode = {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  children?: MarkdownAstNode[];
};
