"use client";

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { CompleteSurfaceState } from "../../../shared/lib/complete-surface-contract";
import type { AgentsListSurfaceV2ViewModel } from "../../hooks/use-agents-list-surface-v2-view-model";
import { kindMeta } from "../../lib/component-meta";

/**
 * The non-population states of `AgentsListSurfaceV2` (ISS-9398).
 *
 * Four sentences, and which one appears is the surface's decision, not a host's.
 * The distinctions are the ones `packages/app/AGENTS.md` -> "Loading ≠
 * unavailable ≠ not-applicable ≠ real zero" requires: an in-flight read is not
 * an empty org, a rejected read is not an empty org either, and a narrowed view
 * that matched nothing is not evidence the inventory is empty.
 *
 * Returns `null` for {@link CompleteSurfaceState.Ready}, which is the rows'
 * state rather than a state of its own, and for `Partial` and `Unavailable`,
 * which this surface has no producer for and no copy for. All seven members are
 * named explicitly so the `default` arm's `never` binding is what fails when an
 * eighth arrives.
 */
export function AgentsListSurfaceV2States({
  model,
}: {
  model: AgentsListSurfaceV2ViewModel;
}) {
  // A switch over EVERY member, not a ladder of ifs, so the tail below is
  // reachable-by-type and `tsc` owns the completeness claim (marisolashgrove review
  // on PR #6803). The ladder this replaces named three of the seven states and
  // let the other four fall into the empty sentence, so `Partial` and
  // `Unavailable` would have rendered "No components yet" — a false empty, and
  // one that arrives on screen rather than in a build.
  switch (model.state) {
    case CompleteSurfaceState.Loading:
      return (
        <p className="px-4 py-12 text-center text-muted-foreground text-sm">
          Loading components…
        </p>
      );

    // A rejected query must not fall through to an empty state — that would tell
    // every org "no agents" during an outage. `role="alert"` so an outage is
    // ANNOUNCED: a screen-reader user watching the list saw the rows vanish and
    // was told nothing.
    case CompleteSurfaceState.Error:
      return (
        <p
          className="px-4 py-12 text-center text-destructive text-sm"
          role="alert"
        >
          Couldn't load components. Check your connection and try again.
        </p>
      );

    case CompleteSurfaceState.Ready:
      return null;

    // FEA-4086: the honest Plugins-inventory empty composes the shared
    // `EmptyState` — the same treatment the sibling Packs panel renders on this
    // tab — so "No plugins installed" lands first and the Packs pointer reads as
    // a quieter description instead of two same-weight grey lines. Every other
    // empty keeps the plain one-line message.
    case CompleteSurfaceState.FilteredEmpty:
    case CompleteSurfaceState.GenuineEmpty:
      return model.isHonestPluginsEmpty ? (
        <EmptyState
          description="Add plugins from Packs."
          icon={kindMeta(AgentComponentKind.Plugin).icon}
          title={model.emptyMessage}
        />
      ) : (
        <p className="px-4 py-12 text-center text-muted-foreground text-sm">
          {model.emptyMessage}
        </p>
      );

    // Named rather than defaulted, which is the whole point: this surface has no
    // producer for either today — `selectAgentsListSurfaceState` cannot return
    // them — but a capped bounded-page read is `Partial` by that enum's own
    // docstring, and whoever wires one up should get a blank region and a review
    // question, not a confident "No components yet".
    //
    // `null` rather than borrowed copy because both sit in
    // `NON_POPULATION_STATES`, which the complete-surface contract forbids
    // from rendering as a zero. Inventing a sentence here would be this file
    // making a product decision it has no design for.
    case CompleteSurfaceState.Partial:
    case CompleteSurfaceState.Unavailable:
      return null;

    default: {
      // Unreachable today — every one of the seven is named above. This is the
      // gate on the EIGHTH: adding a member to `CompleteSurfaceState` without
      // deciding what this surface does with it fails here, at `tsc`.
      const _exhaustive: never = model.state;
      return null;
    }
  }
}
