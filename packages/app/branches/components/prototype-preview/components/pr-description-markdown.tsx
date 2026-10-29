"use client";

import { MarkdownContent } from "@repo/design-system/components/ui/primitives/markdown-content";
import { ImageIcon } from "lucide-react";
import {
  Children,
  type ComponentPropsWithoutRef,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import remarkBreaks from "remark-breaks";

const EXTERNAL_HTTP_HREF = /^https?:\/\//i;
const HTML_IMAGE_SEQUENCE_REGEX = /^(?:\s*<img\b[^>]*>\s*)+$/i;
const HTML_IMAGE_TAG_REGEX = /<img\b[^>]*>/gi;
const HTML_IMAGE_SRC_REGEX =
  /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
const HTML_IMAGE_ALT_REGEX =
  /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
const PR_DESCRIPTION_REMARK_PLUGINS = [
  remarkBreaks,
  remarkPrDescriptionHtmlImages,
];

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

function ExternalLink({ href, children }: ComponentPropsWithoutRef<"a">) {
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

function DescriptionLink({ href, children }: ComponentPropsWithoutRef<"a">) {
  if (!(href && EXTERNAL_HTTP_HREF.test(href))) {
    return <span>{children}</span>;
  }
  if (containsDescriptionImage(children)) {
    return (
      <ExternalLink href={href}>
        {replaceDescriptionImages(children)}
      </ExternalLink>
    );
  }
  return <ExternalLink href={href}>{children}</ExternalLink>;
}

function DescriptionImage({ src, alt }: ComponentPropsWithoutRef<"img">) {
  const href = typeof src === "string" ? src : undefined;
  if (!(href && EXTERNAL_HTTP_HREF.test(href))) {
    return <span>{alt?.trim() ? alt : "Image omitted"}</span>;
  }
  return (
    <a
      className="inline-flex items-center gap-1 text-[var(--link)] underline underline-offset-2"
      href={href}
      rel="noreferrer noopener"
      target="_blank"
    >
      <ImageIcon aria-hidden className="size-3.5" />
      {alt?.trim() ? alt : "Open image"}
    </a>
  );
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
      disabled
      type={type}
    />
  );
}

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

/**
 * Renders a mock PR description with production-equivalent safe GitHub Markdown.
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

type MarkdownAstNode = {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  children?: MarkdownAstNode[];
};

function containsDescriptionImage(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => {
    if (isDescriptionImageElement(child)) {
      return true;
    }
    if (!isValidElement<{ children?: ReactNode }>(child)) {
      return false;
    }
    return containsDescriptionImage(child.props.children);
  });
}

function replaceDescriptionImages(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (isDescriptionImageElement(child)) {
      const alt = child.props.alt?.trim();
      return (
        <span className="inline-flex items-center gap-1">
          <ImageIcon aria-hidden className="size-3.5" />
          {alt || "Open image"}
        </span>
      );
    }
    if (!isValidElement<{ children?: ReactNode }>(child)) {
      return child;
    }
    return cloneElement(
      child,
      undefined,
      replaceDescriptionImages(child.props.children)
    );
  });
}

function isDescriptionImageElement(
  child: ReactNode
): child is ReactElement<ComponentPropsWithoutRef<"img">> {
  return (
    isValidElement<ComponentPropsWithoutRef<"img">>(child) &&
    child.type === DescriptionImage
  );
}
