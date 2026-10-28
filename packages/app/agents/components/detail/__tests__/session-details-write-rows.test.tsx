import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  CollaboratorArtifactType,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Priority } from "@repo/api/src/types/common";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactTagAvailability, TagColor } from "@repo/api/src/types/tag";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import {
  DetailsAvailability,
  type DetailsField,
  DetailsFieldId,
  forViewer,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import { isDetailsFieldDrawn } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-sections";
import {
  DetailsTabArtifactType,
  shippedDetailsTabConfig,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import { DetailsTabSections } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-sections";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import type { FixtureRequestContext } from "@repo/app/shared/storybook/fixture-fetch";
import { PRIORITY_LABELS } from "@repo/design-system/lib/priority-order";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { sessionShellDetailsConfig } from "../session-shell-details";
import {
  priorityRow,
  sessionProjectRow,
  tagsRow,
} from "../session-shell-details-write-rows";

/**
 * ISS-10995: the Session Details tab's Priority, Project and Tags writes.
 *
 * The editable set on Sessions is priority, project, tags and custom fields
 * (operator rulings 2026-10-09 and 2026-10-12). A source carrying none of
 * them — Desktop single-user mode, whose detail projection has no such
 * column — draws no row at all (operator ruling 2026-10-09).
 */

const SESSION_ID = "55555555-5555-4555-8555-555555555551";
const TAG = { color: TagColor.Blue, id: "tag-1", name: "Platform" };
/**
 * Five, because `EntityTagsCell`'s grid default shows two: a two- or
 * three-tag fixture cannot tell an uncapped row from the default one.
 */
const MANY_TAGS = ["Platform", "Infra", "Billing", "Mobile", "Growth"].map(
  (name, index) => ({ color: TagColor.Blue, id: `tag-${index}`, name })
);
/** `TagChips`' overflow indicator, the one thing an uncapped row must not draw. */
const OVERFLOW_CHIP_PATTERN = /^\+\d+$/;

/** The self-saving cell the renderer would mount for this row. */
function cellOf(
  row: DetailsField<DetailsFieldId> | undefined,
  editable: boolean
) {
  if (row?.value.kind !== "self-saving") {
    throw new Error("expected a self-saving row");
  }
  return row.value.render(editable);
}

describe("priorityRow", () => {
  it("omits the row when the producer served no priority", () => {
    const session = createAgentSessionDetailFixture();
    // The fixture's own absence: `undefined` is "this producer does not know",
    // which is every single-user read.
    expect(session.priority).toBeUndefined();

    expect(priorityRow(session)).toEqual([]);
  });

  it("draws a row for a session that genuinely has none, so one can be set", () => {
    const [row] = priorityRow(
      createAgentSessionDetailFixture({ priority: null })
    );

    expect(row?.id).toBe(DetailsFieldId.Priority);
    expect(row?.edit.mode).toBe("self-saving");
    // Never empty: the empty-row rule would otherwise drop the row for a
    // viewer the host has locked out of editing it.
    expect(row?.value).toMatchObject({ kind: "self-saving", empty: false });
  });

  it("keeps an unset priority drawn for a viewer who cannot edit it", () => {
    // The empty-row rule drops a locked self-saving row that reports itself
    // empty, so a row reporting `empty` from its value would vanish for this
    // viewer — hiding a field the producer did serve, whose `null` means "no
    // priority" and not "nothing here".
    const config = forViewer(
      sessionShellDetailsConfig(
        {
          session: createAgentSessionDetailFixture({ priority: null }),
          displayedStatus: SESSION_STATUS.INACTIVE,
        },
        unavailableArtifactCollaborators(CollaboratorArtifactType.Session)
      ),
      DetailsAvailability.NoPermission
    );

    const drawn = config.core
      .filter(isDetailsFieldDrawn)
      .map((field) => field.id);

    expect(drawn).toContain(DetailsFieldId.Priority);
  });

  it("writes the chosen priority alone, guarded by the shown value", async () => {
    const received: { path: string; body: unknown }[] = [];
    const [row] = priorityRow(
      createAgentSessionDetailFixture({
        id: SESSION_ID,
        priority: Priority.Low,
      })
    );
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "PATCH",
            path: "/agent-sessions/*",
            respond: (context: FixtureRequestContext) => {
              received.push({ path: context.pathname, body: context.body });
              return {};
            },
          },
        ]}
      >
        {cellOf(row, true)}
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button"));
    await user.click(
      await screen.findByRole("menuitem", { name: PRIORITY_LABELS.HIGH })
    );

    await waitFor(() => expect(received).toHaveLength(1));
    // The session's wire `id` IS its Artifact id, which the write keys on.
    expect(received[0].path).toBe(`/agent-sessions/${SESSION_ID}`);
    expect(received[0].body).toEqual({
      priority: Priority.High,
      expectedPriority: Priority.Low,
      surface: ArtifactStatusEditSurface.Detail,
    });
  });

  it("writes the priority through DetailsTabSections, the renderer production uses (ISS-12412)", async () => {
    const received: unknown[] = [];
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "PATCH",
            path: "/agent-sessions/*",
            respond: (context: FixtureRequestContext) => {
              received.push(context.body);
              return {};
            },
          },
        ]}
      >
        <DetailsTabSections
          config={shippedDetailsTabConfig(
            DetailsTabArtifactType.Session,
            sessionShellDetailsConfig(
              {
                session: createAgentSessionDetailFixture({
                  id: SESSION_ID,
                  priority: Priority.Low,
                }),
                displayedStatus: SESSION_STATUS.INACTIVE,
              },
              unavailableArtifactCollaborators(CollaboratorArtifactType.Session)
            )
          )}
          priorityEditor={ArtifactPriorityEditor}
        />
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    const row = document.querySelector<HTMLElement>(
      `[data-details-field="${DetailsFieldId.Priority}"]`
    );
    if (!row) {
      throw new Error("Expected the Priority row");
    }
    await user.click(within(row).getByRole("button"));
    await user.click(
      await screen.findByRole("menuitem", { name: PRIORITY_LABELS.HIGH })
    );
    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      priority: Priority.High,
      expectedPriority: Priority.Low,
    });
  });

  it("offers no control to a viewer the host locked out", () => {
    const [row] = priorityRow(
      createAgentSessionDetailFixture({ priority: Priority.Low })
    );

    render(<AppCoreStoryProviders>{cellOf(row, false)}</AppCoreStoryProviders>);

    expect(screen.getByText(PRIORITY_LABELS.LOW)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers no control where no data source can write", () => {
    const [row] = priorityRow(
      createAgentSessionDetailFixture({ priority: Priority.Low })
    );

    // No providers at all, the mount the custom-field suite also pins: a
    // control that cannot commit must not be offered.
    render(cellOf(row, true));

    expect(screen.getByText(PRIORITY_LABELS.LOW)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("tagsRow", () => {
  it("omits the row when the tag relation was never loaded", () => {
    for (const session of [
      createAgentSessionDetailFixture({ tags: undefined }),
      // Availability and the array are read TOGETHER: tags present but
      // unavailable is still a read nobody made.
      createAgentSessionDetailFixture({
        tagAvailability: ArtifactTagAvailability.Unavailable,
        tags: [TAG],
      }),
    ]) {
      expect(tagsRow(session)).toEqual([]);
    }
  });

  it("draws a self-saving row for a loaded relation, empty or not", () => {
    for (const [tags, empty] of [
      [[], true],
      [[TAG], false],
    ] as const) {
      const [row] = tagsRow(
        createAgentSessionDetailFixture({
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

  it("offers the picker only to a viewer who may apply, and never when locked", () => {
    const [row] = tagsRow(
      createAgentSessionDetailFixture({
        name: "Session one",
        tagAvailability: ArtifactTagAvailability.Available,
        tagPermissions: { canApply: true, canRemove: true },
        tags: [TAG],
      })
    );

    const { unmount } = render(
      <AppCoreStoryProviders>{cellOf(row, true)}</AppCoreStoryProviders>
    );
    expect(
      screen.getByRole("button", { name: "Edit tags for Session one" })
    ).toBeInTheDocument();
    unmount();

    render(<AppCoreStoryProviders>{cellOf(row, false)}</AppCoreStoryProviders>);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(TAG.name)).toBeInTheDocument();
  });

  // The row this replaced rendered `TagList`, which wraps and shows every tag.
  // `EntityTagsCell`'s default of two is a GRID cap, so left at the default
  // this tab hid the rest behind a hover-only `+N` (#8697 review).
  it("shows every tag, with no overflow indicator", () => {
    const [row] = tagsRow(
      createAgentSessionDetailFixture({
        tagAvailability: ArtifactTagAvailability.Available,
        tagPermissions: { canApply: true, canRemove: true },
        tags: MANY_TAGS,
      })
    );

    render(<AppCoreStoryProviders>{cellOf(row, true)}</AppCoreStoryProviders>);

    for (const tag of MANY_TAGS) {
      expect(screen.getByText(tag.name)).toBeInTheDocument();
    }
    expect(screen.queryByText(OVERFLOW_CHIP_PATTERN)).toBeNull();
  });
});

const PROJECT_A = {
  id: "44444444-4444-4444-8444-444444444441",
  name: "Desktop MLP",
  slug: "PRO-1",
};
const PROJECT_B = {
  id: "44444444-4444-4444-8444-444444444442",
  name: "Sessions",
  slug: "PRO-2",
};
/** The picker's clear item, which `batch-move` cannot commit. */
const CLEAR_ITEM_NAME = "Clear selection";

/**
 * One of the picker's list items. Scoped to the option role because a filed
 * session's project name is on the TRIGGER as well, and a bare text query would
 * match both. The accessible name carries the slug line too, hence the prefix.
 */
function projectOption(name: string) {
  return screen.findByRole("option", { name: new RegExp(`^${name}`) });
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
          movedArtifacts: [{ id: SESSION_ID, type: ArtifactType.Session }],
        };
      },
    },
  ];
}

function filedSession(project: typeof PROJECT_A | null = PROJECT_A) {
  return createAgentSessionDetailFixture({ id: SESSION_ID, project });
}

describe("sessionProjectRow", () => {
  it("omits the row when the producer served no project", () => {
    // Desktop single-user mode has no project concept, so
    // `buildLocalSessionRelations` omits the key — `undefined` is "this
    // producer does not know", and the row is left out rather than drawn.
    expect(
      sessionProjectRow(
        createAgentSessionDetailFixture({ id: SESSION_ID, project: undefined })
      )
    ).toEqual([]);
  });

  it("draws a row for a session filed into no project, so one can be set", () => {
    const [row] = sessionProjectRow(filedSession(null));

    expect(row?.id).toBe(DetailsFieldId.Project);
    expect(row?.edit.mode).toBe("self-saving");
    expect(row?.value).toMatchObject({ kind: "self-saving", empty: false });
  });

  it("keeps an unfiled session's row drawn for a viewer who cannot edit it", () => {
    // The empty-row rule drops a LOCKED self-saving row that reports itself
    // empty, so a row reporting `empty` from its value would vanish for this
    // viewer — hiding a field the producer did serve, whose `null` means "filed
    // into no project" and not "nothing here".
    const config = forViewer(
      sessionShellDetailsConfig(
        {
          session: filedSession(null),
          displayedStatus: SESSION_STATUS.INACTIVE,
        },
        unavailableArtifactCollaborators(CollaboratorArtifactType.Session)
      ),
      DetailsAvailability.NoPermission
    );

    const drawn = config.core
      .filter(isDetailsFieldDrawn)
      .map((field) => field.id);

    expect(drawn).toContain(DetailsFieldId.Project);
  });

  it("asks for the project list when the picker opens, not on mount", async () => {
    // `@repo/app` AGENTS.md: menu data is gated, not fetched on mount. The
    // trigger paints from the detail, so a Session Details view nobody opens
    // the picker on must not fetch every project in the org.
    const listed: string[] = [];
    const [row] = sessionProjectRow(filedSession());
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
        {cellOf(row, true)}
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

  it("files the session through batch-move, this artifact alone", async () => {
    // One field, one writer: `POST /artifact-links/batch-move` is the canonical
    // mover for both types (operator ruling 2026-10-12), so the Details row
    // does NOT reach for the session PATCH's own `projectId` arm.
    const received: { path: string; body: unknown }[] = [];
    const [row] = sessionProjectRow(filedSession());
    render(
      <AppCoreStoryProviders apiRoutes={projectRoutes(received)}>
        {cellOf(row, true)}
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await user.click(await projectOption(PROJECT_B.name));

    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].path).toBe("/artifact-links/batch-move");
    expect(received[0].body).toEqual({
      // A session's wire `id` IS its Artifact id.
      artifactId: SESSION_ID,
      targetProjectId: PROJECT_B.id,
      // The downstream walk would carry every document linked beneath the
      // session into the project too.
      includeDownstream: false,
      // ISS-10995's stale-write guard: the project this row RENDERED, the
      // sibling of `expectedPriority` on the Priority row.
      expectedProjectId: PROJECT_A.id,
      surface: ArtifactStatusEditSurface.Detail,
    });
  });

  it("writes nothing when the shown project is re-picked", async () => {
    const received: { path: string; body: unknown }[] = [];
    const [row] = sessionProjectRow(filedSession());
    render(
      <AppCoreStoryProviders apiRoutes={projectRoutes(received)}>
        {cellOf(row, true)}
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await user.click(await projectOption(PROJECT_A.name));

    expect(received).toEqual([]);
  });

  it("offers no clear, because batch-move cannot commit one", async () => {
    // `batch-move`'s `targetProjectId` is `z.uuid()`. The picker's clear item
    // would be a control that does nothing.
    const [row] = sessionProjectRow(filedSession());
    render(
      <AppCoreStoryProviders apiRoutes={projectRoutes([])}>
        {cellOf(row, true)}
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));

    await projectOption(PROJECT_B.name);
    expect(screen.queryByRole("option", { name: CLEAR_ITEM_NAME })).toBeNull();
  });

  it("offers no picker to a viewer the host locked out", () => {
    const [row] = sessionProjectRow(filedSession());
    render(
      <AppCoreStoryProviders apiRoutes={projectRoutes([])}>
        {cellOf(row, false)}
      </AppCoreStoryProviders>
    );

    expect(screen.getByText(PROJECT_A.name)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("offers no picker where there is no API port to write through", () => {
    // No providers at all, the mount the priority row also pins: a control that
    // cannot commit must not be offered.
    const [row] = sessionProjectRow(filedSession());
    render(cellOf(row, true));

    expect(screen.getByText(PROJECT_A.name)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("names the session's project before the list has loaded", () => {
    // The trigger reads from the detail, not the list, so a filed session never
    // paints the picker's "nothing chosen" placeholder while the fetch is out.
    const [row] = sessionProjectRow(filedSession());
    render(
      <AppCoreStoryProviders apiRoutes={projectRoutes([])}>
        {cellOf(row, true)}
      </AppCoreStoryProviders>
    );

    expect(
      screen.getByRole("combobox", { name: `Project: ${PROJECT_A.name}` })
    ).toBeInTheDocument();
  });
});
