"use client";

import {
  isWorkspaceMenuEntryRendered,
  WORKSPACE_MENU_ENTRY_LABEL,
  type WorkspaceMenuCapabilities,
  WorkspaceMenuCapabilityStatus,
  WorkspaceMenuEntryId,
} from "@repo/api/src/types/workspace-menu";
// Cross-slice on purpose (ISS-9682/ISS-9651): onboarding owns the ONE map of
// which desktop installers exist, how each platform is spelled on screen, and
// how the gap is said out loud. This menu is the third download surface reading
// it, and a settings-local copy is exactly how it would come to offer a `.dmg`
// the checklist row and the wizard step had already stopped offering.
import { useDetectedDesktopOs } from "@repo/app/onboarding/hooks/use-detected-desktop-os";
import {
  DEFAULT_DESKTOP_DOWNLOAD_HREFS,
  DesktopOs,
  type DetectedPlatform,
  describeDesktopInstallerGap,
  desktopInstallerIsPublished,
  isDesktopOs,
} from "@repo/app/onboarding/lib/desktop-platform-availability";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@repo/design-system/components/ui/dropdown-menu";
import { useId } from "react";
import { ITEM_CLASSNAME } from "./workspace-menu-styles";

/**
 * The workspace menu's "Download desktop app" entry, in every state it has
 * (ISS-8363 for the entry, ISS-9682 for the platform states).
 *
 * Its own file rather than more of `workspace-menu.tsx`: this is the one entry
 * with a decision behind it, and keeping it here is what lets the menu itself
 * go on reading no feature flag. `workspace-menu-trigger.tsx` and
 * `workspace-switcher-submenu.tsx` are split out of that file for the same
 * reason, and, like the submenu, this declares the shared item padding locally
 * rather than reaching across for it.
 */

function DownloadDesktopLink({ downloadUrl }: { downloadUrl: string }) {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild className={ITEM_CLASSNAME}>
        {/* External asset, so a raw anchor is correct here — the in-app Link
            rule governs internal routes. */}
        <a href={downloadUrl} rel="noreferrer" target="_blank">
          {WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.DownloadDesktop]}
        </a>
      </DropdownMenuItem>
    </>
  );
}

/**
 * The download entry present but not offering an artifact.
 *
 * TWO SLOTS, not one line. Half strength is right for an action you cannot take
 * and wrong for the sentence explaining why: on `popover` that sentence measures
 * 3.2:1 in light mode, under the 4.5:1 of WCAG 1.4.3. So the dimmed slot keeps
 * only the label — an inactive control, which 1.4.3 exempts — and `detail` goes
 * in a full-strength `DropdownMenuLabel`, tied to the row by `aria-describedby`
 * so the two are one announcement rather than two loose lines. That is the shape
 * the sign-out failure below already uses, and the label-plus-description shape
 * both ISS-9651 surfaces use. Splitting them also stops a 51-character line
 * wrapping mid-sentence inside a `w-72` menu.
 *
 * `detail` is required rather than optional so each caller states its choice:
 * `null` is "withhold the download, claim nothing", which is a different thing
 * from having no sentence to hand.
 *
 * EVERY unavailable state of this entry goes through here, which is ISS-9753.
 * The release-lookup failure used to be its own row with Radix's `disabled`
 * prop, so two rows that look identical behaved differently for anyone not
 * using a mouse -- and the divergence was worse than the original bug, because
 * it is invisible to a sighted mouse user and leaves the next editor of this
 * menu two patterns to choose between. One shape, one caller contract: hand it
 * the sentence, or `null`. There is no second spelling of an unavailable row
 * left in this file.
 *
 * Also exported for its stories. The platform states are unreachable from a
 * `WorkspaceMenu` story: the platform arrives from `navigator` through
 * {@link useDetectedDesktopOs}, so a whole-menu story would render the link on
 * the reviewer's Mac and the gap row on the Linux runner -- the two states
 * would be viewable by nobody and everybody respectively. Driven by its one
 * prop instead, both are the same everywhere.
 */
export function DownloadDesktopUnavailable({
  detail,
}: {
  detail: string | null;
}) {
  const detailId = useId();

  return (
    <>
      <DropdownMenuSeparator />
      {/* `aria-disabled` and a prevented `onSelect`, NOT Radix's `disabled`
          prop: `disabled` drops the row out of the menu's roving focus, so a
          keyboard or screen-reader user arrows straight past it and never
          learns the download exists OR why it is unavailable — which is the
          only thing this row is here to say. WAI-ARIA APG keeps an unavailable
          menu option focusable for exactly that reason.

          `opacity-50` AND `cursor-default` are applied by hand because the
          catalog item gates its dimming on `data-[disabled]:`, an attribute
          only Radix's prop produces, while `cursor-pointer` sits unconditional
          in the same base class. Half strength alone left the row wearing a
          pointer cursor and answering nothing on click -- a quieter version of
          the promise the `.dmg` link was making. The hover highlight stays: the
          row is deliberately focusable, so it owes a focus response. */}
      <DropdownMenuItem
        aria-describedby={detail ? detailId : undefined}
        aria-disabled
        className={`${ITEM_CLASSNAME} cursor-default opacity-50`}
        onSelect={(event) => event.preventDefault()}
      >
        {WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.DownloadDesktop]}
      </DropdownMenuItem>
      {detail ? (
        <DropdownMenuLabel
          className="font-normal text-muted-foreground text-xs"
          id={detailId}
        >
          {detail}
        </DropdownMenuLabel>
      ) : null}
    </>
  );
}

/**
 * The download entry narrowed to what the visitor's machine can actually run
 * (ISS-9682, PRD-685 FR11).
 *
 * `downloadUrl` is one artifact for every visitor — the release lookup resolves
 * the macOS `.dmg`, and the host has no platform to resolve it against — so on
 * Windows or Linux this item was a one-click download of a disk image that
 * cannot open there, under a label byte-identical to every entry that works.
 *
 * The platform decision stays at this render site rather than moving into
 * {@link WorkspaceMenuCapabilities}: a capability carries a
 * {@link WorkspaceMenuCapabilityReason} and no payload, so the OS the gap
 * sentence names would have to be re-derived here anyway — two owners for one
 * fact, which is how they come to disagree.
 */
function PlatformAwareDownloadItem({ downloadUrl }: { downloadUrl: string }) {
  const detectedOs = useDetectedDesktopOs();

  // Nobody has looked yet: withhold the link WITHOUT claiming a gap, which is
  // the checklist row's move for this same state. The entry keeps its slot
  // rather than returning null — the menu content mounts on open and this effect
  // resolves a frame later, so vanishing here would insert the entry and its
  // separator a beat late and shove Switch workspace and Log out down under the
  // cursor, on every platform including the ones that never needed withholding.
  if (detectedOs === null) {
    return <DownloadDesktopUnavailable detail={null} />;
  }

  // Named AND unpublished — the only state that has to withhold the artifact.
  // Both strings come from their canonical owners, so this surface cannot drift
  // from the checklist row and the wizard.
  //
  // DISABLED AND VISIBLE, never hidden. Perrin's call on the ISS-9682 review
  // (2026-09-08), settling the question that ticket parked: an inert row tells a
  // Windows user the app exists and is merely unpublished for their platform,
  // where an absent row says nothing -- and "nothing" reads as "not supported",
  // a different wrong claim and the same class of lie FR11 exists to stop. That
  // ruling is what makes the `aria-disabled` roving-focus shape above
  // load-bearing rather than ceremony: the gap sentence is the whole point of
  // the row, so the row has to be reachable to say it.
  if (isDesktopOs(detectedOs) && !desktopInstallerIsPublished(detectedOs)) {
    return (
      <DownloadDesktopUnavailable
        detail={describeDesktopInstallerGap(detectedOs).headline}
      />
    );
  }

  // Published, or a completed read that named no desktop OS. The unrecognized
  // half keeps the link deliberately: this entry names no platform, so one link
  // misroutes nobody, and withholding it would also strip the installer from a
  // Mac whose agent could not be parsed — the capability loss Perrin's ISS-9651
  // ruling refused.
  return (
    <DownloadDesktopLink
      downloadUrl={downloadUrlForPlatform(detectedOs, downloadUrl)}
    />
  );
}

export function DownloadDesktopItem({
  capabilities,
  downloadUrl,
}: {
  capabilities: WorkspaceMenuCapabilities;
  downloadUrl: string | null;
}) {
  const capability = capabilities[WorkspaceMenuEntryId.DownloadDesktop];

  // A host that has no such feature renders nothing. A host that HAS it and
  // could not resolve a link says so — rendering both as "no item" makes a
  // failure look like the feature does not exist, which is the conflation the
  // capability union exists to prevent.
  if (capability.status === WorkspaceMenuCapabilityStatus.Error) {
    return (
      <DownloadDesktopUnavailable detail={DOWNLOAD_LOOKUP_FAILED_DETAIL} />
    );
  }

  if (!(isWorkspaceMenuEntryRendered(capability) && downloadUrl)) {
    return null;
  }
  return <PlatformAwareDownloadItem downloadUrl={downloadUrl} />;
}

/**
 * What a failed release lookup says, and what it deliberately does NOT say.
 *
 * `WorkspaceMenuCapabilityReason.ReadFailed` is raised for TWO situations, and
 * the adapter's own docstring says so: the request failed, and the request
 * SUCCEEDED but `sanitizeElectronReleaseInfo` rejected a non-allow-listed URL
 * (`apps/app/lib/workspace-menu-host/web-workspace-menu-host-adapter.tsx`). In
 * the second, nothing was unreachable and retrying returns the same rejected
 * response forever. So this names the outcome a user can act on and asserts no
 * cause — the earlier "could not reach releases. Try again shortly." was a
 * confident wrong diagnosis in one of the two, and `aria-describedby` makes
 * whatever it says the ANNOUNCED reason, so a screen-reader user hears it first.
 * If that reason is ever split in two, branch here and each half may say more.
 */
export const DOWNLOAD_LOOKUP_FAILED_DETAIL = "No download link is available.";

/**
 * ISS-12614: the release lookup resolves only the macOS `.dmg`, so another
 * published platform links to its own installer from the shared href map.
 */
function downloadUrlForPlatform(
  os: DetectedPlatform,
  releaseDownloadUrl: string
): string {
  if (!isDesktopOs(os) || os === DesktopOs.Mac) {
    return releaseDownloadUrl;
  }
  return DEFAULT_DESKTOP_DOWNLOAD_HREFS[os] ?? releaseDownloadUrl;
}
