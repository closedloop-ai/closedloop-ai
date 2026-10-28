import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS_PANEL_ID,
  isSettingsPanelId,
  RETIRED_SETTINGS_PANEL_SUCCESSOR,
  SETTINGS_PANEL_GROUP_MEMBERS,
  SETTINGS_PANEL_IDS,
  SETTINGS_PANEL_LABEL,
} from "./settings-panel.ts";

// Written out by hand rather than derived from the module: a fixture built FROM
// the registry stays green when the registry is emptied, which is precisely the
// regression these assertions exist to catch. The duplication IS the test.
const PUBLISHED_GROUP_MEMBERS = {
  user: ["profile", "connected-devices", "plugins"],
  organization: ["organization", "members"],
  labs: [
    "custom-fields",
    "tags",
    "compliance",
    "api-keys",
    "desktop-app",
    "other-labs",
  ],
};

const PUBLISHED_LABELS = {
  profile: "Profile",
  "connected-devices": "Connected Devices",
  plugins: "Plugins",
  organization: "General",
  members: "Members",
  "custom-fields": "Custom Fields",
  tags: "Tags",
  compliance: "Compliance",
  "api-keys": "API Keys",
  "desktop-app": "Desktop App",
  "other-labs": "Other Labs Settings",
};

describe("settings panel contract", () => {
  it("publishes the panel ids, their groups, and their labels", () => {
    expect(SETTINGS_PANEL_GROUP_MEMBERS).toEqual(PUBLISHED_GROUP_MEMBERS);
    expect(SETTINGS_PANEL_LABEL).toEqual(PUBLISHED_LABELS);
    expect([...SETTINGS_PANEL_IDS]).toEqual([
      ...PUBLISHED_GROUP_MEMBERS.user,
      ...PUBLISHED_GROUP_MEMBERS.organization,
      ...PUBLISHED_GROUP_MEMBERS.labs,
    ]);
    expect(DEFAULT_SETTINGS_PANEL_ID).toBe("profile");
  });

  it("places every published id in exactly one group", () => {
    for (const id of SETTINGS_PANEL_IDS) {
      const owning = Object.values(SETTINGS_PANEL_GROUP_MEMBERS).filter(
        (members) => members.includes(id)
      );
      expect(owning).toHaveLength(1);
    }
  });

  it("recognises published ids and rejects anything else", () => {
    expect(isSettingsPanelId("members")).toBe(true);
    expect(isSettingsPanelId("Members")).toBe(false);
    expect(isSettingsPanelId("integrations")).toBe(false);
    expect(isSettingsPanelId(undefined)).toBe(false);
  });

  it("maps each retired id to a live panel, never to another retired one", () => {
    expect({ ...RETIRED_SETTINGS_PANEL_SUCCESSOR }).toEqual({
      "local-compute-targets": "connected-devices",
    });
    for (const [retired, successor] of Object.entries(
      RETIRED_SETTINGS_PANEL_SUCCESSOR
    )) {
      expect(isSettingsPanelId(retired)).toBe(false);
      expect(isSettingsPanelId(successor)).toBe(true);
    }
  });
});
