import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { LayersIcon } from "lucide-react";
import type { AgentsTypeTabOption } from "../components/workspace/agents-type-tab-strip";
import { type AgentsTypeTabValue, ALL_TYPES } from "./agents-empty-state-copy";
import { KIND_ORDER, kindMeta } from "./component-meta";

/**
 * The Agents inventory's type-tab vocabulary, extracted from
 * `agents-grouped-list.tsx` by ISS-9398.
 *
 * `AgentsListSurfaceV2` and the `AgentsGroupedList` fork it is gated against
 * both read THIS module. Two hosts mounting two tab sets is the divergence
 * ISS-9216 describes, and two components deriving their own from `KIND_ORDER`
 * would be the same thing one level down. The hand-written oracle in
 * `packages/app/agents/__tests__/type-tab-strip-vocabulary.ts` guards this list
 * without importing it, so the pin keeps its ability to fail.
 */

// ---------------------------------------------------------------------------
// Type-tab scoping
//
// Kinds hidden from the top-level type-tab bar — reachable via "All" only,
// never a promoted top-level type tab:
//   • Workflow / Config      — no dedicated tab historically.
//   • Orchestration          — FEA-4019 graduates ONLY Tools, MCPs, and Hooks;
//     harness/orchestration primitives stay scoped out here (they are also
//     non-promotable per isPromotableKind, so there is nothing to act on from a
//     dedicated tab). Keeping it out also keeps `?kind=orchestration` off the
//     permalink surface on both web and desktop.
//
// FEA-4019: Tools/MCPs/Hooks are first-class tabs unconditionally on BOTH
// shells. Tool stays observable-only (never promotable); Mcp and Hook ARE
// promotable (see isPromotableKind), which is why promoting them to top-level
// tabs is consistent with the rest of the promote/catalog flow.
// ---------------------------------------------------------------------------
const SCOPED_OUT_KINDS: ReadonlySet<AgentComponentKind> =
  new Set<AgentComponentKind>([
    AgentComponentKind.Workflow,
    AgentComponentKind.Config,
    AgentComponentKind.Orchestration,
  ]);

/**
 * Core kinds shown as top-level type tabs, in `KIND_ORDER` (so mcp/tool/hook
 * render in their canonical order position: Plugin → Mcp → Tool → Hook).
 */
export const AGENTS_TYPE_TAB_CORE_KINDS: readonly AgentComponentKind[] =
  KIND_ORDER.filter((kind) => !SCOPED_OUT_KINDS.has(kind));

/**
 * The type strip's segments, in render order: `All` then one per core kind.
 *
 * Built once at module scope rather than per render because the vocabulary is
 * static — `AGENTS_TYPE_TAB_CORE_KINDS` is itself derived from `KIND_ORDER` —
 * and `AgentsTypeTabStrip` measures and partitions this array on every resize.
 * Labels come from `kindMeta().plural`, the same map the group-by-Type headers
 * and the empty-state copy read, so a tab can never name a kind differently
 * from the rows it filters to.
 */
export const AGENTS_TYPE_TAB_OPTIONS: readonly AgentsTypeTabOption[] = [
  { value: ALL_TYPES, label: "All", icon: LayersIcon },
  ...AGENTS_TYPE_TAB_CORE_KINDS.map((kind) => ({
    value: kind,
    label: kindMeta(kind).plural,
    icon: kindMeta(kind).icon,
  })),
];

/**
 * The `?kind=` values a tab can select, in render order.
 *
 * A deep-linked `?kind=` outside this set — a scoped-out kind reachable only via
 * `All`, or a bogus value — falls back to `All`, and the default is omitted from
 * the URL so the canonical link stays clean.
 */
export const AGENTS_TYPE_TAB_VALUES: readonly AgentsTypeTabValue[] = [
  ALL_TYPES,
  ...AGENTS_TYPE_TAB_CORE_KINDS,
];
