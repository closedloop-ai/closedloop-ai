/**
 * ISS-12453: the Branches LIST cell's project write, driven through the mount
 * site a user actually stands on — a wire row through `adaptBranchRow`, then
 * `BranchesTable` → `renderApprovedBranchCell`.
 *
 * The Details suite (`branch-details-write-rows.test.tsx`) covers the control's
 * own state machine, but it enters at `branchProjectRow` and so proves nothing
 * about the adapter carrying the two wire fields or the grid handing them to
 * the cell (whitlockk review, PR #8794). The desktop case is here for the same
 * reason it is there: `DesktopBranchesSource` injects a Branch-owned query
 * client, and a list whose rows come from it keeps rendering the old project
 * unless the move invalidates that client too.
 */

import { ArtifactType } from "@repo/api/src/types/artifact";
import type { BranchRow as WireBranchRow } from "@repo/api/src/types/branch";
import { projectKeys } from "@repo/app/projects/hooks/project-keys";
import { projectTreeKeys } from "@repo/app/projects/hooks/project-tree-keys";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import type { FixtureRequestContext } from "@repo/app/shared/storybook/fixture-fetch";
import { createTestQueryClient } from "@repo/app/shared/test-utils";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import { branchRowQueryKeys } from "../../hooks/branch-query-keys";
import { wireRow } from "../../lib/__tests__/approved-branch-fixtures";
import { BRANCH_PROJECT_COLUMN_ID } from "../../lib/branch-column-view-model";
import { adaptBranchRow } from "../../lib/branch-row-adapter";
import { BranchesTable } from "../branches-table";
import { inertBranchesDataSource } from "./branch-detail-page.fixtures";

const BRANCH_ARTIFACT_ID = "33333333-3333-4333-8333-333333333331";
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
/** The word `BranchUnavailableValue` renders. */
const UNAVAILABLE_VALUE = "Unavailable";
const PROJECT_COLUMN_SELECTOR = `[data-column-id="${BRANCH_PROJECT_COLUMN_ID}"]`;

/**
 * Families this move must refresh on the injected client, spanning
 * `ARTIFACT_VIEW_FAMILIES` rather than the Branch slice of it — the same set
 * the Details suite pins, for the reason stated there.
 */
const INJECTED_CLIENT_FAMILY_KEYS = [
  branchRowQueryKeys.lists,
  branchRowQueryKeys.details,
  branchRowQueryKeys.pageData,
  projectKeys.all,
  projectTreeKeys.all,
];

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
            { id: BRANCH_ARTIFACT_ID, type: ArtifactType.Branch },
          ],
        };
      },
    },
  ];
}

/**
 * The Project cell of the single data row — every `data-column-id` match that
 * is not the header, so a selector that silently stopped resolving fails here
 * instead of passing an absence assertion.
 */
function projectCell(container: HTMLElement): HTMLElement {
  const cells = Array.from(
    container.querySelectorAll<HTMLElement>(PROJECT_COLUMN_SELECTOR)
  ).filter((cell) => cell.getAttribute("role") !== "columnheader");
  if (cells.length !== 1) {
    throw new Error(`expected one Project data cell, found ${cells.length}`);
  }
  const [cell] = cells;
  return cell;
}

/** One approved list row, adapted from the wire the way both surfaces do. */
function renderList(
  wireOverrides: Partial<WireBranchRow>,
  options: {
    received?: { path: string; body: unknown }[];
    injectedQueryClient?: ReturnType<typeof createTestQueryClient>;
  } = {}
) {
  const row = adaptBranchRow(
    wireRow({ artifactId: BRANCH_ARTIFACT_ID, ...wireOverrides })
  );
  const table = <BranchesTable approved items={[row]} />;
  return render(
    <AppCoreStoryProviders apiRoutes={projectRoutes(options.received ?? [])}>
      {options.injectedQueryClient ? (
        <BranchesDataSourceProvider
          dataSource={inertBranchesDataSource()}
          queryClient={options.injectedQueryClient}
        >
          {table}
        </BranchesDataSourceProvider>
      ) : (
        table
      )}
    </AppCoreStoryProviders>
  );
}

/**
 * One of the picker's list items. Scoped to the option role rather than the
 * text, because a filed branch's project name is on the TRIGGER too — the
 * Details suite scopes it the same way. The popover portals out of the cell, so
 * this is a document query by design.
 */
function projectOption(name: string) {
  return screen.findByRole("option", { name: new RegExp(`^${name}`) });
}

describe("the approved Branches list Project cell", () => {
  afterEach(cleanup);

  // The absence half and its positive control in ONE case, so the picker query
  // cannot be a selector that never resolved: the producer that OMITS the field
  // must draw no control, and the one that serves `null` must draw one.
  it.each([
    {
      expectedPicker: 0,
      expectedUnavailable: 1,
      label: "a producer with no project concept (Desktop single-user)",
      wire: {},
    },
    {
      expectedPicker: 1,
      expectedUnavailable: 0,
      label: "a branch filed into no project",
      wire: { projectId: null, projectName: null },
    },
  ])(
    "distinguishes an omitted project from an unfiled one: $label",
    ({ expectedPicker, expectedUnavailable, wire }) => {
      const { container } = renderList(wire);

      const cell = within(projectCell(container));
      expect(cell.queryAllByRole("combobox")).toHaveLength(expectedPicker);
      expect(cell.queryAllByText(UNAVAILABLE_VALUE)).toHaveLength(
        expectedUnavailable
      );
    }
  );

  it("files the branch through batch-move, this artifact alone", async () => {
    const received: { path: string; body: unknown }[] = [];
    const { container } = renderList(
      { projectId: PROJECT_A.id, projectName: PROJECT_A.name },
      { received }
    );

    const cell = projectCell(container);
    const user = userEvent.setup();
    await user.click(within(cell).getByRole("combobox"));
    await user.click(await projectOption(PROJECT_B.name));

    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].path).toBe("/artifact-links/batch-move");
    expect(received[0].body).toEqual({
      artifactId: BRANCH_ARTIFACT_ID,
      targetProjectId: PROJECT_B.id,
      includeDownstream: false,
      // The stale-write guard is the project THIS ROW rendered, so the value
      // has to survive the adapter and the grid to be correct here.
      expectedProjectId: PROJECT_A.id,
      surface: ArtifactStatusEditSurface.InlineCell,
    });
  });

  it("names the branch's project on the trigger before the list has loaded", () => {
    const { container } = renderList({
      projectId: PROJECT_A.id,
      projectName: PROJECT_A.name,
    });

    expect(
      within(projectCell(container)).getByRole("combobox")
    ).toHaveAccessibleName(`Project: ${PROJECT_A.name}`);
  });

  it("refreshes the Branch-owned client a desktop source injects", async () => {
    const received: { path: string; body: unknown }[] = [];
    const branchClient = createTestQueryClient();
    const invalidated = vi.spyOn(branchClient, "invalidateQueries");
    const { container } = renderList(
      { projectId: PROJECT_A.id, projectName: PROJECT_A.name },
      { injectedQueryClient: branchClient, received }
    );

    const cell = projectCell(container);
    const user = userEvent.setup();
    await user.click(within(cell).getByRole("combobox"));
    await user.click(await projectOption(PROJECT_B.name));

    await waitFor(() => expect(received).toHaveLength(1));
    await waitFor(() => {
      for (const queryKey of INJECTED_CLIENT_FAMILY_KEYS) {
        expect(invalidated).toHaveBeenCalledWith({ queryKey });
      }
    });
    branchClient.clear();
  });
});

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
