import type { SnippetSegment } from "../lib/search-display";

/**
 * Renders parsed `ts_headline` snippet segments, wrapping matched runs in a
 * `<mark>` and leaving the rest as plain spans. Shared by the results list
 * ({@link SearchHitRow}) and the sidebar typeahead ({@link TypeaheadItem}) so
 * the highlight treatment stays identical across both surfaces. The raw snippet
 * is never trusted as HTML — it is parsed into typed segments upstream by
 * `parseSnippetSegments`, not injected via `dangerouslySetInnerHTML`.
 */
export function SnippetHighlight({
  segments,
}: Readonly<{ segments: SnippetSegment[] }>) {
  return (
    <>
      {segments.map((segment) =>
        segment.highlighted ? (
          <mark
            className="bg-transparent font-medium text-foreground"
            key={segment.key}
          >
            {segment.text}
          </mark>
        ) : (
          <span key={segment.key}>{segment.text}</span>
        )
      )}
    </>
  );
}
