/**
 * ISS-12454: the Sessions LIST files a session into a project.
 *
 * Operator ruling 2026-10-13 — "Project should be editable on list surfaces".
 * The column already rendered the owning project; what it had no affordance for
 * was changing it, so this suite drives the production entry point (the cell the
 * seam mounts) and asserts the REQUEST, not that a control exists. The sibling
 * suite covers what the cell draws; nothing there would notice a picker wired to
 * no writer, or wired to a second one.
 *
 * The write goes through the canonical mover `POST /artifact-links/batch-move`,
 * the one ISS-10995 gave the Details row, which is why this asserts the payload
 * shape rather than just the path: a list-only second writer would satisfy "a
 * POST happened" and still be the duplication that ruling exists to prevent.
 */

import { ArtifactType } from "@repo/api/src/types/artifact";
import { SESSIONS_PROJECTS_COLUMN_ID } from "@repo/app/agents/lib/sessions-table-columns";
import type { FixtureRequestContext } from "@repo/app/shared/storybook/fixture-fetch";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { createAgentSessionListItemFixture } from "../session-list-fixtures";
import { SyncedSessionsTable } from "../synced-sessions-table";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_NAME = "Project write row";
const PROJECT_A = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Platform Core",
  slug: "PRO-1",
};
const PROJECT_B = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Developer Tooling",
  slug: "PRO-2",
};
/** Comfortably above `CARD_FALLBACK_BREAKPOINT` (768), so the grid path renders. */
const GRID_CONTAINER_WIDTH_PX = 1200;

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

type Captured = { path: string; body: unknown };

describe("Sessions list — filing a session into a project (ISS-12454)", () => {
  it("writes the chosen project through the canonical mover, guarded by the shown value", async () => {
    const received: Captured[] = [];
    renderList(received, PROJECT_A);

    const user = userEvent.setup();
    await user.click(projectTrigger());
    await user.click(await projectOption(PROJECT_B.name));

    expect(received).toHaveLength(1);
    expect(received[0]?.path).toBe("/artifact-links/batch-move");
    expect(received[0]?.body).toEqual({
      artifactId: SESSION_ID,
      targetProjectId: PROJECT_B.id,
      // This row files THIS session; carrying its linked artifacts along is not
      // what a one-field cell was asked to do.
      includeDownstream: false,
      // The stale-read guard: the project the cell RENDERED, so a write made
      // against a stale list is refused server-side rather than winning.
      expectedProjectId: PROJECT_A.id,
      surface: ArtifactStatusEditSurface.InlineCell,
    });
  });

  it("files a session that belongs to no project yet", async () => {
    // The row a reader most needs to act on. The sentinel is still what it
    // SHOWS — the dash now sits inside the button rather than instead of it —
    // and `expectedProjectId` is null here rather than absent, which is what
    // tells the server "it was unfiled".
    const received: Captured[] = [];
    renderList(received, null);

    const user = userEvent.setup();
    await user.click(projectTrigger());
    await user.click(await projectOption(PROJECT_A.name));

    expect(received[0]?.body).toEqual({
      artifactId: SESSION_ID,
      targetProjectId: PROJECT_A.id,
      includeDownstream: false,
      expectedProjectId: null,
      surface: ArtifactStatusEditSurface.InlineCell,
    });
  });

  it("asks for the project list when the picker opens, not on mount", async () => {
    // `@repo/app` AGENTS.md: menu data is gated, not fetched on mount. A list of
    // 100 sessions must not fetch every project in the org 100 times because it
    // painted 100 triggers.
    const received: Captured[] = [];
    const listed: string[] = [];
    renderList(received, PROJECT_A, listed);

    // Drain the mount effects AND their microtasks before reading: the fixture
    // transport records in a promise handler, so a synchronous read here cannot
    // tell a gated query from an ungated one — it passes either way.
    await act(async () => {
      await Promise.resolve();
    });
    expect(listed).toEqual([]);
    const user = userEvent.setup();
    await user.click(projectTrigger());
    await screen.findByRole("option", {
      name: new RegExp(`^${PROJECT_B.name}`),
    });
    expect(listed).toEqual(["/projects"]);
  });

  it("sends nothing when the chosen project is the one already shown", async () => {
    // A re-pick of the current value is a no-op, not a write: the server would
    // take it, and every such request invalidates the whole link-view registry.
    const received: Captured[] = [];
    renderList(received, PROJECT_A);

    const user = userEvent.setup();
    await user.click(projectTrigger());
    await user.click(await projectOption(PROJECT_A.name));

    expect(received).toEqual([]);
  });
});

/** The picker's trigger, inside the owning-project track specifically. */
function projectTrigger(): HTMLElement {
  const row = screen.getByText(SESSION_NAME).closest(".group.grid");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Could not find the sessions row for ${SESSION_NAME}`);
  }
  const trigger = row.querySelector<HTMLElement>(
    `[data-column-id="${SESSIONS_PROJECTS_COLUMN_ID}"] button`
  );
  if (trigger === null) {
    throw new Error("The owning-project cell offers no control");
  }
  return trigger;
}

/**
 * One of the picker's list items. Scoped to the option role because the filed
 * session's project name is on the TRIGGER as well, and a bare text query would
 * match both.
 */
function projectOption(name: string) {
  return screen.findByRole("option", { name: new RegExp(`^${name}`) });
}

function renderList(
  received: Captured[],
  project: typeof PROJECT_A | null,
  listed?: string[]
): void {
  restoreContainerWidth = stubContainerWidthPx(GRID_CONTAINER_WIDTH_PX);
  render(
    <AppCoreStoryProviders
      apiRoutes={[
        {
          method: "GET" as const,
          path: "/projects",
          respond: (context: FixtureRequestContext) => {
            listed?.push(context.pathname);
            return [PROJECT_A, PROJECT_B];
          },
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
      ]}
    >
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[
          createAgentSessionListItemFixture({
            id: SESSION_ID,
            name: SESSION_NAME,
            project,
          }),
        ]}
        showLinkedEntityColumns
      />
    </AppCoreStoryProviders>
  );
}

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
