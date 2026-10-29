import { DevToolsSetting } from "./dev-tools-settings";

/**
 * ISS-12048: every user-visible word the Dev Tools overlay renders, approved by
 * Daveth on 2026-10-06 (the ticket's Copy table, then "All flags" and "On this
 * page" the same day), and "Reset to prod" on 2026-10-07 (meeting decision
 * A4), then "Unknown" and "local override" on 2026-10-07. Control labels
 * (flag keys) are shown as-is and are not copy.
 */
export const DEV_TOOLS_LABEL = "Dev Tools";

export const DEV_TOOLS_FEATURE_FLAGS_TITLE = "Feature flags";

export const DEV_TOOLS_RESET_TO_PROD_LABEL = "Reset to prod";

export const DEV_TOOLS_SETTING_LABELS: Readonly<
  Record<DevToolsSetting, string>
> = {
  [DevToolsSetting.On]: "On",
  [DevToolsSetting.Off]: "Off",
};

/** The Feature flags section's show-all toggle; off lists only this page's flags. */
export const DEV_TOOLS_ALL_FLAGS_LABEL = "All flags";

/** Heads the flags this page checked when every flag is shown. */
export const DEV_TOOLS_ON_THIS_PAGE_LABEL = "On this page";

/** Temporary display while production values are unresolved, never a choice. */
export const DEV_TOOLS_UNKNOWN_LABEL = "Unknown";

const DEV_TOOLS_LOCAL_OVERRIDE_LABEL = "local override";

/** Approved screen-reader names for the selected, locally overridden option. */
export const DEV_TOOLS_OVERRIDDEN_SETTING_LABELS: Readonly<
  Record<DevToolsSetting, string>
> = {
  [DevToolsSetting.On]: `${DEV_TOOLS_SETTING_LABELS[DevToolsSetting.On]}, ${DEV_TOOLS_LOCAL_OVERRIDE_LABEL}`,
  [DevToolsSetting.Off]: `${DEV_TOOLS_SETTING_LABELS[DevToolsSetting.Off]}, ${DEV_TOOLS_LOCAL_OVERRIDE_LABEL}`,
};
