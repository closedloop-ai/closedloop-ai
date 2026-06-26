"use client";

/**
 * Engineer routing-selection store (web entry point).
 *
 * The implementation is the single source of truth in
 * `@repo/shared-platform/routing-store`; this module only re-exports it under
 * the historical `Engineer*`-prefixed names so existing app consumers keep
 * their import path (`@/lib/engineer/routing-store`). Do NOT reimplement the
 * store here -- that would fork the module-level selection singleton and break
 * mode coherence across the shared dispatch router and the web surface.
 *
 * The shared store persists under the same `engineer-routing-selection:v1`
 * storage key, so previously stored selections remain compatible.
 */
export {
  getRoutingSelection as getEngineerRoutingSelection,
  resetRoutingSelectionForTests as resetEngineerRoutingSelectionForTests,
  setRoutingAutoSelection as setEngineerRoutingAutoSelection,
  setRoutingManualSelection as setEngineerRoutingManualSelection,
  subscribeRoutingSelection as subscribeEngineerRoutingSelection,
  useRoutingSelection as useEngineerRoutingSelection,
} from "@repo/shared-platform/routing-store";
export type { RoutingSelection as EngineerRoutingSelection } from "@repo/shared-platform/types";
