import {
  BATCH_ITEM_APPLIED_STATUS,
  BatchItemAppliedOutcome,
  BatchItemFailureCode,
  batchItemApplied,
  batchItemAppliedWithOutcome,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import {
  ArtifactTagAvailability,
  type Tag,
  TagColor,
  TagEntityType,
} from "@repo/api/src/types/tag";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import {
  BULK_REMOVE_TAG_ACTION_LABEL,
  BULK_TAG_ACTION_LABEL,
} from "@repo/app/tags/lib/bulk-tag-labels";
import {
  expect,
  fireEvent,
  screen,
  userEvent,
  waitFor,
  within,
} from "storybook/test";
import { z } from "zod";

// The Sessions and Branches lists' shared tag stories: the org catalog, batch
// writes, and current membership. A story resets module state in `beforeEach`.

export const bulkTagFixtureTag: Tag = {
  color: TagColor.Blue,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  createdById: "user_test",
  id: "tag-backend",
  name: "backend",
  organizationId: "org_test",
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
};

const bulkTagWriteSchema = z.object({
  entityIds: z.array(z.string()),
  entityType: z.literal(TagEntityType.Artifact),
  tagId: z.string(),
});

type BulkTagWrite = z.infer<typeof bulkTagWriteSchema>;

const fixtureState: {
  failOnce: ReadonlySet<string>;
  tagged: Set<string>;
  writes: BulkTagWrite[];
} = { failOnce: new Set(), tagged: new Set(), writes: [] };

/** Starts a story with explicit membership; `failOnce` fails the next write. */
export function resetBulkTagFixture(
  failOnce: readonly string[] = [],
  tagged: readonly string[] = []
) {
  fixtureState.failOnce = new Set(failOnce);
  fixtureState.tagged = new Set(tagged);
  fixtureState.writes = [];
}

/** Re-arms a one-write failure while retaining membership and write history. */
export function failNextBulkTagWrite(ids: readonly string[]) {
  fixtureState.failOnce = new Set(ids);
}

/** The writes the story's Add or Remove Tag action sent, in order. */
export function bulkTagWrites(): readonly BulkTagWrite[] {
  return fixtureState.writes;
}

/** The artifact identities that currently carry the fixture tag. */
export function bulkTaggedIds(): readonly string[] {
  return [...fixtureState.tagged];
}

/** A taggable row whose membership reflects the fixture's mutation state. */
export function withBulkTagState<Row extends object>(
  row: Row,
  artifactId: string
): Row {
  return {
    ...row,
    tagAvailability: ArtifactTagAvailability.Available,
    tagPermissions: { canApply: true, canRemove: true },
    tags: fixtureState.tagged.has(artifactId) ? [bulkTagFixtureTag] : [],
  };
}

/** The catalog and mutation routes shared by Add and Remove Tag stories. */
export const bulkTagRoutes: FixtureRoute[] = [
  { method: "GET", path: "/tags", respond: () => [bulkTagFixtureTag] },
  {
    method: "POST",
    path: `${BatchMutationRoute.EntityTags}/v2`,
    respond: ({ body }) => {
      const write = bulkTagWriteSchema.parse(body);
      fixtureState.writes.push(write);
      const results = write.entityIds.map((id) =>
        fixtureState.failOnce.has(id)
          ? batchItemFailed(id, BatchItemFailureCode.ArtifactsNotFound)
          : batchItemApplied(id)
      );
      for (const id of write.entityIds) {
        if (!fixtureState.failOnce.has(id)) {
          fixtureState.tagged.add(id);
        }
      }
      fixtureState.failOnce = new Set();
      return { results };
    },
  },
  {
    method: "POST",
    path: `${BatchMutationRoute.EntityTagsRemove}/v2`,
    respond: ({ body }) => {
      const write = bulkTagWriteSchema.parse(body);
      fixtureState.writes.push(write);
      const results = write.entityIds.map((id) => {
        if (fixtureState.failOnce.has(id)) {
          return batchItemFailed(id, BatchItemFailureCode.ArtifactsNotFound);
        }
        return batchItemAppliedWithOutcome(
          id,
          fixtureState.tagged.has(id)
            ? BatchItemAppliedOutcome.Removed
            : BatchItemAppliedOutcome.NotPresent
        );
      });
      for (const result of results) {
        if (
          result.status === BATCH_ITEM_APPLIED_STATUS &&
          result.outcome === BatchItemAppliedOutcome.Removed
        ) {
          fixtureState.tagged.delete(result.id);
        }
      }
      fixtureState.failOnce = new Set();
      return { results };
    },
  },
];

/** Selects `rowIds` the way a reader does: a click, then Ctrl-clicks. */
export async function selectListRows(
  root: HTMLElement,
  rowIds: readonly string[]
) {
  for (const [index, id] of rowIds.entries()) {
    // Awaited: in the browser Storybook instruments `fireEvent`, so an
    // unawaited click is still queued when the next line runs. The row is
    // looked up again because the grid can repaint it after the selection.
    await fireEvent.click(await findListRow(root, id), { ctrlKey: index > 0 });
    await waitFor(async () =>
      expect(await findListRow(root, id)).toHaveAttribute(
        "aria-selected",
        "true"
      )
    );
  }
}

/** Removes one row from an established multi-selection without replacing it. */
export async function deselectListRow(root: HTMLElement, rowId: string) {
  await fireEvent.click(await findListRow(root, rowId), { ctrlKey: true });
  await waitFor(async () =>
    expect(await findListRow(root, rowId)).toHaveAttribute(
      "aria-selected",
      "false"
    )
  );
}

/** Opens the selection rail's Add Tag picker and applies the fixture tag. */
export async function addFixtureTag() {
  await userEvent.click(
    await screen.findByRole("button", { name: BULK_TAG_ACTION_LABEL })
  );
  await userEvent.click(
    await screen.findByRole("button", { name: bulkTagFixtureTag.name })
  );
}

/** Opens Remove Tag and applies the fixture tag to the selected rows. */
export async function removeFixtureTag() {
  await userEvent.click(
    await screen.findByRole("button", { name: BULK_REMOVE_TAG_ACTION_LABEL })
  );
  await userEvent.click(
    await screen.findByRole("button", { name: bulkTagFixtureTag.name })
  );
}

/** Retries the narrowed failed-row selection from the still-open picker. */
export async function retryFixtureTag() {
  await userEvent.click(
    await screen.findByRole("button", { name: bulkTagFixtureTag.name })
  );
}

/** Waits for one production list row to reflect the expected fixture tag state. */
export async function expectListRowTagMembership(
  root: HTMLElement,
  rowId: string,
  expected: boolean
) {
  await waitFor(async () => {
    const row = await findListRow(root, rowId);
    const tag = within(row).queryByText(bulkTagFixtureTag.name, {
      exact: true,
    });
    if (expected) {
      expect(tag).toBeInTheDocument();
      return;
    }
    expect(tag).not.toBeInTheDocument();
  });
}

async function findListRow(root: HTMLElement, id: string) {
  return await waitFor(
    () => {
      const row = root.querySelector<HTMLElement>(`[data-grid-row-id="${id}"]`);
      if (!row) {
        throw new Error(`List row ${id} did not render`);
      }
      return row;
    },
    { timeout: 10_000 }
  );
}
