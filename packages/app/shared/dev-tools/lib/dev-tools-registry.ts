/**
 * ISS-12048: the Dev Tools overlay renders whatever sections are registered.
 * A section is self-contained: its id, its title, the browser-local settings
 * key its controls write (see `dev-tools-settings.ts`), and its controls.
 * Adding a capability is one new section module, with no overlay change.
 */
export type DevToolsControl = {
  readonly id: string;
  readonly label: string;
};

export type DevToolsSection = {
  readonly id: string;
  readonly title: string;
  readonly storageKey: string;
  readonly controls: readonly DevToolsControl[];
  /**
   * Optional: the controls the current page used, listed first, with every
   * other control behind a show-all toggle (ISS-12048). `useControls` may name
   * controls beyond `controls`, for a key only the page revealed.
   */
  readonly highlight?: {
    readonly useControls: () => readonly DevToolsControl[];
    /** The show-all toggle's label. */
    readonly showAllLabel: string;
    /** Heads the highlighted controls while everything is shown. */
    readonly heading: string;
  };
  /**
   * Optional: each control's default value, which it shows while it has no
   * stored entry and which choosing clears the entry (ISS-12048). Absent means
   * Off; `undefined` means not known yet, shown as Unknown with every choice stored.
   */
  readonly useDefaultValue?: (controlId: string) => boolean | undefined;
};

export type DevToolsRegistry = ReadonlyMap<string, DevToolsSection>;

/**
 * Builds a registry in the given order. Throws on a repeated section id, and on
 * two sections sharing a storage key, since one section's reset would then
 * clear the other's settings.
 */
export function createDevToolsRegistry(
  sections: readonly DevToolsSection[]
): DevToolsRegistry {
  const registry = new Map<string, DevToolsSection>();
  const storageKeys = new Set<string>();
  for (const section of sections) {
    if (registry.has(section.id)) {
      throw new Error(`Duplicate Dev Tools section id "${section.id}".`);
    }
    if (storageKeys.has(section.storageKey)) {
      throw new Error(
        `Dev Tools section "${section.id}" reuses storage key "${section.storageKey}".`
      );
    }
    registry.set(section.id, section);
    storageKeys.add(section.storageKey);
  }
  return registry;
}
