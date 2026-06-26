/**
 * Desktop gateway probe (web entry point).
 *
 * The implementation is the single source of truth in
 * `@repo/shared-platform/gateway-probe`; this module only re-exports it under
 * the historical `Electron*`-prefixed names so existing app consumers keep their
 * import path (`@/lib/engineer/electron-probe`). Do NOT reimplement the probe
 * here -- that would fork the localhost gateway-detection logic across surfaces.
 */
export {
  getPossibleGatewayHostnames as getPossibleElectronHostnames,
  probeGateway as probeElectron,
} from "@repo/shared-platform/gateway-probe";
export type { GatewayDetectionState as ElectronDetectionState } from "@repo/shared-platform/types";
