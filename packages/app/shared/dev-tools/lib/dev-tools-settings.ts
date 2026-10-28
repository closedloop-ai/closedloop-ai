/**
 * ISS-12048: the shared on/off control model behind every Dev Tools section.
 *
 * A section's settings are a browser-local `Record<controlId, boolean>`. A
 * control with no entry shows its default value (for feature flags, the flag's
 * production value; Off when that is unset). Choosing the default value removes
 * the entry rather than storing it, so a control matching its default is never
 * overridden (Daveth Oakhurst, meeting decision A3, 2026-10-07). While the default
 * is not known yet (`undefined`), neither option is selected and a choice is always
 * stored, so it cannot be lost to a default that turns out different.
 */
export const DevToolsSetting = {
  On: "on",
  Off: "off",
} as const;
export type DevToolsSetting =
  (typeof DevToolsSetting)[keyof typeof DevToolsSetting];

export type DevToolsSettings = Readonly<Record<string, boolean>>;

/** Every setting, in the order a control offers them. */
export const DEV_TOOLS_SETTING_ORDER: readonly DevToolsSetting[] =
  Object.values(DevToolsSetting);

export function isDevToolsSetting(value: string): value is DevToolsSetting {
  return (DEV_TOOLS_SETTING_ORDER as readonly string[]).includes(value);
}

/**
 * Whether `controlId` has a stored entry. `Object.hasOwn` rather than an index
 * read, so a control id such as `constructor` cannot resolve through the
 * prototype.
 */
export function isDevToolsControlOverridden(
  settings: DevToolsSettings,
  controlId: string
): boolean {
  return Object.hasOwn(settings, controlId);
}

/** The stored entry or known default; unresolved defaults select neither option. */
export function resolveDevToolsSetting(
  settings: DevToolsSettings,
  controlId: string,
  defaultValue: boolean | undefined
): DevToolsSetting | undefined {
  const value = isDevToolsControlOverridden(settings, controlId)
    ? settings[controlId]
    : defaultValue;
  if (value === undefined) {
    return undefined;
  }
  return value ? DevToolsSetting.On : DevToolsSetting.Off;
}

/**
 * The settings with `controlId` moved to `setting`: its entry removed when
 * `setting` is the known default, stored otherwise. Never mutates its input.
 */
export function applyDevToolsSetting(
  settings: DevToolsSettings,
  controlId: string,
  setting: DevToolsSetting,
  defaultValue: boolean | undefined
): DevToolsSettings {
  if (isDevToolsDefaultSetting(setting, defaultValue)) {
    return Object.fromEntries(
      Object.entries(settings).filter(([id]) => id !== controlId)
    );
  }
  return { ...settings, [controlId]: setting === DevToolsSetting.On };
}

/** Whether `setting` is `defaultValue`; never while the default is unknown. */
export function isDevToolsDefaultSetting(
  setting: DevToolsSetting,
  defaultValue: boolean | undefined
): boolean {
  return (
    defaultValue !== undefined &&
    (setting === DevToolsSetting.On) === defaultValue
  );
}
