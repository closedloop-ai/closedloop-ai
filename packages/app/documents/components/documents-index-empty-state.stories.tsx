import { DocumentsIndexEmptyState } from "@repo/app/documents/components/documents-index-empty-state";
import { DocumentsStaleRefreshNotice } from "@repo/app/documents/components/documents-stale-refresh-notice";
import { DocumentsIndexState } from "@repo/app/documents/lib/documents-index-state";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * The Documents index's non-table states (ISS-8940), each on its own.
 *
 * They ship behind a closed-by-default flag, so four of the five below are not
 * states a reviewer can reach by clicking around a running app — and three of
 * them (a read that failed outright, a refresh that failed over cached rows,
 * and that refresh under a search matching none of them) need a network fault
 * to reach at all. Storybook is where their copy, scale, and register actually
 * get looked at side by side, which is the only way to tell whether they read
 * as genuinely different answers or as five shrugs.
 */
const meta = {
  title: "Composites v1.0/Documents/Documents Index Empty State",
  tags: ["deprecated"],
  component: DocumentsIndexEmptyState,
  parameters: { layout: "padded" },
} satisfies Meta<typeof DocumentsIndexEmptyState>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The organization genuinely has no documents. The onboarding zero-state. */
export const FirstUseEmpty: Story = {
  args: {
    state: DocumentsIndexState.FirstUseEmpty,
    onRetry: () => {
      // Not reachable from this state; the empty state has no retry action.
    },
  },
};

/**
 * A search emptied the view. Read this against FirstUseEmpty: the two must not
 * be mistakable for one another, because one means "type something else" and
 * the other means "write something".
 *
 * Review the copy for BOTH readers who land here (ISS-9762). Once the term is
 * answered upstream, an organization holding hundreds that matched none and one
 * holding nothing at all arrive as the same zero rows, so this screen may not
 * claim a population — check that it still does not.
 */
export const NoResults: Story = {
  args: {
    state: DocumentsIndexState.NoResults,
    onRetry: () => {
      // Not reachable from this state; the empty state has no retry action.
    },
  },
};

/**
 * The intersection: a refresh failed AND the active search excludes every row
 * that survived it. Read this against StaleAfterFailedRefresh below — the whole
 * reason this state exists is that the banner cannot be used here, because
 * there are no rows on screen for it to be about (whitlockk review, cid 3955716628).
 */
export const StaleNoResults: Story = {
  args: {
    state: DocumentsIndexState.StaleNoResults,
    onRetry: () => {
      // Storybook stand-in for the query's refetch.
    },
  },
};

/** The read failed with nothing cached — the surface is unusable, and says so. */
export const BlockingError: Story = {
  args: {
    state: DocumentsIndexState.BlockingError,
    onRetry: () => {
      // Storybook stand-in for the query's refetch.
    },
  },
};

/**
 * The counterpart that is NOT an empty state: rows survived, so the notice sits
 * above them rather than replacing them. Included here so the failed-refresh
 * register can be compared against the blocking error's — a reader must be able
 * to tell "still usable" from "nothing to use" at a glance.
 */
export const StaleAfterFailedRefresh: StoryObj = {
  render: () => (
    <DocumentsStaleRefreshNotice
      onRetry={() => {
        // Storybook stand-in for the query's refetch.
      }}
    />
  ),
};
