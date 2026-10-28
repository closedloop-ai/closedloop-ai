import {
  SettingsPanelCapability,
  SettingsPanelHost,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import { MonitorOffIcon } from "lucide-react";
import {
  defineSettingsPanel,
  type SettingsPanelDescriptor,
} from "./settings-panel-registry";

/**
 * The desktop composition root's explicit host-availability decision
 * (ISS-8370 D4): the panels that exist only on the web app.
 *
 * Two of them — Profile and Members — live in `apps/app` because their bodies
 * import Clerk or `@/`, so the desktop root cannot even import their
 * descriptors; this list is what stands in for them in
 * `assertSettingsPanelRegistryCompleteForHost`. Plugins and Organization
 * General are shared descriptors the desktop does register, listed here because
 * they declare `hosts: [Web]` and this list is the one place the whole web-only
 * set is written down. Whether each entry really is web-only is proved from the
 * web side, which can see every descriptor.
 */
export const WEB_ONLY_SETTINGS_PANEL_IDS: readonly SettingsPanelId[] =
  Object.freeze([
    SettingsPanelId.Profile,
    SettingsPanelId.Members,
    SettingsPanelId.Plugins,
    SettingsPanelId.OrganizationGeneral,
  ]);

/** The host the list above is unavailable on. */
export const WEB_ONLY_SETTINGS_PANEL_HOST: SettingsPanelHost =
  SettingsPanelHost.Desktop;

/**
 * Unreachable by construction: `unavailable` outranks every other resolution
 * outcome, so a placeholder body is never mounted on the host that registers
 * it. A throw rather than `null` so that, should the precedence ever change,
 * the panel boundary shows a visible failure instead of a blank.
 */
function WebOnlySettingsPanelPlaceholder(): never {
  throw new Error("This settings panel is only offered on the web app.");
}

function webOnlyPlaceholder(id: SettingsPanelId): SettingsPanelDescriptor {
  return defineSettingsPanel({
    hosts: [SettingsPanelHost.Web],
    icon: MonitorOffIcon,
    id,
    Panel: WebOnlySettingsPanelPlaceholder,
    requiredCapability: SettingsPanelCapability.Read,
  });
}

/**
 * Stand-in descriptors for the two web-owned panels, for the desktop's
 * RENDERED registry (ISS-8370 D8). They carry the one fact the desktop knows
 * about those panels — they exist, and not here — so a link naming Members
 * resolves `unavailable` ("isn't part of the desktop app", with a recovery
 * link) rather than `unknown` ("is not a settings panel"), and a plain visit
 * sees its default as unavailable and moves on to the first panel the host
 * offers. Never offered in navigation: the model does not list an unavailable
 * panel, so the icon is a neutral stand-in.
 */
export const WEB_ONLY_SETTINGS_PANEL_PLACEHOLDERS: readonly SettingsPanelDescriptor[] =
  Object.freeze([
    webOnlyPlaceholder(SettingsPanelId.Profile),
    webOnlyPlaceholder(SettingsPanelId.Members),
  ]);

/**
 * The mirror of the list above (ISS-10286): the panels that exist only on the
 * DESKTOP app. Desktop App is the whole set — its controls are held by the
 * Electron main process and reached through `window.desktopApi`, which no
 * browser has, so its descriptor cannot even be imported from `apps/app`.
 *
 * Kept as a named list for the same reason the web-only one is: the web root
 * asserts completeness over every id, and an id it can neither register nor
 * name here is a startup gap rather than a panel that quietly disappears.
 */
export const DESKTOP_ONLY_SETTINGS_PANEL_IDS: readonly SettingsPanelId[] =
  Object.freeze([SettingsPanelId.DesktopApp]);

function DesktopOnlySettingsPanelPlaceholder(): never {
  throw new Error("This settings panel is only offered on the desktop app.");
}

/**
 * Stand-in descriptors for the desktop-owned panels, for the WEB rendered
 * registry. Same job as {@link WEB_ONLY_SETTINGS_PANEL_PLACEHOLDERS} in the
 * other direction: a link naming Desktop App in a browser resolves
 * `unavailable` ("isn't part of the web app", with a recovery link) rather than
 * `unknown` ("is not a settings panel"), which is the true and more useful of
 * the two facts. Never offered in navigation, because the model does not list
 * an unavailable panel.
 */
export const DESKTOP_ONLY_SETTINGS_PANEL_PLACEHOLDERS: readonly SettingsPanelDescriptor[] =
  Object.freeze([
    defineSettingsPanel({
      hosts: [SettingsPanelHost.Desktop],
      icon: MonitorOffIcon,
      id: SettingsPanelId.DesktopApp,
      Panel: DesktopOnlySettingsPanelPlaceholder,
      requiredCapability: SettingsPanelCapability.Read,
    }),
  ]);
