import {
  SETTINGS_PANEL_LABEL,
  type SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { expect, within } from "storybook/test";
import { SettingsRouteRoot } from "@/app/(authenticated)/[orgSlug]/settings/settings-route-root";
import {
  resolveSettingsV2RouteState,
  SettingsRoutePresentation,
} from "@/app/(authenticated)/[orgSlug]/settings/settings-route-state";
import { DEFAULT_SETTINGS_TAB } from "@/app/(authenticated)/[orgSlug]/settings/settings-tabs";
import { LivePage } from "./live-page";
import { LIVE_ORG_SLUG, type LiveRoute } from "./live-route";

/** Where Settings lives: `/<org>/settings`. No Global Nav item is active there. */
export const SETTINGS_PATH = "/settings";

/** The live URL of one Settings panel: `/<org>/settings?panel=<id>`. */
export function settingsPanelRoute(panel: string): LiveRoute {
  return { path: `/${LIVE_ORG_SLUG}${SETTINGS_PATH}?panel=${panel}` };
}

/**
 * The live Settings page, `[orgSlug]/settings/page.tsx`, as a cold load of
 * `/<org>/settings?panel=…` renders it: the app frame with an empty content
 * column (the page's only child is the dialog, which portals out), and the
 * Settings v2 dialog over it.
 *
 * The page is a server component; what it hands its client root is derived
 * here exactly as `settings-route-page.tsx` derives it, from the URL the story
 * is at, so the rail's links move the dialog between panels as they do live.
 * `isAdmin` is the Clerk stand-in's `org:admin`.
 */
export function SettingsLivePage() {
  const search = useSearchParamsValue();
  const params = Object.fromEntries(search.entries());
  return (
    <LivePage activePath={SETTINGS_PATH}>
      <SettingsRouteRoot
        initialTab={DEFAULT_SETTINGS_TAB}
        isAdmin
        presentation={SettingsRoutePresentation.Full}
        v2={resolveSettingsV2RouteState(params)}
      />
    </LivePage>
  );
}

/**
 * Asserts the Settings dialog is open on `panel`: its rail entry is the
 * current page.
 */
export async function expectSettingsPanel(
  canvasElement: HTMLElement,
  panel: SettingsPanelId
) {
  // The dialog portals to the document body, outside the story canvas.
  const body = within(canvasElement.ownerDocument.body);
  const dialog = await body.findByRole("dialog", {}, { timeout: 10_000 });
  const entry = await within(dialog).findByRole("link", {
    name: SETTINGS_PANEL_LABEL[panel],
  });
  await expect(entry).toHaveAttribute("aria-current", "page");
}
