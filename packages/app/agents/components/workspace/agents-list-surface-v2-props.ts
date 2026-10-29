import type { AgentComponent } from "@repo/api/src/types/agent-component";
import type { ReactNode } from "react";

/**
 * The public contract of {@link AgentsListSurfaceV2} (ISS-9398).
 *
 * Split out of the component module so the seams a host may supply are read and
 * reviewed apart from what the surface does with them, matching
 * `sessions-list-surface-v2-props.ts`.
 *
 * WHY THERE IS ALMOST NOTHING HERE. ISS-9216 AC2: a prop that changes what the
 * reader sees by being omitted is REQUIRED, not optional. So the two values only
 * a host can produce are required, and the single optional entry is a capability
 * whose absence states a fact about the host's runtime.
 */
export type AgentsListSurfaceV2Props = {
  /**
   * The route a row's name links to, built by the host that owns routing (web
   * an org-slug URL, desktop an unprefixed path its hash route table resolves).
   *
   * REQUIRED: omitted, every row rendered as inert text with nothing failing.
   */
  getComponentHref: (item: AgentComponent) => string;
  /**
   * The host's `localStorage` key for sort / group / column view state —
   * `"agents:web"` or `"agents:desktop"`.
   *
   * REQUIRED: omitted, the user's arrangement silently stopped surviving a
   * reload.
   */
  persistKey: string;
  /**
   * The host's own plugin install / update / uninstall bridge, if it has one.
   *
   * The ONLY optional entry, and optional because the absence is a fact about
   * the host rather than a choice about presentation: desktop reaches installed
   * packs over the pack-catalog IPC channels its preload exposes to the
   * renderer, and a browser tab has none of them. A host without the bridge renders NO management affordance at
   * all — never a disabled control that looks available — and the parity ledger
   * makes it say so.
   *
   * The surface still owns every visible decision about it — which type tab it
   * belongs under, that it sits beneath the inventory, its separator. The host
   * supplies only the body.
   */
  pluginManagement?: AgentsPluginManagementCapability;
};

/**
 * A host's plugin-management bridge, as a named capability rather than the
 * opaque `ReactNode` slot ISS-9216 lists among the seams a complete surface must
 * not expose. Naming it separates the two claims: the host declares it CAN
 * manage plugins, and the surface decides what that looks like.
 */
export type AgentsPluginManagementCapability = {
  /**
   * The host's runtime-bound management body. A function rather than a node so
   * a host's panel is constructed only on the tab that shows it.
   */
  readonly renderPanel: () => ReactNode;
};
