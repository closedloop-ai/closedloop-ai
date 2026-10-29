/**
 * @file settings-panel-registry.ts
 * @description The Settings v2 panel registry (ISS-8362). A panel package
 * (ISS-8363..8369, ISS-8378..8380) exports ONE descriptor built by
 * {@link defineSettingsPanel} and is mounted by handing that descriptor to
 * {@link createSettingsPanelRegistry}. There is no central switch, and no
 * shared file a panel author edits: the id set is contract-owned in
 * `@repo/api/src/types/settings-panel`, so a panel claims an existing id
 * rather than minting one.
 *
 * A panel is testable alone because a registry is just a validated list — a
 * panel's own test builds `createSettingsPanelRegistry([myPanel])` and resolves
 * against it. Completeness is a separate, loud assertion the composition root
 * (ISS-8370) makes, so an unregistered panel is a startup failure naming the
 * gap rather than a nav entry that silently disappears.
 */
import {
  isSettingsPanelId,
  SETTINGS_PANEL_IDS,
  type SettingsPanelCapability,
  type SettingsPanelHost,
  type SettingsPanelId,
  type SettingsPanelIntent,
} from "@repo/api/src/types/settings-panel";
import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

/**
 * Props every panel body receives. Kept deliberately thin: a panel reads its
 * own data through its own hooks. `intent` is the deep link's secondary target
 * and a panel that does not honour one renders as if it were `view`.
 */
export type SettingsPanelProps = {
  intent: SettingsPanelIntent;
};

export type SettingsPanelComponent = ComponentType<SettingsPanelProps>;

export type SettingsPanelDescriptor = {
  id: SettingsPanelId;
  icon: LucideIcon;
  /** Hosts that offer this panel; absence from one means `unavailable` there. */
  hosts: readonly SettingsPanelHost[];
  /** Capability the actor must hold to open the panel at all. */
  requiredCapability: SettingsPanelCapability;
  /**
   * The body. Wrap in `React.lazy` to keep a panel out of the Settings entry
   * bundle — the shell already provides the Suspense and error boundaries a
   * lazy body needs.
   */
  Panel: SettingsPanelComponent;
};

export type SettingsPanelRegistry = {
  get: (id: SettingsPanelId) => SettingsPanelDescriptor | undefined;
  has: (id: SettingsPanelId) => boolean;
  /** Registered ids in contract navigation order, not registration order. */
  ids: readonly SettingsPanelId[];
};

export class SettingsPanelRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsPanelRegistryError";
  }
}

/**
 * Authoring seam for a panel package. Identity at runtime apart from freezing;
 * its job is to type-check the literal at the definition site so a panel author
 * gets the contract enforced where they are working rather than at assembly.
 */
export function defineSettingsPanel(
  descriptor: SettingsPanelDescriptor
): SettingsPanelDescriptor {
  return Object.freeze({
    ...descriptor,
    hosts: Object.freeze([...descriptor.hosts]),
  });
}

export function createSettingsPanelRegistry(
  descriptors: readonly SettingsPanelDescriptor[]
): SettingsPanelRegistry {
  const byId = new Map<SettingsPanelId, SettingsPanelDescriptor>();

  for (const descriptor of descriptors) {
    if (!isSettingsPanelId(descriptor.id)) {
      throw new SettingsPanelRegistryError(
        `Settings panel "${descriptor.id}" is not a known panel id.`
      );
    }
    if (byId.has(descriptor.id)) {
      throw new SettingsPanelRegistryError(
        `Settings panel "${descriptor.id}" is registered more than once.`
      );
    }
    byId.set(descriptor.id, descriptor);
  }

  const ids = SETTINGS_PANEL_IDS.filter((id) => byId.has(id));

  return Object.freeze({
    get: (id: SettingsPanelId) => byId.get(id),
    has: (id: SettingsPanelId) => byId.has(id),
    ids,
  });
}

/**
 * The composition root's guard. Called at module scope where Settings is
 * assembled so a panel package that failed to register fails the app's startup
 * with the missing ids named, instead of leaving a hole a user discovers.
 */
export function assertSettingsPanelRegistryComplete(
  registry: SettingsPanelRegistry
): void {
  const missing = SETTINGS_PANEL_IDS.filter((id) => !registry.has(id));
  if (missing.length > 0) {
    throw new SettingsPanelRegistryError(
      `Settings panel registry is missing: ${missing.join(", ")}.`
    );
  }
}

/**
 * The host-scoped guard (ISS-8370 D4) for a composition root that CANNOT
 * import every descriptor — the desktop renderer cannot reach the three
 * `apps/app` panels. Every id is either registered or named in
 * `unavailableOnHost`, the host's explicit availability decision for the panels
 * it does not offer; an id that is neither is a gap, named at startup exactly
 * as {@link assertSettingsPanelRegistryComplete} names one on web.
 *
 * The list is a claim the host makes about descriptors it cannot see, so it is
 * held honest from the other side: a web-side test proves each listed
 * descriptor really declares itself unavailable here.
 */
export function assertSettingsPanelRegistryCompleteForHost(
  registry: SettingsPanelRegistry,
  host: SettingsPanelHost,
  unavailableOnHost: readonly SettingsPanelId[]
): void {
  const missing = SETTINGS_PANEL_IDS.filter(
    (id) => !(registry.has(id) || unavailableOnHost.includes(id))
  );
  if (missing.length > 0) {
    throw new SettingsPanelRegistryError(
      `Settings panel registry for ${host} is missing: ${missing.join(", ")}. Register the panel, or list it as unavailable on this host.`
    );
  }
}
