"use client";

import {
  GOOGLE_OAUTH_CALLBACK_MESSAGE_PARAM,
  GOOGLE_OAUTH_CALLBACK_PARAM,
  GoogleOAuthCallbackOutcome,
} from "@repo/api/src/types/integration-connect-routes";
import {
  SETTINGS_PANEL_PARAM,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useEffect } from "react";

/**
 * Reports the result of a Google Drive OAuth round trip on the Plugins panel
 * (ISS-10316).
 *
 * The OAuth route returns to `/settings?google=<outcome>`, and the deep-link
 * adapter opens this panel for it. The card does not read the param, so
 * without this hook every outcome would be dropped without a word. Ported from
 * the legacy Settings page's callback effect, which said the same two things.
 *
 * The consumed params are then removed from the address bar, and
 * `panel=plugins` written in their place, so a reload neither repeats the toast nor lands on a
 * different panel.
 */
export function useGoogleOAuthCallbackOutcome(): void {
  const searchParams = useSearchParamsValue();
  const outcome = searchParams.get(GOOGLE_OAUTH_CALLBACK_PARAM);

  useEffect(() => {
    if (!outcome) {
      return;
    }
    if (outcome === GoogleOAuthCallbackOutcome.Success) {
      toast.success("Google Drive connected successfully");
    } else if (outcome === GoogleOAuthCallbackOutcome.Error) {
      toast.error("Failed to connect Google Drive");
    }

    const url = new URL(globalThis.location.href);
    url.searchParams.delete(GOOGLE_OAUTH_CALLBACK_PARAM);
    url.searchParams.delete(GOOGLE_OAUTH_CALLBACK_MESSAGE_PARAM);
    // The routes still return to `?tab=integrations`; `panel` replaces it.
    url.searchParams.delete(SETTINGS_TAB_PARAM);
    url.searchParams.set(SETTINGS_PANEL_PARAM, SettingsPanelId.Plugins);
    globalThis.history.replaceState(
      globalThis.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`
    );
  }, [outcome]);
}

/** The legacy Settings tab key the OAuth routes still redirect with. */
const SETTINGS_TAB_PARAM = "tab";
