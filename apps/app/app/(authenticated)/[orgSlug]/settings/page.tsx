import {
  type SettingsPageProperties,
  SettingsRoutePage,
} from "./settings-route-page";
import { SettingsRoutePresentation } from "./settings-route-state";

export type { SettingsPageProperties } from "./settings-route-page";

/**
 * The full-page Settings route. Its intercepted twin is
 * `[orgSlug]/@settings/(.)settings/page.tsx`; both render
 * {@link SettingsRoutePage} (ISS-8370 D2).
 */
export default function Page(props: Readonly<SettingsPageProperties>) {
  return SettingsRoutePage({
    ...props,
    presentation: SettingsRoutePresentation.Full,
  });
}
