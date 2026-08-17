import { type SearchHit, searchHitRoute } from "@repo/api/src/types/search";
import {
  PHASE_1_SEARCH_ENTITY_TYPES,
  SearchEntityType,
} from "@repo/api/src/types/search-entity-kind";
import {
  BotIcon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  type LucideIcon,
  MessageSquareIcon,
  RotateCcwIcon,
  TerminalIcon,
} from "lucide-react";

/**
 * Human-facing label per unified-search entity type, shown on the type facet
 * chip of each hit. Exhaustive over {@link SearchEntityType} so a new corpus
 * member fails typecheck here until it is given a label (the Phase-2 members are
 * forward-declared and never emitted yet, but kept mapped for stability).
 */
export const SEARCH_ENTITY_TYPE_LABELS: Record<SearchEntityType, string> = {
  [SearchEntityType.Document]: "Document",
  [SearchEntityType.Project]: "Project",
  [SearchEntityType.Loop]: "Loop",
  [SearchEntityType.Comment]: "Comment",
  [SearchEntityType.PullRequest]: "Pull Request",
  [SearchEntityType.Branch]: "Branch",
  [SearchEntityType.AgentSession]: "Session",
  [SearchEntityType.AgentComponent]: "Component",
};

/**
 * A quiet, tokenized per-kind glyph used as the type marker at the head of a
 * result row and in the mouse-first Type control (FEA-4134, faithful to the
 * FEA-4031 prototype — no colored-circle chrome). Exhaustive over
 * {@link SearchEntityType} so a new corpus member fails typecheck until it is
 * given an icon.
 */
export const SEARCH_ENTITY_TYPE_ICONS: Record<SearchEntityType, LucideIcon> = {
  [SearchEntityType.Document]: FileTextIcon,
  [SearchEntityType.Project]: FolderIcon,
  [SearchEntityType.Loop]: RotateCcwIcon,
  [SearchEntityType.Comment]: MessageSquareIcon,
  [SearchEntityType.PullRequest]: GitPullRequestIcon,
  [SearchEntityType.Branch]: GitBranchIcon,
  [SearchEntityType.AgentSession]: TerminalIcon,
  [SearchEntityType.AgentComponent]: BotIcon,
};

/**
 * Stable display order for the mouse-first Type control — the queryable corpus
 * order, so the control lists exactly the kinds a `type:` filter can match.
 */
export const SEARCH_TYPE_CONTROL_ORDER: readonly SearchEntityType[] =
  PHASE_1_SEARCH_ENTITY_TYPES;

/** A parsed run of snippet text, flagged when it was a `ts_headline` match. */
export type SnippetSegment = {
  /** Stable React key for the segment within its snippet. */
  key: string;
  text: string;
  highlighted: boolean;
};

const SNIPPET_MATCH_OPEN = "<b>";
const SNIPPET_MATCH_CLOSE = "</b>";

/**
 * Split a `ts_headline` snippet into plain / highlighted segments. The server
 * emits Postgres' default `<b>…</b>` match markers; we parse them into typed
 * segments so the renderer can wrap matches in `<mark>` WITHOUT
 * `dangerouslySetInnerHTML` — the raw text is never trusted as HTML. Unknown or
 * unbalanced markup degrades to plain text.
 */
export function parseSnippetSegments(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let cursor = 0;

  while (cursor < snippet.length) {
    const open = snippet.indexOf(SNIPPET_MATCH_OPEN, cursor);
    if (open === -1) {
      pushSegment(segments, snippet.slice(cursor), false);
      break;
    }

    const close = snippet.indexOf(
      SNIPPET_MATCH_CLOSE,
      open + SNIPPET_MATCH_OPEN.length
    );
    if (close === -1) {
      // Unbalanced open marker — treat the remainder as plain text.
      pushSegment(segments, snippet.slice(cursor), false);
      break;
    }

    pushSegment(segments, snippet.slice(cursor, open), false);
    pushSegment(
      segments,
      snippet.slice(open + SNIPPET_MATCH_OPEN.length, close),
      true
    );
    cursor = close + SNIPPET_MATCH_CLOSE.length;
  }

  return segments;
}

/**
 * Prepend the org slug to an org-relative route fragment
 * (`/prds/<slug>` → `/<org>/prds/<slug>`). The API cannot know the requester's
 * org, so surfaces own this prefix.
 */
export function orgScopedDeepLink(orgSlug: string, deepLink: string): string {
  return `/${orgSlug}${deepLink}`;
}

/**
 * The org-RELATIVE route a hit should link to, or null when it cannot build a
 * safe route (a document missing its slug/subtype, a project missing its team).
 * A null result means "render a non-link row" so a click never lands on a 404.
 * Surfaces org-scope the result via their navigation adapter (`useOrgPath`).
 * Thin pass-through to the canonical {@link searchHitRoute} contract helper,
 * kept here so the render layer imports one search-display seam.
 */
export function searchHitOrgRelativeRoute(hit: SearchHit): string | null {
  return searchHitRoute(hit);
}

function pushSegment(
  segments: SnippetSegment[],
  text: string,
  highlighted: boolean
): void {
  if (text.length > 0) {
    // Key is stable within one snippet: the running offset of this segment plus
    // its highlight flag uniquely orders the split. Not an array index.
    const offset = segments.reduce((sum, s) => sum + s.text.length, 0);
    segments.push({
      key: `${offset}:${highlighted ? "h" : "p"}`,
      text,
      highlighted,
    });
  }
}
