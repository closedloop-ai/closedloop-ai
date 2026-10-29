import { parseSettingsRouteParams } from "@repo/api/src/types/settings-route";
import {
  type SettingsDismissal,
  SettingsDismissMode,
} from "@repo/app/settings/v2/components/settings-dismissal";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useMemo } from "react";
import { useRendererExceptionReporter } from "../renderer-exception-reporter";
import { DesktopSettingsV2Root } from "./desktop-settings-v2-root";

/**
 * COLD, not Overlay, on a router that restores pages (ISS-8370 D6). Overlay's
 * contract — the host must not navigate, focus restoration keyed to it — assumes
 * a portal over a still-mounted DOM sibling. The desktop hash router keeps
 * visited pages mounted, so "return without losing state" is already true of a
 * navigation back to the last page: dismiss navigates to `returnTo` and the
 * keep-alive page reappears with its state intact. Recorded as ISS-8977 AC1's
 * explicit reason the desktop shell differs.
 */
const COLD_DISMISSAL: SettingsDismissal = { mode: SettingsDismissMode.Cold };

/**
 * The Settings v2 modal as the desktop shell mounts it: the route's own query
 * parsed as on web, with `returnTo` defaulted to the shell's last page href —
 * nav page or detail — when the link carried none. Desktop hrefs are slug-free,
 * which is what `returnTo` is documented to carry on this host.
 *
 * D9: the panel boundary reports through the renderer's existing exception path
 * ({@link useRendererExceptionReporter}); no logging happens here.
 */
export function DesktopSettingsModal({
  returnHref,
}: Readonly<{ returnHref: string }>) {
  const searchParams = useSearchParamsValue();
  const reportException = useRendererExceptionReporter();
  const routeParams = useMemo(() => {
    const parsed = parseSettingsRouteParams(searchParams);
    return { ...parsed, returnTo: parsed.returnTo ?? returnHref };
  }, [returnHref, searchParams]);

  return (
    <DesktopSettingsV2Root
      dismissal={COLD_DISMISSAL}
      reportException={reportException}
      routeParams={routeParams}
    />
  );
}
