// Per-entity-kind icon + snippet-highlight helpers for the results list.
// The icon is a tokenized lucide glyph (no colored-circle chrome), used as a
// quiet type marker at the head of each row. The snippet renderer mirrors the
// real SnippetHighlight: it parses the server's <b>…</b> ts_headline markers
// into typed segments and wraps matches in <mark>, never dangerouslySetInnerHTML.

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
import type { ReactNode } from "react";
import { EntityKind } from "../search-model";

export const KIND_ICONS: Record<EntityKind, LucideIcon> = {
  [EntityKind.Document]: FileTextIcon,
  [EntityKind.Project]: FolderIcon,
  [EntityKind.Loop]: RotateCcwIcon,
  [EntityKind.Comment]: MessageSquareIcon,
  [EntityKind.PullRequest]: GitPullRequestIcon,
  [EntityKind.Branch]: GitBranchIcon,
  [EntityKind.Session]: TerminalIcon,
  [EntityKind.Component]: BotIcon,
};

const MATCH_OPEN = "<b>";
const MATCH_CLOSE = "</b>";

type Segment = { key: string; text: string; highlighted: boolean };

// Split on the ts_headline <b>…</b> match markers into plain / highlighted runs.
function parseSegments(snippet: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  let index = 0;

  while (cursor < snippet.length) {
    const open = snippet.indexOf(MATCH_OPEN, cursor);
    if (open === -1) {
      pushSegment(segments, snippet.slice(cursor), false, index);
      break;
    }
    const close = snippet.indexOf(MATCH_CLOSE, open + MATCH_OPEN.length);
    if (close === -1) {
      pushSegment(segments, snippet.slice(cursor), false, index);
      break;
    }
    pushSegment(segments, snippet.slice(cursor, open), false, index);
    index += 1;
    pushSegment(
      segments,
      snippet.slice(open + MATCH_OPEN.length, close),
      true,
      index
    );
    index += 1;
    cursor = close + MATCH_CLOSE.length;
  }
  return segments;
}

function pushSegment(
  segments: Segment[],
  text: string,
  highlighted: boolean,
  index: number
): void {
  if (text.length === 0) {
    return;
  }
  segments.push({ key: `${index}`, text, highlighted });
}

export function SnippetHighlight({
  snippet,
}: Readonly<{ snippet: string }>): ReactNode {
  return parseSegments(snippet).map((segment) =>
    segment.highlighted ? (
      <mark
        className="rounded-sm bg-primary/15 px-0.5 text-foreground"
        key={segment.key}
      >
        {segment.text}
      </mark>
    ) : (
      <span key={segment.key}>{segment.text}</span>
    )
  );
}
