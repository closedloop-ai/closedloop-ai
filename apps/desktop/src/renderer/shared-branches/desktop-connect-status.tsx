import { DesktopGitHubConnectState } from "../components/branches/use-desktop-github-connect";
import {
  DesktopStatusBanner,
  type DesktopStatusBannerTone,
} from "./desktop-status-banner";

/**
 * Which branch surface renders the connect-GitHub status so the shared renderer
 * can pick the matching chrome and copy:
 * - `list` — the branches table header, a rounded inline card.
 * - `detail` — the branch detail view, a full-width bottom-border banner.
 *
 * Mirrors {@link DesktopStatusBannerVariant} so the variant passes straight
 * through to the shared banner.
 */
export type DesktopConnectStatusVariant = "list" | "detail";

type ConnectStatusContent = { tone: DesktopStatusBannerTone; message: string };

/**
 * Per-variant, per-state semantic tone + copy for {@link DesktopConnectStatus}.
 * The chrome and color tokens live in {@link DesktopStatusBanner}; this map only
 * carries the surface's tone and copy. Only the terminal states that surface
 * guidance appear here; `Idle`, `Pending`, and any future state fall through to
 * `null` (nothing rendered).
 */
const CONNECT_STATUS_CONTENT: Record<
  DesktopConnectStatusVariant,
  Partial<Record<DesktopGitHubConnectState, ConnectStatusContent>>
> = {
  list: {
    [DesktopGitHubConnectState.Opened]: {
      tone: "success",
      message:
        "Continue in the browser to connect GitHub. Branches refresh when the connection is available.",
    },
    [DesktopGitHubConnectState.SignInRequired]: {
      tone: "warning",
      message: "Sign in to ClosedLoop Desktop before connecting GitHub.",
    },
    [DesktopGitHubConnectState.Failed]: {
      tone: "error",
      message:
        "GitHub connect could not be opened. Local branch data remains available.",
    },
  },
  detail: {
    [DesktopGitHubConnectState.Opened]: {
      tone: "success",
      message:
        "Continue in the browser to connect GitHub. Branch details refresh when the connection is available.",
    },
    [DesktopGitHubConnectState.SignInRequired]: {
      tone: "warning",
      message: "Sign in to ClosedLoop Desktop before connecting GitHub.",
    },
    [DesktopGitHubConnectState.Failed]: {
      tone: "error",
      message:
        "GitHub connect could not be opened. Local branch details remain available.",
    },
  },
};

/**
 * Shared connect-GitHub status banner for the desktop branch views (list +
 * detail). Extracted so the enum branches and rendered markup live once instead
 * of being copy-pasted per view (FEA-2617); `variant` selects the surface's
 * chrome and copy while the state → guidance mapping stays identical.
 */
export function DesktopConnectStatus({
  state,
  variant,
}: {
  state: DesktopGitHubConnectState;
  variant: DesktopConnectStatusVariant;
}) {
  const content = CONNECT_STATUS_CONTENT[variant][state];
  if (!content) {
    return null;
  }
  return (
    <DesktopStatusBanner tone={content.tone} variant={variant}>
      {content.message}
    </DesktopStatusBanner>
  );
}
