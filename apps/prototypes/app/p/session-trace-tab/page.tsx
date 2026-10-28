"use client";

import { SessionTracePreviewPanel } from "@repo/app/agents/components/detail/trace/preview/session-trace-preview-panel";

/**
 * The route is a mock HOST and nothing else: it owns the viewport the chart
 * fills and supplies no state of its own. Every control's state lives in the
 * URL, read and written by the surface itself, so a view of this session is a
 * link somebody else can open — which is the whole argument the chart makes
 * about evidence, and which it could not make as a tab inside another
 * prototype whose own tab state was React-local.
 *
 * `h-dvh` rather than a min-height: the surface is a two-pane layout with its
 * own internal scrolling (the toolbar and ruler pin inside the left pane, the
 * inspector scrolls independently), so it needs a bounded height to divide
 * rather than a page that grows.
 */
const SessionTraceTabPrototypePage = () => (
  <main className="flex h-dvh min-h-0 flex-col overflow-hidden">
    <SessionTracePreviewPanel />
  </main>
);

export default SessionTraceTabPrototypePage;
