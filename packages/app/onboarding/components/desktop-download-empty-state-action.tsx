"use client";

import { DESKTOP_LATEST_RELEASE_PAGE_URL } from "@repo/api/src/types/desktop-download";
import {
  WORKSPACE_MENU_ENTRY_LABEL,
  WorkspaceMenuEntryId,
} from "@repo/api/src/types/workspace-menu";
import { Button } from "@repo/design-system/components/ui/button";
import { useDetectedDesktopOs } from "../hooks/use-detected-desktop-os";
import { DEFAULT_DESKTOP_DOWNLOAD_HREFS } from "../lib/desktop-platform-availability";
import { DesktopDownloadAction } from "./desktop-download-action";

/**
 * The desktop-download offer as an empty state's action slot (ISS-11261).
 *
 * The web dashboard's zero-session card used to offer `Connect a compute target`
 * pointing at Settings. A reader with no sessions has, overwhelmingly, no desktop
 * app installed, so that named an internal concept and routed them to a page that
 * cannot help until the app exists. This renders the guided-onboarding
 * `DownloadDesktop` step's OWN composite instead — same component, same approved
 * strings, same platform arms.
 *
 * WHY IT LIVES IN `packages/app/onboarding` rather than beside the route. The
 * composite, the platform map and the approved copy are all owned here, and this
 * is the second surface to consume them; a route-local host would be a second
 * place deciding which installer a platform gets.
 */
export function DesktopDownloadEmptyStateAction() {
  const detectedOs = useDetectedDesktopOs();

  // `w-full` is load-bearing, not a restatement of the parent's own `max-w-sm`:
  // the design-system `EmptyContent` this lands in is `items-center`, so a
  // wrapper without it shrinks to its content and the composite's full-width
  // controls size to their labels instead of the column. The wrapper itself
  // keeps the composite as ONE flex child, so its internal `mb-3` rhythm — the
  // spacing the wizard's arms were drawn with — is what separates the rows
  // rather than `EmptyContent`'s own gap.
  return (
    <div className="mx-auto w-full max-w-sm">
      <DesktopDownloadAction
        detectedOs={detectedOs}
        // Nothing on this surface records an install, and unlike the wizard
        // nothing here writes one, so `false` is what it honestly knows rather
        // than a claim that this reader has never installed Desktop. The web
        // dashboard mounts this on every empty card, a dormant org's included
        // (PLN-2216 R5), whose readers may already have it. This card has no
        // run to advance, which is why `postInstallAction` below is the same
        // forward move rather than a wizard `Continue` with nothing to continue
        // to.
        downloaded={false}
        downloadHrefs={DEFAULT_DESKTOP_DOWNLOAD_HREFS}
        noInstallerAction={<DesktopReleasePageAction />}
        onDownload={noteDownload}
        postInstallAction={<DesktopReleasePageAction />}
      />
    </div>
  );
}

/**
 * The forward control for the arms that offer no installer.
 *
 * The wizard's equivalent advances its run; this card has no run, so the honest
 * forward move is the CHANNEL'S RELEASE PAGE — platform-neutral by construction
 * and, per ISS-9708, the correct link exactly where the reader's platform has no
 * artifact of its own. It is what the gap sentence directly above it says exists,
 * so the arm withdraws nothing and strands nobody: a Windows or Linux reader gets
 * the state in words plus somewhere to go, never a `.dmg` they cannot run.
 *
 * Its label is the canonical one for a platform-neutral desktop-download link
 * (`WorkspaceMenuEntryId.DownloadDesktop`), not a fourth spelling.
 */
function DesktopReleasePageAction() {
  return (
    <Button asChild className="w-full" size="lg" variant="outline">
      {/* External page, so a raw anchor is correct here — the in-app Link rule
          governs internal routes. */}
      <a
        href={DESKTOP_LATEST_RELEASE_PAGE_URL}
        rel="noreferrer"
        target="_blank"
      >
        {WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.DownloadDesktop]}
      </a>
    </Button>
  );
}

/**
 * `onDownload` is the composite's install-click hook, and it exists for the
 * wizard's run bookkeeping. This surface keeps no such record — an empty card is
 * not a phase — so pressing the installer needs no side effect here. A no-op
 * rather than an optional prop, because the composite requires the callback and
 * an optional one would let a host that DOES need the record forget it.
 */
function noteDownload() {
  return;
}
