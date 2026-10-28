import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  CollaboratorArtifactType,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators";
import {
  ArtifactRowFieldEdit,
  BRANCH_ROW_FIELD_EDIT,
  BranchPatchField,
} from "@repo/api/src/types/artifact-row-field-edit";
import { encodeBranchId } from "@repo/api/src/types/branch";
import { Priority } from "@repo/api/src/types/common";
import { ArtifactTagAvailability, TagColor } from "@repo/api/src/types/tag";
import { projectKeys } from "@repo/app/projects/hooks/project-keys";
import { projectTreeKeys } from "@repo/app/projects/hooks/project-tree-keys";
import {
  DetailsAvailability,
  DetailsFieldId,
  forViewer,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import { isDetailsFieldDrawn } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-sections";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import type { FixtureRequestContext } from "@repo/app/shared/storybook/fixture-fetch";
import { createTestQueryClient } from "@repo/app/shared/test-utils";
import { PRIORITY_LABELS } from "@repo/design-system/lib/priority-order";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import { branchRowQueryKeys } from "../../hooks/branch-query-keys";
import { branchShellDetailsConfig } from "../branch-shell-details";
import {
  branchPriorityRow,
  branchProjectRow,
  branchTagsRow,
} from "../branch-shell-details-write-rows";
import { populatedDetail } from "../branch-story-metric-fixtures";
import { inertBranchesDataSource } from "./branch-detail-page.fixtures";

/**
 * ISS-10995: the Branch Details tab's Priority, Project and Tags writes. A
 * source carrying none of them (`shared-branches-api.ts`, the single-user read)
 * draws no row (operator ruling 2026-10-09).
 *
 * Project is editable here and on Sessions alike (operator ruling 2026-10-12);
 * `branch-shell-details-write-rows.tsx` carries what each type's project write
 * actually does, including why a later push cannot re-file a branch.
 */

const TAG = { color: TagColor.Red, id: "tag-1", name: "platform" };
/**
 * Five, because `EntityTagsCell`'s grid default shows two: a two- or
 * three-tag fixture cannot tell an uncapped row from the default one.
 */
const MANY_TAGS = ["platform", "infra", "billing", "mobile", "growth"].map(
  (name, index) => ({ color: TagColor.Red, id: `tag-${index}`, name })
);
/** `TagChips`' overflow indicator, the one thing an uncapped row must not draw. */
const OVERFLOW_CHIP_PATTERN = /^\+\d+$/;

function detail(overrides: Partial<ReturnType<typeof populatedDetail>> = {}) {
  return { ...populatedDetail(), ...overrides };
}

describe("branchPriorityRow", () => {
  it("omits the row when the producer served no priority", () => {
    expect(branchPriorityRow(detail({ priority: undefined }))).toEqual([]);
  });

  it("draws a row for a branch that genuinely has none, so one can be set", () => {
    const [row] = branchPriorityRow(detail({ priority: null }));

    expect(row?.id).toBe(DetailsFieldId.Priority);
    expect(row?.edit.mode).toBe("self-saving");
    // Never empty: the empty-row rule would otherwise drop the row for a
    // viewer the host has locked out of editing it.
    expect(row?.value).toMatchObject({ kind: "self-saving", empty: false });
  });

  it("offers no control where no data source can write", () => {
    const [row] = branchPriorityRow(detail({ priority: Priority.High }));
    if (row?.value.kind !== "self-saving") {
      throw new Error("expected a self-saving row");
    }

    render(row.value.render(true));

    expect(screen.getByText(PRIORITY_LABELS.HIGH)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("branchTagsRow", () => {
  it("omits the row when the tag relation was never loaded", () => {
    for (const unloaded of [
      detail({ tagAvailability: undefined, tags: undefined }),
      // The row this replaced mapped `detail.tags ?? []`, so an unavailable
      // relation rendered an empty picker — "this branch has no tags", a read
      // nobody made.
      detail({
        tagAvailability: ArtifactTagAvailability.Unavailable,
        tags: [TAG],
      }),
    ]) {
      expect(branchTagsRow(unloaded)).toEqual([]);
    }
  });

  it("draws a self-saving row for a loaded relation, empty or not", () => {
    for (const [tags, empty] of [
      [[], true],
      [[TAG], false],
    ] as const) {
      const [row] = branchTagsRow(
        detail({
          tagAvailability: ArtifactTagAvailability.Available,
          tagPermissions: { canApply: true, canRemove: true },
          tags: [...tags],
        })
      );

      expect(row?.id).toBe(DetailsFieldId.Tags);
      expect(row?.edit.mode).toBe("self-saving");
      expect(row?.value).toMatchObject({ kind: "self-saving", empty });
    }
  });

  it("names the picker after the branch and keys it on the artifact id", () => {
    const [row] = branchTagsRow(
      detail({
        artifactId: "artifact-br-1",
        branchName: "feat/details",
        tagAvailability: ArtifactTagAvailability.Available,
        tagPermissions: { canApply: true, canRemove: true },
        tags: [TAG],
      })
    );
    if (row?.value.kind !== "self-saving") {
      throw new Error("expected a self-saving row");
    }

    render(
      <AppCoreStoryProviders>{row.value.render(true)}</AppCoreStoryProviders>
    );

    expect(
      screen.getByRole("button", { name: "Edit tags for feat/details" })
    ).toBeInTheDocument();
  });

  it("offers no picker when the producer served no artifact id", () => {
    // `BranchPageDetail.id` is `encodeBranchId(repoFullName, branchName)` on a
    // producer that omits `artifactId`, and that composite is not an entity id
    // `POST /entity-tags` can write against. The grid cell withholds the picker
    // on the same input (#8697 review).
    const [row] = branchTagsRow(
      detail({
        artifactId: undefined,
        branchName: "feat/details",
        id: encodeBranchId({
          branchName: "feat/details",
          repoFullName: "owner/repo",
        }),
        tagAvailability: ArtifactTagAvailability.Available,
        tagPermissions: { canApply: true, canRemove: true },
        tags: [TAG],
      })
    );
    if (row?.value.kind !== "self-saving") {
      throw new Error("expected a self-saving row");
    }

    render(
      <AppCoreStoryProviders>{row.value.render(true)}</AppCoreStoryProviders>
    );

    expect(
      screen.queryByRole("button", { name: "Edit tags for feat/details" })
    ).toBeNull();
    // Still the chips, so the row reports what it read rather than going blank.
    expect(screen.getByText(TAG.name)).toBeInTheDocument();
  });

  // The row this replaced wrapped every tag; `EntityTagsCell`'s default of two
  // is a GRID cap (#8697 review).
  it("shows every tag, with no overflow indicator", () => {
    const [row] = branchTagsRow(
      detail({
        artifactId: "artifact-br-1",
        tagAvailability: ArtifactTagAvailability.Available,
        tagPermissions: { canApply: true, canRemove: true },
        tags: MANY_TAGS,
      })
    );
    if (row?.value.kind !== "self-saving") {
      throw new Error("expected a self-saving row");
    }

    render(
      <AppCoreStoryProviders>{row.value.render(true)}</AppCoreStoryProviders>
    );

    for (const tag of MANY_TAGS) {
      expect(screen.getByText(tag.name)).toBeInTheDocument();
    }
    expect(screen.queryByText(OVERFLOW_CHIP_PATTERN)).toBeNull();
  });
});

const PROJECT_ARTIFACT_ID = "33333333-3333-4333-8333-333333333331";
const PROJECT_A = {
  id: "44444444-4444-4444-8444-444444444441",
  name: "Desktop MLP",
  slug: "PRO-1",
};
const PROJECT_B = {
  id: "44444444-4444-4444-8444-444444444442",
  name: "Branches",
  slug: "PRO-2",
};
/** Every key the branch PATCH writes; `projectId` must not be one of them. */
const BRANCH_PATCH_FIELD_VALUES: string[] = Object.values(BranchPatchField);

/** The picker's clear item, which no branch route can commit. */
const CLEAR_ITEM_NAME = "Clear selection";

/**
 * One of the picker's list items. Scoped to the option role because a filed
 * branch's project name is on the TRIGGER as well, and a bare text query would
 * match both. The accessible name carries the slug line too, hence the prefix.
 */
function projectOption(name: string) {
  return screen.findByRole("option", { name: new RegExp(`^${name}`) });
}

function filedDetail(
  overrides: Partial<ReturnType<typeof populatedDetail>> = {}
) {
  return detail({
    artifactId: PROJECT_ARTIFACT_ID,
    projectId: PROJECT_A.id,
    projectName: PROJECT_A.name,
    ...overrides,
  });
}

/** The self-saving cell the renderer would mount for this row. */
function projectCell(
  detailInput: ReturnType<typeof populatedDetail>,
  editable: boolean
) {
  const [row] = branchProjectRow(detailInput);
  if (row?.value.kind !== "self-saving") {
    throw new Error("expected a self-saving row");
  }
  return row.value.render(editable);
}

/** `GET /projects` plus a capturing `POST /artifact-links/batch-move`. */
function projectRoutes(received: { path: string; body: unknown }[]) {
  return [
    {
      method: "GET" as const,
      path: "/projects",
      respond: () => [PROJECT_A, PROJECT_B],
    },
    {
      method: "POST" as const,
      path: "/artifact-links/batch-move",
      respond: (context: FixtureRequestContext) => {
        received.push({ path: context.pathname, body: context.body });
        return {
          movedArtifacts: [
            { id: PROJECT_ARTIFACT_ID, type: ArtifactType.Branch },
          ],
        };
      },
    },
  ];
}

/** {@link projectRoutes} with the move held until `pending` settles. */
function heldMoveRoutes(
  received: { path: string; body: unknown }[],
  pending: Promise<void>
) {
  return projectRoutes(received).map((route) =>
    route.method === "POST"
      ? {
          ...route,
          respond: async (context: FixtureRequestContext) => {
            const body = route.respond(context);
            await pending;
            return body;
          },
        }
      : route
  );
}

describe("branchProjectRow", () => {
  it("omits the row when the producer served no project", () => {
    // The single-user read: `shared-branches-api.ts` projects neither
    // `projectId` nor `projectName`, so `undefined` is "this producer does not
    // know" and the row is left out rather than drawn as a dash.
    expect(populatedDetail().projectId).toBeUndefined();

    expect(branchProjectRow(detail({ projectId: undefined }))).toEqual([]);
  });

  it("draws a row for a branch filed into no project, so one can be set", () => {
    const [row] = branchProjectRow(detail({ projectId: null }));

    expect(row?.id).toBe(DetailsFieldId.Project);
    expect(row?.edit.mode).toBe("self-saving");
    expect(row?.value).toMatchObject({ kind: "self-saving", empty: false });
  });

  it("keeps an unfiled branch's row drawn for a viewer who cannot edit it", () => {
    // The empty-row rule drops a LOCKED self-saving row that reports itself
    // empty, so a row reporting `empty` from its value would vanish for this
    // viewer — hiding a field the producer did serve, whose `null` means "filed
    // into no project" and not "nothing here".
    const config = forViewer(
      branchShellDetailsConfig(
        { detail: detail({ projectId: null, projectName: null }) },
        unavailableArtifactCollaborators(CollaboratorArtifactType.Branch)
      ),
      DetailsAvailability.NoPermission
    );

    const drawn = config.core
      .filter(isDetailsFieldDrawn)
      .map((field) => field.id);

    expect(drawn).toContain(DetailsFieldId.Project);
  });

  it("is classified own_route, the registry's word for this write", () => {
    // The Details row IS the surface that writes this field, so the registry
    // has to say a user may — through its own route, not the branch PATCH,
    // which deliberately gains no `projectId` arm. `NotEditable` ("no grid for
    // this type shows it") was true only while no row offered the write.
    expect(BRANCH_ROW_FIELD_EDIT.projectId).toBe(ArtifactRowFieldEdit.OwnRoute);
    expect(BRANCH_PATCH_FIELD_VALUES).not.toContain(
      BRANCH_ROW_FIELD_EDIT.projectId
    );
  });

  it("asks for the project list when the picker opens, not on mount", async () => {
    // `@repo/app` AGENTS.md: menu data is gated, not fetched on mount. The
    // trigger paints from the detail, so a Branch Details view that nobody
    // opens the picker on must not fetch every project in the org.
    const listed: string[] = [];
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET" as const,
            path: "/projects",
            respond: (context: FixtureRequestContext) => {
              listed.push(context.pathname);
              return [PROJECT_A, PROJECT_B];
            },
          },
        ]}
      >
        {projectCell(filedDetail(), true)}
      </AppCoreStoryProviders>
    );

    // Drain the mount effects AND their microtasks: the fixture transport
    // records in a promise handler, so a synchronous read here cannot tell an
    // ungated query from a gated one.
    await act(async () => {
      await Promise.resolve();
    });
    expect(listed).toEqual([]);

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));

    await waitFor(() => expect(listed).toEqual(["/projects"]));
  });

  it("files the branch through batch-move, this artifact alone", async () => {
    const received: { path: string; body: unknown }[] = [];
    render(
      <AppCoreStoryProviders apiRoutes={projectRoutes(received)}>
        {projectCell(filedDetail(), true)}
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await user.click(await projectOption(PROJECT_B.name));

    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].path).toBe("/artifact-links/batch-move");
    expect(received[0].body).toEqual({
      artifactId: PROJECT_ARTIFACT_ID,
      targetProjectId: PROJECT_B.id,
      // The downstream walk would carry every session and document linked
      // beneath the branch into the project too.
      includeDownstream: false,
      // ISS-10995's stale-write guard: the project this row RENDERED, the
      // sibling of `expectedPriority` on the Priority row.
      expectedProjectId: PROJECT_A.id,
      surface: ArtifactStatusEditSurface.Detail,
    });
  });

  it("writes nothing when the shown project is re-picked", async () => {
    const received: { path: string; body: unknown }[] = [];
    render(
      <AppCoreStoryProviders apiRoutes={projectRoutes(received)}>
        {projectCell(filedDetail(), true)}
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await user.click(await projectOption(PROJECT_A.name));

    expect(received).toEqual([]);
  });

  it("offers no clear, because no branch route can commit one", async () => {
    // `batch-move`'s `targetProjectId` is `z.uuid()`. The picker's clear item
    // would be a control that does nothing.
    render(
      <AppCoreStoryProviders apiRoutes={projectRoutes([])}>
        {projectCell(filedDetail(), true)}
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));

    await projectOption(PROJECT_B.name);
    expect(screen.queryByRole("option", { name: CLEAR_ITEM_NAME })).toBeNull();
  });

  it("offers no picker to a viewer the host locked out", () => {
    render(
      <AppCoreStoryProviders apiRoutes={projectRoutes([])}>
        {projectCell(filedDetail(), false)}
      </AppCoreStoryProviders>
    );

    expect(screen.getByText(PROJECT_A.name)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("offers no picker where there is no API port to write through", () => {
    // No providers at all, the mount the priority row also pins: a control that
    // cannot commit must not be offered.
    render(projectCell(filedDetail(), true));

    expect(screen.getByText(PROJECT_A.name)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("offers no picker when the producer served no artifact id", () => {
    // `BranchPageDetail.id` is `encodeBranchId(…)` on a producer that omits
    // `artifactId`, and `batch-move` takes an artifact UUID — the same refusal
    // the Tags row makes.
    render(
      <AppCoreStoryProviders apiRoutes={projectRoutes([])}>
        {projectCell(
          filedDetail({
            artifactId: undefined,
            id: encodeBranchId({
              branchName: "feat/details",
              repoFullName: "owner/repo",
            }),
          }),
          true
        )}
      </AppCoreStoryProviders>
    );

    expect(screen.queryByRole("combobox")).toBeNull();
    // Still the name, so the row reports what it read rather than going blank.
    expect(screen.getByText(PROJECT_A.name)).toBeInTheDocument();
  });

  it("refreshes the Branch-owned client an injected source brings, not only the parent", async () => {
    // marisolashgrove, PR #8735: `useBatchMoveArtifacts` invalidates through
    // `useQueryClient()`. Desktop reads Branches from a client injected by
    // `DesktopBranchesSource` that only `useBranchesQueryContext` resolves, so
    // that invalidation alone leaves the row rendering the old project. Every
    // other case here mounts one client and cannot tell the two apart.
    const received: { path: string; body: unknown }[] = [];
    const branchClient = createTestQueryClient();
    const invalidated = vi.spyOn(branchClient, "invalidateQueries");
    render(
      <AppCoreStoryProviders apiRoutes={projectRoutes(received)}>
        <BranchesDataSourceProvider
          dataSource={inertBranchesDataSource()}
          queryClient={branchClient}
        >
          {projectCell(filedDetail(), true)}
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await user.click(await projectOption(PROJECT_B.name));

    await waitFor(() => expect(received).toHaveLength(1));
    await waitFor(() => {
      for (const queryKey of INJECTED_CLIENT_FAMILY_KEYS) {
        expect(invalidated).toHaveBeenCalledWith({ queryKey });
      }
    });
    branchClient.clear();
  });

  it("still refreshes the injected client when the row unmounts mid-move", async () => {
    // davetho, PR #8735: changing the project and switching tabs before the
    // POST settles unmounts this row. TanStack drops a per-call `mutate`
    // callback once its component is gone, so the refresh has to live on the
    // mutation hook — the case above keeps the row mounted and cannot tell the
    // two apart.
    const received: { path: string; body: unknown }[] = [];
    let releaseMove: (() => void) | undefined;
    const movePending = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
    const branchClient = createTestQueryClient();
    const invalidated = vi.spyOn(branchClient, "invalidateQueries");
    const view = render(
      <AppCoreStoryProviders apiRoutes={heldMoveRoutes(received, movePending)}>
        <BranchesDataSourceProvider
          dataSource={inertBranchesDataSource()}
          queryClient={branchClient}
        >
          {projectCell(filedDetail(), true)}
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await user.click(await projectOption(PROJECT_B.name));
    await waitFor(() => expect(received).toHaveLength(1));

    // The tab switch: the row is gone while the POST is still out.
    view.unmount();
    invalidated.mockClear();
    await act(async () => {
      releaseMove?.();
      await movePending;
    });

    await waitFor(() => {
      for (const queryKey of INJECTED_CLIENT_FAMILY_KEYS) {
        expect(invalidated).toHaveBeenCalledWith({ queryKey });
      }
    });
    branchClient.clear();
  });

  it("names the branch's project before the list has loaded", () => {
    // The trigger reads from the detail, not the list, so a filed branch never
    // paints the picker's "nothing chosen" placeholder while the fetch is out.
    render(
      <AppCoreStoryProviders apiRoutes={projectRoutes([])}>
        {projectCell(filedDetail(), true)}
      </AppCoreStoryProviders>
    );

    expect(
      screen.getByRole("combobox", { name: `Project: ${PROJECT_A.name}` })
    ).toBeInTheDocument();
  });
});

/**
 * Families this row's move must refresh on an injected client, picked to span
 * `ARTIFACT_VIEW_FAMILIES` (`bulk-artifact-invalidation.ts`, the canonical
 * registry) rather than one slice of it: the three Branch families AND two the
 * copied list this file used to assert left out. A refresh narrowed back to
 * Branches leaves the project board and the team project list stale.
 */
const INJECTED_CLIENT_FAMILY_KEYS = [
  branchRowQueryKeys.lists,
  branchRowQueryKeys.details,
  branchRowQueryKeys.pageData,
  projectKeys.all,
  projectTreeKeys.all,
];

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
