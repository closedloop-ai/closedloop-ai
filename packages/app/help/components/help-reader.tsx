"use client";

import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { MarkdownContent } from "@repo/design-system/components/ui/primitives/markdown-content";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  FileQuestionIcon,
  FileWarningIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  useEffect,
  useRef,
} from "react";
import type { DocsHelpPage } from "../lib/docs-help-payload";
import { getTextContent } from "../lib/heading-text";
import { ViewOnlineAction } from "./help-view-online-action";

/**
 * Right pane of the two-pane Help surface (ISS-10005, mastering PRD-555 M2): the
 * rendered doc page, plus the reader's loading, not-found and malformed states.
 *
 * `slugifyHeading` is a REQUIRED prop, not an import: the generator persists the
 * slug as each heading's `headingSlug` at prebuild time and the reader must
 * recompute the identical string, or search-jump lands nowhere with nothing red.
 * `apps/desktop/test/docs-slug-parity.test.ts` holds the two together under
 * plain `node:test` — the host that owns the generator owns the slug.
 */

const CSS_ESCAPE_RE = /[^a-zA-Z0-9\-_]/g;

/** Only this surface's degraded page branch emits it — see the malformed state. */
export const HELP_SURFACE_V2_PAGE_MALFORMED_TEST_ID =
  "help-surface-v2-page-malformed";

/** Only the transport-failure branch emits it — see {@link HelpReaderUnavailable}. */
export const HELP_SURFACE_V2_PAGE_ERROR_TEST_ID = "help-surface-v2-page-error";

export type SlugifyHeading = (text: string) => string;

type HelpReaderProps = {
  page: DocsHelpPage;
  /** Live docs base URL (`status.docsSiteUrl`), for the "View online" link. */
  docsSiteUrl: string;
  /** Heading slug to scroll to once the page renders; cleared by `onHeadingHandled`. */
  pendingHeadingSlug: string | null;
  onHeadingHandled: () => void;
  /** The host's bundle-generator-bound slug. See this module's header. */
  slugifyHeading: SlugifyHeading;
};

export function HelpReader({
  page,
  docsSiteUrl,
  pendingHeadingSlug,
  onHeadingHandled,
  slugifyHeading,
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
          <h1 className="font-semibold text-foreground text-xl tracking-tight">
            {page.title}
          </h1>
          {page.description ? (
            <p className="text-muted-foreground text-sm">{page.description}</p>
          ) : null}
        </div>
        <ViewOnlineAction docsSiteUrl={docsSiteUrl} path={page.path} />
      </header>
      <div className="min-w-0 overflow-auto px-6 py-5">
        <MarkdownContent
          className="max-w-3xl text-sm"
          components={markdownHeadingComponents(slugifyHeading)}
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
  detail,
  docsSiteUrl,
}: Readonly<{ detail: string; docsSiteUrl: string }>) {
  return (
    <EmptyState
      action={<ViewOnlineAction docsSiteUrl={docsSiteUrl} />}
      description={`${detail} View the latest docs online.`}
      icon={FileQuestionIcon}
      title="Page not found"
      titleAs="h2"
    />
  );
}

/**
 * ISS-10005 AC2. Distinct from {@link HelpReaderMissing}: the bundle HAS this
 * page and handed over something the markdown pipeline cannot be given. Saying
 * "not found" would send the reader looking for a page that is right there.
 */
export function HelpReaderMalformed({
  docsSiteUrl,
}: Readonly<{ docsSiteUrl: string }>) {
  return (
    <div data-testid={HELP_SURFACE_V2_PAGE_MALFORMED_TEST_ID}>
      <EmptyState
        action={<ViewOnlineAction docsSiteUrl={docsSiteUrl} />}
        description="This page came back in a shape this version of the app can't render. The rest of the docs still work — or read this one online."
        icon={FileWarningIcon}
        title="This page can't be displayed"
        titleAs="h2"
      />
    </div>
  );
}

/**
 * ISS-10044. The page request did not come back, so nothing was read that could
 * support {@link HelpReaderMissing}'s claim about the snapshot's CONTENTS —
 * which is the sentence this branch used to render, and the reason a reader with
 * a perfectly good local copy was sent looking for it online.
 *
 * No retry control: `DocsHelpSource` exposes no way to re-issue the request, and
 * naming a move the reader cannot make is the defect one level down.
 */
export function HelpReaderUnavailable({
  docsSiteUrl,
}: Readonly<{ docsSiteUrl: string }>) {
  return (
    <div data-testid={HELP_SURFACE_V2_PAGE_ERROR_TEST_ID}>
      <EmptyState
        action={<ViewOnlineAction docsSiteUrl={docsSiteUrl} />}
        description="Something went wrong loading this page. This is on our end and usually temporary."
        icon={TriangleAlertIcon}
        title="Couldn't load this page"
        titleAs="h2"
      />
    </div>
  );
}

/**
 * Heading renderers that stamp a slug `id` on each rendered heading so the reader
 * can deep-link to a section. Kept out of `markdown-content`'s own defaults —
 * id-stamping is a Help concern (search deep-links), not a general markdown one.
 */
function markdownHeadingComponents(slugifyHeading: SlugifyHeading) {
  const idProps = (children: ReactNode) => ({
    id: slugifyHeading(getTextContent(children)),
  });
  return {
    h1: (props: ComponentPropsWithoutRef<"h1">) => (
      <h2 {...idProps(props.children)}>{props.children}</h2>
    ),
    h2: (props: ComponentPropsWithoutRef<"h2">) => (
      <h3 {...idProps(props.children)}>{props.children}</h3>
    ),
    h3: (props: ComponentPropsWithoutRef<"h3">) => (
      <h4 {...idProps(props.children)}>{props.children}</h4>
    ),
    h4: (props: ComponentPropsWithoutRef<"h4">) => (
      <h5 {...idProps(props.children)}>{props.children}</h5>
    ),
  };
}

/** Minimal CSS.escape shim for the `#id` querySelector (jsdom lacks it in some envs). */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(CSS_ESCAPE_RE, "\\$&");
}
