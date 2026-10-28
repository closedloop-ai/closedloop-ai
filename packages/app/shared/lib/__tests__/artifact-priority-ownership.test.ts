import {
  PRIORITY_BEARING_ENTITY_TYPES,
  SearchEntityType,
} from "@repo/api/src/types/search-entity-kind";
// Cross-slice: the support map declares that the Sessions grid renders a
// priority column, and only the agents slice owns the column set that settles it.
import { createHttpAgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { useUpdateSessionPriority } from "@repo/app/agents/hooks/use-update-session-priority";
import { agentSessionToSessionTableRow } from "@repo/app/agents/lib/session-table-row";
import { SESSIONS_COLUMN_SPECS } from "@repo/app/agents/lib/sessions-table-columns";
// Cross-slice, same reason: the Branches grid's own column set is the only
// evidence that its SUPPORTED declaration is true.
import { APPROVED_BRANCH_COLUMN_SPECS } from "@repo/app/branches/components/approved-branches-grid-adapter";
import { createHttpBranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { useUpdateBranchPriority } from "@repo/app/branches/hooks/use-update-branch-priority";
import { adaptBranchRow } from "@repo/app/branches/lib/branch-row-adapter";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import { endpointToDocument } from "@repo/app/documents/lib/artifact-row-adapter";
import { NO_PRIORITY_LABEL } from "@repo/app/documents/lib/group-by";
import { useUpdateProjectPriority } from "@repo/app/projects/hooks/use-projects";
import { ArtifactPriority } from "@repo/app/shared/components/artifact-priority/artifact-priority";
import { EditablePriorityTableCell } from "@repo/app/shared/components/generic-artifact-surface/semantic-cells";
import { IssuePriorityBadge } from "@repo/app/shared/components/status-badge";
import {
  ALL_ARTIFACT_COLUMNS,
  DocumentColumn,
  PROJECT_DEFAULT_COLUMNS,
} from "@repo/app/shared/hooks/use-column-visibility";
import {
  ARTIFACT_PRIORITY_OWNERSHIP,
  ARTIFACT_PRIORITY_SUPPORT,
  ArtifactPriorityLayer,
  ArtifactPriorityState,
  ArtifactPrioritySurface,
  ArtifactPriorityVariant,
} from "@repo/app/shared/lib/artifact-priority-ownership";
import { DEFAULT_PRIORITY } from "@repo/app/shared/lib/priority-constants";
import { PRIORITY_LABEL_NONE } from "@repo/design-system/lib/priority-order";
import { describe, expect, it } from "vitest";

// Pinned literally, not read from the vocabularies they police.
const APPROVED_VARIANTS = [
  "icon-only",
  "label",
  "badge",
  "compact-cell",
  "editor",
  "filter",
  "bulk-action",
  "board-card",
  "detail-field",
];
const APPROVED_STATES = [
  "loading",
  "none",
  "unknown",
  "error",
  "disabled",
  "read-only",
  "selected",
  "focus-visible",
  "hover",
  "editing",
  "mutation-activity",
];
const OWNED_LAYERS = [
  "presentation",
  "domain-mapping",
  "data-access",
  "mutation",
  "rollout-flag",
];
const DECLARED_SURFACES = ["artifact", "project", "branch", "session"];

/**
 * One priority-relevant export from every module the contract names, keyed by
 * the specifier it names it with.
 *
 * WHAT THIS PINS, exactly: the imports are STATIC and NAMED, so DELETING a
 * module, or deleting/renaming the export named here, fails this file at load.
 * The key-set assertion below then holds the production map's specifier list
 * and this table to the same set, so neither can gain or drop a specifier
 * alone. What it does NOT pin is a MOVE: relocating a module forces only the
 * static import above to change, and the two specifier STRINGS — the key here
 * and the one in `ARTIFACT_PRIORITY_OWNERSHIP` — would go stale together and
 * stay green. A dynamic `import(specifier)` would close that, and is refused by
 * the `no-desktop-gateway-import` guard, which cannot fold a computed
 * specifier.
 */
const RESOLVED_MODULES: Readonly<Record<string, unknown>> = {
  "@repo/design-system/lib/priority-order": PRIORITY_LABEL_NONE,
  "@repo/app/shared/components/artifact-priority/artifact-priority":
    ArtifactPriority,
  "@repo/app/documents/components/artifact-priority/artifact-priority-editor":
    ArtifactPriorityEditor,
  "@repo/app/shared/components/status-badge": IssuePriorityBadge,
  "@repo/app/shared/components/generic-artifact-surface/semantic-cells":
    EditablePriorityTableCell,
  "@repo/app/shared/lib/priority-constants": DEFAULT_PRIORITY,
  "@repo/app/documents/lib/artifact-row-adapter": endpointToDocument,
  "@repo/app/documents/lib/group-by": NO_PRIORITY_LABEL,
  "@repo/app/documents/lib/artifact-priority-unset-flag":
    ARTIFACT_PRIORITY_UNSET_FLAG_KEY,
  "@repo/app/projects/hooks/use-projects": useUpdateProjectPriority,
  "@repo/app/branches/components/approved-branches-grid-adapter":
    APPROVED_BRANCH_COLUMN_SPECS,
  "@repo/app/agents/lib/sessions-table-columns": SESSIONS_COLUMN_SPECS,
  // ISS-10332: the two grids' row mappers, data-source ports and mutation hooks.
  "@repo/app/agents/lib/session-table-row": agentSessionToSessionTableRow,
  "@repo/app/branches/lib/branch-row-adapter": adaptBranchRow,
  "@repo/app/agents/data-source/agent-sessions-data-source":
    createHttpAgentSessionsDataSource,
  "@repo/app/branches/data-source/branches-data-source":
    createHttpBranchesDataSource,
  "@repo/app/agents/hooks/use-update-session-priority":
    useUpdateSessionPriority,
  "@repo/app/branches/hooks/use-update-branch-priority":
    useUpdateBranchPriority,
};

/**
 * Every surface, paired with the column inventory that settles whether it
 * renders priority. Exhaustive by type, so a surface added to the vocabulary
 * fails typecheck here until it is paired with real evidence.
 */
const SURFACE_COLUMN_INVENTORIES: Readonly<
  Record<ArtifactPrioritySurface, readonly { id: string }[]>
> = {
  [ArtifactPrioritySurface.Artifact]: ALL_ARTIFACT_COLUMNS.map((id) => ({
    id,
  })),
  // The projects grid's own list, not the artifact grid's: pairing both
  // surfaces with one list would let the projects table stop rendering Priority
  // while this test kept reading the artifact list and stayed green.
  //
  // Narrower than it looks, and deliberately so: this is the DEFAULT set. It
  // doubles as the projects grid's offered universe only because both projects
  // pages hand this same constant to `TableViewMenu` as `columns` and derive
  // the visible set by filtering it — there is no separate all-columns list for
  // this surface the way `ALL_ARTIFACT_COLUMNS` is one for artifacts. Should a
  // wider universe constant appear, making Priority non-default but still
  // toggleable, this row must follow the universe: left on the default set it
  // would report "renders no priority" and fail a declaration that is true.
  [ArtifactPrioritySurface.Project]: PROJECT_DEFAULT_COLUMNS.map((id) => ({
    id,
  })),
  [ArtifactPrioritySurface.Branch]: APPROVED_BRANCH_COLUMN_SPECS,
  [ArtifactPrioritySurface.Session]: SESSIONS_COLUMN_SPECS,
};

/**
 * The entity kind each surface names, so the support map can be held against
 * `PRIORITY_BEARING_ENTITY_TYPES` — the server's answer to the same question,
 * spelled in a vocabulary neither side can import from the other.
 */
/**
 * Whether a priority each surface carries can be CLEARED, stated per member.
 *
 * Exhaustive by type, so a surface added to the vocabulary fails typecheck here
 * until it answers, and one that genuinely refuses the clear can be written
 * down. A universal "every supported surface clears" could express neither, and
 * would make `allowsUnset` a field no test permits to be false.
 *
 * `false` for an unsupported surface is not a refusal — it carries no priority
 * at all, so there is nothing to clear. ISS-10332 (operator ruling 2026-09-21)
 * made Branch and Session supported AND clearable: both routes read `null` as
 * the clear, like the two routes above.
 */
const EXPECTED_ALLOWS_UNSET: Readonly<
  Record<ArtifactPrioritySurface, boolean>
> = {
  [ArtifactPrioritySurface.Artifact]: true,
  [ArtifactPrioritySurface.Project]: true,
  [ArtifactPrioritySurface.Branch]: true,
  [ArtifactPrioritySurface.Session]: true,
};

const SURFACE_ENTITY_TYPE: Readonly<
  Record<ArtifactPrioritySurface, SearchEntityType>
> = {
  [ArtifactPrioritySurface.Artifact]: SearchEntityType.Document,
  [ArtifactPrioritySurface.Project]: SearchEntityType.Project,
  [ArtifactPrioritySurface.Branch]: SearchEntityType.Branch,
  [ArtifactPrioritySurface.Session]: SearchEntityType.AgentSession,
};

function hasPriorityColumn(specs: readonly { id: string }[]): boolean {
  return specs.some((spec) => spec.id.toLowerCase().includes("priority"));
}

describe("artifact priority contract vocabulary", () => {
  it("expresses every approved variant as one vocabulary", () => {
    expect(Object.values(ArtifactPriorityVariant).sort()).toEqual(
      [...APPROVED_VARIANTS].sort()
    );
  });

  it("expresses every approved state", () => {
    expect(Object.values(ArtifactPriorityState).sort()).toEqual(
      [...APPROVED_STATES].sort()
    );
  });

  it("keeps unknown a state of its own, not a spelling of none", () => {
    // The design system renders different words for the two; a contract that
    // named only one would let the champion collapse them.
    expect(ArtifactPriorityState.Unknown).not.toBe(ArtifactPriorityState.None);
  });

  it("names an owner for every layer", () => {
    expect(Object.keys(ARTIFACT_PRIORITY_OWNERSHIP).sort()).toEqual(
      [...OWNED_LAYERS].sort()
    );
    for (const layer of Object.values(ArtifactPriorityLayer)) {
      expect(ARTIFACT_PRIORITY_OWNERSHIP[layer].owner.length).toBeGreaterThan(
        0
      );
    }
  });

  it("names every priority mutation writer", () => {
    const owner =
      ARTIFACT_PRIORITY_OWNERSHIP[ArtifactPriorityLayer.Mutation].owner;

    expect(owner).toContain("PUT /documents/[id]");
    expect(owner).toContain("PUT /projects/[id]");
    // ISS-10332 / PLN-2086 Milestone 1.
    expect(owner).toContain("PATCH /agent-sessions/[id]");
    expect(owner).toContain("PATCH /branches/[id]");
    expect(owner).toContain("decompose-handler");
    expect(owner).toContain("documentService.create");
    expect(owner).toContain("pre-PRD-797 Desktop builds");
  });

  it("names only modules whose export this file still imports", () => {
    const declared = Object.values(ArtifactPriorityLayer).flatMap(
      (layer) => ARTIFACT_PRIORITY_OWNERSHIP[layer].modules
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const specifier of declared) {
      expect(Object.hasOwn(RESOLVED_MODULES, specifier)).toBe(true);
    }
  });

  it("leaves no resolved module unclaimed by a declaration", () => {
    // The other direction, so the two lists cannot drift apart: a specifier
    // dropped from the production map would otherwise leave a stale row here
    // that nothing reads, and the check above would still pass.
    const declared = new Set([
      ...Object.values(ArtifactPriorityLayer).flatMap(
        (layer) => ARTIFACT_PRIORITY_OWNERSHIP[layer].modules
      ),
      ...Object.values(ArtifactPrioritySurface).map(
        (surface) => ARTIFACT_PRIORITY_SUPPORT[surface].adapter
      ),
    ]);
    expect(Object.keys(RESOLVED_MODULES).sort()).toEqual([...declared].sort());
  });
});

describe("artifact priority surface support", () => {
  it("declares every surface", () => {
    expect(Object.keys(ARTIFACT_PRIORITY_SUPPORT).sort()).toEqual(
      [...DECLARED_SURFACES].sort()
    );
  });

  it("supports the artifact surface, which renders a Priority column", () => {
    const artifact =
      ARTIFACT_PRIORITY_SUPPORT[ArtifactPrioritySurface.Artifact];
    expect(artifact.supported).toBe(true);
    expect(ALL_ARTIFACT_COLUMNS).toContain(DocumentColumn.Priority);
  });

  it("states per surface whether a priority it carries can be cleared", () => {
    // ISS-9833, ruled 2026-09-14: a project's priority IS an artifact's, so one
    // contract covers both — `Artifact.priority` and `Project.priority` are each
    // nullable with no default, and PUT /documents/[id] and PUT /projects/[id]
    // each read an explicit null as the clear (ISS-9665, ISS-9441).
    const artifact =
      ARTIFACT_PRIORITY_SUPPORT[ArtifactPrioritySurface.Artifact];
    const project = ARTIFACT_PRIORITY_SUPPORT[ArtifactPrioritySurface.Project];
    expect(artifact.supported).toBe(true);
    expect(project.supported).toBe(true);
    expect(artifact.supported === true && artifact.allowsUnset).toBe(true);
    expect(project.supported === true && project.allowsUnset).toBe(true);
    // And over the whole vocabulary, against a STATED answer per surface rather
    // than a universal `true`, which no surface could ever fail.
    for (const surface of Object.values(ArtifactPrioritySurface)) {
      const support = ARTIFACT_PRIORITY_SUPPORT[surface];
      expect(
        support.supported === true && support.allowsUnset,
        `surface ${surface}`
      ).toBe(EXPECTED_ALLOWS_UNSET[surface]);
    }
  });

  // ISS-10332 (operator ruling 2026-09-21, superseding the 09-11 "unsupported"
  // declarations and the canceled ISS-9850): both grids render a Priority
  // column, and each declares it may be cleared.
  it("supports branches, which render a Priority column", () => {
    const branch = ARTIFACT_PRIORITY_SUPPORT[ArtifactPrioritySurface.Branch];
    expect(branch.supported).toBe(true);
    expect(branch.supported === true && branch.allowsUnset).toBe(true);
    expect(hasPriorityColumn(APPROVED_BRANCH_COLUMN_SPECS)).toBe(true);
  });

  it("supports sessions, which render a Priority column", () => {
    const session = ARTIFACT_PRIORITY_SUPPORT[ArtifactPrioritySurface.Session];
    expect(session.supported).toBe(true);
    expect(session.supported === true && session.allowsUnset).toBe(true);
    expect(hasPriorityColumn(SESSIONS_COLUMN_SPECS)).toBe(true);
  });

  it("matches every declaration against what its surface renders", () => {
    // The pairing is what makes the declaration load-bearing: adding a Priority
    // column to a grid without flipping its declaration fails here, and so does
    // flipping a declaration without changing what renders.
    for (const surface of Object.values(ArtifactPrioritySurface)) {
      expect(hasPriorityColumn(SURFACE_COLUMN_INVENTORIES[surface])).toBe(
        ARTIFACT_PRIORITY_SUPPORT[surface].supported
      );
    }
  });

  it("names only adapters whose export this file still imports", () => {
    for (const surface of Object.values(ArtifactPrioritySurface)) {
      expect(
        Object.hasOwn(
          RESOLVED_MODULES,
          ARTIFACT_PRIORITY_SUPPORT[surface].adapter
        )
      ).toBe(true);
    }
  });

  it("agrees with the server about which kinds carry a priority", () => {
    // Two declarations, one fact. The server scopes `:priority=NONE` by its
    // list; a surface declared supported here that the server does not consider
    // priority-bearing would filter to an empty facet.
    const supportedKinds = Object.values(ArtifactPrioritySurface)
      .filter((surface) => ARTIFACT_PRIORITY_SUPPORT[surface].supported)
      .map((surface) => SURFACE_ENTITY_TYPE[surface])
      .sort();
    expect(supportedKinds).toEqual([...PRIORITY_BEARING_ENTITY_TYPES].sort());
  });
});
