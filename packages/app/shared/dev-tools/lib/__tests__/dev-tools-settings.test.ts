import { describe, expect, it } from "vitest";
import { DEV_TOOLS_SETTING_LABELS } from "../dev-tools-copy";
import {
  applyDevToolsSetting,
  DEV_TOOLS_SETTING_ORDER,
  DevToolsSetting,
  isDevToolsControlOverridden,
  isDevToolsDefaultSetting,
  isDevToolsSetting,
  resolveDevToolsSetting,
} from "../dev-tools-settings";

const FIRST_CONTROL = "first-control";
const SECOND_CONTROL = "second-control";

describe("dev tools control model", () => {
  it("offers On and Off only, each with a label", () => {
    expect(DEV_TOOLS_SETTING_ORDER).toEqual([
      DevToolsSetting.On,
      DevToolsSetting.Off,
    ]);
    for (const setting of DEV_TOOLS_SETTING_ORDER) {
      expect(DEV_TOOLS_SETTING_LABELS[setting]).toBeTruthy();
    }
  });

  it("recognizes only setting values, not the retired default", () => {
    expect(isDevToolsSetting(DevToolsSetting.Off)).toBe(true);
    expect(isDevToolsSetting("default")).toBe(false);
    expect(isDevToolsSetting("enabled")).toBe(false);
  });

  it("shows a stored entry over the default, and the default otherwise", () => {
    const settings = { [FIRST_CONTROL]: true, [SECOND_CONTROL]: false };

    expect(resolveDevToolsSetting(settings, FIRST_CONTROL, false)).toBe(
      DevToolsSetting.On
    );
    expect(resolveDevToolsSetting(settings, SECOND_CONTROL, true)).toBe(
      DevToolsSetting.Off
    );
    expect(resolveDevToolsSetting(settings, "absent", true)).toBe(
      DevToolsSetting.On
    );
    expect(resolveDevToolsSetting(settings, "absent", false)).toBe(
      DevToolsSetting.Off
    );
    expect(resolveDevToolsSetting(settings, "constructor", false)).toBe(
      DevToolsSetting.Off
    );
  });

  it("reads only own entries as overridden", () => {
    const settings = { [FIRST_CONTROL]: false };

    expect(isDevToolsControlOverridden(settings, FIRST_CONTROL)).toBe(true);
    expect(isDevToolsControlOverridden(settings, SECOND_CONTROL)).toBe(false);
    expect(isDevToolsControlOverridden(settings, "constructor")).toBe(false);
  });

  it("stores a value away from the default without touching the others or the input", () => {
    const settings = Object.freeze({ [SECOND_CONTROL]: true });

    expect(
      applyDevToolsSetting(settings, FIRST_CONTROL, DevToolsSetting.Off, true)
    ).toEqual({ [FIRST_CONTROL]: false, [SECOND_CONTROL]: true });
    expect(
      applyDevToolsSetting(settings, FIRST_CONTROL, DevToolsSetting.On, false)
    ).toEqual({ [FIRST_CONTROL]: true, [SECOND_CONTROL]: true });
    expect(settings).toEqual({ [SECOND_CONTROL]: true });
  });

  it("clears the entry, rather than storing it, when the default is chosen", () => {
    const settings = { [FIRST_CONTROL]: false, [SECOND_CONTROL]: true };

    expect(
      applyDevToolsSetting(settings, FIRST_CONTROL, DevToolsSetting.On, true)
    ).toEqual({ [SECOND_CONTROL]: true });
    expect(
      applyDevToolsSetting(settings, SECOND_CONTROL, DevToolsSetting.Off, false)
    ).toEqual({ [FIRST_CONTROL]: false });
    expect(
      applyDevToolsSetting({}, FIRST_CONTROL, DevToolsSetting.Off, false)
    ).toEqual({});
  });

  it("selects neither option and stores every choice while the default is unknown", () => {
    expect(
      resolveDevToolsSetting({}, FIRST_CONTROL, undefined)
    ).toBeUndefined();
    expect(
      resolveDevToolsSetting(
        { [FIRST_CONTROL]: false },
        FIRST_CONTROL,
        undefined
      )
    ).toBe(DevToolsSetting.Off);
    expect(
      resolveDevToolsSetting(
        { [FIRST_CONTROL]: true },
        FIRST_CONTROL,
        undefined
      )
    ).toBe(DevToolsSetting.On);
    expect(
      applyDevToolsSetting({}, FIRST_CONTROL, DevToolsSetting.Off, undefined)
    ).toEqual({ [FIRST_CONTROL]: false });
    expect(
      applyDevToolsSetting({}, FIRST_CONTROL, DevToolsSetting.On, undefined)
    ).toEqual({ [FIRST_CONTROL]: true });
    expect(isDevToolsDefaultSetting(DevToolsSetting.Off, undefined)).toBe(
      false
    );
    expect(isDevToolsDefaultSetting(DevToolsSetting.Off, false)).toBe(true);
    expect(isDevToolsDefaultSetting(DevToolsSetting.On, false)).toBe(false);
  });
});
