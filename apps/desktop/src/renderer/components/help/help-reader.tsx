/**
 * Right pane of the two-pane Help view (FEA-3844 / PRD-555 M2): the rendered
 * doc page.
 *
 * Renders the M1 bundle page — a plain-text/markdown body with the JSX stripped
 * — through the design-system `MarkdownContent` primitive (prose typography +
 * code highlighting), stamping GitHub-style `id`s on headings so a search hit's
 * `headingSlug` deep-links to the right section. Handles the loading, not-found,
 * and idle states so the pane is never blank. A "View online" affordance links
 * to the live docs page for the freshest version.
 */
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { EmptyState } from "@closedloop-ai/design-system/components/ui/empty-state";
import { MarkdownContent } from "@closedloop-ai/design-system/components/ui/primitives/markdown-content";
import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import { ExternalLinkIcon, FileQuestionIcon } from "lucide-react";
import { type ComponentPropsWithoutRef, useEffect, useRef } from "react";
import {
  DOCS_HELP_VIEW_ONLINE_LABEL,
  type DocsHelpPage,
} from "../../../shared/docs-help-contract";
import { slugHeadingProps } from "./help-reader-headings";

const CSS_ESCAPE_RE = /[^a-zA-Z0-9\-_]/g;
const TRAILING_SLASH_RE = /\/+$/;

type HelpReaderProps = {
  page: DocsHelpPage;
  /** Live docs base URL (`status.docsSiteUrl`), for the "View online" link. */
  docsSiteUrl: string;
  /** Heading slug to scroll to once the page renders; cleared by `onHeadingHandled`. */
  pendingHeadingSlug: string | null;
  onHeadingHandled: () => void;
};

/** The "View latest online" escape hatch for the current page. */
function viewOnlineHref(docsSiteUrl: string, path: string): string {
  const base = docsSiteUrl.replace(TRAILING_SLASH_RE, "");
  return `${base}/${path}`;
}

export function HelpReader({
  page,
  docsSiteUrl,
  pendingHeadingSlug,
  onHeadingHandled,
}: Readonly<HelpReaderProps>) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // After the page renders, scroll the pending heading anchor into view. Runs on
  // page/slug change so a search-jump lands on the right section.
  useEffect(() => {
    if (!pendingHeadingSlug) {
      return;
    }
    const container = containerRef.current;
    if (container) {
      const target = container.querySelector(
        `#${cssEscape(pendingHeadingSlug)}`
      );
      target?.scrollIntoView({ block: "start" });
    }
    onHeadingHandled();
    // `pendingHeadingSlug` is set alongside each page change (via `selectPage`),
    // so it is the sole trigger — re-listing `page.path` would be redundant.
  }, [pendingHeadingSlug, onHeadingHandled]);

  return (
    <article className="flex min-h-0 flex-1 flex-col" ref={containerRef}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-border/60 border-b px-6 py-4">
        <div className="min-w-0 space-y-1">
          <h1 className="font-semibold text-[var(--foreground)] text-xl tracking-tight">
            {page.title}
          </h1>
          {page.description ? (
            <p className="text-[var(--muted-foreground)] text-sm">
              {page.description}
            </p>
          ) : null}
        </div>
        <Button asChild size="sm" variant="outline">
          <a
            href={viewOnlineHref(docsSiteUrl, page.path)}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLinkIcon aria-hidden className="size-3.5" />
            {DOCS_HELP_VIEW_ONLINE_LABEL}
          </a>
        </Button>
      </header>
      <div className="min-w-0 overflow-auto px-6 py-5">
        <MarkdownContent
          className="max-w-3xl text-sm"
          components={markdownHeadingComponents}
          text={page.renderBody ?? page.body}
        />
      </div>
    </article>
  );
}

export function HelpReaderLoading() {
  return (
    <div aria-hidden className="flex flex-1 flex-col gap-4 px-6 py-5">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-4 w-full max-w-2xl" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <Skeleton className="h-4 w-full max-w-2xl" />
      <Skeleton className="h-4 w-40" />
    </div>
  );
}

export function HelpReaderMissing({
  docsSiteUrl,
}: Readonly<{ docsSiteUrl: string }>) {
  return (
    <EmptyState
      action={
        <Button asChild size="sm" variant="outline">
          <a href={docsSiteUrl} rel="noreferrer" target="_blank">
            <ExternalLinkIcon aria-hidden className="size-3.5" />
            {DOCS_HELP_VIEW_ONLINE_LABEL}
          </a>
        </Button>
      }
      description="This page isn't in the bundled docs snapshot. It may be newer than your app — view the latest docs online."
      icon={FileQuestionIcon}
      title="Page not found"
    />
  );
}

/**
 * Heading renderers that stamp a slug `id` on each rendered heading so the
 * reader can deep-link to a section. Kept out of `markdown-content`'s own
 * defaults — this id-stamping is a Help-view concern (search deep-links), not a
 * general markdown one.
 */
const markdownHeadingComponents = {
  h1: (props: ComponentPropsWithoutRef<"h1">) => (
    <h2 {...slugHeadingProps(props.children)}>{props.children}</h2>
  ),
  h2: (props: ComponentPropsWithoutRef<"h2">) => (
    <h3 {...slugHeadingProps(props.children)}>{props.children}</h3>
  ),
  h3: (props: ComponentPropsWithoutRef<"h3">) => (
    <h4 {...slugHeadingProps(props.children)}>{props.children}</h4>
  ),
  h4: (props: ComponentPropsWithoutRef<"h4">) => (
    <h5 {...slugHeadingProps(props.children)}>{props.children}</h5>
  ),
};

/** Minimal CSS.escape shim for the `#id` querySelector (jsdom lacks it in some envs). */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(CSS_ESCAPE_RE, "\\$&");
}
