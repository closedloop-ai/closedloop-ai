"use client";

import { Header } from "@/app/(authenticated)/components/header";
import { InboxHost } from "./inbox-host";

/**
 * Inbox index (ISS-9406).
 *
 * A thin adapter: shell chrome, then the host that owns this platform's
 * notification transport. The feature body is `InboxSurfaceV2` in
 * `@repo/app/inbox`.
 *
 * No `LiveblocksErrorBoundary` here (ISS-10202): at this height it would also
 * span the host's feature-flag gate, so a PostHog or gate throw would be
 * degraded as "inbox unavailable" instead of reaching this route's `error.tsx`.
 * The host mounts it around each Liveblocks-dependent body instead.
 */
export default function InboxPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={[{ label: "Inbox" }]} />
      <InboxHost />
    </div>
  );
}
