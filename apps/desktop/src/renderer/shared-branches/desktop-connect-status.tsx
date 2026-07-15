import { DesktopGitHubConnectState } from "../components/branches/use-desktop-github-connect";

/**
 * Which branch surface renders the connect-GitHub status so the shared renderer
 * can pick the matching chrome and copy:
 * - `list` — the branches table header, a rounded inline card.
 * - `detail` — the branch detail view, a full-width bottom-border banner.
 */
export type DesktopConnectStatusVariant = "list" | "detail";

type ConnectStatusContent = { className: string; message: string };

/**
 * Per-variant, per-state chrome + copy for {@link DesktopConnectStatus}. Class
 * names are spelled out in full (never interpolated) so Tailwind's JIT keeps
 * them. Only the terminal states that surface guidance appear here; `Idle`,
 * `Pending`, and any future state fall through to `null` (nothing rendered).
 */
const CONNECT_STATUS_CONTENT: Record<
  DesktopConnectStatusVariant,
  Partial<Record<DesktopGitHubConnectState, ConnectStatusContent>>
> = {
  list: {
    [DesktopGitHubConnectState.Opened]: {
      className:
        "rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-900 text-xs",
      message:
        "Continue in the browser to connect GitHub. Branches refresh when the connection is available.",
    },
    [DesktopGitHubConnectState.SignInRequired]: {
      className:
        "rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 text-xs",
      message: "Sign in to ClosedLoop Desktop before connecting GitHub.",
    },
    [DesktopGitHubConnectState.Failed]: {
      className:
        "rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-900 text-xs",
      message:
        "GitHub connect could not be opened. Local branch data remains available.",
    },
  },
  detail: {
    [DesktopGitHubConnectState.Opened]: {
      className:
        "border-emerald-200 border-b bg-emerald-50 px-4 py-2 text-emerald-900 text-xs",
      message:
        "Continue in the browser to connect GitHub. Branch details refresh when the connection is available.",
    },
    [DesktopGitHubConnectState.SignInRequired]: {
      className:
        "border-amber-200 border-b bg-amber-50 px-4 py-2 text-amber-900 text-xs",
      message: "Sign in to ClosedLoop Desktop before connecting GitHub.",
    },
    [DesktopGitHubConnectState.Failed]: {
      className:
        "border-red-200 border-b bg-red-50 px-4 py-2 text-red-900 text-xs",
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
  return <div className={content.className}>{content.message}</div>;
}
