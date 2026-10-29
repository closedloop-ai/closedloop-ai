import {
  HOST_CAPABILITY,
  type SurfaceCapabilityKinds,
} from "../../shared/lib/surface-capability-kind";
import type { SearchSurfaceV2Props } from "./search-surface-v2-props";

/**
 * ISS-9218, applied to {@link SearchSurfaceV2Props} — for every optional prop,
 * whether a host may honestly say it cannot supply one.
 *
 * `onActivateResult` is a capability because its absence states a fact about
 * the shell: a page IS the destination context, so it has no container to
 * dismiss when a row is activated. A new optional prop this file does not
 * classify fails `tsc`.
 */
export const SEARCH_SURFACE_V2_CAPABILITY_KINDS = {
  onActivateResult: HOST_CAPABILITY,
} as const satisfies SurfaceCapabilityKinds<SearchSurfaceV2Props>;
