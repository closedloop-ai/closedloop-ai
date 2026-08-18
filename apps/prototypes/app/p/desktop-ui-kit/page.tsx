import { DesktopShell } from "./components/desktop-shell";
import { SessionsView } from "./components/sessions-view";

// Sessions is the desktop landing page; like the real app it relies on the
// topbar breadcrumb for its name rather than an in-body heading, and the
// toolbar (time window + Filter + View) leads the content area.
const DesktopUiKitPrototypePage = () => (
  <DesktopShell breadcrumbs={[{ label: "Sessions", isCurrent: true }]}>
    <SessionsView />
  </DesktopShell>
);

export default DesktopUiKitPrototypePage;
