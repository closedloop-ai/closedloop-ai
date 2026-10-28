/**
 * The create-then-pick-colour flow driven through a real MOUNT SITE rather than
 * through `TagPicker` on its own (ISS-6385).
 *
 * The branches table is the only surface that reaches `TagPicker` in the
 * DESKTOP renderer (`BranchesView` → `BranchesListSurfaceV2` → this table), so it is
 * where the flow is worth driving: the row's own trigger, the props this table
 * derives from `tagPermissions`, and the picker's mutations, in one pass. The
 * sibling suite in `tags/components/__tests__/tag-picker.test.tsx` covers the
 * picker's own state machine; this one covers that a user standing on a branch
 * row can actually reach it — and, at the bottom, when they must NOT.
 */

import { BranchTagAvailability } from "@repo/api/src/types/branch";
import type { Tag, TagSummary } from "@repo/api/src/types/tag";
import { TagColor } from "@repo/api/src/types/tag";
import { TAG_CREATE_COLOR_FLAG_KEY } from "@repo/api/src/types/tag-create-color-flag";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { documentKeys } from "../../../documents/hooks/document-keys";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { FixtureRoute } from "../../../shared/storybook/fixture-fetch";
import { tagKeys } from "../../../tags/hooks/use-tags";
import type { BranchesDataSource } from "../../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import { branchesKeys } from "../../hooks/use-branches";
import type { BranchRow } from "../../lib/branch-row";
import { BRANCH_SAMPLE_ROWS } from "../../lib/branch-sample-data";
import { BranchesListSurfaceV2 } from "../branches-list-surface-v2";
import { BranchesTable } from "../branches-table";
import { branchesListSurfaceV2SummaryPropsFixture } from "./branches-list-surface-v2-props.fixtures";
import { branchesToolbarPropsFixture } from "./branches-toolbar-props.fixtures";

const CREATED_TAG: Tag = {
  id: "tag-created",
  organizationId: "org-1",
  name: "brandnew",
  color: TagColor.Teal,
  createdById: "user-1",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

/** Colours the PATCH route received, so a dropped write is visible. */
const patchedColors: string[] = [];

const TAG_ROUTES: FixtureRoute[] = [
  { method: "GET", path: "/tags", respond: () => [] },
  { method: "POST", path: "/tags", respond: () => CREATED_TAG },
  {
    method: "PATCH",
    path: "/tags/*",
    respond: ({ body }) => {
      const input = (body ?? {}) as { color?: string };
      if (input.color) {
        patchedColors.push(input.color);
      }
      return { ...CREATED_TAG, color: input.color ?? CREATED_TAG.color };
    },
  },
  { method: "POST", path: "/entity-tags", respond: () => ({ applied: true }) },
];

const TAGGABLE_ROW: BranchRow = {
  ...(BRANCH_SAMPLE_ROWS[0] as BranchRow),
  id: "branch-taggable",
  branchName: "agent/tag-colour-step",
  artifactId: "artifact-1",
  tags: [],
  tagAvailability: BranchTagAvailability.Available,
  tagPermissions: { canApply: true, canRemove: true },
};

const EDIT_TAGS_LABEL = `Edit tags for ${TAGGABLE_ROW.branchName}`;
const PICK_A_COLOR_PATTERN = /Pick a color for/i;
const CREATE_TAG_PATTERN = /Create/i;
const SEARCH_PLACEHOLDER = "Search tags...";

function renderBranchesTable(enabledFlags: readonly string[]) {
  return render(
    <AppCoreStoryProviders
      apiRoutes={TAG_ROUTES}
      enabledFlags={enabledFlags}
      queryData={[[tagKeys.list({}), []]]}
    >
      <BranchesTable approved items={[TAGGABLE_ROW]} />
    </AppCoreStoryProviders>
  );
}

/** Opens the row's tag editor and names a tag that does not exist yet. */
async function createTagFromTheRow() {
  fireEvent.click(screen.getByRole("button", { name: EDIT_TAGS_LABEL }));
  const input = await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);
  fireEvent.change(input, { target: { value: CREATED_TAG.name } });
  fireEvent.click(await screen.findByText(CREATE_TAG_PATTERN));
  return input;
}

describe("approved branches tags cell", () => {
  afterEach(() => {
    cleanup();
    patchedColors.length = 0;
  });

  it("creates a tag from the row and writes the colour picked in the step", async () => {
    renderBranchesTable([TAG_CREATE_COLOR_FLAG_KEY]);

    await createTagFromTheRow();

    expect(await screen.findByText(PICK_A_COLOR_PATTERN)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: TagColor.Violet }));

    await waitFor(() => {
      expect(patchedColors).toEqual([TagColor.Violet]);
    });
    expect(screen.queryByText(PICK_A_COLOR_PATTERN)).not.toBeInTheDocument();
  });

  it("creates the tag with no colour step when the flag is off", async () => {
    renderBranchesTable([]);

    const input = await createTagFromTheRow();

    await waitFor(() => {
      expect(input).toHaveValue("");
    });
    expect(screen.queryByText(PICK_A_COLOR_PATTERN)).not.toBeInTheDocument();
    expect(patchedColors).toEqual([]);
  });
});

/**
 * ISS-12452: this table is the documented desktop mount site for `TagPicker`
 * (file header above), and desktop injects a Branch-owned query client here
 * (`BranchesDataSourceProvider`/`useBranchesQueryContext`) distinct from the
 * ambient one. Mirrors `useUpdateBranchPriority`'s own regression test
 * (`use-update-branch-priority.test.tsx`, ISS-9491) for the same defect class:
 * a write that invalidates the wrong client never reaches the row.
 *
 * Unlike a priority write, a tag write also moves families only the ambient
 * client caches — the picker's tag list, Documents, Sessions — so both clients
 * are asserted here rather than one at the other's expense (marisolashgrove
 * review, PR #8793).
 */
const EXISTING_TAG: TagSummary = {
  id: "tag-existing",
  name: "infra-existing",
  color: TagColor.Blue,
};

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
}

describe("approved branches tags cell writes through the injected Branch client and the ambient one on desktop (ISS-12452)", () => {
  afterEach(cleanup);

  it("invalidates the Branch-injected client and the ambient client when a tag is applied from the row", async () => {
    const branchClient = newQueryClient();
    const ambientClient = newQueryClient();
    ambientClient.setQueryData(tagKeys.list({}), [EXISTING_TAG]);
    const listKey = branchesKeys.list("desktop-scope", {});
    for (const client of [branchClient, ambientClient]) {
      client.setQueryData(listKey, { items: [], total: 0 });
    }
    // A family the Branch client never caches, so it is what a write routed to
    // that client alone would leave stale.
    const documentListKey = documentKeys.list({});
    ambientClient.setQueryData(documentListKey, { items: [], total: 0 });
    const source = {} as unknown as BranchesDataSource;

    render(
      <AppCoreStoryProviders apiRoutes={TAG_ROUTES}>
        <QueryClientProvider client={ambientClient}>
          <BranchesDataSourceProvider
            dataSource={source}
            queryClient={branchClient}
          >
            <BranchesTable approved items={[TAGGABLE_ROW]} />
          </BranchesDataSourceProvider>
        </QueryClientProvider>
      </AppCoreStoryProviders>
    );

    fireEvent.click(screen.getByRole("button", { name: EDIT_TAGS_LABEL }));
    fireEvent.click(await screen.findByText(EXISTING_TAG.name));

    await waitFor(() => {
      expect(branchClient.getQueryState(listKey)?.isInvalidated).toBe(true);
    });
    expect(ambientClient.getQueryState(documentListKey)?.isInvalidated).toBe(
      true
    );
    expect(ambientClient.getQueryState(listKey)?.isInvalidated).toBe(true);
  });
});

/**
 * ISS-9215 (whitlockk review): a reader granted `canRemove` and nothing else, on a
 * row with nothing applied. The grant reaches no applied tag, so the picker it
 * used to open could apply nothing and remove nothing — a control that opens
 * and does nothing.
 *
 * Driven through BOTH production mounts of the approved-branches grid adapter,
 * because that is the seam where an inert picker would come back: the V1
 * `BranchesTable` and the V2 `BranchesListSurfaceV2`, each of which the web
 * page and the desktop renderer mount behind the grid-table-v2 gate. The
 * companion case with one tag applied is what stops the first from passing on
 * a row that simply renders no editor at all.
 */
const APPLIED_TAG: TagSummary = {
  id: "tag-applied",
  name: "infra",
  color: TagColor.Blue,
};

const REMOVE_ONLY_ROW: BranchRow = {
  ...TAGGABLE_ROW,
  tagPermissions: { canApply: false, canRemove: true },
};

function renderBranchesTableRow(row: BranchRow) {
  return render(
    <AppCoreStoryProviders apiRoutes={TAG_ROUTES}>
      <BranchesTable approved items={[row]} />
    </AppCoreStoryProviders>
  );
}

const TAGS_ONLY_COLUMNS = new Set(["tags"]);

function renderBranchesSurfaceV2Row(row: BranchRow) {
  return render(
    <AppCoreStoryProviders apiRoutes={TAG_ROUTES}>
      <BranchesListSurfaceV2
        allRows={[row]}
        hasActiveFilters={false}
        hasWindow={false}
        includeTagsColumn
        isError={false}
        isPending={false}
        isPlaceholderData={false}
        items={[row]}
        onPageChange={() => undefined}
        onPageSizeChange={() => undefined}
        onRetry={() => undefined}
        onShowAllTime={() => undefined}
        onSort={() => undefined}
        page={0}
        pageSize={25}
        sortBy="lastActivity"
        sortDir="desc"
        {...branchesListSurfaceV2SummaryPropsFixture()}
        // ISS-9225: the surface composes its OWN toolbar from these arguments,
        // so this mount is the whole production surface — toolbar included —
        // rather than the table under an inert placeholder node.
        toolbar={branchesToolbarPropsFixture({
          rows: [row],
          visibleColumns: TAGS_ONLY_COLUMNS,
        })}
        total={1}
        totalPages={1}
        visibleColumns={TAGS_ONLY_COLUMNS}
      />
    </AppCoreStoryProviders>
  );
}

describe.each([
  { mount: renderBranchesTableRow, name: "BranchesTable" },
  { mount: renderBranchesSurfaceV2Row, name: "BranchesListSurfaceV2" },
])("$name offers no inert tag picker (ISS-9215)", ({ mount }) => {
  afterEach(cleanup);

  it("offers no editor when the reader may only remove and nothing is applied", () => {
    const { container } = mount(REMOVE_ONLY_ROW);

    expect(
      screen.queryByRole("button", { name: EDIT_TAGS_LABEL })
    ).not.toBeInTheDocument();
    // Scoped to the tags cell (ISS-12453 added a second popover trigger, the
    // Project cell's, elsewhere in the row).
    expect(
      container.querySelector(
        "[data-column-id='tags'] button[data-slot='popover-trigger']"
      )
    ).not.toBeInTheDocument();
  });

  it("offers the editor once that same grant has an applied tag to spend on", () => {
    mount({ ...REMOVE_ONLY_ROW, tags: [APPLIED_TAG] });

    expect(
      screen.getByRole("button", { name: EDIT_TAGS_LABEL })
    ).toBeInTheDocument();
    expect(screen.getByText(APPLIED_TAG.name)).toBeInTheDocument();
  });
});
