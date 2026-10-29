import type { DesktopGitHubConnectState } from "../components/branches/use-desktop-github-connect";
import {
  DesktopGitHubConnectSurface,
  desktopGitHubConnectMessage,
} from "./desktop-github-connect-copy";
import {
  DesktopStatusBanner,
  type DesktopStatusBannerVariant,
} from "./desktop-status-banner";

/**
 * Which list surface renders the connect-GitHub status, selecting its copy. The
 * `panel` surface is excluded: ISS-11274 removed the Branches detail banner and
 * the approved design places no connect status on a detail view, so this
 * component only ever renders the list-shaped ones.
 *
 * No longer the banner's chrome token too. ISS-11326 split the stalled Branches
 * slot out so it can say something its empty screen can back, and the two still
 * share one chrome — {@link LIST_BANNER_VARIANT} is what that costs, in place of
 * the identity this used to rely on.
 */
export type DesktopConnectStatusVariant = Exclude<
  DesktopGitHubConnectSurface,
  "panel"
>;

/**
 * The chrome both list surfaces wear: a rounded inline card above a list. A
 * `Record` rather than a fallback so adding a fourth surface fails `tsc` here
 * instead of silently inheriting one page's chrome.
 */
const LIST_BANNER_VARIANT: Record<
  DesktopConnectStatusVariant,
  DesktopStatusBannerVariant
> = {
  [DesktopGitHubConnectSurface.List]: "list",
  [DesktopGitHubConnectSurface.StalledList]: "list",
};

/**
 * Shared connect-GitHub status banner for the desktop list surfaces that offer
 * the connect ask: Sessions, Insights and the Dashboard (which mounts the same
 * `DesktopInsightsProvider` banner) on `list`, and the Branches stalled-load
 * slot on `stalledList`, whose retained ISS-10645 ask reports its outcome here
 * (ISS-11274). No
 * variant's copy names a page, because none of them renders on only one
 * (ISS-11326). Extracted so the enum
 * branches and rendered markup live once instead of being copy-pasted per view
 * (FEA-2617); the tone + copy come from the one desktop connect-copy map
 * (ISS-5958) that the Settings and onboarding surfaces also read.
 */
export function DesktopConnectStatus({
  state,
  variant,
}: {
  state: DesktopGitHubConnectState;
  variant: DesktopConnectStatusVariant;
}) {
  const content = desktopGitHubConnectMessage(state, variant);
  if (!content) {
    return null;
  }
  return (
    <DesktopStatusBanner
      tone={content.tone}
      variant={LIST_BANNER_VARIANT[variant]}
    >
      {content.message}
    </DesktopStatusBanner>
  );
}
