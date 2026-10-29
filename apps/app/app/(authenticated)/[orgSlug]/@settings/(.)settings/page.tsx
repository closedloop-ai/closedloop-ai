import type { SettingsPageProperties } from "../../settings/settings-route-page";
import { SettingsRoutePage } from "../../settings/settings-route-page";
import { SettingsRoutePresentation } from "../../settings/settings-route-state";

/**
 * The intercepted twin of `[orgSlug]/settings/page.tsx` (ISS-8370 D2): the
 * same server module, presented over the surface the user navigated from. It
 * defines `/settings` only — the legacy sub-routes
 * (`/settings/integrations/desktop/*`) have no counterpart here and are never
 * intercepted.
 */
export default function InterceptedSettingsPage(
  props: Readonly<SettingsPageProperties>
) {
  return SettingsRoutePage({
    ...props,
    presentation: SettingsRoutePresentation.Intercepted,
  });
}
