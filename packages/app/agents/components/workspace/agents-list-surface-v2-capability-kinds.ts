import {
  HOST_CAPABILITY,
  type SurfaceCapabilityKinds,
} from "../../../shared/lib/surface-capability-kind";
import type { AgentsListSurfaceV2Props } from "./agents-list-surface-v2-props";

/**
 * ISS-9218, applied to {@link AgentsListSurfaceV2Props} — for every optional
 * prop, whether a host may honestly say it cannot support it.
 *
 * There is exactly one entry, and it is {@link HOST_CAPABILITY}. That is the
 * whole point of the contract's shape rather than an accident of a small
 * surface: ISS-9216 AC2 says no optional prop may change rendered behaviour by
 * being omitted, so a value every host can produce is REQUIRED here instead of
 * classified here. `AgentsGroupedList`'s `persistKey` and `getComponentHref`
 * were both that kind of prop and both are now required; `pluginsFooter` was the
 * one seam whose absence states a fact about the host's runtime, and it is the
 * one that survives as a capability.
 *
 * A new optional prop that this file does not classify fails `tsc`. The
 * converse holds only while at least one optional prop survives: with none,
 * `OptionalPropKeys` is `never`, `Record<never, …>` collapses to `{}`, and a
 * stale entry compiles. The parity guard is the backstop for both — it counts
 * this map's keys against the props read off the AST — and it is also what
 * refuses to let a host `notSupported` a PRESENTATION entry away.
 */
export const AGENTS_LIST_SURFACE_V2_CAPABILITY_KINDS = {
  pluginManagement: HOST_CAPABILITY,
} as const satisfies SurfaceCapabilityKinds<AgentsListSurfaceV2Props>;
