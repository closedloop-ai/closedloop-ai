// Single source for the Closedloop brand mark asset. Local dev (`next dev`)
// shows the purple mark; deployed builds (Vercel runs as production) show the
// blue mark, so it is obvious at a glance whether a tab is a local instance.
// Consumed by both the tab favicon (layout.tsx) and the landing header
// (page.tsx) so the two can never drift apart.
export const brandMarkSrc =
  process.env.NODE_ENV === "development" ? "/icon-local.png" : "/icon.png";
