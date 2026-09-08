"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Maps a `meta.title` to the id of its first story, read from Storybook's own
 * `/index.json` at runtime.
 *
 * Deriving the id from the title by hand would mean re-implementing
 * Storybook's `sanitize` + story-name suffix rules here, and the second half of
 * that is not derivable at all — a component whose first story is `Complete
 * With Deltas` has no `--default` to guess at. Asking the running instance is
 * both shorter and cannot drift when a story is renamed.
 */
export function useStoryIdsByTitle() {
  const [idsByTitle, setIdsByTitle] = useState<Record<string, string> | null>(
    null
  );

  useEffect(() => {
    let cancelled = false;

    fetch("/index.json")
      .then((response) => response.json())
      .then((index: { entries?: Record<string, IndexEntry> }) => {
        if (cancelled) {
          return;
        }
        const next: Record<string, string> = {};
        for (const entry of Object.values(index.entries ?? {})) {
          // First story wins: entries arrive in declaration order, so this is
          // the story an author would consider the component's front door.
          if (entry.type === "story" && !next[entry.title]) {
            next[entry.title] = entry.id;
          }
        }
        setIdsByTitle(next);
      })
      .catch(() => {
        if (!cancelled) {
          setIdsByTitle({});
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return idsByTitle;
}

type IndexEntry = {
  id: string;
  title: string;
  type: string;
};

/**
 * Renders a story in an iframe, but only once the card has actually been
 * scrolled near the viewport.
 *
 * The catalog lists several hundred entries. Mounting every preview eagerly
 * would boot several hundred React trees into one page on first paint; the
 * observer keeps the cost proportional to what has been looked at. Each
 * preview is its own document, so a component that throws takes down its own
 * card and nothing else on the page.
 */
export function StoryPreview({
  storyId,
  title,
}: Readonly<{ storyId: string | undefined; title: string }>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [shouldLoad, setShouldLoad] = useState(false);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || shouldLoad) {
      return;
    }

    const observer = new IntersectionObserver(
      (observed) => {
        if (observed.some((item) => item.isIntersecting)) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      // Start fetching a screen early so a preview is usually painted by the
      // time it scrolls into view.
      { rootMargin: "400px" }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [shouldLoad]);

  return (
    <div
      className="relative h-40 overflow-hidden rounded-md border bg-background"
      ref={containerRef}
    >
      {/* Sits behind the iframe rather than being toggled by an onLoad
          handler: biome rejects event handlers on non-interactive elements,
          and the iframe paints its own opaque background over this as soon as
          it has something to show. */}
      {shouldLoad && storyId ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-muted-foreground text-xs">Loading…</span>
        </div>
      ) : null}
      {shouldLoad && storyId ? (
        <iframe
          className="relative h-[320px] w-[200%] origin-top-left scale-50 border-0 bg-background"
          loading="lazy"
          src={`/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story`}
          title={`Preview of ${title}`}
        />
      ) : null}
      {shouldLoad && !storyId ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-muted-foreground text-xs">
            No story to preview
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Navigates the whole Storybook, not the preview iframe this page renders
 * inside — hence `target="_top"`. Without it the manager chrome would end up
 * nested inside its own preview pane.
 */
export function OpenStoryLink({
  storyId,
}: Readonly<{ storyId: string | undefined }>) {
  if (!storyId) {
    return null;
  }

  return (
    <a
      className="inline-flex items-center gap-1 font-medium text-link text-xs underline underline-offset-2"
      href={`/?path=/story/${encodeURIComponent(storyId)}`}
      target="_top"
    >
      Open story →
    </a>
  );
}
