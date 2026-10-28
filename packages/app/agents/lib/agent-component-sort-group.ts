import type { AgentComponent } from "@repo/api/src/types/agent-component";
import {
  AgentComponentGroupBy,
  Harness,
} from "@repo/api/src/types/agent-component";
import {
  AGENT_COMPONENT_KIND_ORDER,
  HARNESS_LABEL,
  kindPlural,
} from "@repo/api/src/utils/agent-component-reduce";
import { AGENT_COMPONENT_NO_AUTHORS_LABEL } from "./agent-component-authors";

/**
 * ISS-6822: sorting, the Source facet projection, and the facet counters moved
 * to `@repo/api/src/utils/agent-component-reduce` so the SERVER can run the
 * identical code and return a bounded page instead of shipping the whole
 * inventory here to be reduced. Import them from there directly — this module
 * deliberately does not re-export them, because a file of pass-throughs is a
 * barrel and hides which module actually owns a symbol.
 *
 * Grouping stays here: it runs over the CURRENT PAGE only
 * (`groupAgentComponentRows(pageRows, groupBy)`), so it never sees the full
 * population and there is nothing for the server to do with it.
 */

// Group helpers

/** A single group produced by `groupAgentComponentRows`. */
export type AgentComponentGroup = {
  /** Display label for the group header. Empty string when `groupBy` is None. */
  label: string;
  items: AgentComponent[];
};

/**
 * Bucket an already-sorted array of `AgentComponent` rows into labelled
 * groups for the Consolidated layout's group-by display.
 *
 * - `None` — returns a single group with an empty label (no header rendered).
 * - `Type` — one group per `AgentComponentKind` in canonical
 *   `AGENT_COMPONENT_KIND_ORDER`; labels come from `kindPlural` (mirrors
 *   `KIND_META[kind].plural`). Groups with zero items are included so the UI can
 *   show an empty state.
 * - `Collaborators` — one group per distinct author (discoverer + editors),
 *   sorted alphabetically; a component with several authors appears under each,
 *   and a component with none is placed in an "No authors" group at the end.
 * - `Harness` — one group per `Harness` value in definition order; groups with
 *   zero items are included.
 */
export function groupAgentComponentRows(
  rows: AgentComponent[],
  groupBy: AgentComponentGroupBy
): AgentComponentGroup[] {
  switch (groupBy) {
    case AgentComponentGroupBy.None: {
      return [{ label: "", items: rows }];
    }

    case AgentComponentGroupBy.Type: {
      // Bucket by kind, preserving the canonical kind order and including empty
      // groups. Any kind not in the enum (e.g. synced desktop "tool" usage) is
      // collected into its own trailing group — keyed on `get()` returning
      // undefined — rather than being silently dropped, so the grouped view
      // stays total over arbitrary kind strings like the sort/badge paths.
      const byKind = new Map<string, AgentComponent[]>(
        AGENT_COMPONENT_KIND_ORDER.map((kind) => [kind, []])
      );
      const extraKinds: string[] = [];
      for (const row of rows) {
        const bucket = byKind.get(row.kind);
        if (bucket) {
          bucket.push(row);
        } else {
          byKind.set(row.kind, [row]);
          extraKinds.push(row.kind);
        }
      }
      const orderedKinds: string[] = [
        ...AGENT_COMPONENT_KIND_ORDER,
        ...extraKinds,
      ];
      return orderedKinds.map((kind) => ({
        label: kindPlural(kind),
        items: byKind.get(kind) ?? [],
      }));
    }

    case AgentComponentGroupBy.Collaborators: {
      // Collect rows by author (collaborator) name; a component with several
      // authors lands in each of their buckets, and one with none goes to a
      // trailing "No authors" group. FEA-4098 (Slice 3).
      const byCollaborator = new Map<string, AgentComponent[]>();
      const noAuthors: AgentComponent[] = [];
      for (const row of rows) {
        if (row.collaborators.length === 0) {
          noAuthors.push(row);
          continue;
        }
        for (const collaborator of row.collaborators) {
          const bucket = byCollaborator.get(collaborator);
          if (bucket) {
            bucket.push(row);
          } else {
            byCollaborator.set(collaborator, [row]);
          }
        }
      }
      const groups: AgentComponentGroup[] = [...byCollaborator.keys()]
        .sort((a, b) => a.localeCompare(b))
        .map((collaborator) => ({
          label: collaborator,
          items: byCollaborator.get(collaborator) ?? [],
        }));
      if (noAuthors.length > 0) {
        groups.push({
          label: AGENT_COMPONENT_NO_AUTHORS_LABEL,
          items: noAuthors,
        });
      }
      return groups;
    }

    case AgentComponentGroupBy.Harness: {
      // One group per Harness value in definition order, EMPTY GROUPS DROPPED
      // (T11): with OpenCode added, always rendering all four headers left a
      // typical org staring at an empty OpenCode bucket next to an empty Codex
      // one — mostly chrome with no rows under it. Only harnesses that actually
      // have components get a header.
      const HARNESS_ORDER: readonly Harness[] = [
        Harness.Both,
        Harness.Claude,
        Harness.Codex,
        Harness.Opencode,
      ];
      const byHarness = new Map<Harness, AgentComponent[]>(
        HARNESS_ORDER.map((h) => [h, []])
      );
      for (const row of rows) {
        byHarness.get(row.harness)?.push(row);
      }
      return HARNESS_ORDER.filter(
        (h) => (byHarness.get(h)?.length ?? 0) > 0
      ).map((h) => ({
        label: HARNESS_LABEL[h],
        items: byHarness.get(h) ?? [],
      }));
    }

    default: {
      const _exhaustive: never = groupBy;
      return _exhaustive;
    }
  }
}
