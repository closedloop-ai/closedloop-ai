import { type ReactNode, Suspense } from "react";
import { lazyWithRetry } from "../lazy-with-retry";
import { NavId } from "../navigation/route-table";

// Lazy for the same reason every route-owned view in the shell is: the modal
// pulls the shared Settings v2 stack into the module graph, and the shell must
// paint before it (see `insights-route-lazy-load.test.tsx`).
const DesktopSettingsModal = lazyWithRetry(() =>
  import("./desktop-settings-modal").then((m) => ({
    default: m.DesktopSettingsModal,
  }))
);

/**
 * The Settings overlay host beside the nav map (ISS-8370 D6). Settings is not a
 * nav PAGE on desktop: it is the PRD-691 modal presented over the last nav page,
 * so the keep-alive map never mounts it. Renders the modal while the route is
 * `#/settings`, in Cold mode with `returnTo` defaulted to `returnHref` — the
 * shell's last non-Settings route, nav page or detail — and nothing otherwise.
 */
export function DesktopSettingsModalHost({
  requestedNavId,
  returnHref,
}: {
  requestedNavId: NavId | null;
  returnHref: string;
}): ReactNode {
  if (requestedNavId !== NavId.Settings) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <DesktopSettingsModal returnHref={returnHref} />
    </Suspense>
  );
}
