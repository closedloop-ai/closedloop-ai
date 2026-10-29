/**
 * ISS-10397 — story files the browser-mode `storybookTest` project skips.
 *
 * Every story here passes in the jsdom sweep (`__tests__/story-sweep.test.tsx`,
 * which still runs all of them) and fails in real Chromium, because its `play`
 * function asserts something jsdom never computes: layout, CSS visibility, or
 * a native drag. Measured at 1280x720 over four full runs of 574 files / 3047
 * stories: these 27 files held every failure, and reruns moved some of them
 * between stories of the same file, so the list is per FILE.
 *
 * Skipping, not deleting: the rest of each file is still covered by the jsdom
 * sweep, and the nightly lane stays green on everything else instead of going
 * red on day one and being ignored. Burning the list down is ISS-12836;
 * remove a row once its file passes `pnpm --filter storybook test:storybook`.
 *
 * Paths are relative to `apps/storybook`, the browser project's root, matching
 * how the plugin writes its own story `include` globs.
 */
export const STORYBOOK_BROWSER_EXCLUSIONS: readonly string[] = [
  // Native drag: `userEvent` cannot build a `DataTransfer` for a real
  // `dragstart`, which jsdom's synthetic events never needed.
  "stories/table-grid-header-handles.stories.tsx",
  "stories/table-grid-header-v2-handles.stories.tsx",

  // Layout: the queried control is laid out of the measured width (toolbar
  // overflow, a virtualized row or header) only once real sizes exist.
  "stories/grid-table-list-surface.stories.tsx",
  "stories/composites-v2/v2-grid-table-list-surface.stories.tsx",
  "stories/table-grid-header-v2-label.stories.tsx",
  "stories/grid-table-toolbar.stories.tsx",
  "stories/grid-table-v2.stories.tsx",
  "stories/table-grid-column-menu.stories.tsx",
  "stories/table-grid-header.stories.tsx",
  "stories/composites-v2/filtering-and-sorting-model.stories.tsx",
  "stories/composites-v2/v2-branches-list-toolbar.stories.tsx",
  "../../packages/app/agents/components/sessions/sessions-list-surface-v2-contracts.stories.tsx",
  "../../packages/app/agents/components/sessions/sessions-list-surface-v2.stories.tsx",
  "../../packages/app/branches/components/branches-list-surface-v2.stories.tsx",
  "../../packages/app/issues/components/issues-index-view.stories.tsx",
  "../../packages/app/projects/components/project-artifact-list.stories.tsx",
  "../../packages/app/documents/components/table/cells/edit-cells.stories.tsx",
  "../../packages/app/shared/components/comments/comments-pane.stories.tsx",
  "../../packages/app/shared/components/generic-artifact-surface/generic-artifact-surface.stories.tsx",

  // CSS visibility: `toBeVisible()` / pointer interaction against an element
  // a real stylesheet hides, clips or makes `pointer-events: none`.
  "stories/table-add-field-dialog.stories.tsx",
  "stories/surfaces/dashboard.stories.tsx",
  "../../packages/app/documents/components/related-sessions-cell.stories.tsx",
  "../../packages/app/onboarding/components/guided-onboarding-dialog.stories.tsx",
  "../../packages/app/onboarding/components/onboarding-analysis-banner.stories.tsx",
  "../../packages/app/organizations/components/invite-team-dialog.stories.tsx",
  "../../packages/app/projects/components/project-select-popover.stories.tsx",
  "../../packages/app/shared/components/generic-artifact-surface/related-sessions-table-cell.stories.tsx",
];
